package server

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ryan-ressmeyer/revisions/internal/host/githubfake"
)

type repoBody struct {
	ID, Path, Head, Origin string
	Branch                 *string
	Linked                 bool
}

// cloneURL is how the fake GitHub's owner/name is spelled in a remote.
func (h *hosted) cloneURL() string {
	return githubfake.FileURL(filepath.Dir(filepath.Dir(h.bare))) + "/owner/name.git"
}

// ownCopy is a clone of owner/name that the user keeps outside the Revisions
// folder, with origin set to the given URL.
func (h *hosted) ownCopy(t *testing.T, origin string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "papers", "name")
	gitIn(t, "", "clone", "--quiet", h.bare, dir)
	gitIn(t, dir, "remote", "set-url", "origin", origin)
	return dir
}

func (h *hosted) link(t *testing.T, path string) string {
	t.Helper()
	return ok[struct{ Repo string }](t, h.call(t, "POST", "/api/link", map[string]string{"path": path})).Repo
}

// Scenario: Link a folder.
func TestLinkAFolder(t *testing.T) {
	h := newHosted(t) // signed out: linking reads only the folder
	dir := h.ownCopy(t, h.cloneURL())

	// A folder inside the repository links the whole repository.
	if repo := h.link(t, filepath.Join(dir, "sections")); repo != "github.com/owner/name" {
		t.Fatalf("linked %q", repo)
	}
	real, _ := filepath.EvalSymlinks(dir)
	repos := ok[[]repoBody](t, h.call(t, "GET", "/api/repos", nil))
	if len(repos) != 1 || repos[0].ID != "github.com/owner/name" || repos[0].Path != real || repos[0].Branch == nil {
		t.Fatalf("repos %+v, want owner/name at %s", repos, real)
	}

	// The project and saves work on the folder itself.
	file := h.call(t, "GET", testRepo+"/file?path=main.tex", nil)
	saved := h.call(t, "PUT", testRepo+"/file?path=main.tex", map[string]string{
		"baseHash": file.Header().Get("X-Revisions-Hash"), "text": "edited\n"})
	if saved.Code != 200 {
		t.Fatalf("save: %d %s", saved.Code, saved.Body)
	}
	if disk, _ := os.ReadFile(filepath.Join(dir, "main.tex")); string(disk) != "edited\n" {
		t.Fatalf("main.tex holds %q", disk)
	}
	gitIn(t, dir, "commit", "--quiet", "-am", "Edit")

	// Opening a link to the repository uses the folder, not a new clone.
	t.Setenv("REVISIONS_GITHUB_TOKEN", githubfake.Token)
	h.open(t, repoURL)
	if _, err := os.Stat(h.clone); !os.IsNotExist(err) {
		t.Fatalf("open cloned into %s: %v", h.clone, err)
	}
	if got := gitIn(t, dir, "rev-parse", "--abbrev-ref", "HEAD"); got != "main" {
		t.Fatalf("folder on %q", got)
	}
}

// Scenario: Folder with an SSH remote.
func TestLinkedSSHRemoteUsesTheSignedInAccount(t *testing.T) {
	h := newSignedIn(t)
	t.Setenv("GIT_SSH_COMMAND", "false") // any attempt to use SSH fails
	dir := h.ownCopy(t, "git@github.com:owner/name.git")
	h.link(t, dir)

	author := h.authorClone(t)
	sha := authorCommit(t, author, "main.tex", "news\n")
	if rec := h.call(t, "POST", testRepo+"/git/fetch", nil); rec.Code != 200 {
		t.Fatalf("fetch: %d %s", rec.Code, rec.Body)
	}
	if got := gitIn(t, dir, "rev-parse", "origin/main"); got != sha {
		t.Fatalf("origin/main at %s, want %s", got, sha)
	}
	if got := gitIn(t, dir, "config", "--get-all", "remote.origin.url"); got != "git@github.com:owner/name.git" {
		t.Fatalf("origin changed to %q", got)
	}
}

// Scenario: Folder not set up correctly.
func TestLinkRefusesAFolderNotSetUp(t *testing.T) {
	h := newHosted(t)
	plain := t.TempDir()
	noRemote := t.TempDir()
	gitIn(t, noRemote, "init", "--quiet")
	elsewhere := h.ownCopy(t, "https://gitlab.com/owner/name.git")
	for name, path := range map[string]string{
		"plain folder": plain, "no origin": noRemote, "origin not on GitHub": elsewhere,
		"missing folder": filepath.Join(plain, "absent"),
	} {
		rec := h.call(t, "POST", "/api/link", map[string]string{"path": path})
		if rec.Code != 422 {
			t.Errorf("%s: got %d %s", name, rec.Code, rec.Body)
			continue
		}
		wantError(t, rec, 422, "bad_repo")
	}
	wantError(t, h.call(t, "POST", "/api/link", map[string]string{"path": ""}), 400, "bad_request")
	wantError(t, h.call(t, "POST", "/api/link", map[string]string{"path": "papers/name"}), 400, "bad_request")
	if repos := ok[[]repoBody](t, h.call(t, "GET", "/api/repos", nil)); len(repos) != 0 {
		t.Fatalf("repos %+v", repos)
	}
}

// Scenario: Repository already on this computer.
func TestLinkRefusesARepositoryAlreadyHere(t *testing.T) {
	h := newSignedIn(t)
	h.open(t, repoURL)
	wantError(t, h.call(t, "POST", "/api/link", map[string]string{"path": h.ownCopy(t, h.cloneURL())}), 409, "repo_exists")

	// Linking the same folder again is not a conflict.
	h2 := newHosted(t)
	dir := h2.ownCopy(t, h2.cloneURL())
	h2.link(t, dir)
	h2.link(t, dir)
	wantError(t, h2.call(t, "POST", "/api/link", map[string]string{"path": h2.ownCopy(t, h2.cloneURL())}), 409, "repo_exists")
}
