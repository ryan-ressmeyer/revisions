package server

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/ryan-ressmeyer/revisions/internal/gitx"
	"github.com/ryan-ressmeyer/revisions/internal/host"
	"github.com/ryan-ressmeyer/revisions/internal/host/github"
	"github.com/ryan-ressmeyer/revisions/internal/settings"
	"github.com/ryan-ressmeyer/revisions/internal/workspace"
)

// authDeps holds what these routes need. Add fields here and set them at the top
// of registerAuth; no other file has to change.
type authDeps struct {
	host   host.Host
	tokens *settings.TokenStore

	mu           sync.Mutex
	device       *deviceFlow // the sign-in in progress, if any
	user         host.User   // the account behind userToken
	userToken    string
	rejected     string // rejected access token, retained only while renewal is retryable
	disconnected bool
	blocked      error         // credential storage did not finish successfully
	pendingToken string        // new pair awaiting storage recovery or identity validation
	epoch        atomic.Uint64 // invalidates permission caches, even for the same token
}

// deviceFlow is a started sign-in. The device code is a secret the page
// never sees.
type deviceFlow struct {
	code     string
	expires  time.Time
	interval time.Duration
	nextPoll time.Time // GitHub penalizes a poll before this
}

// registerAuth registers /api/auth/*, GET /api/repos, and POST /api/open.
func (s *Server) registerAuth(mux *http.ServeMux) {
	s.auth.host = github.New()
	s.auth.tokens = settings.NewTokenStore(s.paths.ConfigDir)

	mux.HandleFunc("GET /api/auth", s.getAuth)
	mux.HandleFunc("POST /api/auth/device", s.startDevice)
	mux.HandleFunc("POST /api/auth/device/poll", s.pollDevice)
	mux.HandleFunc("POST /api/auth/signout", s.signOut)
	mux.HandleFunc("POST /api/auth/reconnect", s.reconnect)
	mux.HandleFunc("POST /api/auth/device/cancel", s.cancelDevice)
	mux.HandleFunc("GET /api/repos", s.listRepos)
	mux.HandleFunc("POST /api/open", s.open)
}

var (
	errAuthOverride = errors.New("GitHub token is set by the environment")
	errAuthChanged  = errors.New("GitHub sign-in was renewed or changed")
)

type credentialStorageError struct{ error }

type authProblem struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func problemFor(err error) *authProblem {
	if err == nil {
		return nil
	}
	r := describeHostError(err)
	return &r
}

// Same error mapping for failing requests and optional GitHub reads.
func describeHostError(err error) authProblem {
	var storage *credentialStorageError
	var answer *host.Error
	switch {
	case errors.As(err, &storage):
		return authProblem{"storage_failed", "Could not read or finish storing the GitHub sign-in on this computer. Check credential storage, then choose Reconnect GitHub to retry the saved sign-in."}
	case errors.Is(err, errAuthChanged):
		return authProblem{"auth_changed", "The GitHub sign-in was renewed or changed. Nothing was retried. Retry your action when you are ready."}
	case errors.Is(err, errAuthOverride):
		return authProblem{"auth_override", "REVISIONS_GITHUB_TOKEN overrides GitHub sign-in. Replace or remove it and restart Revisions."}
	case errors.Is(err, host.ErrUnauthorized):
		return authProblem{"auth_required", "GitHub is disconnected. The sign-in expired or was rejected. Reconnect GitHub, then retry your action. Local editing, saving, and builds still work."}
	case errors.Is(err, host.ErrNotFound):
		return authProblem{"not_found", "GitHub has no such repository or pull request, or your account cannot see it."}
	case errors.Is(err, host.ErrNotConfigured):
		return authProblem{"not_configured", "This build of Revisions has no GitHub client ID, so sign-in is unavailable."}
	case errors.As(err, &answer):
		return authProblem{"host_failed", "GitHub refused the request: " + answer.Message}
	default:
		return authProblem{"host_unreachable", "Could not reach GitHub. Check your internet connection. Your sign-in has been kept."}
	}
}

func (s *Server) clearAuthLocked() {
	s.auth.user, s.auth.userToken = host.User{}, ""
	s.auth.epoch.Add(1)
}

// hostToken renews only on demand, serialized with sign-in and sign-out.
func (s *Server) hostToken(ctx context.Context) (string, error) {
	a := &s.auth
	a.mu.Lock()
	defer a.mu.Unlock()
	return s.tokenLocked(ctx, false)
}

func (s *Server) tokenLocked(ctx context.Context, force bool) (string, error) {
	a := &s.auth
	if token := os.Getenv("REVISIONS_GITHUB_TOKEN"); token != "" {
		if a.rejected == token {
			return "", errAuthOverride
		}
		return token, nil
	}
	if a.blocked != nil && !force {
		return "", a.blocked
	}
	c, err := a.tokens.Read()
	if err != nil {
		return "", &credentialStorageError{err}
	}
	if a.blocked != nil {
		// Only an explicit retry may recover a pair whose write returned an
		// error. Never unblock the consumed old token or an unreadable store.
		if c.Token == "" || c.Token != a.pendingToken {
			return "", a.blocked
		}
		a.blocked = nil
	}
	if c.Token == "" {
		return "", host.ErrUnauthorized
	}
	// Validate the saved pair first, without minting another.
	if c.Token == a.pendingToken {
		force = false
	}
	expired := !c.ExpiresAt.IsZero() && !time.Now().Before(c.ExpiresAt)
	if expired || a.rejected == c.Token || (force && c.RefreshToken != "") {
		if c.RefreshToken == "" || (!c.RefreshExpiresAt.IsZero() && !time.Now().Before(c.RefreshExpiresAt)) {
			return "", s.disconnectLocked()
		}
		next, err := a.host.Refresh(ctx, c.RefreshToken)
		if errors.Is(err, host.ErrUnauthorized) {
			return "", s.disconnectLocked()
		}
		if err != nil {
			return "", err
		}
		if err := s.acceptCredentialLocked(ctx, next); err != nil {
			return "", err
		}
		return next.Token, nil
	}
	return c.Token, nil
}

// Device authorization and refresh have the same ordering: retain the new
// complete pair before a fallible identity lookup, and never expose an old
// account or claim validated success while that lookup is unavailable.
func (s *Server) acceptCredentialLocked(ctx context.Context, credential host.Credential) error {
	a := &s.auth
	s.clearAuthLocked()
	a.pendingToken = credential.Token
	if err := a.tokens.Write(credential); err != nil {
		a.blocked = &credentialStorageError{err}
		return a.blocked
	}
	a.rejected, a.disconnected, a.blocked = "", false, nil
	user, err := a.host.User(ctx, credential.Token)
	if errors.Is(err, host.ErrUnauthorized) {
		return s.disconnectLocked()
	}
	if err != nil {
		return err
	}
	a.user, a.userToken, a.pendingToken = user, credential.Token, ""
	return nil
}

func (s *Server) disconnectLocked() error {
	s.clearAuthLocked()
	s.auth.disconnected = true
	s.auth.pendingToken = ""
	if err := s.auth.tokens.Delete(); err != nil {
		return &credentialStorageError{err}
	}
	s.auth.rejected = ""
	return host.ErrUnauthorized
}

// A request rejecting A must not invalidate credentials installed after it.
func (s *Server) rejectedToken(ctx context.Context, token string) error {
	a := &s.auth
	a.mu.Lock()
	defer a.mu.Unlock()
	if override := os.Getenv("REVISIONS_GITHUB_TOKEN"); override != "" {
		if override != token {
			return nil
		}
		a.rejected = token
		s.clearAuthLocked()
		return errAuthOverride
	}
	c, err := a.tokens.Read()
	if err != nil {
		return &credentialStorageError{err}
	}
	if c.Token != token {
		return nil
	}
	a.rejected = token
	s.clearAuthLocked()
	_, err = s.tokenLocked(ctx, false)
	return err
}

func (s *Server) hostFailure(ctx context.Context, token string, err error) error {
	if errors.Is(err, host.ErrUnauthorized) {
		if recovery := s.rejectedToken(ctx, token); recovery != nil {
			return recovery
		}
		return errAuthChanged
	}
	return err
}

// A Git failure is auth loss only when an uncached REST check of the exact
// operation token proves it. Network failures and conflicts stay Git errors.
func (s *Server) networkGitFailed(w http.ResponseWriter, r *http.Request, token string, err error) {
	if !errors.Is(err, gitx.ErrMissing) {
		if _, check := s.auth.host.User(r.Context(), token); errors.Is(check, host.ErrUnauthorized) {
			hostFailed(w, s.hostFailure(r.Context(), token, check))
			return
		}
	}
	gitFailed(w, err)
}

// hostUser returns the account behind token, asking the host once per token.
func (s *Server) hostUser(ctx context.Context, token string) (host.User, error) {
	a := &s.auth
	a.mu.Lock()
	defer a.mu.Unlock()
	if token == "" {
		return host.User{}, host.ErrUnauthorized
	}
	if a.userToken != token {
		user, err := a.host.User(ctx, token)
		if err != nil {
			return host.User{}, err
		}
		a.user, a.userToken = user, token
		if a.pendingToken == token {
			a.pendingToken, a.rejected, a.disconnected = "", "", false
		}
	}
	return a.user, nil
}

// gitAuth is how Git authenticates to the host as the signed-in account.
func (s *Server) gitAuth(token string) gitx.Auth {
	base, header := s.auth.host.GitAuth(token)
	return gitx.Auth{BaseURL: base, Header: header}
}

// hostFailed answers for a failed call to the host.
func hostFailed(w http.ResponseWriter, err error) {
	problem := describeHostError(err)
	status := http.StatusBadGateway
	switch problem.Code {
	case "auth_required":
		status = http.StatusUnauthorized
	case "auth_override", "auth_changed":
		status = http.StatusConflict
	case "storage_failed":
		status = http.StatusInternalServerError
	case "not_found":
		status = http.StatusNotFound
	case "not_configured":
		status = http.StatusServiceUnavailable
	}
	writeError(w, status, problem.Code, problem.Message)
}

// gitFailed answers for a failed Git command.
func gitFailed(w http.ResponseWriter, err error) {
	if errors.Is(err, gitx.ErrMissing) {
		writeError(w, http.StatusFailedDependency, "git_missing", "Git is not installed on this computer.")
		return
	}
	writeError(w, http.StatusBadGateway, "git_failed", "Git reported a problem: "+err.Error())
}

type authUser struct {
	Login     string `json:"login"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatarUrl"`
}

type authState struct {
	SignedIn          bool         `json:"signedIn"`
	User              *authUser    `json:"user"`
	SuggestedAuthorID string       `json:"suggestedAuthorId"`
	Problem           *authProblem `json:"problem,omitempty"`
}

func (s *Server) getAuth(w http.ResponseWriter, r *http.Request) {
	state := authState{}
	token, err := s.hostToken(r.Context())
	var user host.User
	if err == nil {
		user, err = s.hostUser(r.Context(), token)
		if errors.Is(err, host.ErrUnauthorized) {
			err = s.hostFailure(r.Context(), token, err)
			// Bounded read-only retry only after successful recovery, not a
			// transient refresh failure that may have consumed the old pair.
			if errors.Is(err, errAuthChanged) {
				if next, readErr := s.hostToken(r.Context()); readErr != nil {
					err = readErr
				} else if next != token {
					token = next
					user, err = s.hostUser(r.Context(), token)
				}
			}
		}
	}
	var storage *credentialStorageError
	if errors.As(err, &storage) {
		hostFailed(w, err)
		return
	}
	if err == nil {
		state.SignedIn, state.User, state.SuggestedAuthorID = true, &authUser{user.Login, user.Name, user.AvatarURL}, suggestedAuthorID(user)
	} else {
		a := &s.auth
		a.mu.Lock()
		state.SignedIn = !errors.Is(err, host.ErrUnauthorized) && !errors.Is(err, errAuthOverride)
		if !errors.Is(err, host.ErrUnauthorized) || a.disconnected {
			state.Problem = problemFor(err)
		}
		a.mu.Unlock()
	}
	writeJSON(w, http.StatusOK, state)
}

// suggestedAuthorID proposes a changes-package author id: the initials of the
// account's name, or else its login, keeping ASCII letters and digits only.
func suggestedAuthorID(user host.User) string {
	keep := func(r rune) bool { return r < unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r)) }
	var id strings.Builder
	for _, word := range strings.Fields(user.Name) {
		if first := []rune(word)[0]; keep(first) {
			id.WriteRune(unicode.ToUpper(first))
		}
	}
	if id.Len() > 0 {
		return id.String()
	}
	for _, r := range user.Login {
		if keep(r) {
			id.WriteRune(r)
		}
	}
	return id.String()
}

func (s *Server) startDevice(w http.ResponseWriter, r *http.Request) {
	a := &s.auth
	a.mu.Lock()
	defer a.mu.Unlock()
	if os.Getenv("REVISIONS_GITHUB_TOKEN") != "" {
		hostFailed(w, errAuthOverride)
		return
	}
	code, err := a.host.StartDevice(r.Context())
	if err != nil {
		hostFailed(w, err)
		return
	}
	interval := time.Duration(code.Interval) * time.Second
	a.device = &deviceFlow{
		code:     code.DeviceCode,
		expires:  time.Now().Add(time.Duration(code.ExpiresIn) * time.Second),
		interval: interval, nextPoll: time.Now().Add(interval),
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"userCode": code.UserCode, "verificationUri": code.VerificationURI,
		"expiresIn": code.ExpiresIn, "interval": code.Interval,
	})
}

func (s *Server) pollDevice(w http.ResponseWriter, r *http.Request) {
	a := &s.auth
	a.mu.Lock()
	defer a.mu.Unlock()
	status := func(v string) { writeJSON(w, http.StatusOK, map[string]string{"status": v}) }

	flow := a.device
	if flow == nil || time.Now().After(flow.expires) {
		a.device = nil
		status(host.PollExpired)
		return
	}
	if time.Now().Before(flow.nextPoll) {
		status(host.PollPending)
		return
	}
	poll, err := a.host.PollDevice(r.Context(), flow.code)
	if err != nil {
		hostFailed(w, err)
		return
	}
	switch poll.Status {
	case host.PollPending:
		if poll.Interval > 0 {
			flow.interval = time.Duration(poll.Interval) * time.Second
		}
		flow.nextPoll = time.Now().Add(flow.interval)
	case host.PollOK:
		a.device = nil
		if err := s.acceptCredentialLocked(r.Context(), poll.Credential); err != nil {
			hostFailed(w, err)
			return
		}
	default:
		a.device = nil
	}
	status(poll.Status)
}

func (s *Server) cancelDevice(w http.ResponseWriter, r *http.Request) {
	s.auth.mu.Lock()
	s.auth.device = nil
	s.auth.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{})
}

func (s *Server) reconnect(w http.ResponseWriter, r *http.Request) {
	s.auth.mu.Lock()
	if os.Getenv("REVISIONS_GITHUB_TOKEN") != "" {
		s.auth.mu.Unlock()
		hostFailed(w, errAuthOverride)
		return
	}
	s.clearAuthLocked()
	_, err := s.tokenLocked(r.Context(), true)
	s.auth.mu.Unlock()
	if err != nil && !errors.Is(err, host.ErrUnauthorized) {
		hostFailed(w, err)
		return
	}
	s.getAuth(w, r)
}

func (s *Server) signOut(w http.ResponseWriter, r *http.Request) {
	a := &s.auth
	a.mu.Lock()
	if os.Getenv("REVISIONS_GITHUB_TOKEN") != "" {
		a.mu.Unlock()
		hostFailed(w, errAuthOverride)
		return
	}
	a.device = nil
	s.clearAuthLocked()
	err := a.tokens.Delete()
	if err == nil {
		a.rejected, a.disconnected, a.blocked, a.pendingToken = "", false, nil, ""
	}
	a.mu.Unlock()
	if err != nil {
		hostFailed(w, &credentialStorageError{err})
		return
	}
	s.getAuth(w, r)
}

type repoSummary struct {
	ID     string  `json:"id"`
	Branch *string `json:"branch"` // null on a detached HEAD
	Head   string  `json:"head"`
}

func (s *Server) listRepos(w http.ResponseWriter, r *http.Request) {
	repos := []repoSummary{}
	// Clones live at <home>/<host>/<owner>/<name>.
	clones, _ := fs.Glob(os.DirFS(s.paths.Home), "*/*/*/.git")
	for _, clone := range clones {
		parts := strings.Split(clone, "/")
		id, err := workspace.NewRepoID(parts[0], parts[1], parts[2])
		if err != nil {
			continue
		}
		st, err := gitx.GetStatus(r.Context(), s.paths.CloneDir(id))
		if err != nil {
			continue
		}
		repos = append(repos, repoSummary{id.String(), branchOrNull(st.Branch), st.Head})
	}
	writeJSON(w, http.StatusOK, repos)
}

func branchOrNull(branch string) *string {
	if branch == "" {
		return nil
	}
	return &branch
}

// open implements "Opening a shared URL" in specs/architecture.md.
func (s *Server) open(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL string `json:"url"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	ctx, h := r.Context(), s.auth.host

	// Step 1: sign-in comes first.
	token, ok := s.requireToken(w, r)
	if !ok {
		return
	}
	repo, ref, err := h.ParseURL(body.URL)
	id, idErr := workspace.NewRepoID(h.Name(), repo.Owner, repo.Name)
	if err != nil || idErr != nil {
		writeError(w, http.StatusBadRequest, "bad_url", "That is not a GitHub repository, branch, commit, or pull-request address.")
		return
	}
	if _, err := gitx.Version(ctx); err != nil {
		gitFailed(w, err)
		return
	}
	info, err := h.Repository(ctx, token, repo)
	if err != nil {
		hostFailed(w, s.hostFailure(ctx, token, err))
		return
	}
	var pull host.PullRequest
	if ref.Kind == host.RefPull {
		if pull, err = h.PullRequest(ctx, token, repo, ref.Number); err != nil {
			hostFailed(w, s.hostFailure(ctx, token, err))
			return
		}
	}

	s.git.mu.Lock()
	defer s.git.mu.Unlock()
	dir, auth := s.paths.CloneDir(id), s.gitAuth(token)

	// Steps 2 and 3: clone, or fetch into the clone that exists.
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		err = gitx.Clone(ctx, auth, h.CloneURL(repo), dir)
		if err != nil {
			s.networkGitFailed(w, r, token, err)
			return
		}
	} else if err := gitx.Fetch(ctx, dir, auth); err != nil {
		s.networkGitFailed(w, r, token, err)
		return
	}

	// Steps 4 to 6: which branch to end on, which remote ref it follows, and
	// which commit that leaves checked out.
	var branch, remote, target string
	track := true
	switch {
	case ref.Kind == host.RefDefault:
		branch = info.DefaultBranch
	case ref.Kind == host.RefBranch:
		branch = ref.Name
	case ref.Kind == host.RefPull && pull.SameRepo:
		branch = pull.HeadRef
	case ref.Kind == host.RefPull:
		// The head lives in a fork; GitHub mirrors it as refs/pull/<n>/head.
		branch, track = fmt.Sprintf("pr-%d", ref.Number), false
		remote = fmt.Sprintf("refs/remotes/pull/%d", ref.Number)
		if err := gitx.Fetch(ctx, dir, auth, fmt.Sprintf("+refs/pull/%d/head:%s", ref.Number, remote)); err != nil {
			s.networkGitFailed(w, r, token, err)
			return
		}
	case ref.Kind == host.RefCommit:
		sha, found, err := gitx.Resolve(ctx, dir, ref.Name+"^{commit}")
		if err != nil {
			gitFailed(w, err)
			return
		}
		if !found {
			writeError(w, http.StatusNotFound, "not_found", "That commit is not on any branch of the repository on GitHub.")
			return
		}
		target = sha
		// The branch whose remote tip is this commit, when exactly one exists.
		if tips, _ := gitx.RemoteBranchesAt(ctx, dir, sha); len(tips) == 1 {
			branch = tips[0]
		}
	}
	if remote == "" && branch != "" {
		remote = "refs/remotes/origin/" + branch
	}

	var localSHA string
	var hasLocal bool
	if branch != "" {
		remoteSHA, found, err := gitx.Resolve(ctx, dir, remote)
		if err == nil && found {
			localSHA, hasLocal, err = gitx.Resolve(ctx, dir, "refs/heads/"+branch)
		}
		if err != nil {
			gitFailed(w, err)
			return
		}
		if !found {
			writeError(w, http.StatusNotFound, "not_found", "The repository on GitHub has no branch named "+branch+".")
			return
		}
		// A local branch moves only by fast-forward, so unpushed commits stay.
		forward := !hasLocal
		if hasLocal {
			if forward, err = gitx.IsAncestor(ctx, dir, localSHA, remoteSHA); err != nil {
				gitFailed(w, err)
				return
			}
		}
		switch {
		case ref.Kind != host.RefCommit && forward:
			target = remoteSHA
		case ref.Kind != host.RefCommit:
			target = localSHA
		case !forward:
			branch = "" // the local branch has moved on; reach the commit detached
		}
	}

	st, err := gitx.GetStatus(ctx, dir)
	if err != nil {
		gitFailed(w, err)
		return
	}
	// A commit URL is satisfied by sitting at the commit, on any branch.
	atTarget := st.Head == target && (ref.Kind == host.RefCommit || st.Branch == branch)
	if !atTarget {
		if st.Dirty() && st.Head != target {
			writeError(w, http.StatusConflict, "dirty",
				"This copy of the manuscript has changes that are not committed. Commit or discard them, then open the link again.",
				map[string]any{"files": st.Files})
			return
		}
		switch {
		case branch == "":
			err = gitx.Detach(ctx, dir, target)
		case !hasLocal:
			err = gitx.CreateBranch(ctx, dir, branch, remote, track)
		default:
			if st.Branch != branch {
				err = gitx.Switch(ctx, dir, branch)
			}
			if err == nil && localSHA != target {
				err = gitx.FastForward(ctx, dir, remote)
			}
		}
		if err == nil {
			st, err = gitx.GetStatus(ctx, dir)
		}
		if err != nil {
			gitFailed(w, err)
			return
		}
	}

	kind := "branch"
	if st.Branch == "" {
		kind = "commit"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"repo": id.String(),
		"ref":  map[string]string{"kind": kind, "name": st.Branch, "sha": st.Head},
	})
}
