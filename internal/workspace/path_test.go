package workspace

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// writeTree creates files under root; keys are slash paths.
func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func symlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("cannot create symbolic links here: %v", err)
	}
}

func TestResolveAcceptsRegularFilesInsideTheRoot(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{"main.tex": "x", "sections/deep/methods.tex": "y", "notes..txt": "z"})

	for _, rel := range []string{"main.tex", "sections/deep/methods.tex", "notes..txt"} {
		got, err := Resolve(root, rel)
		if err != nil || got != filepath.Join(root, filepath.FromSlash(rel)) {
			t.Errorf("Resolve(%q) = %q, %v", rel, got, err)
		}
	}
}

// Scenario: Escaping path.
func TestResolveRejectsPathsThatLeaveTheRoot(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "repo")
	writeTree(t, parent, map[string]string{"secret.txt": "s", "repo/main.tex": "x", "repo/sections/methods.tex": "y"})

	for _, rel := range []string{
		"../secret.txt",
		"sections/../../secret.txt",
		"sections/../main.tex", // ".." is refused even when it stays inside
		"..",
		".",
		"",
		"./main.tex",
		"sections//methods.tex",
		"sections/",
		"sections", // a directory is not a file
		"/etc/passwd",
		filepath.Join(parent, "secret.txt"),
		`..\secret.txt`,
		`sections\methods.tex`,
		"C:/Windows/win.ini",
		"C:main.tex",
		"main.tex:stream",
		"main.tex\x00.png",
	} {
		if got, err := Resolve(root, rel); !errors.Is(err, ErrBadPath) {
			t.Errorf("Resolve(%q) = %q, %v; want ErrBadPath", rel, got, err)
		}
	}
}

func TestResolveReportsMissingFiles(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{"main.tex": "x"})
	for _, rel := range []string{"absent.tex", "absent/main.tex", "main.tex/child"} {
		if got, err := Resolve(root, rel); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("Resolve(%q) = %q, %v; want a not-exist error", rel, got, err)
		}
	}
}

// Scenario: Symlink.
func TestResolveRefusesSymbolicLinks(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "repo")
	writeTree(t, parent, map[string]string{
		"outside/secret.txt":  "s",
		"repo/main.tex":       "x",
		"repo/real/inner.tex": "y",
	})
	symlink(t, filepath.Join(parent, "outside", "secret.txt"), filepath.Join(root, "link-out.txt"))
	symlink(t, "main.tex", filepath.Join(root, "link-in.tex")) // refused even though it stays inside
	symlink(t, filepath.Join(parent, "outside"), filepath.Join(root, "dir-out"))
	symlink(t, "real", filepath.Join(root, "dir-in"))

	for _, rel := range []string{"link-out.txt", "link-in.tex", "dir-out/secret.txt", "dir-in/inner.tex"} {
		if got, err := Resolve(root, rel); !errors.Is(err, ErrBadPath) {
			t.Errorf("Resolve(%q) = %q, %v; want ErrBadPath", rel, got, err)
		}
	}
}

// Writing under .git (hooks, config) would be code execution.
func TestResolveRefusesTheGitDirectory(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{
		".git/config":           "c",
		".git/hooks/pre-commit": "h",
		"sub/.git/config":       "c",
		"sub/.GIT/config":       "c",
		".gitignore":            "ok",
		".github/workflow.yml":  "ok",
	})
	for _, rel := range []string{".git/config", ".git/hooks/pre-commit", ".GIT/config", ".Git/hooks/pre-commit", "sub/.git/config", "sub/.GIT/config"} {
		if got, err := Resolve(root, rel); !errors.Is(err, ErrBadPath) {
			t.Errorf("Resolve(%q) = %q, %v; want ErrBadPath", rel, got, err)
		}
	}
	for _, rel := range []string{".gitignore", ".github/workflow.yml"} {
		if _, err := Resolve(root, rel); err != nil {
			t.Errorf("Resolve(%q): %v", rel, err)
		}
	}
}

// In a worktree or submodule .git is a file; it is refused as well.
func TestResolveRefusesAGitFile(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{".git": "gitdir: elsewhere"})
	if got, err := Resolve(root, ".git"); !errors.Is(err, ErrBadPath) {
		t.Errorf("Resolve(.git) = %q, %v; want ErrBadPath", got, err)
	}
}
