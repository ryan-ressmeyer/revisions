package workspace

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

var testID = RepoID{Host: "github.com", Owner: "owner", Name: "paper"}

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"}, args...)...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// newRepo makes a committed clone of the fixture manuscript, plus any extra
// files, under temporary REVISIONS_* roots.
func newRepo(t *testing.T, extra map[string]string) (Paths, string) {
	t.Helper()
	paths := Paths{Home: t.TempDir(), ConfigDir: t.TempDir(), CacheDir: t.TempDir()}
	root := paths.CloneDir(testID)
	if err := os.CopyFS(root, os.DirFS(filepath.Join("..", "..", "testdata", "manuscript"))); err != nil {
		t.Fatal(err)
	}
	writeTree(t, root, extra)
	gitIn(t, root, "init", "-q", "-b", "main")
	gitIn(t, root, "add", "-A")
	gitIn(t, root, "commit", "-q", "-m", "fixture")
	return paths, root
}

func load(t *testing.T, paths Paths) Project {
	t.Helper()
	p, err := paths.LoadProject(testID)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestProjectListsTrackedAndUntrackedFilesWithKinds(t *testing.T) {
	paths, root := newRepo(t, map[string]string{
		".gitignore": "*.aux\nbuild/\n",
		"Makefile":   "all:\n",
		"huge.tex":   strings.Repeat("x", 2<<20+1),
	})
	writeTree(t, root, map[string]string{
		"draft.tex":      "untracked",
		"main.aux":       "ignored",
		"build/main.pdf": "ignored",
	})
	os.Remove(filepath.Join(root, "supplement.tex")) // tracked but deleted
	symlink(t, "main.tex", filepath.Join(root, "alias.tex"))

	got := map[string]File{}
	var order []string
	for _, f := range load(t, paths).Files {
		got[f.Path] = File{Path: f.Path, Kind: f.Kind, Size: f.Size}
		order = append(order, f.Path)
	}
	png, _ := os.Stat(filepath.Join(root, "figures", "trace.png"))
	want := map[string]File{
		".gitignore":           {".gitignore", "text", 13, time.Time{}},
		"Makefile":             {"Makefile", "other", 5, time.Time{}},
		"draft.tex":            {"draft.tex", "text", 9, time.Time{}},
		"figures/trace.png":    {"figures/trace.png", "image", png.Size(), time.Time{}},
		"huge.tex":             {"huge.tex", "other", 2<<20 + 1, time.Time{}}, // over 2 MiB
		"main.tex":             got["main.tex"],
		"refs.bib":             got["refs.bib"],
		"sections/methods.tex": got["sections/methods.tex"],
		"stats.tex":            got["stats.tex"],
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("files:\n got %v\nwant %v", got, want)
	}
	for _, p := range []string{"main.tex", "refs.bib", "sections/methods.tex", "stats.tex"} {
		if got[p].Kind != "text" || got[p].Size == 0 {
			t.Errorf("%s = %+v, want a text file", p, got[p])
		}
	}
	if !sortedStrings(order) {
		t.Errorf("files are not sorted by path: %v", order)
	}
}

func sortedStrings(s []string) bool {
	for i := 1; i < len(s); i++ {
		if s[i-1] >= s[i] {
			return false
		}
	}
	return true
}

// Scenario: Several candidates.
func TestEntryIsTheFirstFileWithDocumentclass(t *testing.T) {
	paths, root := newRepo(t, map[string]string{
		"aaa-commented.tex": "% \\documentclass{article}\n  %\\documentclass{book}\n",
		"aab-notes.tex":     "Uses the \\emph{article} class.\n",
		"zeta/later.tex":    "100\\% sure\r\\documentclass{book}\r",
	})
	writeTree(t, root, map[string]string{"aaa-untracked.tex": "\\documentclass{article}\n"})

	p := load(t, paths)
	if p.Entry != "main.tex" || p.EntryFromConfig || p.Engine != "pdflatex" {
		t.Errorf("entry=%q fromConfig=%v engine=%q", p.Entry, p.EntryFromConfig, p.Engine)
	}
	if want := []string{"main.tex", "supplement.tex", "zeta/later.tex"}; !reflect.DeepEqual(p.EntryCandidates, want) {
		t.Errorf("candidates = %v, want %v", p.EntryCandidates, want)
	}
}

func TestProjectWithoutAnyDocumentHasNoEntry(t *testing.T) {
	paths, root := newRepo(t, nil)
	gitIn(t, root, "rm", "-q", "main.tex", "supplement.tex")
	p := load(t, paths)
	if p.Entry != "" || p.EntryCandidates == nil || len(p.EntryCandidates) != 0 {
		t.Errorf("entry=%q candidates=%#v, want none and an empty list", p.Entry, p.EntryCandidates)
	}
}

// Scenario: Config override.
func TestConfigNamesEntryAndEngine(t *testing.T) {
	paths, _ := newRepo(t, map[string]string{".revisions.toml": `# Revisions settings
entry = "supplement.tex"   # not the first candidate
engine = 'xelatex'

[other]
entry = "main.tex"
`})
	p := load(t, paths)
	if p.Entry != "supplement.tex" || !p.EntryFromConfig || p.Engine != "xelatex" {
		t.Errorf("entry=%q fromConfig=%v engine=%q", p.Entry, p.EntryFromConfig, p.Engine)
	}
}

func TestConfigEngine(t *testing.T) {
	for config, want := range map[string]string{
		`engine = "lualatex"`:  "lualatex",
		`engine="xelatex"`:     "xelatex",
		`engine = "pdflatex"`:  "pdflatex",
		`engine = "sh -c x"`:   "pdflatex",
		`engine = xelatex`:     "pdflatex", // not a TOML string
		`# engine = "xelatex"`: "pdflatex",
	} {
		paths, _ := newRepo(t, map[string]string{".revisions.toml": config + "\n"})
		if p := load(t, paths); p.Engine != want || p.EntryFromConfig || p.Entry != "main.tex" {
			t.Errorf("%s: engine=%q entry=%q fromConfig=%v, want %q", config, p.Engine, p.Entry, p.EntryFromConfig, want)
		}
	}
}

// A config entry that cannot be used is reported as no entry rather than
// silently building some other document.
func TestConfigEntryThatCannotBeUsed(t *testing.T) {
	for _, entry := range []string{"absent.tex", "../outside.tex", "sections"} {
		paths, _ := newRepo(t, map[string]string{".revisions.toml": `entry = "` + entry + `"` + "\n"})
		if p := load(t, paths); p.Entry != "" || !p.EntryFromConfig {
			t.Errorf("%s: entry=%q fromConfig=%v, want no entry from config", entry, p.Entry, p.EntryFromConfig)
		}
	}
}

func TestChosenEntryIsLocalState(t *testing.T) {
	paths, root := newRepo(t, nil)

	if err := paths.SetEntry(testID, "supplement.tex"); err != nil {
		t.Fatal(err)
	}
	if p := load(t, paths); p.Entry != "supplement.tex" || p.EntryFromConfig {
		t.Errorf("entry=%q fromConfig=%v after choosing supplement.tex", p.Entry, p.EntryFromConfig)
	}
	if status := gitIn(t, root, "status", "--porcelain", "--ignored"); status != "" {
		t.Errorf("choosing an entry changed the repository:\n%s", status)
	}

	for _, bad := range []string{"sections/methods.tex", "absent.tex", "../x.tex", ""} {
		if err := paths.SetEntry(testID, bad); !errors.Is(err, ErrBadEntry) {
			t.Errorf("SetEntry(%q) = %v, want ErrBadEntry", bad, err)
		}
	}
	if p := load(t, paths); p.Entry != "supplement.tex" {
		t.Errorf("a refused choice replaced the entry with %q", p.Entry)
	}

	// The choice stops applying when the file is no longer a candidate.
	gitIn(t, root, "rm", "-q", "supplement.tex")
	if p := load(t, paths); p.Entry != "main.tex" {
		t.Errorf("entry=%q after the chosen file was removed, want main.tex", p.Entry)
	}
}

func TestFingerprintFollowsTheWorkingTree(t *testing.T) {
	paths, root := newRepo(t, map[string]string{".gitignore": "*.aux\n"})
	fp := func() string { return load(t, paths).Fingerprint() }
	base := fp()
	if base == "" || fp() != base {
		t.Fatal("the fingerprint of an unchanged tree is not stable")
	}

	writeTree(t, root, map[string]string{"main.aux": "ignored"})
	if fp() != base {
		t.Error("an ignored file changed the fingerprint")
	}

	step := func(name string, change func()) {
		before := fp()
		change()
		if fp() == before {
			t.Errorf("%s did not change the fingerprint", name)
		}
	}
	methods := filepath.Join(root, "sections", "methods.tex")
	step("an edit", func() {
		data, _ := os.ReadFile(methods)
		os.WriteFile(methods, append(data, "More.\n"...), 0o644)
	})
	step("a same-size edit at a later time", func() {
		data, _ := os.ReadFile(methods)
		data[0] ^= 1
		os.WriteFile(methods, data, 0o644)
		os.Chtimes(methods, time.Time{}, time.Now().Add(time.Hour))
	})
	step("a new untracked file", func() { writeTree(t, root, map[string]string{"new.tex": "x"}) })
	step("a deleted file", func() { os.Remove(filepath.Join(root, "refs.bib")) })
	step("another entry file", func() { paths.SetEntry(testID, "supplement.tex") })
}

func TestGitStatus(t *testing.T) {
	_, root := newRepo(t, nil)
	head := gitIn(t, root, "rev-parse", "HEAD")

	st, err := GitStatus(root)
	if err != nil {
		t.Fatal(err)
	}
	if st.Head != head || st.Branch == nil || *st.Branch != "main" || st.Dirty {
		t.Errorf("clean clone: %+v", st)
	}

	writeTree(t, root, map[string]string{"untracked.tex": "x"})
	if st, _ := GitStatus(root); !st.Dirty {
		t.Error("an untracked file did not make the clone dirty")
	}
	os.Remove(filepath.Join(root, "untracked.tex"))
	writeTree(t, root, map[string]string{"main.tex": "edited"})
	if st, _ := GitStatus(root); !st.Dirty {
		t.Error("an edit did not make the clone dirty")
	}

	gitIn(t, root, "checkout", "-q", "--detach", "--force", "HEAD")
	if st, _ := GitStatus(root); st.Branch != nil || st.Head != head || st.Dirty {
		t.Errorf("detached clone: %+v", st)
	}
}
