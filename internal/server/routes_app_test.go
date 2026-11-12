package server

import (
	"os/exec"
	"runtime"
	"strings"
	"testing"

	"github.com/ryan-ressmeyer/revisions/internal/build"
)

type settingsBody struct {
	AuthorID            string `json:"authorId"`
	AuthorName          string `json:"authorName"`
	BuildTimeoutSeconds int    `json:"buildTimeoutSeconds"`
}

func TestSettingsStartAtDefaults(t *testing.T) {
	s := newTestServer(t)
	got := decode[settingsBody](t, api(t, s, "GET", "/api/settings", nil))
	if got != (settingsBody{BuildTimeoutSeconds: 300}) {
		t.Fatalf("got %+v, want no author and a 300 s timeout", got)
	}
}

func TestSettingsAreSavedAcrossRestarts(t *testing.T) {
	s := newTestServer(t)
	want := settingsBody{AuthorID: "GH", AuthorName: "Gale Harper", BuildTimeoutSeconds: 900}

	if got := decode[settingsBody](t, api(t, s, "PUT", "/api/settings", want)); got != want {
		t.Errorf("PUT answered %+v, want %+v", got, want)
	}
	restarted := New(s.paths, "test-version", 4747, testUI)
	if got := decode[settingsBody](t, api(t, restarted, "GET", "/api/settings", nil)); got != want {
		t.Errorf("after a restart: %+v, want %+v", got, want)
	}
}

func TestInvalidSettingsAreRejected(t *testing.T) {
	s := newTestServer(t)
	good := settingsBody{AuthorID: "RR", AuthorName: "Ryan", BuildTimeoutSeconds: 600}
	decode[settingsBody](t, api(t, s, "PUT", "/api/settings", good))

	for _, bad := range []settingsBody{
		{AuthorID: "R R", BuildTimeoutSeconds: 300},
		{AuthorID: "rr}{", BuildTimeoutSeconds: 300},
		{AuthorID: "RR", BuildTimeoutSeconds: 9},
		{AuthorID: "RR", BuildTimeoutSeconds: 7201},
		{AuthorID: "RR"}, // no timeout at all
	} {
		wantError(t, api(t, s, "PUT", "/api/settings", bad), 400, "bad_settings")
	}
	wantError(t, api(t, s, "PUT", "/api/settings", `{"authorId":`), 400, "bad_json")
	wantError(t, api(t, s, "PUT", "/api/settings", `{"buildTimeoutSeconds":"long"}`), 400, "bad_json")
	if got := decode[settingsBody](t, api(t, s, "GET", "/api/settings", nil)); got != good {
		t.Errorf("a rejected PUT changed the settings to %+v", got)
	}
}

type envBody struct {
	Platform string
	Git      struct {
		Found   bool
		Version string
	}
	Latexmk struct {
		Found   bool
		Version string
	}
	Synctex struct{ Found bool }
}

func TestEnvReportsPlatformAndTools(t *testing.T) {
	s := newTestServer(t)
	env := decode[envBody](t, api(t, s, "GET", "/api/env", nil))

	if env.Platform != runtime.GOOS {
		t.Errorf("platform = %q, want %q", env.Platform, runtime.GOOS)
	}
	gitVersion, err := exec.Command("git", "--version").Output()
	if err != nil {
		t.Fatal(err)
	}
	if !env.Git.Found || env.Git.Version == "" || !strings.Contains(string(gitVersion), env.Git.Version) {
		t.Errorf("git = %+v, but git --version says %q", env.Git, gitVersion)
	}
	if installed := build.FindTool("latexmk") != ""; env.Latexmk.Found != installed || (env.Latexmk.Version != "") != installed {
		t.Errorf("latexmk = %+v, but installed = %v", env.Latexmk, installed)
	}
	if installed := build.FindTool("synctex") != ""; env.Synctex.Found != installed {
		t.Errorf("synctex.found = %v, but installed = %v", env.Synctex.Found, installed)
	}
}

func TestEnvWithNothingInstalled(t *testing.T) {
	s := newTestServer(t)
	t.Setenv("PATH", t.TempDir())
	s.build.find = pathOnly

	env := decode[envBody](t, api(t, s, "GET", "/api/env", nil))
	if env.Git.Found || env.Git.Version != "" || env.Latexmk.Found || env.Latexmk.Version != "" || env.Synctex.Found {
		t.Errorf("env with an empty PATH = %+v, want nothing found", env)
	}
}

// pathOnly is tool discovery without the well-known install directories, so
// that an empty PATH hides a TeX that is installed on the test machine.
func pathOnly(name string) string {
	p, _ := exec.LookPath(name)
	return p
}
