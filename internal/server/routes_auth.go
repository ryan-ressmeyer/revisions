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

	mu        sync.Mutex
	device    *deviceFlow // the sign-in in progress, if any
	user      host.User   // the account behind userToken
	userToken string
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
	mux.HandleFunc("GET /api/repos", s.listRepos)
	mux.HandleFunc("POST /api/open", s.open)
}

// hostToken returns the GitHub token, or "" when signed out.
// REVISIONS_GITHUB_TOKEN bypasses sign-in.
func (s *Server) hostToken() string {
	if token := os.Getenv("REVISIONS_GITHUB_TOKEN"); token != "" {
		return token
	}
	token, _ := s.auth.tokens.Get()
	return token
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
	var answer *host.Error
	switch {
	case errors.Is(err, host.ErrUnauthorized):
		writeError(w, http.StatusUnauthorized, "auth_required", "Sign in to GitHub to continue.")
	case errors.Is(err, host.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "GitHub has no such repository or pull request, or your account cannot see it.")
	case errors.Is(err, host.ErrNotConfigured):
		writeError(w, http.StatusServiceUnavailable, "not_configured", "This build of Revisions has no GitHub client ID, so sign-in is unavailable.")
	case errors.As(err, &answer):
		writeError(w, http.StatusBadGateway, "host_failed", "GitHub refused the request: "+answer.Message)
	default:
		writeError(w, http.StatusBadGateway, "host_unreachable", "Could not reach GitHub. Check your internet connection.")
	}
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
	SignedIn          bool      `json:"signedIn"`
	User              *authUser `json:"user"`
	SuggestedAuthorID string    `json:"suggestedAuthorId"`
}

func (s *Server) getAuth(w http.ResponseWriter, r *http.Request) {
	state := authState{}
	token := s.hostToken()
	user, err := s.hostUser(r.Context(), token)
	switch {
	case err == nil:
		state = authState{true, &authUser{user.Login, user.Name, user.AvatarURL}, suggestedAuthorID(user)}
	case token != "" && !errors.Is(err, host.ErrUnauthorized):
		// GitHub is unreachable: still signed in, but the account is unknown for now.
		state.SignedIn = true
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
	code, err := a.host.StartDevice(r.Context())
	if err != nil {
		hostFailed(w, err)
		return
	}
	interval := time.Duration(code.Interval) * time.Second
	a.mu.Lock()
	a.device = &deviceFlow{
		code:     code.DeviceCode,
		expires:  time.Now().Add(time.Duration(code.ExpiresIn) * time.Second),
		interval: interval, nextPoll: time.Now().Add(interval),
	}
	a.mu.Unlock()
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
		if err := a.tokens.Set(poll.Token); err != nil {
			writeError(w, http.StatusInternalServerError, "storage_failed", "Could not store the sign-in on this computer: "+err.Error())
			return
		}
		a.device = nil
	default:
		a.device = nil
	}
	status(poll.Status)
}

func (s *Server) signOut(w http.ResponseWriter, r *http.Request) {
	if err := s.auth.tokens.Delete(); err != nil {
		writeError(w, http.StatusInternalServerError, "storage_failed", "Could not remove the sign-in from this computer: "+err.Error())
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
	token := s.hostToken()
	if token == "" {
		hostFailed(w, host.ErrUnauthorized)
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
		hostFailed(w, err)
		return
	}
	var pull host.PullRequest
	if ref.Kind == host.RefPull {
		if pull, err = h.PullRequest(ctx, token, repo, ref.Number); err != nil {
			hostFailed(w, err)
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
			gitFailed(w, err)
			return
		}
	} else if err := gitx.Fetch(ctx, dir, auth); err != nil {
		gitFailed(w, err)
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
			gitFailed(w, err)
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
