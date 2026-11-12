package gitx

import (
	"encoding/base64"
	"errors"
	"io/fs"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// isolate keeps the developer's Git configuration out of the test.
func isolate(t *testing.T) {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(t.TempDir(), "gitconfig"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
}

func must(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := git(t.Context(), dir, args...)
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return strings.TrimSpace(out)
}

// The token reaches the server as a header on network commands and is found
// nowhere else: not in the clone, not in an error.
func TestTokenTravelsOnlyInTheHeader(t *testing.T) {
	isolate(t)
	ctx := t.Context()
	backend := filepath.Join(must(t, "", "--exec-path"), "git-http-backend")
	if runtime.GOOS == "windows" {
		backend += ".exe"
	}
	if _, err := os.Stat(backend); err != nil {
		t.Skip("git-http-backend is not installed")
	}

	// A bare repository with one commit, served over smart HTTP only to
	// requests that carry the token.
	root := t.TempDir()
	bare := filepath.Join(root, "owner", "name.git")
	must(t, "", "init", "--bare", "-b", "main", bare)
	must(t, bare, "config", "http.receivepack", "true")
	seed := t.TempDir()
	must(t, "", "init", "-b", "main", seed)
	os.WriteFile(filepath.Join(seed, "main.tex"), []byte("one\n"), 0o644)
	must(t, seed, "add", "-A")
	must(t, seed, "-c", "user.name=Author", "-c", "user.email=author@example.com", "commit", "-m", "first")
	must(t, seed, "push", bare, "main")

	const token = "gho_SECRETTOKENVALUE"
	credential := "Basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:"+token))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != credential {
			w.Header().Set("WWW-Authenticate", `Basic realm="test"`)
			http.Error(w, "sign in", http.StatusUnauthorized)
			return
		}
		(&cgi.Handler{Path: backend, Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1"}}).ServeHTTP(w, r)
	}))
	defer srv.Close()
	auth := Auth{BaseURL: srv.URL + "/", Header: "Authorization: " + credential}
	leaks := func(s string) bool {
		return strings.Contains(s, token) || strings.Contains(s, strings.TrimPrefix(credential, "Basic "))
	}

	clone := filepath.Join(t.TempDir(), "clone")
	if err := Clone(ctx, auth, srv.URL+"/owner/name.git", clone); err != nil {
		t.Fatalf("clone with the token: %v", err)
	}
	filepath.WalkDir(filepath.Join(clone, ".git"), func(path string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			if data, _ := os.ReadFile(path); leaks(string(data)) {
				t.Errorf("%s holds the token", path)
			}
		}
		return nil
	})

	// Fetch and push authenticate the same way.
	if err := Fetch(ctx, clone, auth); err != nil {
		t.Fatalf("fetch with the token: %v", err)
	}
	os.WriteFile(filepath.Join(clone, "main.tex"), []byte("two\n"), 0o644)
	if err := Commit(ctx, clone, "second", Identity{Name: "Gale", Email: "gale@example.com"}); err != nil {
		t.Fatal(err)
	}
	if err := Push(ctx, clone, auth, "main", nil); err != nil {
		t.Fatalf("push with the token: %v", err)
	}
	if got, want := must(t, bare, "rev-parse", "main"), must(t, clone, "rev-parse", "HEAD"); got != want {
		t.Fatalf("remote main = %s, want %s", got, want)
	}

	// Without the token Git fails instead of prompting.
	if err := Fetch(ctx, clone, Auth{}); err == nil {
		t.Fatal("fetch without the token succeeded")
	}
	// The header is scoped to its base URL: a token for another host is not sent here.
	if err := Fetch(ctx, clone, Auth{BaseURL: "https://github.com/", Header: auth.Header}); err == nil {
		t.Fatal("a token scoped to another host was sent to this one")
	}
	// A failed network command does not put the token in its error.
	err := Clone(ctx, auth, srv.URL+"/owner/missing.git", filepath.Join(t.TempDir(), "missing"))
	if err == nil || leaks(err.Error()) {
		t.Fatalf("clone of a missing repository: %v", err)
	}
}

func TestMissingGit(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if _, err := Version(t.Context()); !errors.Is(err, ErrMissing) {
		t.Fatalf("got %v, want ErrMissing", err)
	}
}
