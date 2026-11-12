package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"testing/fstest"

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
// way the release build stamps it, and returns the binary's path.
func buildRevisions(t *testing.T, dir, name, version string) string {
	t.Helper()
	out := filepath.Join(dir, name)
	cmd := exec.Command("go", "build", "-ldflags", "-X main.version="+version, "-o", out, ".")
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
