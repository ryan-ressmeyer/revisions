package github

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ryan-ressmeyer/revisions/internal/host"
	"github.com/ryan-ressmeyer/revisions/internal/host/githubfake"
)

var _ host.Host = (*Host)(nil)

// newHost returns a Host wired to a fake GitHub whose repositories are bare
// repositories in a temporary directory.
func newHost(t *testing.T) (*Host, *githubfake.Fake) {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(t.TempDir(), "gitconfig"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	remotes := t.TempDir()
	fake := githubfake.New(remotes)
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	t.Setenv("REVISIONS_GITHUB_URL", githubfake.FileURL(remotes))
	t.Setenv("REVISIONS_GITHUB_API_URL", srv.URL)
	t.Setenv("REVISIONS_GITHUB_CLIENT_ID", "test-client")
	return New(), fake
}

func TestParseURL(t *testing.T) {
	h := New()
	repo := host.Repo{Owner: "ryan-ressmeyer", Name: "OpenIrisDPI"}
	sha := "0123456789abcdef0123456789abcdef01234567"
	for raw, want := range map[string]host.Ref{
		"https://github.com/ryan-ressmeyer/OpenIrisDPI":                         {Kind: host.RefDefault},
		"https://github.com/ryan-ressmeyer/OpenIrisDPI/":                        {Kind: host.RefDefault},
		"https://github.com/ryan-ressmeyer/OpenIrisDPI.git":                     {Kind: host.RefDefault},
		"  github.com/ryan-ressmeyer/OpenIrisDPI\n":                             {Kind: host.RefDefault},
		"https://www.github.com/ryan-ressmeyer/OpenIrisDPI?tab=readme#top":      {Kind: host.RefDefault},
		"https://github.com/ryan-ressmeyer/OpenIrisDPI/tree/main":               {Kind: host.RefBranch, Name: "main"},
		"https://github.com/ryan-ressmeyer/OpenIrisDPI/tree/gale/intro-edits":   {Kind: host.RefBranch, Name: "gale/intro-edits"},
		"https://github.com/ryan-ressmeyer/OpenIrisDPI/commit/" + sha:           {Kind: host.RefCommit, Name: sha},
		"https://github.com/ryan-ressmeyer/OpenIrisDPI/commit/0123abc":          {Kind: host.RefCommit, Name: "0123abc"},
		"https://github.com/ryan-ressmeyer/OpenIrisDPI/pull/12":                 {Kind: host.RefPull, Number: 12},
		"https://github.com/ryan-ressmeyer/OpenIrisDPI/pull/12/files":           {Kind: host.RefPull, Number: 12},
		"https://github.com/ryan-ressmeyer/OpenIrisDPI/pull/12#issuecomment-99": {Kind: host.RefPull, Number: 12},
	} {
		gotRepo, got, err := h.ParseURL(raw)
		if err != nil || gotRepo != repo || got != want {
			t.Errorf("ParseURL(%q) = %v, %+v, %v; want %v, %+v", raw, gotRepo, got, err, repo, want)
		}
	}
	for _, raw := range []string{
		"",
		"https://github.com",
		"https://github.com/ryan-ressmeyer",
		"https://gitlab.com/ryan-ressmeyer/OpenIrisDPI",
		"https://github.com.evil.example/ryan-ressmeyer/OpenIrisDPI",
		"ssh://github.com/ryan-ressmeyer/OpenIrisDPI",
		"https://github.com/ryan-ressmeyer/OpenIrisDPI/tree",
		"https://github.com/ryan-ressmeyer/OpenIrisDPI/commit/not-a-sha",
		"https://github.com/ryan-ressmeyer/OpenIrisDPI/pull/0",
		"https://github.com/ryan-ressmeyer/OpenIrisDPI/pull/abc",
		"https://github.com/ryan-ressmeyer/OpenIrisDPI/issues/3",
	} {
		if _, _, err := h.ParseURL(raw); !errors.Is(err, host.ErrBadURL) {
			t.Errorf("ParseURL(%q) = %v, want ErrBadURL", raw, err)
		}
	}
}

func TestDeviceFlow(t *testing.T) {
	h, fake := newHost(t)
	ctx := t.Context()

	code, err := h.StartDevice(ctx)
	if err != nil || code.UserCode == "" || code.DeviceCode == "" || code.VerificationURI == "" || code.ExpiresIn <= 0 {
		t.Fatalf("StartDevice = %+v, %v", code, err)
	}
	if poll, err := h.PollDevice(ctx, code.DeviceCode); err != nil || poll.Status != host.PollPending || poll.Token != "" {
		t.Fatalf("before approval: %+v, %v", poll, err)
	}
	fake.SetDevice("approved")
	poll, err := h.PollDevice(ctx, code.DeviceCode)
	if err != nil || poll.Status != host.PollOK || poll.Token != githubfake.Token {
		t.Fatalf("after approval: %+v, %v", poll, err)
	}

	for state, want := range map[string]string{"denied": host.PollDenied, "expired": host.PollExpired} {
		fake.SetDevice(state)
		if poll, err := h.PollDevice(ctx, code.DeviceCode); err != nil || poll.Status != want || poll.Token != "" {
			t.Errorf("%s: %+v, %v", state, poll, err)
		}
	}

	// GitHub answers slow_down with the interval to use from now on.
	fake.SetDevice("slow_down")
	if poll, err := h.PollDevice(ctx, code.DeviceCode); err != nil || poll.Status != host.PollPending || poll.Interval <= 0 {
		t.Errorf("slow_down: %+v, %v", poll, err)
	}
}

func TestExpiringDeviceCredentialAndRefresh(t *testing.T) {
	h, _ := newHost(t)
	bad := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.Form.Has("client_secret") || strings.Contains(r.Form.Get("scope"), "offline_access") {
			t.Error("requested extra credentials or scope")
		}
		if r.Form.Get("grant_type") == "refresh_token" {
			if r.Form.Get("refresh_token") != "refresh-a" {
				t.Error("missing refresh token")
			}
			if bad {
				fmt.Fprint(w, `{"error":"bad_refresh_token"}`)
				return
			}
			fmt.Fprint(w, `{"access_token":"access-b","refresh_token":"refresh-b","expires_in":28800,"refresh_token_expires_in":15000000}`)
			return
		}
		fmt.Fprint(w, `{"access_token":"access-a","refresh_token":"refresh-a","expires_in":28800,"refresh_token_expires_in":15000000}`)
	}))
	defer srv.Close()
	h.oauth = srv.URL
	before := time.Now()
	poll, err := h.PollDevice(t.Context(), "device")
	if err != nil || poll.Token != "access-a" || poll.RefreshToken != "refresh-a" || poll.ExpiresAt.Before(before.Add(28799*time.Second)) || poll.RefreshExpiresAt.Before(before.Add(14999999*time.Second)) {
		t.Fatalf("device metadata lost: %+v, %v", poll, err)
	}
	credential, err := h.Refresh(t.Context(), poll.RefreshToken)
	if err != nil || credential.Token != "access-b" || credential.RefreshToken != "refresh-b" {
		t.Fatalf("rotation: %+v, %v", credential, err)
	}
	bad = true
	if _, err := h.Refresh(t.Context(), "refresh-a"); !errors.Is(err, host.ErrUnauthorized) {
		t.Fatalf("bad refresh: %v", err)
	}
}

func TestStartDeviceWithoutClientID(t *testing.T) {
	newHost(t)
	builtIn := ClientID
	t.Cleanup(func() { ClientID = builtIn })

	// An empty override turns sign-in off even when the build has an ID, so
	// these tests keep working once the real ID is in the source.
	ClientID = "built-in"
	t.Setenv("REVISIONS_GITHUB_CLIENT_ID", "")
	if _, err := New().StartDevice(t.Context()); !errors.Is(err, host.ErrNotConfigured) {
		t.Fatalf("empty override: got %v, want ErrNotConfigured", err)
	}

	os.Unsetenv("REVISIONS_GITHUB_CLIENT_ID") // t.Setenv restores it
	if _, err := New().StartDevice(t.Context()); err != nil {
		t.Fatalf("built-in ID: %v", err)
	}
	ClientID = ""
	if _, err := New().StartDevice(t.Context()); !errors.Is(err, host.ErrNotConfigured) {
		t.Fatalf("no ID: got %v, want ErrNotConfigured", err)
	}
}

func TestUserAndRepository(t *testing.T) {
	h, fake := newHost(t)
	ctx := t.Context()
	if err := githubfake.Seed(fake.Remotes, "owner/name", t.TempDir()); err != nil {
		t.Fatal(err)
	}
	repo := host.Repo{Owner: "owner", Name: "name"}

	fake.SetUser(583231, "gharper", "Gale Harper")
	user, err := h.User(ctx, githubfake.Token)
	if err != nil || user.ID != 583231 || user.Login != "gharper" || user.Name != "Gale Harper" || user.AvatarURL == "" {
		t.Fatalf("User = %+v, %v", user, err)
	}
	if got := h.CommitEmail(user); got != "583231+gharper@users.noreply.github.com" {
		t.Errorf("CommitEmail = %q", got)
	}
	if _, err := h.User(ctx, "revoked"); !errors.Is(err, host.ErrUnauthorized) {
		t.Errorf("revoked token: %v, want ErrUnauthorized", err)
	}

	info, err := h.Repository(ctx, githubfake.Token, repo)
	if err != nil || info.DefaultBranch != "main" || !info.Push {
		t.Fatalf("Repository = %+v, %v", info, err)
	}
	fake.SetPush("owner/name", false)
	if info, err := h.Repository(ctx, githubfake.Token, repo); err != nil || info.Push {
		t.Fatalf("read-only Repository = %+v, %v", info, err)
	}
	if _, err := h.Repository(ctx, githubfake.Token, host.Repo{Owner: "owner", Name: "absent"}); !errors.Is(err, host.ErrNotFound) {
		t.Errorf("absent repository: %v, want ErrNotFound", err)
	}
}

func TestPullRequests(t *testing.T) {
	h, fake := newHost(t)
	ctx := t.Context()
	src := t.TempDir()
	os.WriteFile(filepath.Join(src, "main.tex"), []byte("text\n"), 0o644)
	if err := githubfake.Seed(fake.Remotes, "owner/name", src); err != nil {
		t.Fatal(err)
	}
	bare := filepath.Join(fake.Remotes, "owner", "name.git")
	gitOut := func(args ...string) string {
		out, err := exec.Command("git", append([]string{"-C", bare}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	gitOut("branch", "edits", "main")
	head := gitOut("rev-parse", "edits")
	repo := host.Repo{Owner: "owner", Name: "name"}

	if pulls, err := h.PullRequests(ctx, githubfake.Token, repo); err != nil || len(pulls) != 0 {
		t.Fatalf("no pull requests yet: %v, %v", pulls, err)
	}
	created, err := h.CreatePullRequest(ctx, githubfake.Token, repo, host.NewPull{Title: "Intro edits", Body: "Please review.", Head: "edits", Base: "main"})
	want := host.PullRequest{Number: 1, Title: "Intro edits", State: "open", HeadSHA: head, HeadRef: "edits", URL: "https://github.com/owner/name/pull/1", SameRepo: true}
	if err != nil || created != want {
		t.Fatalf("CreatePullRequest = %+v, %v; want %+v", created, err, want)
	}
	if got, err := h.PullRequest(ctx, githubfake.Token, repo, 1); err != nil || got != want {
		t.Fatalf("PullRequest(1) = %+v, %v", got, err)
	}
	if pulls, err := h.PullRequests(ctx, githubfake.Token, repo); err != nil || len(pulls) != 1 || pulls[0] != want {
		t.Fatalf("PullRequests = %+v, %v", pulls, err)
	}
	if _, err := h.PullRequest(ctx, githubfake.Token, repo, 9); !errors.Is(err, host.ErrNotFound) {
		t.Errorf("absent pull request: %v, want ErrNotFound", err)
	}

	// A head branch GitHub does not have is a validation failure with its message.
	var hostErr *host.Error
	if _, err := h.CreatePullRequest(ctx, githubfake.Token, repo, host.NewPull{Title: "x", Head: "nowhere", Base: "main"}); !errors.As(err, &hostErr) || hostErr.Status != 422 || hostErr.Message == "" {
		t.Errorf("unknown head: %v, want a 422 host.Error", err)
	}

	// A pull request from a fork is not SameRepo.
	n := fake.AddPull("owner/name", githubfake.Pull{Title: "From a fork", HeadRepo: "forker/name", HeadRef: "patch-1", HeadSHA: head})
	if got, err := h.PullRequest(ctx, githubfake.Token, repo, n); err != nil || got.SameRepo || got.HeadRef != "patch-1" {
		t.Errorf("fork pull request = %+v, %v", got, err)
	}
}

func TestCloneURLAndGitAuth(t *testing.T) {
	t.Setenv("REVISIONS_GITHUB_URL", "")
	t.Setenv("REVISIONS_GITHUB_API_URL", "")
	h := New()
	if h.Name() != "github.com" {
		t.Errorf("Name = %q", h.Name())
	}
	if got := h.CloneURL(host.Repo{Owner: "owner", Name: "name"}); got != "https://github.com/owner/name.git" {
		t.Errorf("CloneURL = %q", got)
	}
	base, header := h.GitAuth("gho_token")
	want := "Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:gho_token"))
	if base != "https://github.com/" || header != want {
		t.Errorf("GitAuth = %q, %q", base, header)
	}

	// The repository id host stays github.com when the base URLs point elsewhere.
	h, _ = newHost(t)
	if h.Name() != "github.com" || !strings.HasPrefix(h.CloneURL(host.Repo{Owner: "owner", Name: "name"}), "file://") {
		t.Errorf("with overrides: Name = %q, CloneURL = %q", h.Name(), h.CloneURL(host.Repo{Owner: "owner", Name: "name"}))
	}
}
