package build

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ryan-ressmeyer/revisions/internal/workspace"
)

var testID = workspace.RepoID{Host: "github.com", Owner: "owner", Name: "paper"}

type fixture struct {
	paths   workspace.Paths
	root    string
	latexmk string
	b       *Builder
}

// newFixture makes a clone holding files under temporary roots. It skips the
// test when TeX is not installed.
func newFixture(t *testing.T, files map[string]string) *fixture {
	t.Helper()
	latexmk := FindTool("latexmk")
	if latexmk == "" {
		t.Skip("latexmk is not installed; skipping a test that runs a real build")
	}
	paths := workspace.Paths{Home: t.TempDir(), ConfigDir: t.TempDir(), CacheDir: t.TempDir()}
	root := paths.CloneDir(testID)
	for name, content := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, args := range [][]string{{"init", "-q"}, {"add", "-A"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	return &fixture{paths: paths, root: root, latexmk: latexmk, b: New(paths.CacheDir)}
}

func (f *fixture) project(t *testing.T) workspace.Project {
	t.Helper()
	proj, err := f.paths.LoadProject(testID)
	if err != nil {
		t.Fatal(err)
	}
	return proj
}

// build runs one build to its end.
func (f *fixture) build(t *testing.T, timeout time.Duration) Status {
	t.Helper()
	proj := f.project(t)
	if st := f.b.Start(testID, f.root, proj, f.latexmk, timeout); st.State != "running" {
		t.Fatalf("Start answered state %q, want running", st.State)
	}
	return f.wait(t)
}

func (f *fixture) wait(t *testing.T) Status {
	t.Helper()
	for deadline := time.Now().Add(2 * time.Minute); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if st := f.b.Status(testID, f.project(t).Fingerprint()); st.State != "running" {
			return st
		}
	}
	t.Fatal("the build did not finish")
	return Status{}
}

func doc(body string) string {
	return "\\documentclass{article}\n\\begin{document}\n" + body + "\n\\end{document}\n"
}

func TestFindToolSearchesPathThenWellKnownDirs(t *testing.T) {
	exe := ""
	if runtime.GOOS == "windows" {
		exe = ".exe"
	}
	onPath, texlive := t.TempDir(), t.TempDir()
	for _, p := range []string{
		filepath.Join(onPath, "both"+exe),
		filepath.Join(texlive, "2026", "bin", "x86_64-linux", "both"+exe),
		filepath.Join(texlive, "2026", "bin", "x86_64-linux", "onlytex"+exe),
	} {
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// A file that cannot be executed is not a tool.
	os.WriteFile(filepath.Join(texlive, "2026", "bin", "x86_64-linux", "notes.txt"), []byte("x"), 0o644)
	t.Setenv("PATH", onPath)
	globs := []string{filepath.Join(t.TempDir(), "absent"), filepath.Join(texlive, "*", "bin", "*")}

	if got, want := findTool("both", globs), filepath.Join(onPath, "both"+exe); got != want {
		t.Errorf("a tool on PATH: found %q, want %q", got, want)
	}
	if got, want := findTool("onlytex", globs), filepath.Join(texlive, "2026", "bin", "x86_64-linux", "onlytex"+exe); got != want {
		t.Errorf("a tool only in a well-known directory: found %q, want %q", got, want)
	}
	if got := findTool("neither", globs); got != "" {
		t.Errorf("a missing tool: found %q", got)
	}
	if runtime.GOOS != "windows" {
		if got := findTool("notes.txt", globs); got != "" {
			t.Errorf("a non-executable file was taken for a tool: %q", got)
		}
	}
}

func TestSuccessfulBuildProducesAVersionedPDF(t *testing.T) {
	t.Parallel()
	f := newFixture(t, map[string]string{"main.tex": doc("Hello.")})

	if _, _, ok := f.b.ReadPDF(testID); ok {
		t.Fatal("a PDF exists before any build")
	}
	if st := f.b.Status(testID, "x"); st.State != "none" || st.PDFVersion != 0 || st.Stale || st.Errors == nil {
		t.Fatalf("status before any build: %+v", st)
	}

	st := f.build(t, time.Minute)
	if st.State != "succeeded" || st.PDFVersion != 1 || st.Stale || len(st.Errors) != 0 {
		t.Fatalf("status: %+v", st)
	}
	if st.StartedAt == nil || st.FinishedAt == nil || st.FinishedAt.Before(*st.StartedAt) || !strings.Contains(st.Log, "Latexmk") {
		t.Errorf("started %v, finished %v, log %q", st.StartedAt, st.FinishedAt, st.Log)
	}
	pdf, version, ok := f.b.ReadPDF(testID)
	if !ok || version != 1 || !strings.HasPrefix(string(pdf), "%PDF-") {
		t.Errorf("ReadPDF: ok=%v version=%d, %d bytes", ok, version, len(pdf))
	}

	if st := f.build(t, time.Minute); st.State != "succeeded" || st.PDFVersion != 2 {
		t.Errorf("second build: state %q, pdfVersion %d, want succeeded and 2", st.State, st.PDFVersion)
	}

	// A new process finds the last good PDF and its version again.
	again := New(f.paths.CacheDir)
	if st := again.Status(testID, f.project(t).Fingerprint()); st.State != "none" || st.PDFVersion != 2 || st.Stale {
		t.Errorf("status in a new process: %+v", st)
	}
	if _, version, ok := again.ReadPDF(testID); !ok || version != 2 {
		t.Errorf("ReadPDF in a new process: ok=%v version=%d", ok, version)
	}
}

func TestTheGoodPDFKeepsTheLogOfItsBuild(t *testing.T) {
	t.Parallel()
	f := newFixture(t, map[string]string{"main.tex": doc("Hello.")})
	if _, _, ok := f.b.ReadLog(testID); ok {
		t.Fatal("a build log exists before any build")
	}
	good := f.build(t, time.Minute)
	log, builtAt, ok := f.b.ReadLog(testID)
	if !ok || log != good.Log || !builtAt.Equal(*good.FinishedAt) {
		t.Fatalf("ReadLog after a good build: ok=%v builtAt=%v (finished %v), same log %v", ok, builtAt, good.FinishedAt, log == good.Log)
	}

	if err := os.WriteFile(filepath.Join(f.root, "main.tex"), []byte(doc("\\nosuchmacro")), 0o644); err != nil {
		t.Fatal(err)
	}
	if st := f.build(t, time.Minute); st.State != "failed" || !strings.Contains(st.Log, "nosuchmacro") {
		t.Fatalf("second build: state %q", st.State)
	}
	if again, at, ok := f.b.ReadLog(testID); !ok || again != log || !at.Equal(builtAt) {
		t.Errorf("after a failed build ReadLog gave another log (ok=%v, at %v)", ok, at)
	}
	// A new process still has it.
	if again, _, ok := New(f.paths.CacheDir).ReadLog(testID); !ok || again != log {
		t.Errorf("ReadLog in a new process: ok=%v", ok)
	}
}

func TestErrorsCarryRepositoryRelativePaths(t *testing.T) {
	t.Parallel()
	f := newFixture(t, map[string]string{
		"paper/main.tex":         doc("First \\undefinedone.\n\\input{sections/bad}\n"),
		"paper/sections/bad.tex": "Line one.\nLine two \\undefinedtwo.\n",
	})

	st := f.build(t, time.Minute)
	if st.State != "failed" || st.PDFVersion != 0 {
		t.Fatalf("state %q, pdfVersion %d; want a failed build\n%s", st.State, st.PDFVersion, st.Log)
	}
	want := []Error{
		{Path: "paper/main.tex", Line: 3, Message: "Undefined control sequence."},
		{Path: "paper/sections/bad.tex", Line: 2, Message: "Undefined control sequence."},
	}
	if !reflect.DeepEqual(st.Errors, want) {
		t.Errorf("errors = %+v, want %+v\n%s", st.Errors, want, st.Log)
	}
	if _, _, ok := f.b.ReadPDF(testID); ok {
		t.Error("a failed build produced a good PDF")
	}
}

// latexmk does not rerun a rule that failed until one of its sources changes;
// it prints "Nothing to do" and "gave an error in previous invocation" and no
// error with a file and line.
func TestRebuildAfterAFailureShowsTheErrorAgain(t *testing.T) {
	t.Parallel()
	f := newFixture(t, map[string]string{"main.tex": doc("\\nosuchmacro")})
	want := []Error{{Path: "main.tex", Line: 3, Message: "Undefined control sequence."}}

	for i, b := range []*Builder{f.b, f.b, New(f.paths.CacheDir)} {
		f.b = b // the last build runs in a new process
		st := f.build(t, time.Minute)
		if st.State != "failed" || !reflect.DeepEqual(st.Errors, want) || strings.Contains(st.Log, "Nothing to do") {
			t.Fatalf("build %d: state %q, errors %+v, want %+v\n%s", i+1, st.State, st.Errors, want, st.Log)
		}
	}

	if err := os.WriteFile(filepath.Join(f.root, "main.tex"), []byte(doc("Fixed.")), 0o644); err != nil {
		t.Fatal(err)
	}
	if st := f.build(t, time.Minute); st.State != "succeeded" {
		t.Fatalf("after the fix: state %q\n%s", st.State, st.Log)
	}
	// An unchanged rebuild after a success stays as quick as before.
	if st := f.build(t, time.Minute); st.State != "succeeded" || !strings.Contains(st.Log, "Nothing to do") {
		t.Errorf("unchanged rebuild after a success: state %q, ran the engine again\n%s", st.State, st.Log)
	}
}

// A comment's margin note in a figure stops pdflatex; biber can then meet a
// malformed .bcf and delete the .bbl. Recent latexmk renames a .bcf that
// lacks its last line itself, so the test breaks one the way an interrupted
// run of an older TeX left it, and marks the output as a release that never
// cleaned it would have.
func TestRecoveryAfterABiberFailure(t *testing.T) {
	t.Parallel()
	if FindTool("biber") == "" {
		t.Skip("biber is not installed")
	}
	paper := func(figure string) string {
		return "\\documentclass{article}\n\\usepackage{changes}\n\\usepackage[backend=biber]{biblatex}\n" +
			"\\addbibresource{refs.bib}\n\\definechangesauthor{GH}\n\\begin{document}\n" +
			"\\begin{figure}" + figure + "\\caption{A figure.}\\end{figure}\n" +
			"See \\cite{key}.\n\\printbibliography\n\\end{document}\n"
	}
	f := newFixture(t, map[string]string{
		"main.tex": paper("word"),
		"refs.bib": "@book{key, author={A. Author}, title={A Title}, year={2000}, publisher={P}}\n",
	})
	write := func(text string) {
		if err := os.WriteFile(filepath.Join(f.root, "main.tex"), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if st := f.build(t, 2*time.Minute); st.State != "succeeded" {
		t.Fatalf("first build: state %q\n%s", st.State, st.Log)
	}

	write(paper("\\highlight[id=GH, comment={A comment}]{word}"))
	want := []Error{{Path: "main.tex", Line: 10, Message: "LaTeX Error: Float(s) lost."}}
	if st := f.build(t, 2*time.Minute); st.State != "failed" || !reflect.DeepEqual(st.Errors, want) {
		t.Fatalf("comment in a figure: state %q, errors %+v\n%s", st.State, st.Errors, st.Log)
	}

	out := f.b.dir(testID, "out")
	bcf := filepath.Join(out, "main.bcf")
	data, err := os.ReadFile(bcf)
	if err != nil {
		t.Fatal(err)
	}
	broken := strings.Replace(string(data), "<bcf:bibdata section=\"0\">", "<bcf:bibdata section=\"0\"", 1)
	if err := os.WriteFile(bcf, []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	os.Remove(filepath.Join(out, "main.bbl"))
	if err := os.WriteFile(filepath.Join(out, okMarker), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if st := f.build(t, 2*time.Minute); st.State != "failed" || !strings.Contains(st.Log, "malformed") {
		t.Fatalf("biber did not fail on the malformed .bcf: state %q\n%s", st.State, st.Log)
	}

	for i := range 2 {
		if st := f.build(t, 2*time.Minute); st.State != "failed" || !reflect.DeepEqual(st.Errors, want) {
			t.Fatalf("unchanged rebuild %d after the biber failure: state %q, errors %+v\n%s", i+1, st.State, st.Errors, st.Log)
		}
	}

	write(paper("word"))
	st := f.build(t, 2*time.Minute)
	if st.State != "succeeded" {
		t.Fatalf("after the fix: state %q\n%s", st.State, st.Log)
	}
	// The .log holds the last pass of the engine only.
	if last, err := os.ReadFile(filepath.Join(out, "main.log")); err != nil || strings.Contains(string(last), "Citation 'key'") {
		t.Errorf("the citation does not resolve after the fix (%v)\n%s", err, st.Log)
	}
}

// With -outdir, TeX writes sub/chapter.aux into the output directory, which
// must therefore mirror the source directories.
func TestIncludeFromASubdirectoryBuilds(t *testing.T) {
	t.Parallel()
	f := newFixture(t, map[string]string{
		"main.tex":              doc("\\include{chapters/deep/one}"),
		"chapters/deep/one.tex": "Chapter one.\n",
	})
	if st := f.build(t, time.Minute); st.State != "succeeded" {
		t.Fatalf("state %q\n%s", st.State, st.Log)
	}
}

func TestShellEscapeAndLatexmkrcAreOff(t *testing.T) {
	t.Parallel()
	rc := "open(my $f, '>', 'rc-ran'); close($f);\n"
	f := newFixture(t, map[string]string{
		// \pdfshellescape is 0 only when shell escape is fully disabled; the
		// TeX Live default is 2 (restricted).
		"main.tex":   doc("\\typeout{SHELL-ESCAPE-IS-\\the\\pdfshellescape.}\n\\immediate\\write18{kpsewhich article.cls > escaped}\nx"),
		"latexmkrc":  rc,
		".latexmkrc": rc,
	})
	st := f.build(t, time.Minute)
	if st.State != "succeeded" {
		t.Fatalf("state %q\n%s", st.State, st.Log)
	}
	if !strings.Contains(st.Log, "SHELL-ESCAPE-IS-0.") {
		t.Errorf("shell escape is not disabled:\n%s", st.Log)
	}
	for _, marker := range []string{"rc-ran", "escaped"} {
		if _, err := os.Stat(filepath.Join(f.root, marker)); err == nil {
			t.Errorf("%s exists: code from the repository ran", marker)
		}
	}
}

func TestLogKeepsTheLastMebibyte(t *testing.T) {
	t.Parallel()
	f := newFixture(t, map[string]string{"main.tex": doc(
		"\\count255=0 \\loop\\ifnum\\count255<30000 \\advance\\count255 by 1 " +
			"\\typeout{row \\the\\count255\\space " + strings.Repeat("x", 60) + "}\\repeat\n\\typeout{LAST-MARKER}\nx")})

	st := f.build(t, time.Minute)
	if st.State != "succeeded" {
		t.Fatalf("state %q", st.State)
	}
	if len(st.Log) > 1<<20 || len(st.Log) < 1<<19 {
		t.Errorf("log holds %d bytes, want the last 1 MiB of about 2 MiB", len(st.Log))
	}
	if !strings.Contains(st.Log, "LAST-MARKER") || strings.Contains(st.Log, "row 1 x") {
		t.Error("the log does not hold the end of the output, or still holds its start")
	}
}

func TestEngineComesFromTheProject(t *testing.T) {
	t.Parallel()
	if FindTool("xelatex") == "" {
		t.Skip("xelatex is not installed")
	}
	f := newFixture(t, map[string]string{
		"main.tex":        doc("\\typeout{ENGINE-\\ifdefined\\XeTeXversion XETEX\\else OTHER\\fi.}x"),
		".revisions.toml": "engine = \"xelatex\"\n",
	})
	if st := f.build(t, time.Minute); st.State != "succeeded" || !strings.Contains(st.Log, "ENGINE-XETEX.") {
		t.Fatalf("state %q; the document was not built with XeLaTeX\n%s", st.State, st.Log)
	}
}

func TestStartWhileRunningReturnsTheRunningBuild(t *testing.T) {
	t.Parallel()
	f := newFixture(t, map[string]string{"main.tex": doc("\\def\\x{\\x}\\x")})
	proj := f.project(t)

	first := f.b.Start(testID, f.root, proj, f.latexmk, time.Minute)
	second := f.b.Start(testID, f.root, proj, f.latexmk, time.Minute)
	if first.State != "running" || second.State != "running" || !second.StartedAt.Equal(*first.StartedAt) {
		t.Errorf("first %+v, second %+v; want the same running build", first, second)
	}

	if st := f.b.Cancel(testID, proj.Fingerprint()); st.State != "canceled" || st.FinishedAt == nil {
		t.Errorf("after Cancel: %+v", st)
	}
	// Canceling with nothing running changes nothing.
	if st := f.b.Cancel(testID, proj.Fingerprint()); st.State != "canceled" {
		t.Errorf("after a second Cancel: %+v", st)
	}
}
