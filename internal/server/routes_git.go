package server

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"net/http/httptest"
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
	// worktree orders saves around the Git operations that change the working
	// copy or HEAD. A save holds it for reading; such an operation holds it,
	// through holdSaves, for its uncommitted-changes check and the change.
	// Fetches, pushes, and calls to GitHub stay outside it, so a save never
	// waits on the network. Take mu first.
	worktree sync.RWMutex

	permMu sync.Mutex
	perms  map[workspace.RepoID]pushPermission

	// reveal opens a folder in the file manager. Tests replace it.
	reveal func(dir string) error
}

// pushPermission is a remembered answer to "may this token push here?".
type pushPermission struct {
	push  bool
	token string
	at    time.Time
	err   error
	epoch uint64
}

// The status is polled every 2 s; the host is asked at most this often.
const permissionTTL = 30 * time.Second

// gitHandler is a route on one clone.
type gitHandler func(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string)

// registerGit registers R/git/*, R/pulls, R/reveal, and R/remove/*.
func (s *Server) registerGit(mux *http.ServeMux) {
	s.git.perms = map[workspace.RepoID]pushPermission{}
	s.git.reveal = Open

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
	mux.HandleFunc("GET "+R+"/git/branches/delete/preview", read(s.gitDeletePreview))
	mux.HandleFunc("POST "+R+"/git/branches/delete", change(s.gitDeleteBranch))
	mux.HandleFunc("POST "+R+"/pulls", change(s.createPull))
	mux.HandleFunc("POST "+R+"/reveal", read(s.revealFolder))
	mux.HandleFunc("GET "+R+"/remove/preview", read(s.removePreview))
	mux.HandleFunc("POST "+R+"/remove", change(s.removeRepo))
}

// canPush reports whether the signed-in account may push to the repository.
// The answer is remembered for permissionTTL unless fresh is set. An error is
// remembered as "no", so a status poll does not retry a failing lookup.
func (s *Server) canPush(ctx context.Context, id workspace.RepoID, token string, fresh bool) (bool, error) {
	g := &s.git
	g.permMu.Lock()
	defer g.permMu.Unlock()
	if p, ok := g.perms[id]; ok && !fresh && p.token == token && p.epoch == s.auth.epoch.Load() && time.Since(p.at) < permissionTTL {
		return p.push, p.err
	}
	epoch := s.auth.epoch.Load()
	info, err := s.auth.host.Repository(ctx, token, host.Repo{Owner: id.Owner, Name: id.Name})
	err = s.hostFailure(ctx, token, err)
	g.perms[id] = pushPermission{push: info.Push && err == nil, token: token, at: time.Now(), err: err, epoch: epoch}
	return info.Push && err == nil, err
}

// requireToken returns the GitHub token, or answers 401 auth_required.
func (s *Server) requireToken(w http.ResponseWriter, r *http.Request) (string, bool) {
	token, err := s.hostToken(r.Context())
	if err != nil {
		hostFailed(w, err)
	}
	return token, err == nil
}

// commitIdentity is who commits when Git has no identity configured: the
// GitHub account, at its no-reply address.
func (s *Server) commitIdentity(ctx context.Context) gitx.Identity {
	token, err := s.hostToken(ctx)
	if err != nil {
		return gitx.Identity{}
	}
	user, err := s.hostUser(ctx, token)
	if err != nil {
		s.hostFailure(ctx, token, err)
		return gitx.Identity{}
	}
	name := user.Name
	if name == "" {
		name = user.Login
	}
	return gitx.Identity{Name: name, Email: s.auth.host.CommitEmail(user)}
}

// holdSaves runs step while saves wait. step is a Git operation's check for
// uncommitted changes and the change itself; nothing in it may reach the
// network. It reports what step returns: true when the change was made.
func (s *Server) holdSaves(step func() bool) bool {
	s.git.worktree.Lock()
	defer s.git.worktree.Unlock()
	return step()
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
	Unsent       int               `json:"unsent"` // commits GitHub keeps nowhere; 0 on a detached HEAD
	Files        []gitx.FileStatus `json:"files"`
	Merging      bool              `json:"merging"`
	Conflicts    []string          `json:"conflicts"`
	Permissions  struct {
		Push bool `json:"push"`
	} `json:"permissions"`
	Snapshot      *snapshot        `json:"snapshot"` // null on a branch
	Finished      []finishedBranch `json:"finished"`
	DefaultBranch *string          `json:"defaultBranch"` // origin/HEAD; null when unknown
	AuthError     *authProblem     `json:"authError,omitempty"`
}

// finishedBranch is a local branch whose GitHub branch was removed and whose
// commits GitHub keeps.
type finishedBranch struct {
	Name        string `json:"name"`
	Pull        int    `json:"pull"`        // a pull request holding its tip, or 0
	Fingerprint string `json:"fingerprint"` // that of its deletion preview
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
	var err error
	if body.Unsent, err = gitx.Unsent(r.Context(), dir, st.Branch, st.Head); err != nil {
		gitFailed(w, err)
		return
	}
	if st.Branch == "" && st.Head != "" {
		c, err := gitx.HeadCommit(r.Context(), dir)
		if err != nil {
			gitFailed(w, err)
			return
		}
		body.Snapshot = &snapshot{Subject: c.Subject, Date: c.Date, ReturnTo: branchOrNull(gitx.ReturnBranch(r.Context(), dir))}
	}
	skip := ""
	if st.Dirty() {
		skip = st.Branch
	}
	finished, err := gitx.FinishedBranches(r.Context(), dir, skip)
	if err != nil {
		gitFailed(w, err)
		return
	}
	body.Finished = []finishedBranch{}
	for _, f := range finished {
		// Every commit of a finished branch is kept on GitHub, so its
		// deletion preview lists none.
		body.Finished = append(body.Finished, finishedBranch{Name: f.Name, Pull: f.Pull, Fingerprint: deletionFingerprint(f.Head, nil)})
	}
	body.DefaultBranch = branchOrNull(gitx.DefaultBranch(r.Context(), dir))
	// Signed out or offline, pushing is not on offer.
	token, err := s.hostToken(r.Context())
	if err == nil {
		body.Permissions.Push, err = s.canPush(r.Context(), id, token, false)
	}
	body.AuthError = problemFor(err)
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
	token, authErr := s.hostToken(r.Context())
	if authErr == nil {
		list, err := s.auth.host.PullRequests(r.Context(), token, host.Repo{Owner: id.Owner, Name: id.Name})
		authErr = s.hostFailure(r.Context(), token, err)
		if authErr == nil {
			pulls = list
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"commits": commits, "pulls": pulls, "authError": problemFor(authErr)})
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
	who := s.commitIdentity(r.Context()) // may ask GitHub, so before saves wait
	if s.holdSaves(func() bool {
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
			err := gitx.Commit(r.Context(), dir, body.Message, who)
			if err != nil {
				gitFailed(w, err)
			}
			return err == nil
		}
		return false
	}) {
		s.writeStatus(w, r, id, dir)
	}
}

func (s *Server) gitFetch(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	token, ok := s.requireToken(w, r)
	if !ok {
		return
	}
	if err := gitx.Fetch(r.Context(), dir, s.gitAuth(token)); err != nil {
		s.fetchFailed(w, r, token, err)
		return
	}
	s.writeStatus(w, r, id, dir)
}

func (s *Server) gitPull(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	token, ok := s.requireToken(w, r)
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
		s.fetchFailed(w, r, token, err)
		return
	}
	who := s.commitIdentity(ctx)
	if s.holdSaves(func() bool {
		st, ok := onBranch(w, r, dir)
		switch {
		case !ok:
			return false
		case st.UpstreamGone:
			writeError(w, http.StatusConflict, "upstream_gone", "This branch was removed from GitHub, probably because its pull request was closed or merged. Your copy still has it. Switch to another branch, or Send to put it back on GitHub.")
			return false
		case st.Upstream == "":
			writeError(w, http.StatusConflict, "no_upstream", "This branch is not on GitHub yet, so there is nothing to pull.")
			return false
		case st.Dirty():
			// Stricter than Git, which merges when the incoming commits touch other files.
			dirty(w, st, "You have changes that are not committed. Commit or discard them, then get the latest again.")
			return false
		}
		err := gitx.Merge(ctx, dir, "@{upstream}", who)
		if err != nil {
			gitFailed(w, err)
		}
		return err == nil
	}) {
		s.writeStatus(w, r, id, dir)
	}
}

func (s *Server) gitMergeAbort(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	if s.holdSaves(func() bool {
		st, ok := status(w, r, dir)
		switch {
		case !ok:
			return false
		case !st.Merging:
			writeError(w, http.StatusConflict, "not_merging", "No merge is in progress.")
			return false
		}
		err := gitx.MergeAbort(r.Context(), dir)
		if err != nil {
			gitFailed(w, err)
		}
		return err == nil
	}) {
		s.writeStatus(w, r, id, dir)
	}
}

// push is the shared tail of push and force-push: it checks the account's
// permission afresh, pushes the current branch, and answers.
func (s *Server) push(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string, lease *string, rejected func(string) string) {
	token, ok := s.requireToken(w, r)
	if !ok {
		return
	}
	st, ok := onBranch(w, r, dir)
	if ok && s.mayPush(w, r, id, token) && s.send(w, r, token, dir, st.Branch, lease, rejected) {
		s.writeStatus(w, r, id, dir)
	}
}

// mayPush asks GitHub afresh whether the account may push here, and answers
// 403 no_push_permission when it may not.
func (s *Server) mayPush(w http.ResponseWriter, r *http.Request, id workspace.RepoID, token string) bool {
	allowed, err := s.canPush(r.Context(), id, token, true)
	switch {
	case err != nil:
		hostFailed(w, err)
	case !allowed:
		writeError(w, http.StatusForbidden, "no_push_permission", "Your GitHub account cannot push to this repository. Ask its owner for write access.")
	}
	return allowed && err == nil
}

// send pushes branch and sets its upstream, or answers with why it could not.
// rejected words GitHub's refusal, given Git's reason for it.
func (s *Server) send(w http.ResponseWriter, r *http.Request, token, dir, branch string, lease *string, rejected func(reason string) string) bool {
	err := gitx.Push(r.Context(), dir, s.gitAuth(token), branch, lease)
	switch {
	case errors.Is(err, gitx.ErrRejected):
		writeError(w, http.StatusConflict, "rejected", rejected(strings.TrimPrefix(err.Error(), gitx.ErrRejected.Error()+": ")))
	case err != nil:
		s.networkGitFailed(w, r, token, err)
	}
	return err == nil
}

// says is a rejected wording for send that ignores Git's reason.
func says(message string) func(string) string {
	return func(string) string { return message }
}

func (s *Server) gitPush(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	s.push(w, r, id, dir, nil, says("GitHub has commits that this copy does not have. Pull them, then push again."))
}

func (s *Server) gitForcePreview(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	token, ok := s.requireToken(w, r)
	if !ok {
		return
	}
	st, ok := onBranch(w, r, dir)
	if !ok {
		return
	}
	if err := gitx.Fetch(r.Context(), dir, s.gitAuth(token)); err != nil {
		s.fetchFailed(w, r, token, err)
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
	s.push(w, r, id, dir, body.ExpectedRemoteSHA, says("The branch on GitHub changed after the preview, so nothing was pushed. Review the preview again."))
}

func (s *Server) gitBranch(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	var body struct {
		Name string `json:"name"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	ctx := r.Context()
	if s.holdSaves(func() bool {
		if _, exists, _ := gitx.Resolve(ctx, dir, "refs/heads/"+body.Name); exists {
			writeError(w, http.StatusConflict, "branch_exists", "A branch with that name already exists.")
			return false
		}
		err := gitx.CreateBranch(ctx, dir, body.Name, "", false)
		switch {
		case errors.Is(err, gitx.ErrBadBranch):
			writeError(w, http.StatusBadRequest, "bad_branch", "That is not a valid branch name. Use letters, digits, hyphens, and slashes.")
		case err != nil:
			gitFailed(w, err)
		}
		return err == nil
	}) {
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
	if s.holdSaves(func() bool {
		st, ok := status(w, r, dir)
		if !ok {
			return false
		}
		if body.Commit != "" {
			// A snapshot: the commit checked out with no branch (detached HEAD).
			sha, found := "", shaPattern.MatchString(body.Commit)
			if found {
				var err error
				if sha, found, err = gitx.Resolve(ctx, dir, body.Commit+"^{commit}"); err != nil {
					gitFailed(w, err)
					return false
				}
			}
			switch {
			case !found:
				writeError(w, http.StatusNotFound, "not_found", "This copy of the repository has no such commit.")
				return false
			case st.Branch == "" && st.Head == sha:
			case st.Dirty():
				dirty(w, st, "You have changes that are not committed. Commit or discard them before looking at another version.")
				return false
			default:
				if err := gitx.Detach(ctx, dir, sha); err != nil {
					gitFailed(w, err)
					return false
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
				return false
			case st.Dirty():
				dirty(w, st, "You have changes that are not committed. Commit or discard them before switching branches.")
				return false
			case local:
				err = gitx.Switch(ctx, dir, body.Branch)
			default:
				// The branch exists only on GitHub: create a local one that tracks it.
				err = gitx.CreateBranch(ctx, dir, body.Branch, remote, true)
			}
			if err != nil {
				gitFailed(w, err)
				return false
			}
		}
		return true
	}) {
		s.writeStatus(w, r, id, dir)
	}
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
	// A save lands before the check, and refuses the discard, or after the
	// reset, as stale.
	if s.holdSaves(func() bool {
		p, ok := previewDiscard(w, r, dir)
		switch {
		case !ok:
			return false
		case p.Fingerprint != body.Fingerprint:
			writeError(w, http.StatusConflict, "changed", "Your changes are different from the ones shown, so nothing was discarded. Review them again.")
			return false
		}
		err := gitx.Discard(r.Context(), dir)
		if err != nil {
			gitFailed(w, err)
		}
		return err == nil
	}) {
		s.writeStatus(w, r, id, dir)
	}
}

// createPull opens a pull request in one sweep. On the base branch it first
// moves the work onto the new branch body.Branch and the base back to GitHub's;
// it sends the branch when GitHub lacks any of it; then it asks GitHub. Every
// refusal comes before the first step; a later failure names the steps done.
func (s *Server) createPull(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	var body struct {
		Title  string `json:"title"`
		Body   string `json:"body"`
		Base   string `json:"base"`
		Branch string `json:"branch"` // the new branch, on the base branch only
	}
	if !readJSON(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Title) == "" {
		badRequest(w, "Give the pull request a title.")
		return
	}
	token, ok := s.requireToken(w, r)
	if !ok {
		return
	}
	st, ok := onBranch(w, r, dir)
	switch {
	case !ok:
		return
	case st.Merging:
		writeError(w, http.StatusConflict, "merging", "A merge is not finished. Commit it or undo it before opening a pull request.")
		return
	case !s.mayPush(w, r, id, token):
		return
	}
	ctx, h, repo := r.Context(), s.auth.host, host.Repo{Owner: id.Owner, Name: id.Name}
	if body.Base == "" {
		info, err := h.Repository(ctx, token, repo)
		if err != nil {
			hostFailed(w, s.hostFailure(ctx, token, err))
			return
		}
		body.Base = info.DefaultBranch
	}
	baseSHA, found := "", gitx.CheckBranchName(ctx, dir, body.Base) == nil
	if found {
		var err error
		if baseSHA, found, err = gitx.Resolve(ctx, dir, "refs/remotes/origin/"+body.Base); err != nil {
			gitFailed(w, err)
			return
		}
	}
	if !found {
		writeError(w, http.StatusUnprocessableEntity, "pull_rejected", "GitHub did not open the pull request: it has no branch "+body.Base+" as of the last check.")
		return
	}
	missing, err := gitx.Run(ctx, dir, "rev-list", "--count", st.Head, "--not", baseSHA)
	if err != nil {
		gitFailed(w, err)
		return
	}
	if strings.TrimSpace(missing) == "0" {
		writeError(w, http.StatusConflict, "nothing_to_propose", "There is nothing to propose yet: GitHub's "+body.Base+" already has every commit on this branch.")
		return
	}
	head, onBase := st.Branch, st.Branch == body.Base
	if onBase {
		_, local, _ := gitx.Resolve(ctx, dir, "refs/heads/"+body.Branch)
		_, remote, _ := gitx.Resolve(ctx, dir, "refs/remotes/origin/"+body.Branch)
		switch {
		case body.Branch == "":
			writeError(w, http.StatusConflict, "needs_branch", "You are on "+body.Base+", the branch the pull request goes into. Name a new branch for your commits.")
			return
		case gitx.CheckBranchName(ctx, dir, body.Branch) != nil:
			writeError(w, http.StatusBadRequest, "bad_branch", "That is not a valid branch name. Use letters, digits, hyphens, and slashes.")
			return
		case local || remote:
			writeError(w, http.StatusConflict, "branch_exists", "A branch with that name already exists here or on GitHub. Choose another name.")
			return
		}
		head = body.Branch
	}

	// From here each step answers into steps, so a failure can name the
	// steps already done.
	steps, done := httptest.NewRecorder(), []string{}
	defer func() { answerSteps(w, steps, done) }()
	if onBase && !s.holdSaves(func() bool {
		// Uncommitted changes come along to the new branch.
		if err := gitx.CreateBranch(ctx, dir, body.Branch, "", false); err != nil {
			gitFailed(steps, err)
			return false
		}
		done = append(done, "branch")
		// Only while the base is still where the new branch began.
		if err := gitx.MoveBranch(ctx, dir, body.Base, baseSHA, st.Head); err != nil {
			if now, _, _ := gitx.Resolve(ctx, dir, "refs/heads/"+body.Base); now != st.Head {
				writeError(steps, http.StatusConflict, "base_moved", "Branch "+body.Base+" changed while the pull request was being prepared, so it was left as it is.")
			} else {
				gitFailed(steps, err)
			}
			return false
		}
		done = append(done, "base")
		return true
	}) {
		return
	}
	if onBase || st.Upstream != "origin/"+st.Branch || st.Ahead > 0 {
		if !s.send(steps, r, token, dir, head, nil, func(reason string) string {
			return "GitHub refused the branch: " + reason + "."
		}) {
			return
		}
		done = append(done, "sent")
	}
	pull, err := h.CreatePullRequest(ctx, token, repo, host.NewPull{Title: body.Title, Body: body.Body, Head: head, Base: body.Base})
	var refused *host.Error
	switch {
	case errors.As(err, &refused) && refused.Status == http.StatusUnprocessableEntity:
		// For example: a pull request for this branch already exists.
		writeError(steps, http.StatusUnprocessableEntity, "pull_rejected", "GitHub did not open the pull request: "+refused.Message)
	case err != nil:
		hostFailed(steps, s.hostFailure(ctx, token, err))
	default:
		writeJSON(steps, http.StatusOK, pull)
	}
}

// answerSteps sends the answer held in steps, adding done, the steps
// completed, to an error's object when there are any.
func answerSteps(w http.ResponseWriter, steps *httptest.ResponseRecorder, done []string) {
	var body struct {
		Error map[string]any `json:"error"`
	}
	if steps.Code >= 400 && len(done) > 0 && json.Unmarshal(steps.Body.Bytes(), &body) == nil && body.Error != nil {
		body.Error["done"] = done
		writeJSON(w, steps.Code, body)
		return
	}
	maps.Copy(w.Header(), steps.Header())
	w.WriteHeader(steps.Code)
	w.Write(steps.Body.Bytes())
}

type deletePreview struct {
	Name        string           `json:"name"`
	Head        string           `json:"head"`
	Commits     []gitx.LogCommit `json:"commits"`     // held by no other branch or pull-request reference
	Fingerprint string           `json:"fingerprint"` // what POST R/git/branches/delete must name
}

// deletionFingerprint names a deletion preview: the branch tip and the
// commits only it holds.
func deletionFingerprint(head string, commits []gitx.LogCommit) string {
	shas := []string{}
	for _, c := range commits {
		shas = append(shas, c.SHA)
	}
	summary, _ := json.Marshal([]any{head, shas})
	return workspace.Hash(summary)
}

// previewDelete describes what deleting the local branch name would lose, or
// answers with why it cannot be deleted.
func previewDelete(w http.ResponseWriter, r *http.Request, dir, name string) (deletePreview, bool) {
	ctx := r.Context()
	if err := gitx.CheckBranchName(ctx, dir, name); err != nil {
		writeError(w, http.StatusBadRequest, "bad_branch", "That is not a valid branch name.")
		return deletePreview{}, false
	}
	head, found, err := gitx.Resolve(ctx, dir, "refs/heads/"+name)
	if err != nil {
		gitFailed(w, err)
		return deletePreview{}, false
	}
	if !found {
		writeError(w, http.StatusNotFound, "not_found", "This computer has no branch with that name.")
		return deletePreview{}, false
	}
	st, ok := status(w, r, dir)
	if !ok {
		return deletePreview{}, false
	}
	if st.Branch == name {
		writeError(w, http.StatusConflict, "current", "You are on this branch. Switch to another branch before deleting it.")
		return deletePreview{}, false
	}
	commits, err := gitx.OnlyOn(ctx, dir, name, head)
	if err != nil {
		gitFailed(w, err)
		return deletePreview{}, false
	}
	return deletePreview{Name: name, Head: head, Commits: commits, Fingerprint: deletionFingerprint(head, commits)}, true
}

func (s *Server) gitDeletePreview(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	if p, ok := previewDelete(w, r, dir, r.URL.Query().Get("name")); ok {
		writeJSON(w, http.StatusOK, p)
	}
}

// gitDeleteBranch deletes a local branch, never the GitHub one. It changes no
// file and not HEAD, so saves need not wait.
func (s *Server) gitDeleteBranch(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	var body struct {
		Name        string `json:"name"`
		Fingerprint string `json:"fingerprint"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Fingerprint == "" {
		badRequest(w, "A deletion must name the preview it confirms.")
		return
	}
	const changed = "The branch changed after the preview, so nothing was deleted. Review it again."
	p, ok := previewDelete(w, r, dir, body.Name)
	switch {
	case !ok:
		return
	case p.Fingerprint != body.Fingerprint:
		writeError(w, http.StatusConflict, "changed", changed)
		return
	}
	if err := gitx.DeleteBranch(r.Context(), dir, p.Name, p.Head); err != nil {
		// Another Git process moved the branch since the preview.
		if now, found, _ := gitx.Resolve(r.Context(), dir, "refs/heads/"+p.Name); found && now != p.Head {
			writeError(w, http.StatusConflict, "changed", changed)
		} else {
			gitFailed(w, err)
		}
		return
	}
	s.writeStatus(w, r, id, dir)
}
