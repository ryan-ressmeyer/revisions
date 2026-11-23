package server

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ryan-ressmeyer/revisions/internal/gitx"
)

type removeBody struct {
	Path        string
	Linked      bool
	Files       []gitx.FileStatus
	Commits     []gitx.LogCommit
	Fingerprint string
}

func (h *hosted) previewRemove(t *testing.T) removeBody {
	t.Helper()
	return ok[removeBody](t, h.call(t, "GET", testRepo+"/remove/preview", nil))
}

func (h *hosted) remove(t *testing.T, fingerprint string) int {
	t.Helper()
	return h.call(t, "POST", testRepo+"/remove", map[string]string{"fingerprint": fingerprint}).Code
}

// Scenario: Show in folder and copy path.
func TestShowInFolder(t *testing.T) {
	h := newSignedIn(t)
	h.open(t, repoURL)
	var opened []string
	h.git.reveal = func(target string) error { opened = append(opened, target); return nil }
	if rec := h.call(t, "POST", testRepo+"/reveal", nil); rec.Code != 204 {
		t.Fatalf("reveal: %d %s", rec.Code, rec.Body)
	}
	if len(opened) != 1 || opened[0] != h.clone {
		t.Fatalf("opened %v, want %s", opened, h.clone)
	}
}

// Scenarios: Remove a copy; Remove a copy with work not on GitHub.
func TestRemoveACopy(t *testing.T) {
	h := newSignedIn(t)
	h.open(t, repoURL)
	repos := ok[[]repoBody](t, h.call(t, "GET", "/api/repos", nil))
	if len(repos) != 1 || repos[0].Linked || repos[0].Origin != gitIn(t, h.clone, "config", "--get", "remote.origin.url") {
		t.Fatalf("repos %+v", repos)
	}

	clean := h.previewRemove(t)
	if clean.Path != h.clone || clean.Linked || len(clean.Files) != 0 || len(clean.Commits) != 0 || clean.Fingerprint == "" {
		t.Fatalf("clean preview %+v", clean)
	}

	// A commit on a branch never sent, and an edit never committed.
	gitIn(t, h.clone, "switch", "--quiet", "-c", "draft")
	os.WriteFile(filepath.Join(h.clone, "notes.tex"), []byte("draft\n"), 0o644)
	gitIn(t, h.clone, "add", "notes.tex")
	gitIn(t, h.clone, "commit", "--quiet", "-m", "Draft notes")
	gitIn(t, h.clone, "switch", "--quiet", "main")
	os.WriteFile(filepath.Join(h.clone, "main.tex"), []byte("edited\n"), 0o644)

	p := h.previewRemove(t)
	if len(p.Files) != 1 || p.Files[0].Path != "main.tex" || len(p.Commits) != 1 || p.Commits[0].Subject != "Draft notes" {
		t.Fatalf("preview %+v", p)
	}
	if code := h.remove(t, clean.Fingerprint); code != 409 {
		t.Fatalf("stale fingerprint: %d", code)
	}
	wantError(t, h.call(t, "POST", testRepo+"/remove", map[string]string{}), 400, "bad_request")
	if _, err := os.Stat(filepath.Join(h.clone, "main.tex")); err != nil {
		t.Fatalf("a refused removal deleted the clone: %v", err)
	}

	if code := h.remove(t, p.Fingerprint); code != 204 {
		t.Fatalf("remove: %d", code)
	}
	if _, err := os.Stat(h.clone); !os.IsNotExist(err) {
		t.Fatalf("clone still there: %v", err)
	}
	if repos := ok[[]repoBody](t, h.call(t, "GET", "/api/repos", nil)); len(repos) != 0 {
		t.Fatalf("repos %+v", repos)
	}
}

// Scenario: Unlink a folder.
func TestUnlinkAFolder(t *testing.T) {
	h := newHosted(t)
	dir := h.ownCopy(t, "git@github.com:owner/name.git")
	h.link(t, dir)
	repos := ok[[]repoBody](t, h.call(t, "GET", "/api/repos", nil))
	if len(repos) != 1 || !repos[0].Linked || repos[0].Origin != "git@github.com:owner/name.git" {
		t.Fatalf("repos %+v", repos)
	}
	os.WriteFile(filepath.Join(dir, "main.tex"), []byte("kept\n"), 0o644)

	p := h.previewRemove(t)
	real, _ := filepath.EvalSymlinks(dir)
	if !p.Linked || p.Path != real || len(p.Files) != 0 || len(p.Commits) != 0 {
		t.Fatalf("preview %+v", p)
	}
	if code := h.remove(t, p.Fingerprint); code != 204 {
		t.Fatalf("unlink: %d", code)
	}
	if disk, err := os.ReadFile(filepath.Join(dir, "main.tex")); err != nil || string(disk) != "kept\n" {
		t.Fatalf("folder changed: %q %v", disk, err)
	}
	if repos := ok[[]repoBody](t, h.call(t, "GET", "/api/repos", nil)); len(repos) != 0 {
		t.Fatalf("repos %+v", repos)
	}
}

// Revisions deletes only inside its own folder, never through a link.
func TestRemoveRefusesAFolderReachedThroughALink(t *testing.T) {
	h := newHosted(t)
	elsewhere := filepath.Join(t.TempDir(), "owner")
	gitIn(t, "", "clone", "--quiet", h.bare, filepath.Join(elsewhere, "name"))
	os.MkdirAll(filepath.Dir(filepath.Dir(h.clone)), 0o755)
	if err := os.Symlink(elsewhere, filepath.Dir(h.clone)); err != nil {
		t.Skip("no symbolic links here:", err)
	}
	wantError(t, h.call(t, "GET", testRepo+"/remove/preview", nil), 409, "not_removable")
	wantError(t, h.call(t, "POST", testRepo+"/remove", map[string]string{"fingerprint": "x"}), 409, "not_removable")
	if _, err := os.Stat(filepath.Join(elsewhere, "name", "main.tex")); err != nil {
		t.Fatalf("deleted through the link: %v", err)
	}
}
