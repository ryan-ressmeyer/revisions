// Package githubfake is an in-process stand-in for the parts of GitHub that
// internal/host/github calls: the OAuth device flow, /user, /repos/{o}/{r},
// and listing, reading, and creating pull requests. Git traffic does not pass
// through it. Repositories are bare repositories on disk at
// <Remotes>/<owner>/<name>.git, and REVISIONS_GITHUB_URL points at that
// directory as a file:// URL so clone URLs resolve to them.
package githubfake

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// Token is the access token the fake issues and the only one it accepts.
const Token = "gho_fakeaccesstoken"

const (
	deviceCode = "fake-device-code"
	userCode   = "WDJB-MJHT"
)

// Pull is a pull request held by the fake. HeadRepo is "owner/name"; empty
// means the repository the pull request belongs to.
type Pull struct {
	Number   int
	Title    string
	State    string // "open" when empty
	HeadRepo string
	HeadRef  string
	HeadSHA  string
}

// Fake serves the API. The zero value is not usable; call New.
type Fake struct {
	Remotes string // directory of bare repositories

	mux *http.ServeMux
	mu  sync.Mutex

	id          int64
	login, name string
	readOnly    map[string]bool
	device      string
	interval    int
	requests    map[string]int
	pulls       map[string][]Pull
}

// New returns a fake whose repositories live under remotes. The device flow
// starts pending, the user is Gale Harper, and every repository is writable.
func New(remotes string) *Fake {
	f := &Fake{
		Remotes: remotes, mux: http.NewServeMux(),
		id: 583231, login: "gharper", name: "Gale Harper",
		readOnly: map[string]bool{}, device: "pending", pulls: map[string][]Pull{}, requests: map[string]int{},
	}
	f.mux.HandleFunc("POST /login/device/code", f.startDevice)
	f.mux.HandleFunc("POST /login/oauth/access_token", f.accessToken)
	f.mux.HandleFunc("GET /user", f.authed(f.user))
	f.mux.HandleFunc("GET /repos/{owner}/{name}", f.authed(f.repo))
	f.mux.HandleFunc("GET /repos/{owner}/{name}/pulls", f.authed(f.listPulls))
	f.mux.HandleFunc("GET /repos/{owner}/{name}/pulls/{number}", f.authed(f.getPull))
	f.mux.HandleFunc("POST /repos/{owner}/{name}/pulls", f.authed(f.createPull))
	return f
}

func (f *Fake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests[r.Method+" "+r.URL.Path]++
	f.mux.ServeHTTP(w, r)
}

// SetUser changes the account behind Token.
func (f *Fake) SetUser(id int64, login, name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.id, f.login, f.name = id, login, name
}

// SetPush sets whether the account may push to repo ("owner/name").
func (f *Fake) SetPush(repo string, push bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.readOnly[repo] = !push
}

// SetDevice sets what the user has done with the one-time code: "pending",
// "approved", "denied", or "expired". "slow_down" makes the next polls answer
// that the client polls too fast.
func (f *Fake) SetDevice(state string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.device = state
}

// SetInterval sets the polling interval, in seconds, that the device flow
// asks for. It is 0 unless set, so tests need not wait.
func (f *Fake) SetInterval(seconds int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.interval = seconds
}

// Requests counts the requests served so far for a route such as
// "GET /repos/owner/name".
func (f *Fake) Requests(route string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests[route]
}

// AddPull records an existing pull request on repo and returns its number.
func (f *Fake) AddPull(repo string, pull Pull) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.addPull(repo, pull)
}

func (f *Fake) addPull(repo string, pull Pull) int {
	pull.Number = len(f.pulls[repo]) + 1
	if pull.State == "" {
		pull.State = "open"
	}
	if pull.HeadRepo == "" {
		pull.HeadRepo = repo
	}
	f.pulls[repo] = append(f.pulls[repo], pull)
	return pull.Number
}

func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, message string) {
	reply(w, status, map[string]string{"message": message})
}

func (f *Fake) startDevice(w http.ResponseWriter, r *http.Request) {
	if r.FormValue("client_id") == "" || r.FormValue("scope") != "repo" {
		fail(w, http.StatusBadRequest, "client_id and scope=repo are required")
		return
	}
	reply(w, http.StatusOK, map[string]any{
		"device_code": deviceCode, "user_code": userCode,
		"verification_uri": "https://github.com/login/device",
		"expires_in":       900, "interval": f.interval,
	})
}

// accessToken answers like GitHub: always 200, with either a token or an
// error code in the body.
func (f *Fake) accessToken(w http.ResponseWriter, r *http.Request) {
	if r.FormValue("device_code") != deviceCode || r.FormValue("grant_type") != "urn:ietf:params:oauth:grant-type:device_code" || r.FormValue("client_id") == "" {
		reply(w, http.StatusOK, map[string]string{"error": "incorrect_device_code"})
		return
	}
	switch f.device {
	case "approved":
		reply(w, http.StatusOK, map[string]string{"access_token": Token, "token_type": "bearer", "scope": "repo"})
	case "denied":
		reply(w, http.StatusOK, map[string]string{"error": "access_denied"})
	case "expired":
		reply(w, http.StatusOK, map[string]string{"error": "expired_token"})
	case "slow_down":
		reply(w, http.StatusOK, map[string]any{"error": "slow_down", "interval": f.interval + 5})
	default:
		reply(w, http.StatusOK, map[string]string{"error": "authorization_pending"})
	}
}

func (f *Fake) authed(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+Token {
			fail(w, http.StatusUnauthorized, "Bad credentials")
			return
		}
		next(w, r)
	}
}

func (f *Fake) user(w http.ResponseWriter, r *http.Request) {
	reply(w, http.StatusOK, map[string]any{
		"id": f.id, "login": f.login, "name": f.name,
		"avatar_url": "https://avatars.githubusercontent.com/u/" + strconv.FormatInt(f.id, 10),
	})
}

// bare returns the repository's "owner/name" and its bare directory, or
// answers 404 when there is none.
func (f *Fake) bare(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	dir := filepath.Join(f.Remotes, r.PathValue("owner"), r.PathValue("name")+".git")
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		fail(w, http.StatusNotFound, "Not Found")
		return "", "", false
	}
	return r.PathValue("owner") + "/" + r.PathValue("name"), dir, true
}

func (f *Fake) repo(w http.ResponseWriter, r *http.Request) {
	repo, _, ok := f.bare(w, r)
	if !ok {
		return
	}
	reply(w, http.StatusOK, map[string]any{
		"full_name": repo, "default_branch": "main",
		"permissions": map[string]bool{"pull": true, "push": !f.readOnly[repo]},
	})
}

func pullJSON(repo string, p Pull) map[string]any {
	return map[string]any{
		"number": p.Number, "title": p.Title, "state": p.State, "merged_at": nil,
		"html_url": "https://github.com/" + repo + "/pull/" + strconv.Itoa(p.Number),
		"head":     map[string]any{"ref": p.HeadRef, "sha": p.HeadSHA, "repo": map[string]string{"full_name": p.HeadRepo}},
		"base":     map[string]any{"repo": map[string]string{"full_name": repo}},
	}
}

func (f *Fake) listPulls(w http.ResponseWriter, r *http.Request) {
	repo, _, ok := f.bare(w, r)
	if !ok {
		return
	}
	list := []map[string]any{}
	for _, p := range f.pulls[repo] {
		if p.State == "open" {
			list = append(list, pullJSON(repo, p))
		}
	}
	reply(w, http.StatusOK, list)
}

func (f *Fake) getPull(w http.ResponseWriter, r *http.Request) {
	repo, _, ok := f.bare(w, r)
	if !ok {
		return
	}
	n, _ := strconv.Atoi(r.PathValue("number"))
	if n < 1 || n > len(f.pulls[repo]) {
		fail(w, http.StatusNotFound, "Not Found")
		return
	}
	reply(w, http.StatusOK, pullJSON(repo, f.pulls[repo][n-1]))
}

func (f *Fake) createPull(w http.ResponseWriter, r *http.Request) {
	repo, dir, ok := f.bare(w, r)
	if !ok {
		return
	}
	var body struct{ Title, Body, Head, Base string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Title == "" {
		fail(w, http.StatusUnprocessableEntity, "Validation Failed: title is required")
		return
	}
	// The head must be a branch that was really pushed to the bare repository.
	sha, err := git(dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+body.Head)
	if _, baseErr := git(dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+body.Base); err != nil || baseErr != nil {
		fail(w, http.StatusUnprocessableEntity, "Validation Failed: head or base is not a branch of "+repo)
		return
	}
	n := f.addPull(repo, Pull{Title: body.Title, HeadRef: body.Head, HeadSHA: sha})
	reply(w, http.StatusCreated, pullJSON(repo, f.pulls[repo][n-1]))
}

// git runs Git for the fake's own bookkeeping, independent of the caller's
// Git configuration.
func git(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{
		"-c", "user.name=Fixture Author", "-c", "user.email=author@example.com",
		"-c", "commit.gpgsign=false", "-c", "core.autocrlf=false",
	}, args...)...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %v: %s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out)), nil
}

// Seed creates the bare repository for repo ("owner/name") under remotes,
// with one commit on main holding the contents of the directory src.
func Seed(remotes, repo, src string) error {
	owner, name, ok := strings.Cut(repo, "/")
	if !ok {
		return fmt.Errorf("seed %q: want owner/name", repo)
	}
	bare := filepath.Join(remotes, owner, name+".git")
	if _, err := git("", "init", "--quiet", "--bare", "--initial-branch=main", bare); err != nil {
		return err
	}
	// The bare repository borrows src as its work tree for one commit.
	if _, err := git("", "--git-dir="+bare, "--work-tree="+src, "add", "-A"); err != nil {
		return err
	}
	_, err := git("", "--git-dir="+bare, "--work-tree="+src, "commit", "--quiet", "--allow-empty", "-m", "Initial manuscript")
	return err
}

// FileURL is the file:// URL of a directory, the value for
// REVISIONS_GITHUB_URL.
func FileURL(dir string) string {
	path := filepath.ToSlash(dir)
	if !strings.HasPrefix(path, "/") {
		path = "/" + path // Windows: C:/x becomes /C:/x
	}
	return "file://" + path
}
