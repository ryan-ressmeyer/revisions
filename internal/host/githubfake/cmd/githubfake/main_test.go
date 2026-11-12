package main

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/ryan-ressmeyer/revisions/internal/host"
	"github.com/ryan-ressmeyer/revisions/internal/host/github"
)

// The printed line is all a browser test needs to point revisions at the fake.
func TestSetupServesSeededRepository(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(t.TempDir(), "gitconfig"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	manuscript := filepath.Join("..", "..", "..", "..", "..", "testdata", "manuscript")
	ln, line, fake, err := setup([]string{"-remotes", t.TempDir(), "-seed", "owner/name=" + manuscript, "-push=false", "-auto-approve"})
	if err != nil {
		t.Fatal(err)
	}
	go http.Serve(ln, fake)
	defer ln.Close()

	var out struct{ APIURL, WebURL, Token string }
	if err := json.Unmarshal([]byte(line), &out); err != nil || out.APIURL == "" || out.WebURL == "" || out.Token == "" {
		t.Fatalf("printed %q: %v", line, err)
	}
	t.Setenv("REVISIONS_GITHUB_API_URL", out.APIURL)
	t.Setenv("REVISIONS_GITHUB_URL", out.WebURL)
	t.Setenv("REVISIONS_GITHUB_CLIENT_ID", "e2e")
	h := github.New()

	code, err := h.StartDevice(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if poll, err := h.PollDevice(t.Context(), code.DeviceCode); err != nil || poll.Status != host.PollOK || poll.Token != out.Token {
		t.Fatalf("auto-approved sign-in: %+v, %v", poll, err)
	}
	info, err := h.Repository(t.Context(), out.Token, host.Repo{Owner: "owner", Name: "name"})
	if err != nil || info.Push || info.DefaultBranch != "main" {
		t.Fatalf("seeded read-only repository: %+v, %v", info, err)
	}
}
