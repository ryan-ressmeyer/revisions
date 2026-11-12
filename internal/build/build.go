package build

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ryan-ressmeyer/revisions/internal/workspace"
)

// maxLog is how much build output is kept: the last 1 MiB.
const maxLog = 1 << 20

// okMarker, in the output directory, says the last build there succeeded.
const okMarker = ".revisions-ok"

// Error is one `file:line: message` error from the build output.
type Error struct {
	Path    string `json:"path"` // relative to the repository root; empty for a file outside it
	Line    int    `json:"line"`
	Message string `json:"message"`
}

// Status is the body of GET R/build.
type Status struct {
	State      string     `json:"state"` // none, running, succeeded, failed, timeout, or canceled
	StartedAt  *time.Time `json:"startedAt"`
	FinishedAt *time.Time `json:"finishedAt"`
	Log        string     `json:"log"`
	Errors     []Error    `json:"errors"`
	PDFVersion int        `json:"pdfVersion"` // 0 until a build succeeds
	Stale      bool       `json:"stale"`
}

// Builder runs at most one build per repository and remembers the last one.
type Builder struct {
	cacheDir string

	mu   sync.Mutex // guards jobs and the fields of each job
	jobs map[workspace.RepoID]*job

	// good is held to replace a repository's good directory and to read from
	// it, so a reader never sees a new PDF beside an old SyncTeX file.
	good sync.RWMutex
}

type job struct {
	state             string
	started, finished time.Time
	log               tail
	errors            []Error
	cancel            context.CancelFunc
	done              chan struct{} // closed when the build has ended
}

// New returns a Builder that keeps its output under cacheDir/build.
func New(cacheDir string) *Builder {
	return &Builder{cacheDir: cacheDir, jobs: map[workspace.RepoID]*job{}}
}

// dir is the cache directory of one repository. It holds out, where latexmk
// writes, and good, the last successful PDF.
func (b *Builder) dir(id workspace.RepoID, sub string) string {
	sum := sha256.Sum256([]byte(id.String()))
	return filepath.Join(b.cacheDir, "build", hex.EncodeToString(sum[:8]), sub)
}

// goodMeta describes the contents of a good directory.
type goodMeta struct {
	PDF         string    `json:"pdf"`         // file name inside the directory
	Entry       string    `json:"entry"`       // entry file it was built from
	PDFVersion  int       `json:"pdfVersion"`  // counts successful builds
	Fingerprint string    `json:"fingerprint"` // working tree it was built from
	BuiltAt     time.Time `json:"builtAt"`     // when the build finished
}

func (b *Builder) meta(id workspace.RepoID) goodMeta {
	var m goodMeta
	if data, err := os.ReadFile(filepath.Join(b.dir(id, "good"), "meta.json")); err == nil {
		json.Unmarshal(data, &m)
	}
	return m
}

// Start begins a build of proj's entry file, or returns the build that is
// already running. latexmk is the program found by FindTool.
func (b *Builder) Start(id workspace.RepoID, root string, proj workspace.Project, latexmk string, timeout time.Duration) Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	fingerprint := proj.Fingerprint()
	if j := b.jobs[id]; j == nil || j.state != "running" {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		j = &job{state: "running", started: time.Now(), cancel: cancel, done: make(chan struct{})}
		b.jobs[id] = j
		go b.run(ctx, j, id, root, proj, latexmk, fingerprint)
	}
	return b.status(id, fingerprint)
}

// Status reports the last or running build. fingerprint is the current
// Project.Fingerprint, which decides Stale.
func (b *Builder) Status(id workspace.RepoID, fingerprint string) Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.status(id, fingerprint)
}

func (b *Builder) status(id workspace.RepoID, fingerprint string) Status {
	b.good.RLock()
	meta := b.meta(id)
	b.good.RUnlock()
	st := Status{
		State:      "none",
		Errors:     []Error{},
		PDFVersion: meta.PDFVersion,
		Stale:      meta.PDFVersion > 0 && meta.Fingerprint != fingerprint,
	}
	if j := b.jobs[id]; j != nil {
		st.State, st.StartedAt, st.Log = j.state, &j.started, j.log.String()
		if j.state != "running" {
			st.FinishedAt, st.Errors = &j.finished, j.errors
		}
	}
	return st
}

// Cancel stops the running build, if any, waits for its processes to be
// killed, and returns the status.
func (b *Builder) Cancel(id workspace.RepoID, fingerprint string) Status {
	b.mu.Lock()
	j := b.jobs[id]
	b.mu.Unlock()
	if j != nil {
		j.cancel()
		<-j.done
	}
	return b.Status(id, fingerprint)
}

// CancelAll cancels every running build, as Cancel does, before Revisions
// quits.
func (b *Builder) CancelAll() {
	b.mu.Lock()
	ids := make([]workspace.RepoID, 0, len(b.jobs))
	for id := range b.jobs {
		ids = append(ids, id)
	}
	b.mu.Unlock()
	for _, id := range ids {
		b.Cancel(id, "")
	}
}

// ReadPDF returns the last good PDF and its version.
func (b *Builder) ReadPDF(id workspace.RepoID) ([]byte, int, bool) {
	b.good.RLock()
	defer b.good.RUnlock()
	meta := b.meta(id)
	if meta.PDFVersion == 0 {
		return nil, 0, false
	}
	data, err := os.ReadFile(filepath.Join(b.dir(id, "good"), meta.PDF))
	return data, meta.PDFVersion, err == nil
}

// ReadLog returns the log of the build that made the last good PDF and when
// that build finished.
func (b *Builder) ReadLog(id workspace.RepoID) (string, time.Time, bool) {
	b.good.RLock()
	defer b.good.RUnlock()
	meta := b.meta(id)
	if meta.PDFVersion == 0 {
		return "", time.Time{}, false
	}
	// A PDF built before logs were kept has none; it reads as empty.
	data, _ := os.ReadFile(filepath.Join(b.dir(id, "good"), "build.log"))
	return string(data), meta.BuiltAt, true
}

func (b *Builder) run(ctx context.Context, j *job, id workspace.RepoID, root string, proj workspace.Project, latexmk, fingerprint string) {
	defer close(j.done)
	defer j.cancel()

	entry := filepath.Join(root, filepath.FromSlash(proj.Entry))
	out := b.dir(id, "out")
	// After a build that did not succeed, start from an empty directory:
	// latexmk will not rerun a rule that failed until a source changes, and a
	// malformed .bcf or .aux can keep failing after the source is fixed.
	// ponytail: the build after a failure is a full build (about 4x the
	// incremental one on testdata/manuscript); if that hurts, keep the
	// directory and pass -g, deleting only the .bcf and .aux files.
	ok := filepath.Join(out, okMarker)
	err := os.Remove(ok)
	if err != nil {
		err = os.RemoveAll(out)
	}
	if err == nil {
		err = mirrorDirs(out, proj)
	}
	if err == nil {
		engine := map[string]string{"xelatex": "-xelatex", "lualatex": "-lualatex"}[proj.Engine]
		if engine == "" {
			engine = "-pdf"
		}
		// -norc because a latexmkrc is Perl that latexmk would execute. The
		// "./" keeps a file name that starts with "-" from being an option.
		cmd := exec.CommandContext(ctx, latexmk, "-norc", engine, "-interaction=nonstopmode", "-file-line-error",
			"-synctex=1", "-no-shell-escape", "-outdir="+out, "./"+filepath.Base(entry))
		cmd.Dir = filepath.Dir(entry)
		cmd.Env = append(os.Environ(),
			"PATH="+filepath.Dir(latexmk)+string(os.PathListSeparator)+os.Getenv("PATH"),
			// TeX wraps its terminal output at 79 columns, which would cut
			// file:line: messages in two.
			"max_print_line=10000",
		)
		cmd.Stdout, cmd.Stderr = &j.log, &j.log
		killTreeOnCancel(cmd)
		cmd.WaitDelay = 5 * time.Second // do not wait forever on a pipe held by a stray child
		err = cmd.Run()
	}

	state := "failed"
	finished := time.Now()
	switch {
	case err == nil:
		jobname := strings.TrimSuffix(filepath.Base(entry), filepath.Ext(entry))
		if err = b.promote(id, out, jobname, proj.Entry, fingerprint, j.log.String(), finished); err == nil {
			state = "succeeded"
			os.WriteFile(ok, nil, 0o644) // if lost, the next build is a full one
		}
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		state = "timeout"
	case ctx.Err() != nil:
		state = "canceled"
	}
	if state == "failed" {
		fmt.Fprintf(&j.log, "\nRevisions: the build failed: %v\n", err)
	}
	found := findErrors(j.log.String(), root, filepath.Dir(entry))

	b.mu.Lock()
	j.state, j.finished, j.errors = state, finished, found
	b.mu.Unlock()
}

// mirrorDirs creates, inside out, every source directory below the entry
// file's directory. TeX writes the .aux file of \include{sub/chapter} to
// out/sub and does not create that directory itself.
func mirrorDirs(out string, proj workspace.Project) error {
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	prefix := path.Dir(proj.Entry) + "/"
	if prefix == "./" {
		prefix = ""
	}
	made := map[string]bool{}
	for _, f := range proj.Files {
		dir, ok := strings.CutPrefix(path.Dir(f.Path)+"/", prefix)
		if !ok || dir == "" || dir == "./" || made[dir] {
			continue
		}
		made[dir] = true
		if err := os.MkdirAll(filepath.Join(out, filepath.FromSlash(dir)), 0o755); err != nil {
			return err
		}
	}
	return nil
}

// promote makes the PDF that latexmk just wrote, its SyncTeX file, and the
// log of the build the last good build.
func (b *Builder) promote(id workspace.RepoID, out, jobname, entry, fingerprint, log string, finished time.Time) error {
	b.good.Lock()
	defer b.good.Unlock()
	good := b.dir(id, "good")
	if err := os.MkdirAll(good, 0o755); err != nil {
		return err
	}
	meta := b.meta(id)
	keep := []string{"meta.json", "build.log", jobname + ".pdf", jobname + ".synctex.gz"}
	if err := workspace.WriteFileAtomic(filepath.Join(good, "build.log"), []byte(log), 0o644); err != nil {
		return err
	}
	for _, name := range keep[2:] {
		data, err := os.ReadFile(filepath.Join(out, name))
		if err != nil {
			return err
		}
		if err := workspace.WriteFileAtomic(filepath.Join(good, name), data, 0o644); err != nil {
			return err
		}
	}
	// A different entry file leaves the previous document's files behind.
	if entries, err := os.ReadDir(good); err == nil {
		for _, e := range entries {
			if !slices.Contains(keep, e.Name()) {
				os.Remove(filepath.Join(good, e.Name()))
			}
		}
	}
	data, err := json.Marshal(goodMeta{PDF: jobname + ".pdf", Entry: entry, PDFVersion: meta.PDFVersion + 1, Fingerprint: fingerprint, BuiltAt: finished})
	if err != nil {
		return err
	}
	return workspace.WriteFileAtomic(filepath.Join(good, "meta.json"), data, 0o644)
}

var errorLine = regexp.MustCompile(`(?m)^(.+?):(\d+): (.+?)\r?$`)

// findErrors extracts the `file:line: message` errors that -file-line-error
// puts in the output. dir is the directory the build ran in.
func findErrors(log, root, dir string) []Error {
	found := []Error{}
	for _, m := range errorLine.FindAllStringSubmatch(log, -1) {
		if strings.HasPrefix(strings.TrimSpace(m[3]), "==>") {
			continue // latexmk's summary of the error before it
		}
		e := Error{Message: strings.TrimRight(m[0], "\r")}
		if rel, ok := repoRelative(root, dir, m[1]); ok {
			line, _ := strconv.Atoi(m[2])
			e = Error{Path: rel, Line: line, Message: m[3]}
		}
		if !slices.Contains(found, e) {
			found = append(found, e)
		}
	}
	return found
}

// repoRelative turns a file name printed by TeX, absolute or relative to dir,
// into a slash path relative to the repository root. It reports false for a
// file outside the repository.
func repoRelative(root, dir, name string) (string, bool) {
	name = filepath.FromSlash(name)
	if !filepath.IsAbs(name) {
		name = filepath.Join(dir, name)
	}
	// TeX records absolute names with symbolic links resolved, as on macOS
	// where /tmp is a link.
	roots := []string{root}
	if real, err := filepath.EvalSymlinks(root); err == nil && real != root {
		roots = append(roots, real)
	}
	for _, r := range roots {
		if rel, err := filepath.Rel(r, filepath.Clean(name)); err == nil && rel != "." && filepath.IsLocal(rel) {
			return filepath.ToSlash(rel), true
		}
	}
	return "", false
}

// tail is a writer that keeps the last maxLog bytes written to it.
type tail struct {
	mu  sync.Mutex
	buf []byte
}

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > 2*maxLog {
		t.buf = append(t.buf[:0], t.buf[len(t.buf)-maxLog:]...)
	}
	return len(p), nil
}

func (t *tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf[max(0, len(t.buf)-maxLog):])
}
