package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"testing"
	"testing/fstest"
	"time"

	"github.com/ryan-ressmeyer/revisions/internal/server"
	"github.com/ryan-ressmeyer/revisions/internal/workspace"
)

// exe is the executable suffix on this platform.
var exe = map[bool]string{true: ".exe"}[runtime.GOOS == "windows"]

func TestIsRevisionsRecognizesARunningInstance(t *testing.T) {
	ts := httptest.NewUnstartedServer(nil)
	port := ts.Listener.Addr().(*net.TCPAddr).Port
	ts.Config.Handler = server.New(workspace.Paths{}, "test", port, fstest.MapFS{})
	ts.Start()
	defer ts.Close()

	if !isRevisions(ts.URL) {
		t.Fatal("a running Revisions instance was not recognized")
	}
}

func TestIsRevisionsRejectsOtherPrograms(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"app":"something-else"}`))
	}))
	defer other.Close()
	if isRevisions(other.URL) {
		t.Fatal("another program on the port was taken for Revisions")
	}

	closed := httptest.NewServer(nil)
	closed.Close()
	if isRevisions(closed.URL) {
		t.Fatal("a closed port was taken for Revisions")
	}
}

// buildRevisions compiles this command into dir with its version stamped the
// way the release build stamps it, and returns the binary's path. Its page is
// a stand-in that carries the token, so tests can call the API without
// building the web UI.
func buildRevisions(t *testing.T, dir, name, version string) string {
	t.Helper()
	out := filepath.Join(dir, name)
	index, err := filepath.Abs(filepath.Join("..", "..", "web", "dist", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	scratch := t.TempDir()
	page := filepath.Join(scratch, "index.html")
	overlay := filepath.Join(scratch, "overlay.json")
	replace, _ := json.Marshal(map[string]map[string]string{"Replace": {index: page}})
	if os.WriteFile(page, []byte(`<meta name="revisions-token" content="__REVISIONS_TOKEN__">`), 0o644) != nil ||
		os.WriteFile(overlay, replace, 0o644) != nil {
		t.Fatal("could not write the stand-in page")
	}
	cmd := exec.Command("go", "build", "-overlay", overlay, "-ldflags", "-X main.version="+version, "-o", out, ".")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, b)
	}
	return out
}

func TestVersionFlagPrintsTheStampedVersion(t *testing.T) {
	bin := buildRevisions(t, t.TempDir(), "revisions"+exe, "v1.2.3")
	out, err := exec.Command(bin, "--version").Output()
	if err != nil || string(out) != "revisions v1.2.3\n" {
		t.Fatalf("got %q, %v", out, err)
	}
}

// The real serving loop, as main runs it: a quit from the page is answered,
// then the server stops and serve returns, so the program exits.
func TestQuitStopsServing(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	paths := workspace.Paths{Home: t.TempDir(), ConfigDir: t.TempDir(), CacheDir: t.TempDir()}
	ui := fstest.MapFS{"index.html": {Data: []byte(`<meta name="revisions-token" content="__REVISIONS_TOKEN__">`)}}
	served := make(chan error, 1)
	go func() { served <- serve(ln, server.New(paths, "test", port, ui)) }()

	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	resp, err := http.Get(base + "/")
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	token := regexp.MustCompile(`content="([^"]+)"`).FindSubmatch(page)
	if token == nil {
		t.Fatalf("no token in %q", page)
	}

	quit := func(origin string) int {
		req, _ := http.NewRequest("POST", base+"/api/quit", nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("X-Revisions-Token", string(token[1]))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if code := quit("https://evil.example"); code != 403 {
		t.Fatalf("a foreign page's quit answered %d", code)
	}
	if !isRevisions(base) {
		t.Fatal("a foreign page stopped Revisions")
	}
	if code := quit(base); code != 200 {
		t.Fatalf("quit answered %d", code)
	}
	select {
	case err := <-served:
		if err != nil {
			t.Fatalf("serve returned %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the server was still running 10 s after quit")
	}
	if isRevisions(base) {
		t.Fatal("Revisions still answers after quitting")
	}
}
