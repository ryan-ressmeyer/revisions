package server

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"maps"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/ryan-ressmeyer/revisions/internal/host/githubfake"
	"github.com/zalando/go-keyring"
)

// No test in this package may reach the developer's real keychain.
func init() { keyring.MockInit() }

const testRepo = "/api/repos/github.com/owner/name"

// hosted is a server wired to a fake GitHub. The repository owner/name exists
// there as a bare repository seeded from testdata/manuscript, with push
// access. The server starts signed out.
type hosted struct {
	*Server
	fake  *githubfake.Fake
	page  string // the per-process token
	clone string // where the server puts its clone of owner/name
	bare  string // the "GitHub" side of owner/name
}

func newHosted(t *testing.T) *hosted {
	t.Helper()
	// Independent of the developer's Git configuration: no identity, no helpers.
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(t.TempDir(), "gitconfig"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("REVISIONS_TOKEN_STORE", "file")
	t.Setenv("REVISIONS_GITHUB_TOKEN", "")

	remotes := t.TempDir()
	fake := githubfake.New(remotes)
	api := httptest.NewServer(fake)
	t.Cleanup(api.Close)
	t.Setenv("REVISIONS_GITHUB_URL", githubfake.FileURL(remotes))
	t.Setenv("REVISIONS_GITHUB_API_URL", api.URL)
	t.Setenv("REVISIONS_GITHUB_CLIENT_ID", "test-client")
	if err := githubfake.Seed(remotes, "owner/name", filepath.Join("..", "..", "testdata", "manuscript")); err != nil {
		t.Fatal(err)
	}

	s := newTestServer(t)
	return &hosted{
		Server: s, fake: fake, page: pageToken(t, s),
		clone: filepath.Join(s.paths.Home, "github.com", "owner", "name"),
		bare:  filepath.Join(remotes, "owner", "name.git"),
	}
}

// newSignedIn is newHosted with the token supplied by the environment.
func newSignedIn(t *testing.T) *hosted {
	t.Helper()
	h := newHosted(t)
	t.Setenv("REVISIONS_GITHUB_TOKEN", githubfake.Token)
	return h
}

// call sends one API request the way the page does. body, when not nil, is
// sent as JSON.
func (h *hosted) call(t *testing.T, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var payload bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&payload).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, &payload)
	req.Host = testHost
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("X-Revisions-Token", h.page)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// ok asserts a 200 answer and decodes its body.
func ok[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if rec.Code != 200 {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("body %s: %v", rec.Body, err)
	}
	return v
}

// errorBody asserts an error answer and returns its error object.
func errorBody(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) map[string]any {
	t.Helper()
	wantError(t, rec, status, code)
	var body struct{ Error map[string]any }
	json.Unmarshal(rec.Body.Bytes(), &body)
	return body.Error
}

// gitIn runs git in dir as the manuscript's author and returns its output.
func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=Ada Author", "-c", "user.email=ada@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"}, args...)...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func write(t *testing.T, dir, path, content string) {
	t.Helper()
	full := filepath.Join(dir, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// authorClone is the author's own working copy of owner/name.
func (h *hosted) authorClone(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "author")
	gitIn(t, "", "clone", "--quiet", h.bare, dir)
	return dir
}

// authorCommit writes one file in the author's copy, commits, pushes the
// current branch, and returns the new commit.
func authorCommit(t *testing.T, dir, path, content string) string {
	t.Helper()
	write(t, dir, path, content)
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "--quiet", "-m", "Edit "+path)
	gitIn(t, dir, "push", "--quiet", "origin", "HEAD")
	return gitIn(t, dir, "rev-parse", "HEAD")
}

// tree reads every file of a working tree, the .git directory aside.
func tree(t *testing.T, dir string) map[string]string {
	t.Helper()
	files := map[string]string{}
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		data, err := os.ReadFile(path)
		rel, _ := filepath.Rel(dir, path)
		files[filepath.ToSlash(rel)] = string(data)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

type authBody struct {
	SignedIn bool
	User     *struct{ Login, Name, AvatarURL string }
	// SuggestedAuthorID is a default for the changes-package author id.
	SuggestedAuthorID string `json:"suggestedAuthorId"`
}

type openBody struct {
	Repo string
	Ref  struct{ Kind, Name, SHA string }
}

const repoURL = "https://github.com/owner/name"

func (h *hosted) open(t *testing.T, url string) openBody {
	t.Helper()
	return ok[openBody](t, h.call(t, "POST", "/api/open", map[string]string{"url": url}))
}

// Scenario: Device sign-in.
func TestDeviceSignIn(t *testing.T) {
	h := newHosted(t)
	if auth := ok[authBody](t, h.call(t, "GET", "/api/auth", nil)); auth.SignedIn || auth.User != nil {
		t.Fatalf("signed in before sign-in: %+v", auth)
	}

	// Starting sign-in yields the one-time code and the page to enter it on.
	rec := h.call(t, "POST", "/api/auth/device", nil)
	start := ok[struct {
		UserCode, VerificationURI string
		ExpiresIn                 int
		Interval                  *int
	}](t, rec)
	if start.UserCode != "WDJB-MJHT" || start.VerificationURI != "https://github.com/login/device" || start.ExpiresIn <= 0 || start.Interval == nil {
		t.Fatalf("device start: %s", rec.Body)
	}
	if strings.Contains(rec.Body.String(), "fake-device-code") {
		t.Fatal("the device code, a secret, was sent to the page")
	}

	poll := func() string {
		return ok[struct{ Status string }](t, h.call(t, "POST", "/api/auth/device/poll", nil)).Status
	}
	if got := poll(); got != "pending" {
		t.Fatalf("before GitHub confirms: %q", got)
	}
	if ok[authBody](t, h.call(t, "GET", "/api/auth", nil)).SignedIn {
		t.Fatal("signed in while the code is pending")
	}

	// Once GitHub confirms the code, Revisions is signed in.
	h.fake.SetDevice("approved")
	if got := poll(); got != "ok" {
		t.Fatalf("after GitHub confirms: %q", got)
	}
	auth := ok[authBody](t, h.call(t, "GET", "/api/auth", nil))
	if !auth.SignedIn || auth.User == nil || auth.User.Login != "gharper" || auth.User.Name != "Gale Harper" || auth.User.AvatarURL == "" || auth.SuggestedAuthorID != "GH" {
		t.Fatalf("after sign-in: %+v %+v", auth, auth.User)
	}

	// The token outlives the process, and sign-out forgets it.
	restarted := &hosted{Server: New(h.paths, "test-version", 4747, testUI)}
	restarted.page = pageToken(t, restarted.Server)
	if !ok[authBody](t, restarted.call(t, "GET", "/api/auth", nil)).SignedIn {
		t.Fatal("a restart lost the sign-in")
	}
	if auth := ok[authBody](t, h.call(t, "POST", "/api/auth/signout", nil)); auth.SignedIn {
		t.Fatalf("after sign-out: %+v", auth)
	}
	if ok[authBody](t, restarted.call(t, "GET", "/api/auth", nil)).SignedIn {
		t.Fatal("sign-out left the token stored")
	}
}

func TestDevicePollOutcomes(t *testing.T) {
	h := newHosted(t)
	poll := func() string {
		return ok[struct{ Status string }](t, h.call(t, "POST", "/api/auth/device/poll", nil)).Status
	}
	if got := poll(); got != "expired" {
		t.Errorf("poll with no sign-in started: %q", got)
	}
	for _, outcome := range []string{"denied", "expired"} {
		ok[map[string]any](t, h.call(t, "POST", "/api/auth/device", nil))
		h.fake.SetDevice(outcome)
		if got := poll(); got != outcome {
			t.Errorf("%s: got %q", outcome, got)
		}
		// The flow is over: a later approval of the old code signs nobody in.
		h.fake.SetDevice("approved")
		if got := poll(); got != "expired" {
			t.Errorf("poll after %s: %q", outcome, got)
		}
		if ok[authBody](t, h.call(t, "GET", "/api/auth", nil)).SignedIn {
			t.Errorf("signed in after %s", outcome)
		}
	}

	// GitHub penalizes polling faster than the interval it gave, so the
	// server holds early polls back instead of forwarding them.
	h.fake.SetDevice("approved")
	h.fake.SetInterval(3600)
	ok[map[string]any](t, h.call(t, "POST", "/api/auth/device", nil))
	before := h.fake.Requests("POST /login/oauth/access_token")
	if got := poll(); got != "pending" || h.fake.Requests("POST /login/oauth/access_token") != before {
		t.Errorf("early poll: %q, %d requests reached GitHub", got, h.fake.Requests("POST /login/oauth/access_token")-before)
	}
}

func TestSignInNotConfigured(t *testing.T) {
	h := newHosted(t)
	t.Setenv("REVISIONS_GITHUB_CLIENT_ID", "")
	h.Server = New(h.paths, "test-version", 4747, testUI)
	h.page = pageToken(t, h.Server)
	wantError(t, h.call(t, "POST", "/api/auth/device", nil), 503, "not_configured")
}

func TestEnvTokenBypassesSignIn(t *testing.T) {
	h := newSignedIn(t)
	if auth := ok[authBody](t, h.call(t, "GET", "/api/auth", nil)); !auth.SignedIn || auth.User == nil || auth.User.Login != "gharper" {
		t.Fatalf("got %+v", auth)
	}
	// A token GitHub rejects is not a sign-in.
	t.Setenv("REVISIONS_GITHUB_TOKEN", "revoked")
	if auth := ok[authBody](t, h.call(t, "GET", "/api/auth", nil)); auth.SignedIn || auth.User != nil {
		t.Fatalf("revoked token: %+v", auth)
	}
}

func TestSuggestedAuthorID(t *testing.T) {
	for _, c := range []struct{ name, login, want string }{
		{"Gale Harper", "gharper", "GH"},
		{"ryan a. ressmeyer", "ryan-ressmeyer", "RAR"},
		{"", "ryan-ressmeyer", "ryanressmeyer"},
		{"  ", "octo_cat9", "octocat9"},
		{"Élodie Ångström", "elodie", "elodie"}, // settings accept only ASCII letters and digits
	} {
		h := newSignedIn(t)
		h.fake.SetUser(7, c.login, c.name)
		if got := ok[authBody](t, h.call(t, "GET", "/api/auth", nil)).SuggestedAuthorID; got != c.want {
			t.Errorf("name %q login %q: got %q, want %q", c.name, c.login, got, c.want)
		}
	}
}

func TestOpenNeedsSignInAndAGoodURL(t *testing.T) {
	h := newHosted(t)
	wantError(t, h.call(t, "POST", "/api/open", map[string]string{"url": repoURL}), 401, "auth_required")
	if _, err := os.Stat(h.clone); err == nil {
		t.Fatal("cloned without a sign-in")
	}

	t.Setenv("REVISIONS_GITHUB_TOKEN", githubfake.Token)
	for _, url := range []string{"", "https://example.com/owner/name", repoURL + "/issues/3", "https://github.com/owner/..", "https://github.com/own er/name"} {
		wantError(t, h.call(t, "POST", "/api/open", map[string]string{"url": url}), 400, "bad_url")
	}
	wantError(t, h.call(t, "POST", "/api/open", map[string]string{"url": "https://github.com/owner/absent"}), 404, "not_found")
	wantError(t, h.call(t, "POST", "/api/open", map[string]string{"url": repoURL + "/tree/absent"}), 404, "not_found")
	wantError(t, h.call(t, "POST", "/api/open", map[string]string{"url": repoURL + "/commit/0123456789abcdef0123456789abcdef01234567"}), 404, "not_found")
	wantError(t, h.call(t, "POST", "/api/open", map[string]string{"url": repoURL + "/pull/9"}), 404, "not_found")

	// An environment override cannot be repaired by device sign-in.
	t.Setenv("REVISIONS_GITHUB_TOKEN", "revoked")
	wantError(t, h.call(t, "POST", "/api/open", map[string]string{"url": repoURL}), 409, "auth_override")
}

// Scenario: First open.
func TestOpenFirstOpen(t *testing.T) {
	h := newSignedIn(t)
	author := h.authorClone(t)
	shared := gitIn(t, author, "rev-parse", "HEAD")
	authorCommit(t, author, "main.tex", "later work\n")

	if repos := ok[[]any](t, h.call(t, "GET", "/api/repos", nil)); len(repos) != 0 {
		t.Fatalf("repos before the first open: %v", repos)
	}
	got := h.open(t, repoURL+"/commit/"+shared)
	if got.Repo != "github.com/owner/name" || got.Ref.SHA != shared || got.Ref.Kind != "commit" || got.Ref.Name != "" {
		t.Fatalf("open answered %+v", got)
	}
	if head := gitIn(t, h.clone, "rev-parse", "HEAD"); head != shared {
		t.Fatalf("clone is at %s, want the shared commit %s", head, shared)
	}
	fixture := tree(t, filepath.Join("..", "..", "testdata", "manuscript"))
	if !maps.Equal(tree(t, h.clone), fixture) {
		t.Fatal("the clone's files are not the shared commit's files")
	}

	// The clone is now listed, detached at the shared commit.
	repos := ok[[]struct {
		ID, Head string
		Branch   *string
	}](t, h.call(t, "GET", "/api/repos", nil))
	if len(repos) != 1 || repos[0].ID != "github.com/owner/name" || repos[0].Head != shared || repos[0].Branch != nil {
		t.Fatalf("repos = %+v", repos)
	}
}

// Scenario: Existing clone.
func TestOpenExistingClone(t *testing.T) {
	h := newSignedIn(t)
	first := h.open(t, repoURL)
	if first.Ref.Kind != "branch" || first.Ref.Name != "main" {
		t.Fatalf("the repository URL opened %+v, want branch main", first.Ref)
	}

	// The author pushes a new commit; its URL is a commit the clone lacks.
	author := h.authorClone(t)
	next := authorCommit(t, author, "main.tex", "the author's revision\n")
	got := h.open(t, repoURL+"/commit/"+next)
	// main is the one branch whose remote tip is that commit, so main is checked out.
	if got.Ref.SHA != next || got.Ref.Kind != "branch" || got.Ref.Name != "main" {
		t.Fatalf("open answered %+v", got.Ref)
	}
	if head := gitIn(t, h.clone, "rev-parse", "HEAD"); head != next {
		t.Fatalf("clone is at %s, want %s", head, next)
	}
	if data, _ := os.ReadFile(filepath.Join(h.clone, "main.tex")); string(data) != "the author's revision\n" {
		t.Fatalf("main.tex = %q", data)
	}

	// An abbreviated commit that is no branch tip is checked out detached.
	if got := h.open(t, repoURL+"/commit/"+first.Ref.SHA[:10]); got.Ref.Kind != "commit" || got.Ref.SHA != first.Ref.SHA {
		t.Fatalf("older commit: %+v", got.Ref)
	}

	// A branch URL creates a local branch that tracks the remote one.
	gitIn(t, author, "switch", "--quiet", "-c", "gale/intro-edits")
	edits := authorCommit(t, author, "sections/methods.tex", "methods, revised\n")
	got = h.open(t, repoURL+"/tree/gale/intro-edits")
	if got.Ref.Kind != "branch" || got.Ref.Name != "gale/intro-edits" || got.Ref.SHA != edits {
		t.Fatalf("branch URL: %+v", got.Ref)
	}
	if upstream := gitIn(t, h.clone, "rev-parse", "--abbrev-ref", "@{upstream}"); upstream != "origin/gale/intro-edits" {
		t.Fatalf("upstream = %q", upstream)
	}

	// Opening the branch again after it moved fast-forwards the local branch.
	edits = authorCommit(t, author, "sections/methods.tex", "methods, revised twice\n")
	if got := h.open(t, repoURL+"/tree/gale/intro-edits"); got.Ref.SHA != edits || got.Ref.Name != "gale/intro-edits" {
		t.Fatalf("branch URL after the branch moved: %+v", got.Ref)
	}
}

// Scenario: Dirty clone.
func TestOpenDirtyClone(t *testing.T) {
	h := newSignedIn(t)
	start := h.open(t, repoURL)
	author := h.authorClone(t)
	next := authorCommit(t, author, "main.tex", "the author's revision\n")

	write(t, h.clone, "main.tex", "the collaborator's unsaved thoughts\r\n")
	write(t, h.clone, "notes/todo.txt", "untracked\n")
	before := tree(t, h.clone)

	for _, url := range []string{repoURL + "/commit/" + next, repoURL, repoURL + "/tree/main"} {
		e := errorBody(t, h.call(t, "POST", "/api/open", map[string]string{"url": url}), 409, "dirty")
		if msg := e["message"].(string); !strings.Contains(msg, "ommit") || !strings.Contains(msg, "iscard") {
			t.Errorf("the explanation %q does not say to commit or discard", msg)
		}
		files, _ := json.Marshal(e["files"])
		if string(files) != `[{"path":"main.tex","status":"modified"},{"path":"notes/todo.txt","status":"untracked"}]` {
			t.Errorf("files = %s", files)
		}
		if !maps.Equal(tree(t, h.clone), before) {
			t.Fatal("the working tree changed")
		}
		if head := gitIn(t, h.clone, "rev-parse", "HEAD"); head != start.Ref.SHA {
			t.Fatalf("HEAD moved to %s", head)
		}
		if branch := gitIn(t, h.clone, "branch", "--show-current"); branch != "main" {
			t.Fatalf("branch changed to %q", branch)
		}
	}

	// The commit the clone already sits at is not "another commit".
	if got := h.open(t, repoURL+"/commit/"+start.Ref.SHA); got.Ref.SHA != start.Ref.SHA || got.Ref.Name != "main" {
		t.Fatalf("same commit: %+v", got.Ref)
	}
	if !maps.Equal(tree(t, h.clone), before) {
		t.Fatal("opening the current commit changed the working tree")
	}
}

// Scenario: Missing Git.
func TestOpenMissingGit(t *testing.T) {
	h := newSignedIn(t)
	t.Setenv("PATH", t.TempDir())
	wantError(t, h.call(t, "POST", "/api/open", map[string]string{"url": repoURL}), 424, "git_missing")
	if _, err := os.Stat(h.clone); err == nil {
		t.Fatal("a clone directory appeared without Git")
	}
}

func TestOpenKeepsUnpushedLocalCommits(t *testing.T) {
	h := newSignedIn(t)
	h.open(t, repoURL)
	write(t, h.clone, "main.tex", "local, committed, not pushed\n")
	gitIn(t, h.clone, "commit", "--quiet", "-am", "Local work")
	local := gitIn(t, h.clone, "rev-parse", "HEAD")
	author := h.authorClone(t)
	remote := authorCommit(t, author, "refs.bib", "% the author's revision\n")

	// The branch cannot fast-forward, so it stays where the collaborator left it.
	if got := h.open(t, repoURL+"/tree/main"); got.Ref.SHA != local || got.Ref.Name != "main" {
		t.Fatalf("branch URL: %+v, want local commit %s", got.Ref, local)
	}
	// The commit URL still reaches its commit, detached, without moving main.
	if got := h.open(t, repoURL+"/commit/"+remote); got.Ref.SHA != remote || got.Ref.Kind != "commit" {
		t.Fatalf("commit URL: %+v", got.Ref)
	}
	if main := gitIn(t, h.clone, "rev-parse", "main"); main != local {
		t.Fatalf("main moved to %s", main)
	}
}

func TestOpenPullRequest(t *testing.T) {
	h := newSignedIn(t)
	author := h.authorClone(t)

	// A pull request whose head branch is in the repository opens that branch.
	gitIn(t, author, "switch", "--quiet", "-c", "edits")
	edits := authorCommit(t, author, "main.tex", "edits\n")
	same := h.fake.AddPull("owner/name", githubfake.Pull{Title: "Edits", HeadRef: "edits", HeadSHA: edits})
	if got := h.open(t, repoURL+"/pull/"+strconv.Itoa(same)); got.Ref.Kind != "branch" || got.Ref.Name != "edits" || got.Ref.SHA != edits {
		t.Fatalf("same-repository pull request: %+v", got.Ref)
	}

	// A pull request from a fork has no branch here; GitHub exposes its head
	// as refs/pull/<n>/head, which becomes local branch pr-<n>.
	gitIn(t, author, "switch", "--quiet", "--detach")
	write(t, author, "main.tex", "from the fork\n")
	gitIn(t, author, "commit", "--quiet", "-am", "Fork work")
	forked := gitIn(t, author, "rev-parse", "HEAD")
	fork := h.fake.AddPull("owner/name", githubfake.Pull{Title: "From a fork", HeadRepo: "forker/name", HeadRef: "main", HeadSHA: forked})
	gitIn(t, author, "push", "--quiet", "origin", "HEAD:refs/pull/"+strconv.Itoa(fork)+"/head")
	got := h.open(t, repoURL+"/pull/"+strconv.Itoa(fork)+"/files")
	if got.Ref.Kind != "branch" || got.Ref.Name != "pr-"+strconv.Itoa(fork) || got.Ref.SHA != forked {
		t.Fatalf("fork pull request: %+v", got.Ref)
	}
	if data, _ := os.ReadFile(filepath.Join(h.clone, "main.tex")); string(data) != "from the fork\n" {
		t.Fatalf("main.tex = %q", data)
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }
