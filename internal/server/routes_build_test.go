package server

import (
	"bytes"
	"fmt"
	"io/fs"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ryan-ressmeyer/revisions/internal/build"
)

type buildBody struct {
	State      string
	StartedAt  *time.Time
	FinishedAt *time.Time
	Log        string
	Errors     []build.Error
	PDFVersion int `json:"pdfVersion"`
	Stale      bool
}

type stateBody struct {
	Hashes map[string]string
	Tree   string
	Build  struct {
		State      string
		PDFVersion int `json:"pdfVersion"`
		Stale      bool
	}
	Git struct {
		Head   string
		Branch *string
		Dirty  bool
	}
}

func needTeX(t *testing.T) {
	t.Helper()
	if build.FindTool("latexmk") == "" {
		t.Skip("latexmk is not installed; skipping a test that runs a real build")
	}
}

// startBuild posts a build and waits for it to end.
func startBuild(t *testing.T, s *Server) buildBody {
	t.Helper()
	rec := api(t, s, "POST", R+"/build", nil)
	if st := decode[buildBody](t, rec); rec.Code != 202 || st.State != "running" || st.StartedAt == nil {
		t.Fatalf("POST build: status %d, %+v; want 202 and a running build", rec.Code, st)
	}
	for deadline := time.Now().Add(3 * time.Minute); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if st := decode[buildBody](t, api(t, s, "GET", R+"/build", nil)); st.State != "running" {
			return st
		}
	}
	t.Fatal("the build did not finish")
	return buildBody{}
}

func texDoc(body string) string {
	return "\\documentclass{article}\n\\begin{document}\n" + body + "\n\\end{document}\n"
}

// treeOf lists every file under root except .git, with its size.
func treeOf(t *testing.T, root string) map[string]int64 {
	t.Helper()
	tree := map[string]int64{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		tree[p] = info.Size()
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return tree
}

// save replaces old with new in a repository file through the save route.
func save(t *testing.T, s *Server, path, old, new string) {
	t.Helper()
	rec := api(t, s, "GET", filePath(path), nil)
	text := strings.Replace(rec.Body.String(), old, new, 1)
	if text == rec.Body.String() {
		t.Fatalf("%s does not contain %q", path, old)
	}
	res := decode[saveResult](t, api(t, s, "PUT", filePath(path), map[string]string{"baseHash": rec.Header().Get("X-Revisions-Hash"), "text": text}))
	if !res.Written {
		t.Fatalf("the save of %s wrote nothing", path)
	}
}

type boxBody struct {
	Page                int
	X, Y, Width, Height float64
}

type locationBody struct {
	Path         string
	Line, Column int
}

func forwardPath(path string, line, column int) string {
	return fmt.Sprintf("%s/synctex/forward?path=%s&line=%d&column=%d", R, url.QueryEscape(path), line, column)
}

// The fixture manuscript is built once and the scenarios that need its PDF
// run against that build, in the order a user would meet them.
func TestBuildLifecycle(t *testing.T) {
	needTeX(t)
	s := newTestServer(t)
	root := fixtureRepo(t, s, nil)
	before := treeOf(t, root)

	t.Run("nothing is built yet", func(t *testing.T) {
		wantError(t, api(t, s, "GET", R+"/pdf", nil), 404, "no_pdf")
		wantError(t, api(t, s, "GET", R+"/pdf/log", nil), 404, "no_pdf")
		wantError(t, api(t, s, "GET", forwardPath("main.tex", 31, 0), nil), 404, "no_pdf")
		wantError(t, api(t, s, "GET", R+"/synctex/inverse?page=1&x=100&y=100", nil), 404, "no_pdf")
		st := decode[buildBody](t, api(t, s, "GET", R+"/build", nil))
		if st.State != "none" || st.PDFVersion != 0 || st.Stale || st.StartedAt != nil || st.Errors == nil {
			t.Errorf("build before any build: %+v", st)
		}
	})

	// Scenario: Build output.
	var pdf []byte
	var first buildBody
	t.Run("Build output", func(t *testing.T) {
		first = startBuild(t, s)
		if first.State != "succeeded" || first.PDFVersion != 1 || first.Stale || len(first.Errors) != 0 || first.FinishedAt == nil {
			t.Fatalf("build: state %q pdfVersion %d stale %v errors %v\n%s", first.State, first.PDFVersion, first.Stale, first.Errors, first.Log)
		}
		if after := treeOf(t, root); !reflect.DeepEqual(after, before) {
			t.Errorf("the build changed the working tree:\nbefore %v\nafter  %v", before, after)
		}
		if status := gitIn(t, root, "status", "--porcelain", "--ignored"); status != "" {
			t.Errorf("git status after the build:\n%s", status)
		}

		rec := api(t, s, "GET", R+"/pdf", nil)
		pdf = rec.Body.Bytes()
		h := rec.Header()
		if rec.Code != 200 || !bytes.HasPrefix(pdf, []byte("%PDF-")) || h.Get("Content-Type") != "application/pdf" {
			t.Errorf("GET pdf: status %d, type %q, %d bytes", rec.Code, h.Get("Content-Type"), len(pdf))
		}
		if h.Get("X-Content-Type-Options") != "nosniff" || h.Get("Content-Security-Policy") != "sandbox" {
			t.Errorf("GET pdf: nosniff=%q CSP=%q", h.Get("X-Content-Type-Options"), h.Get("Content-Security-Policy"))
		}
		st := decode[stateBody](t, api(t, s, "GET", R+"/state", nil))
		if st.Build.State != "succeeded" || st.Build.PDFVersion != 1 || st.Build.Stale {
			t.Errorf("state.build = %+v", st.Build)
		}
	})

	// Scenarios: Source to PDF, PDF to source (the server half).
	t.Run("SyncTeX round trip", func(t *testing.T) {
		if build.FindTool("synctex") == "" {
			t.Skip("synctex is not installed")
		}
		for _, src := range []struct {
			path string
			line int
		}{{"main.tex", 31}, {"main.tex", 99}, {"sections/methods.tex", 6}} {
			box := decode[boxBody](t, api(t, s, "GET", forwardPath(src.path, src.line, 0), nil))
			// The fixture is US letter: 612 by 792 points.
			if box.Page < 1 || box.Width <= 0 || box.Height <= 0 || box.X < 0 || box.X+box.Width > 612 || box.Y < 0 || box.Y+box.Height > 792 {
				t.Errorf("%s:%d: forward gave %+v, which is not a box on the page", src.path, src.line, box)
				continue
			}
			inverse := fmt.Sprintf("%s/synctex/inverse?page=%d&x=%.2f&y=%.2f", R, box.Page, box.X+box.Width/2, box.Y+box.Height/2)
			loc := decode[locationBody](t, api(t, s, "GET", inverse, nil))
			if loc.Path != src.path || math.Abs(float64(loc.Line-src.line)) > 2 || loc.Column < 0 {
				t.Errorf("%s:%d: forward gave %+v and inverse from its centre gave %+v", src.path, src.line, box, loc)
			}
		}

		wantError(t, api(t, s, "GET", forwardPath("../outside.tex", 1, 0), nil), 400, "bad_path")
		wantError(t, api(t, s, "GET", forwardPath("absent.tex", 1, 0), nil), 404, "not_found")
		wantError(t, api(t, s, "GET", R+"/synctex/forward?path=main.tex&line=x", nil), 400, "bad_query")
		wantError(t, api(t, s, "GET", R+"/synctex/inverse?page=one&x=1&y=1", nil), 400, "bad_query")
		wantError(t, api(t, s, "GET", R+"/synctex/inverse?page=1&x=NaN&y=1", nil), 400, "bad_query")
		// A file that the document never reads has no place in the PDF, and
		// a page the PDF does not have has no source.
		wantError(t, api(t, s, "GET", forwardPath("supplement.tex", 3, 0), nil), 404, "no_match")
		wantError(t, api(t, s, "GET", R+"/synctex/inverse?page=99&x=100&y=100", nil), 404, "no_match")
	})

	// Scenario: Edit after build.
	t.Run("Edit after build", func(t *testing.T) {
		save(t, s, "sections/methods.tex", "sampled at 1~kHz", "sampled at 2~kHz")

		st := decode[stateBody](t, api(t, s, "GET", R+"/state", nil))
		if !st.Build.Stale || st.Build.State != "succeeded" || st.Build.PDFVersion != 1 {
			t.Errorf("state.build after an edit = %+v, want stale and still version 1", st.Build)
		}
		b := decode[buildBody](t, api(t, s, "GET", R+"/build", nil))
		if !b.Stale || !b.StartedAt.Equal(*first.StartedAt) || !b.FinishedAt.Equal(*first.FinishedAt) {
			t.Errorf("build after an edit: stale=%v started=%v; the edit must not start a build", b.Stale, b.StartedAt)
		}
		if rec := api(t, s, "GET", R+"/pdf", nil); !bytes.Equal(rec.Body.Bytes(), pdf) {
			t.Error("the PDF changed without a build")
		}
	})

	// Scenario: Failed build.
	t.Run("Failed build", func(t *testing.T) {
		save(t, s, "sections/methods.tex", "\\subsection{Analysis}", "\\subsection{Analysis} \\notacommand")

		st := startBuild(t, s)
		if st.State != "failed" || st.PDFVersion != 1 || !st.Stale {
			t.Fatalf("build: state %q pdfVersion %d stale %v\n%s", st.State, st.PDFVersion, st.Stale, st.Log)
		}
		want := build.Error{Path: "sections/methods.tex", Line: 10, Message: "Undefined control sequence."}
		if len(st.Errors) == 0 || st.Errors[0] != want {
			t.Errorf("errors = %+v, want first %+v", st.Errors, want)
		}
		if rec := api(t, s, "GET", R+"/pdf", nil); rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), pdf) {
			t.Errorf("GET pdf after a failed build: status %d; the last good PDF must still be served unchanged", rec.Code)
		}
		if after := treeOf(t, root); len(after) != len(before) {
			t.Errorf("the failed build left files in the working tree: %v", after)
		}
		// The log of the build whose PDF is shown is still there.
		shown := decode[struct {
			Log     string
			BuiltAt time.Time `json:"builtAt"`
		}](t, api(t, s, "GET", R+"/pdf/log", nil))
		if shown.Log != first.Log || !shown.BuiltAt.Equal(*first.FinishedAt) {
			t.Errorf("GET pdf/log after a failed build: builtAt %v, want the first build's log and %v", shown.BuiltAt, first.FinishedAt)
		}
	})
}

// A short "second" makes the default 300 s limit last 0.6 s and the 7200 s
// maximum 14.4 s, so the timeout scenarios run through the real settings.
const shortSecond = 2 * time.Millisecond

// Scenario: Runaway build.
// Scenario: PDF from another version.
func TestPDFFromAnotherVersionIsOutOfDate(t *testing.T) {
	needTeX(t)
	s := newTestServer(t)
	root := fixtureRepo(t, s, nil)
	first := gitIn(t, root, "rev-parse", "HEAD")
	main, _ := os.ReadFile(filepath.Join(root, "main.tex"))
	writeFiles(t, root, map[string]string{"main.tex": string(main) + "% a later line\n"})
	gitIn(t, root, "commit", "-q", "-am", "Later")

	stale := func() bool { return decode[stateBody](t, api(t, s, "GET", R+"/state", nil)).Build.Stale }
	checkout := func(body map[string]string) {
		t.Helper()
		if rec := api(t, s, "POST", R+"/git/checkout", body); rec.Code != 200 {
			t.Fatalf("checkout %v: %d %s", body, rec.Code, rec.Body)
		}
	}

	if b := startBuild(t, s); b.State != "succeeded" || stale() {
		t.Fatalf("build on main: %+v", b)
	}
	checkout(map[string]string{"commit": first})
	if !stale() {
		t.Error("the PDF of the later version is not out of date on the earlier one")
	}
	// A snapshot can be built, and its PDF is out of date back on the branch.
	if b := startBuild(t, s); b.State != "succeeded" || stale() {
		t.Fatalf("build on the snapshot: %+v", b)
	}
	checkout(map[string]string{"branch": "main"})
	if !stale() {
		t.Error("the PDF of the snapshot is not out of date back on main")
	}
}

func TestRunawayBuildTimesOut(t *testing.T) {
	needTeX(t)
	s := newTestServer(t)
	s.build.second = shortSecond
	plainRepo(t, s, map[string]string{"main.tex": texDoc("\\def\\x{\\x}\\x")})

	st := startBuild(t, s)
	if st.State != "timeout" || st.PDFVersion != 0 {
		t.Fatalf("state %q pdfVersion %d, want timeout\n%s", st.State, st.PDFVersion, st.Log)
	}
	if took := st.FinishedAt.Sub(*st.StartedAt); took > 10*time.Second {
		t.Errorf("the build was stopped after %v, want about 0.6 s", took)
	}
	wantError(t, api(t, s, "GET", R+"/pdf", nil), 404, "no_pdf")
}

// Scenario: Longer timeout.
func TestLongerTimeoutLetsASlowBuildFinish(t *testing.T) {
	needTeX(t)
	s := newTestServer(t)
	s.build.second = shortSecond
	// Counting to three million takes TeX a few seconds.
	plainRepo(t, s, map[string]string{"main.tex": texDoc("\\count255=0 \\loop\\ifnum\\count255<3000000 \\advance\\count255 by 1 \\repeat x")})

	if st := startBuild(t, s); st.State != "timeout" {
		t.Fatalf("under the default limit: state %q, want timeout", st.State)
	}
	decode[settingsBody](t, api(t, s, "PUT", "/api/settings", settingsBody{BuildTimeoutSeconds: 7200}))
	if st := startBuild(t, s); st.State != "succeeded" || st.PDFVersion != 1 {
		t.Fatalf("under the raised limit: state %q pdfVersion %d\n%s", st.State, st.PDFVersion, st.Log)
	}
}

// Scenario: Missing TeX.
func TestBuildWithoutTeXAsksForAnInstall(t *testing.T) {
	s := newTestServer(t)
	root := fixtureRepo(t, s, nil)
	before := treeOf(t, root)
	t.Setenv("PATH", t.TempDir())
	s.build.find = pathOnly

	wantError(t, api(t, s, "POST", R+"/build", nil), 424, "latexmk_missing")
	wantError(t, api(t, s, "GET", forwardPath("main.tex", 31, 0), nil), 424, "synctex_missing")
	wantError(t, api(t, s, "GET", R+"/synctex/inverse?page=1&x=1&y=1", nil), 424, "synctex_missing")
	if env := decode[envBody](t, api(t, s, "GET", "/api/env", nil)); env.Latexmk.Found || env.Platform == "" {
		t.Errorf("env = %+v, want latexmk not found and a platform to give guidance for", env)
	}
	if after := treeOf(t, root); !reflect.DeepEqual(after, before) {
		t.Error("something was written although no build could run")
	}
	entries, _ := os.ReadDir(s.paths.CacheDir)
	if len(entries) != 0 {
		t.Errorf("a build was attempted: the cache holds %v", entries)
	}
}

func TestCancelStopsTheBuild(t *testing.T) {
	needTeX(t)
	s := newTestServer(t)
	plainRepo(t, s, map[string]string{"main.tex": texDoc("\\def\\x{\\x}\\x")})

	started := decode[buildBody](t, api(t, s, "POST", R+"/build", nil))
	again := decode[buildBody](t, api(t, s, "POST", R+"/build", nil))
	if started.State != "running" || again.State != "running" || !again.StartedAt.Equal(*started.StartedAt) {
		t.Fatalf("a second POST did not return the running build: %+v then %+v", started, again)
	}

	st := decode[buildBody](t, api(t, s, "DELETE", R+"/build", nil))
	if st.State != "canceled" || st.FinishedAt == nil {
		t.Errorf("DELETE build answered %+v, want a canceled build", st)
	}
	if st := decode[buildBody](t, api(t, s, "GET", R+"/build", nil)); st.State != "canceled" {
		t.Errorf("state after cancel = %q", st.State)
	}
}

func TestBuildNeedsAnEntryFile(t *testing.T) {
	needTeX(t)
	s := newTestServer(t)
	plainRepo(t, s, map[string]string{"notes.tex": "No document here.\n", ".revisions.toml": "entry = \"absent.tex\"\n"})
	wantError(t, api(t, s, "POST", R+"/build", nil), 409, "no_entry")
	wantError(t, api(t, s, "POST", "/api/repos/github.com/owner/absent/build", nil), 404, "not_found")
}

// latexmk runs its commands through a shell with the file name in double
// quotes, where a backtick still runs a command. A hostile repository must not
// get a document with such a name built, whether it is detected or named in
// .revisions.toml.
func TestEntryNameCannotRunCommands(t *testing.T) {
	needTeX(t)
	for _, config := range []string{"", "entry = \"a`touch PWNED`.tex\"\n"} {
		s := newTestServer(t)
		files := map[string]string{
			"a`touch PWNED`.tex": texDoc("x"), "a$(touch PWNED).tex": texDoc("x"), "b\"x.tex": texDoc("x"),
			"c%PATH%.tex": texDoc("x"),
			// Real manuscripts use names like this one, which no shell reads specially.
			"!paper (v2), final+.tex": texDoc("x"),
		}
		if config != "" {
			files[".revisions.toml"] = config
		}
		root := plainRepo(t, s, files)

		p := decode[projectBody](t, api(t, s, "GET", R+"/project", nil))
		want := "!paper (v2), final+.tex"
		if config != "" {
			want = ""
		}
		if p.Entry != want || (config == "" && !reflect.DeepEqual(p.EntryCandidates, []string{want})) {
			t.Errorf("config %q: entry %q, candidates %v; want %q only", config, p.Entry, p.EntryCandidates, want)
		}
		if rec := api(t, s, "POST", R+"/build", nil); rec.Code == 202 {
			for decode[buildBody](t, api(t, s, "GET", R+"/build", nil)).State == "running" {
				time.Sleep(50 * time.Millisecond)
			}
		}
		if _, err := os.Stat(filepath.Join(root, "PWNED")); err == nil {
			t.Fatalf("config %q: the file name ran a command", config)
		}
	}
}

func TestStateReportsHashesBuildAndGit(t *testing.T) {
	s := newTestServer(t)
	root := fixtureRepo(t, s, map[string]string{"huge.tex": strings.Repeat("x", 2<<20+1)})
	head := gitIn(t, root, "rev-parse", "HEAD")

	st := decode[stateBody](t, api(t, s, "GET", R+"/state", nil))
	want := map[string]string{}
	for _, path := range []string{"main.tex", "supplement.tex", "refs.bib", "sections/methods.tex"} {
		data, _ := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
		want[path] = sha(data)
	}
	// The image and the text file over 2 MiB are left out.
	if !reflect.DeepEqual(st.Hashes, want) {
		t.Errorf("hashes = %v, want %v", st.Hashes, want)
	}
	if st.Build.State != "none" || st.Build.PDFVersion != 0 || st.Build.Stale {
		t.Errorf("build = %+v", st.Build)
	}
	if st.Git.Head != head || st.Git.Branch == nil || *st.Git.Branch != "main" || st.Git.Dirty {
		t.Errorf("git = %+v, want head %s on main and clean", st.Git, head)
	}

	// A change made outside Revisions shows up in the next poll.
	writeFiles(t, root, map[string]string{"refs.bib": "@article{new,}\n"})
	st = decode[stateBody](t, api(t, s, "GET", R+"/state", nil))
	if st.Hashes["refs.bib"] != sha([]byte("@article{new,}\n")) || st.Hashes["main.tex"] != want["main.tex"] || !st.Git.Dirty {
		t.Errorf("after an outside edit: refs.bib hash %s, dirty %v", st.Hashes["refs.bib"], st.Git.Dirty)
	}
}
