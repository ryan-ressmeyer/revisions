package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ryan-ressmeyer/revisions/internal/gitx"
	"github.com/ryan-ressmeyer/revisions/internal/host"
	"github.com/ryan-ressmeyer/revisions/internal/workspace"
)

// gitDeps holds what these routes need. Add fields here and set them at the top
// of registerGit; no other file has to change.
type gitDeps struct {
	// mu serializes every request that changes a clone, so two of them never
	// race for Git's index lock.
	//
	// ponytail: one lock for all clones. Make it per repository if two
	// manuscripts are ever worked on at once and one blocks the other.
	mu sync.Mutex

	permMu sync.Mutex
	perms  map[workspace.RepoID]pushPermission
}

// pushPermission is a remembered answer to "may this token push here?".
type pushPermission struct {
	push  bool
	token string
	at    time.Time
}

// The status is polled every 2 s; the host is asked at most this often.
const permissionTTL = 30 * time.Second

// gitHandler is a route on one clone.
type gitHandler func(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string)

// registerGit registers R/git/* and R/pulls.
func (s *Server) registerGit(mux *http.ServeMux) {
	s.git.perms = map[workspace.RepoID]pushPermission{}

	const R = "/api/repos/{host}/{owner}/{name}"
	// read routes leave the clone as it is; change routes take the lock.
	read := func(h gitHandler) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if id, dir, ok := s.repo(w, r); ok {
				h(w, r, id, dir)
			}
		}
	}
	change := func(h gitHandler) http.HandlerFunc {
		return read(func(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
			s.git.mu.Lock()
			defer s.git.mu.Unlock()
			h(w, r, id, dir)
		})
	}
	mux.HandleFunc("GET "+R+"/git/status", read(s.writeStatus))
	mux.HandleFunc("GET "+R+"/git/diff", read(s.gitDiff))
	mux.HandleFunc("GET "+R+"/git/log", read(s.gitLog))
	mux.HandleFunc("GET "+R+"/git/commits/{sha}", read(s.gitShow))
	mux.HandleFunc("POST "+R+"/git/commit", change(s.gitCommit))
	mux.HandleFunc("POST "+R+"/git/fetch", change(s.gitFetch))
	mux.HandleFunc("POST "+R+"/git/pull", change(s.gitPull))
	mux.HandleFunc("POST "+R+"/git/merge/abort", change(s.gitMergeAbort))
	mux.HandleFunc("POST "+R+"/git/push", change(s.gitPush))
	mux.HandleFunc("GET "+R+"/git/force-push/preview", change(s.gitForcePreview)) // it fetches
	mux.HandleFunc("POST "+R+"/git/force-push", change(s.gitForcePush))
	mux.HandleFunc("POST "+R+"/git/branches", change(s.gitBranch))
	mux.HandleFunc("POST "+R+"/git/checkout", change(s.gitCheckout))
	mux.HandleFunc("GET "+R+"/git/discard/preview", read(s.gitDiscardPreview))
	mux.HandleFunc("POST "+R+"/git/discard", change(s.gitDiscard))
	mux.HandleFunc("POST "+R+"/pulls", read(s.createPull))
}

// canPush reports whether the signed-in account may push to the repository.
// The answer is remembered for permissionTTL unless fresh is set. An error is
// remembered as "no", so a status poll does not retry a failing lookup.
func (s *Server) canPush(ctx context.Context, id workspace.RepoID, fresh bool) (bool, error) {
	token := s.hostToken()
	if token == "" {
		return false, host.ErrUnauthorized
	}
	g := &s.git
	g.permMu.Lock()
	defer g.permMu.Unlock()
	if p, ok := g.perms[id]; ok && !fresh && p.token == token && time.Since(p.at) < permissionTTL {
		return p.push, nil
	}
	info, err := s.auth.host.Repository(ctx, token, host.Repo{Owner: id.Owner, Name: id.Name})
	g.perms[id] = pushPermission{push: info.Push, token: token, at: time.Now()}
	return info.Push, err
}

// requireToken returns the GitHub token, or answers 401 auth_required.
func (s *Server) requireToken(w http.ResponseWriter) (string, bool) {
	token := s.hostToken()
	if token == "" {
		hostFailed(w, host.ErrUnauthorized)
	}
	return token, token != ""
}

// commitIdentity is who commits when Git has no identity configured: the
// GitHub account, at its no-reply address.
func (s *Server) commitIdentity(ctx context.Context) gitx.Identity {
	user, err := s.hostUser(ctx, s.hostToken())
	if err != nil {
		return gitx.Identity{}
	}
	name := user.Name
	if name == "" {
		name = user.Login
	}
	return gitx.Identity{Name: name, Email: s.auth.host.CommitEmail(user)}
}

// status reads the clone's status, or answers with the failure.
func status(w http.ResponseWriter, r *http.Request, dir string) (gitx.Status, bool) {
	st, err := gitx.GetStatus(r.Context(), dir)
	if err != nil {
		gitFailed(w, err)
	}
	return st, err == nil
}

// onBranch is status for routes that need a branch: a detached HEAD is
// answered 409 detached.
func onBranch(w http.ResponseWriter, r *http.Request, dir string) (gitx.Status, bool) {
	st, ok := status(w, r, dir)
	if ok && st.Branch == "" {
		writeError(w, http.StatusConflict, "detached", "No branch is checked out. Create a branch first.")
		return st, false
	}
	return st, ok
}

func dirty(w http.ResponseWriter, st gitx.Status, message string) {
	writeError(w, http.StatusConflict, "dirty", message, map[string]any{"files": st.Files})
}

func badRequest(w http.ResponseWriter, message string) {
	writeError(w, http.StatusBadRequest, "bad_request", message)
}

type statusResponse struct {
	Branch       *string           `json:"branch"`       // null on a detached HEAD
	Head         string            `json:"head"`         // "" before the first commit
	Upstream     *string           `json:"upstream"`     // null when the branch has none
	UpstreamGone bool              `json:"upstreamGone"` // the upstream was removed on GitHub
	Ahead        int               `json:"ahead"`
	Behind       int               `json:"behind"`
	Files        []gitx.FileStatus `json:"files"`
	Merging      bool              `json:"merging"`
	Conflicts    []string          `json:"conflicts"`
	Permissions  struct {
		Push bool `json:"push"`
	} `json:"permissions"`
	Snapshot *snapshot `json:"snapshot"` // null on a branch
}

// snapshot is the version a detached HEAD shows, and where "back" goes.
type snapshot struct {
	Subject  string  `json:"subject"`
	Date     string  `json:"date"`
	ReturnTo *string `json:"returnTo"` // null when there is no branch to go back to
}

// writeStatus answers GET R/git/status, and every route that changes the
// clone answers with it too.
func (s *Server) writeStatus(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	st, ok := status(w, r, dir)
	if !ok {
		return
	}
	body := statusResponse{
		Branch: branchOrNull(st.Branch), Head: st.Head, Upstream: branchOrNull(st.Upstream), UpstreamGone: st.UpstreamGone,
		Ahead: st.Ahead, Behind: st.Behind, Files: st.Files, Merging: st.Merging, Conflicts: st.Conflicts,
	}
	if st.Branch == "" && st.Head != "" {
		c, err := gitx.HeadCommit(r.Context(), dir)
		if err != nil {
			gitFailed(w, err)
			return
		}
		body.Snapshot = &snapshot{Subject: c.Subject, Date: c.Date, ReturnTo: branchOrNull(gitx.ReturnBranch(r.Context(), dir))}
	}
	// Signed out or offline, pushing is not on offer.
	body.Permissions.Push, _ = s.canPush(r.Context(), id, false)
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) gitDiff(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	path := r.URL.Query().Get("path")
	if path != "" && !filepath.IsLocal(filepath.FromSlash(path)) {
		writeError(w, http.StatusBadRequest, "bad_path", "That path is not inside the repository.")
		return
	}
	diff, err := gitx.Diff(r.Context(), dir, path)
	if err != nil {
		gitFailed(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"diff": diff})
}

func (s *Server) gitLog(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	limit, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || limit < 1 {
		limit = 200
	}
	commits, err := gitx.Log(r.Context(), dir, min(limit, 2000))
	if err != nil {
		gitFailed(w, err)
		return
	}
	// The graph is still worth showing signed out or offline, without pull requests.
	pulls := []host.PullRequest{}
	if token := s.hostToken(); token != "" {
		if list, err := s.auth.host.PullRequests(r.Context(), token, host.Repo{Owner: id.Owner, Name: id.Name}); err == nil {
			pulls = list
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"commits": commits, "pulls": pulls})
}

var (
	shaPattern   = regexp.MustCompile(`^[0-9a-f]{4,64}$`)
	leasePattern = regexp.MustCompile(`^([0-9a-f]{40,64})?$`)
)

func (s *Server) gitShow(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	var detail gitx.CommitDetail
	found := shaPattern.MatchString(r.PathValue("sha"))
	if found {
		var err error
		if detail, found, err = gitx.Show(r.Context(), dir, r.PathValue("sha")); err != nil {
			gitFailed(w, err)
			return
		}
	}
	if !found {
		writeError(w, http.StatusNotFound, "not_found", "This copy of the repository has no such commit.")
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) gitCommit(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	var body struct {
		Message string `json:"message"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Message) == "" {
		badRequest(w, "Describe the change in a commit message.")
		return
	}
	st, ok := onBranch(w, r, dir)
	switch {
	case !ok:
	case len(st.Conflicts) > 0:
		writeError(w, http.StatusConflict, "conflicts",
			"Some files still contain conflict markers (<<<<<<< and >>>>>>>). Edit them to keep the text you want, then commit.",
			map[string]any{"files": st.Conflicts})
	case !st.Dirty():
		writeError(w, http.StatusConflict, "nothing_to_commit", "There are no changes to commit.")
	default:
		if err := gitx.Commit(r.Context(), dir, body.Message, s.commitIdentity(r.Context())); err != nil {
			gitFailed(w, err)
			return
		}
		s.writeStatus(w, r, id, dir)
	}
}

func (s *Server) gitFetch(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	token, ok := s.requireToken(w)
	if !ok {
		return
	}
	if err := gitx.Fetch(r.Context(), dir, s.gitAuth(token)); err != nil {
		gitFailed(w, err)
		return
	}
	s.writeStatus(w, r, id, dir)
}

func (s *Server) gitPull(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	token, ok := s.requireToken(w)
	if !ok {
		return
	}
	if _, ok := onBranch(w, r, dir); !ok {
		return
	}
	// Fetch first: other branches update even when this one has nothing to
	// get, and the fetch is what notices a branch removed on GitHub.
	ctx := r.Context()
	if err := gitx.Fetch(ctx, dir, s.gitAuth(token)); err != nil {
		gitFailed(w, err)
		return
	}
	st, ok := onBranch(w, r, dir)
	switch {
	case !ok:
		return
	case st.UpstreamGone:
		writeError(w, http.StatusConflict, "upstream_gone", "This branch was removed from GitHub, probably because its pull request was closed or merged. Your copy still has it. Switch to another branch, or Send to put it back on GitHub.")
		return
	case st.Upstream == "":
		writeError(w, http.StatusConflict, "no_upstream", "This branch is not on GitHub yet, so there is nothing to pull.")
		return
	}
	if err := gitx.Merge(ctx, dir, "@{upstream}", s.commitIdentity(ctx)); err != nil {
		if st.Dirty() {
			// Git refuses to merge over uncommitted changes to the same files.
			dirty(w, st, "The incoming changes touch files you have changed. Commit or discard your changes, then pull again.")
		} else {
			gitFailed(w, err)
		}
		return
	}
	s.writeStatus(w, r, id, dir)
}

func (s *Server) gitMergeAbort(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	st, ok := status(w, r, dir)
	if !ok {
		return
	}
	if !st.Merging {
		writeError(w, http.StatusConflict, "not_merging", "No merge is in progress.")
		return
	}
	if err := gitx.MergeAbort(r.Context(), dir); err != nil {
		gitFailed(w, err)
		return
	}
	s.writeStatus(w, r, id, dir)
}

// push is the shared tail of push and force-push: it checks the account's
// permission afresh, pushes the current branch, and answers.
func (s *Server) push(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string, lease *string, rejected string) {
	token, ok := s.requireToken(w)
	if !ok {
		return
	}
	st, ok := onBranch(w, r, dir)
	if !ok {
		return
	}
	allowed, err := s.canPush(r.Context(), id, true)
	if err != nil {
		hostFailed(w, err)
		return
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "no_push_permission", "Your GitHub account cannot push to this repository. Ask its owner for write access.")
		return
	}
	err = gitx.Push(r.Context(), dir, s.gitAuth(token), st.Branch, lease)
	switch {
	case errors.Is(err, gitx.ErrRejected):
		writeError(w, http.StatusConflict, "rejected", rejected)
	case err != nil:
		gitFailed(w, err)
	default:
		s.writeStatus(w, r, id, dir)
	}
}

func (s *Server) gitPush(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	s.push(w, r, id, dir, nil, "GitHub has commits that this copy does not have. Pull them, then push again.")
}

func (s *Server) gitForcePreview(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	token, ok := s.requireToken(w)
	if !ok {
		return
	}
	st, ok := onBranch(w, r, dir)
	if !ok {
		return
	}
	if err := gitx.Fetch(r.Context(), dir, s.gitAuth(token)); err != nil {
		gitFailed(w, err)
		return
	}
	remote, erased, err := gitx.ForcePushPreview(r.Context(), dir, st.Branch)
	if err != nil {
		gitFailed(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"remoteSha": remote, "commits": erased})
}

func (s *Server) gitForcePush(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	var body struct {
		// The remote commit the preview showed; "" when it showed no remote branch.
		ExpectedRemoteSHA *string `json:"expectedRemoteSha"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.ExpectedRemoteSHA == nil || !leasePattern.MatchString(*body.ExpectedRemoteSHA) {
		badRequest(w, "A force-push must name the remote commit shown in its preview.")
		return
	}
	s.push(w, r, id, dir, body.ExpectedRemoteSHA, "The branch on GitHub changed after the preview, so nothing was pushed. Review the preview again.")
}

func (s *Server) gitBranch(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	var body struct {
		Name string `json:"name"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	ctx := r.Context()
	if _, exists, _ := gitx.Resolve(ctx, dir, "refs/heads/"+body.Name); exists {
		writeError(w, http.StatusConflict, "branch_exists", "A branch with that name already exists.")
		return
	}
	switch err := gitx.CreateBranch(ctx, dir, body.Name, "", false); {
	case errors.Is(err, gitx.ErrBadBranch):
		writeError(w, http.StatusBadRequest, "bad_branch", "That is not a valid branch name. Use letters, digits, hyphens, and slashes.")
	case err != nil:
		gitFailed(w, err)
	default:
		s.writeStatus(w, r, id, dir)
	}
}

func (s *Server) gitCheckout(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	var body struct {
		Branch string `json:"branch"`
		Commit string `json:"commit"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Branch != "" && body.Commit != "" {
		badRequest(w, "Name a branch or a commit, not both.")
		return
	}
	ctx := r.Context()
	st, ok := status(w, r, dir)
	if !ok {
		return
	}
	if body.Commit != "" {
		// A snapshot: the commit checked out with no branch (detached HEAD).
		sha, found := "", shaPattern.MatchString(body.Commit)
		if found {
			var err error
			if sha, found, err = gitx.Resolve(ctx, dir, body.Commit+"^{commit}"); err != nil {
				gitFailed(w, err)
				return
			}
		}
		switch {
		case !found:
			writeError(w, http.StatusNotFound, "not_found", "This copy of the repository has no such commit.")
			return
		case st.Branch == "" && st.Head == sha:
		case st.Dirty():
			dirty(w, st, "You have changes that are not committed. Commit or discard them before looking at another version.")
			return
		default:
			if err := gitx.Detach(ctx, dir, sha); err != nil {
				gitFailed(w, err)
				return
			}
		}
	} else if st.Branch != body.Branch {
		_, local, _ := gitx.Resolve(ctx, dir, "refs/heads/"+body.Branch)
		remote := "refs/remotes/origin/" + body.Branch
		_, onRemote, _ := gitx.Resolve(ctx, dir, remote)
		var err error
		switch {
		case !local && !onRemote:
			writeError(w, http.StatusNotFound, "not_found", "There is no branch with that name.")
			return
		case st.Dirty():
			dirty(w, st, "You have changes that are not committed. Commit or discard them before switching branches.")
			return
		case local:
			err = gitx.Switch(ctx, dir, body.Branch)
		default:
			// The branch exists only on GitHub: create a local one that tracks it.
			err = gitx.CreateBranch(ctx, dir, body.Branch, remote, true)
		}
		if err != nil {
			gitFailed(w, err)
			return
		}
	}
	s.writeStatus(w, r, id, dir)
}

type discardPreview struct {
	Diff        string            `json:"diff"`
	Files       []gitx.FileStatus `json:"files"`
	Fingerprint string            `json:"fingerprint"` // what POST R/git/discard must name
}

// previewDiscard describes everything a discard would remove. The fingerprint
// covers the diff (whose index lines name every changed blob, binary ones
// included), the file list, and a merge in progress.
func previewDiscard(w http.ResponseWriter, r *http.Request, dir string) (discardPreview, bool) {
	st, ok := status(w, r, dir)
	if !ok {
		return discardPreview{}, false
	}
	diff, err := gitx.Diff(r.Context(), dir, "")
	if err != nil {
		gitFailed(w, err)
		return discardPreview{}, false
	}
	p := discardPreview{Diff: diff, Files: st.Files}
	summary, _ := json.Marshal([]any{p.Diff, p.Files, st.Merging})
	p.Fingerprint = workspace.Hash(summary)
	return p, true
}

func (s *Server) gitDiscardPreview(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	if p, ok := previewDiscard(w, r, dir); ok {
		writeJSON(w, http.StatusOK, p)
	}
}

func (s *Server) gitDiscard(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	var body struct {
		Fingerprint string `json:"fingerprint"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Fingerprint == "" {
		badRequest(w, "A discard must name the changes shown in its preview.")
		return
	}
	// Saves do not take the Git lock, so an autosave landing between this
	// check and the reset still goes; the UI saves before it previews.
	p, ok := previewDiscard(w, r, dir)
	if !ok {
		return
	}
	if p.Fingerprint != body.Fingerprint {
		writeError(w, http.StatusConflict, "changed", "Your changes are different from the ones shown, so nothing was discarded. Review them again.")
		return
	}
	if err := gitx.Discard(r.Context(), dir); err != nil {
		gitFailed(w, err)
		return
	}
	s.writeStatus(w, r, id, dir)
}

func (s *Server) createPull(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	var body struct {
		Title string `json:"title"`
		Body  string `json:"body"`
		Base  string `json:"base"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Title) == "" {
		badRequest(w, "Give the pull request a title.")
		return
	}
	token, ok := s.requireToken(w)
	if !ok {
		return
	}
	st, ok := onBranch(w, r, dir)
	if !ok {
		return
	}
	if st.Upstream != "origin/"+st.Branch || st.Ahead > 0 {
		writeError(w, http.StatusConflict, "not_pushed", "Push this branch first, so the pull request includes all of your commits.")
		return
	}
	ctx, h, repo := r.Context(), s.auth.host, host.Repo{Owner: id.Owner, Name: id.Name}
	if body.Base == "" {
		info, err := h.Repository(ctx, token, repo)
		if err != nil {
			hostFailed(w, err)
			return
		}
		body.Base = info.DefaultBranch
	}
	pull, err := h.CreatePullRequest(ctx, token, repo, host.NewPull{Title: body.Title, Body: body.Body, Head: st.Branch, Base: body.Base})
	var refused *host.Error
	switch {
	case errors.As(err, &refused) && refused.Status == http.StatusUnprocessableEntity:
		// For example: a pull request for this branch already exists.
		writeError(w, http.StatusUnprocessableEntity, "pull_rejected", "GitHub did not open the pull request: "+refused.Message)
	case err != nil:
		hostFailed(w, err)
	default:
		writeJSON(w, http.StatusOK, pull)
	}
}
