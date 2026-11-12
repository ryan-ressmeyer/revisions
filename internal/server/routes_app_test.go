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

// quitting reports whether the server has been told to stop.
func quitting(s *Server) bool {
	select {
	case <-s.Quitting():
		return true
	default:
		return false
	}
}

func TestQuitAnswersThenAsksToStop(t *testing.T) {
	s := newTestServer(t)
	if quitting(s) {
		t.Fatal("a new server is already quitting")
	}
	rec := api(t, s, "POST", "/api/quit", nil)
	if rec.Code != 200 || rec.Body.String() != "{}\n" {
		t.Fatalf("POST /api/quit answered %d %q, want 200 {}", rec.Code, rec.Body)
	}
	if !quitting(s) {
		t.Fatal("the server was not asked to stop")
	}
	// A second quit, from another tab, is answered too.
	if rec := api(t, s, "POST", "/api/quit", nil); rec.Code != 200 {
		t.Fatalf("a second quit answered %d", rec.Code)
	}
}

// Scenario: Foreign origin, for the route that stops the program.
func TestQuitRefusesAForeignPage(t *testing.T) {
	s := newTestServer(t)
	token := pageToken(t, s)
	wantError(t, do(s, "POST", "/api/quit", "Origin", "https://evil.example", "X-Revisions-Token", token), 403, "bad_origin")
	wantError(t, do(s, "POST", "/api/quit", "X-Revisions-Token", token), 403, "bad_origin")
	wantError(t, do(s, "POST", "/api/quit", "Origin", testOrigin), 403, "bad_token")
	wantError(t, do(s, "POST", "/api/quit", "Host", "evil.example:4747", "Origin", "http://evil.example:4747", "X-Revisions-Token", token), 403, "bad_host")
	wantError(t, do(s, "GET", "/api/quit", "X-Revisions-Token", token), 404, "not_found")
	if quitting(s) {
		t.Fatal("a refused request stopped the server")
	}
}

// A build without a release version, such as dev, never looks for or offers
// an update.
func TestADevBuildOffersNoUpdate(t *testing.T) {
	t.Setenv("REVISIONS_RELEASES_URL", "http://127.0.0.1:1") // nothing listens there
	s := newTestServer(t)
	got := decode[map[string]string](t, api(t, s, "GET", "/api/update", nil))
	if got["version"] != "test-version" || got["available"] != "" || got["notesUrl"] != "" {
		t.Fatalf("got %v", got)
	}
	wantError(t, api(t, s, "POST", "/api/update", nil), 409, "no_update")
}
