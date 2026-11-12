package server

import (
	"encoding/json"
	"maps"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

type statusBody struct {
	Branch   *string
	Head     string
	Upstream *string
	Ahead    int
	Behind   int
	Files    []struct{ Path, Status string }
	Merging  bool
	// Conflicts and Permissions are pointers so a missing field is noticed.
	Conflicts   *[]string
	Permissions *struct{ Push bool }
}

func (st statusBody) files() string {
	var parts []string
	for _, f := range st.Files {
		parts = append(parts, f.Status+" "+f.Path)
	}
	return strings.Join(parts, ", ")
}

type commitBody struct {
	SHA        string
	Parents    []string
	AuthorName string
	Date       string
	Subject    string
	Refs       []string
}

type pullBody struct {
	Number  int
	Title   string
	State   string
	HeadSHA string `json:"headSha"`
	HeadRef string `json:"headRef"`
	URL     string
}

type logBody struct {
	Commits []commitBody
	Pulls   []pullBody
}

type previewBody struct {
	RemoteSHA *string `json:"remoteSha"`
	Commits   []commitBody
}

func shas(commits []commitBody) []string {
	out := []string{}
	for _, c := range commits {
		out = append(out, c.SHA)
	}
	return out
}

// newOpened is a signed-in server with owner/name cloned and on main.
func newOpened(t *testing.T) *hosted {
	t.Helper()
	h := newSignedIn(t)
	h.open(t, repoURL)
	return h
}

func (h *hosted) status(t *testing.T) statusBody {
	t.Helper()
	return ok[statusBody](t, h.call(t, "GET", testRepo+"/git/status", nil))
}

func (h *hosted) commit(t *testing.T, message string) statusBody {
	t.Helper()
	return ok[statusBody](t, h.call(t, "POST", testRepo+"/git/commit", map[string]string{"message": message}))
}

func (h *hosted) head(t *testing.T) string { t.Helper(); return gitIn(t, h.clone, "rev-parse", "HEAD") }

func TestGitStatus(t *testing.T) {
	h := newOpened(t)
	st := h.status(t)
	if st.Branch == nil || *st.Branch != "main" || st.Head != h.head(t) || st.Upstream == nil || *st.Upstream != "origin/main" ||
		st.Ahead != 0 || st.Behind != 0 || st.Files == nil || len(st.Files) != 0 || st.Merging ||
		st.Conflicts == nil || len(*st.Conflicts) != 0 || st.Permissions == nil || !st.Permissions.Push {
		t.Fatalf("clean clone: %+v", st)
	}

	write(t, h.clone, "main.tex", "changed\n")
	write(t, h.clone, "new section.tex", "a name with a space\n")
	write(t, h.clone, "sections/results.tex", "nested\n")
	os.Remove(filepath.Join(h.clone, "refs.bib"))
	if got := h.status(t).files(); got != "modified main.tex, untracked new section.tex, deleted refs.bib, untracked sections/results.tex" {
		t.Fatalf("files: %s", got)
	}

	// A local commit is ahead of the remote; a detached HEAD has no branch.
	if st := h.commit(t, "Local work"); st.Ahead != 1 || st.Behind != 0 || len(st.Files) != 0 {
		t.Fatalf("after a commit: %+v", st)
	}
	gitIn(t, h.clone, "switch", "--quiet", "--detach")
	if st := h.status(t); st.Branch != nil || st.Upstream != nil || st.Head != h.head(t) {
		t.Fatalf("detached: %+v", st)
	}

	wantError(t, h.call(t, "GET", "/api/repos/github.com/owner/absent/git/status", nil), 404, "not_found")
}

// Scenario: Read-only collaborator.
func TestReadOnlyCollaborator(t *testing.T) {
	h := newOpened(t)
	h.fake.SetPush("owner/name", false)
	remote := gitIn(t, h.bare, "rev-parse", "main")

	if st := h.status(t); st.Permissions == nil || st.Permissions.Push {
		t.Fatalf("status offers pushing to a read-only repository: %+v", st.Permissions)
	}
	// The status is polled every two seconds; GitHub is not asked each time.
	before := h.fake.Requests("GET /repos/owner/name")
	for range 5 {
		h.status(t)
	}
	if n := h.fake.Requests("GET /repos/owner/name") - before; n != 0 {
		t.Errorf("five status polls made %d permission requests", n)
	}

	write(t, h.clone, "main.tex", "a suggestion\n")
	h.commit(t, "Suggest")
	wantError(t, h.call(t, "POST", testRepo+"/git/push", nil), 403, "no_push_permission")
	wantError(t, h.call(t, "POST", testRepo+"/git/force-push", map[string]string{"expectedRemoteSha": remote}), 403, "no_push_permission")
	if got := gitIn(t, h.bare, "rev-parse", "main"); got != remote {
		t.Fatalf("the remote moved to %s", got)
	}

	// Push asks GitHub afresh, so access granted a moment ago counts.
	h.fake.SetPush("owner/name", true)
	if st := ok[statusBody](t, h.call(t, "POST", testRepo+"/git/push", nil)); st.Ahead != 0 || !st.Permissions.Push {
		t.Fatalf("after access was granted: %+v", st)
	}
	if got := gitIn(t, h.bare, "rev-parse", "main"); got != h.head(t) {
		t.Fatalf("remote main = %s, want %s", got, h.head(t))
	}
}

// Scenario: Open a pull request.
func TestOpenAPullRequest(t *testing.T) {
	h := newOpened(t)
	base := h.head(t)

	st := ok[statusBody](t, h.call(t, "POST", testRepo+"/git/branches", map[string]string{"name": "gale/intro-edits"}))
	if st.Branch == nil || *st.Branch != "gale/intro-edits" || st.Upstream != nil {
		t.Fatalf("new branch: %+v", st)
	}
	write(t, h.clone, "main.tex", "a clearer introduction\n")
	h.commit(t, "Clarify the introduction")
	head := h.head(t)

	// A pull request needs the branch on GitHub first.
	pull := map[string]string{"title": "Clarify the introduction", "body": "See the first paragraph.", "base": "main"}
	wantError(t, h.call(t, "POST", testRepo+"/pulls", pull), 409, "not_pushed")

	st = ok[statusBody](t, h.call(t, "POST", testRepo+"/git/push", nil))
	if st.Upstream == nil || *st.Upstream != "origin/gale/intro-edits" || st.Ahead != 0 {
		t.Fatalf("after push: %+v", st)
	}
	if got := gitIn(t, h.bare, "rev-parse", "gale/intro-edits"); got != head {
		t.Fatalf("GitHub's branch is at %s, want %s", got, head)
	}

	created := ok[pullBody](t, h.call(t, "POST", testRepo+"/pulls", pull))
	want := pullBody{Number: 1, Title: "Clarify the introduction", State: "open", HeadSHA: head, HeadRef: "gale/intro-edits", URL: "https://github.com/owner/name/pull/1"}
	if created != want {
		t.Fatalf("created %+v, want %+v", created, want)
	}

	// The commit graph lists the pull request against its head commit.
	log := ok[logBody](t, h.call(t, "GET", testRepo+"/git/log", nil))
	if len(log.Pulls) != 1 || log.Pulls[0] != want {
		t.Fatalf("log pulls = %+v", log.Pulls)
	}
	if got := shas(log.Commits); !slices.Equal(got, []string{head, base}) {
		t.Fatalf("log commits = %v, want %v", got, []string{head, base})
	}
	tip := log.Commits[0]
	if !slices.Equal(tip.Refs, []string{"HEAD", "refs/heads/gale/intro-edits", "refs/remotes/origin/gale/intro-edits"}) ||
		!slices.Equal(tip.Parents, []string{base}) || tip.Subject != "Clarify the introduction" || tip.AuthorName != "Gale Harper" || tip.Date == "" {
		t.Fatalf("head commit = %+v", tip)
	}
	if root := log.Commits[1]; !slices.Equal(root.Refs, []string{"refs/heads/main", "refs/remotes/origin/main"}) || root.Parents == nil || len(root.Parents) != 0 {
		t.Fatalf("root commit = %+v", root)
	}

	// With commits not yet pushed, the pull request would miss them.
	write(t, h.clone, "main.tex", "an even clearer introduction\n")
	h.commit(t, "Clarify again")
	wantError(t, h.call(t, "POST", testRepo+"/pulls", pull), 409, "not_pushed")
}

// Scenario: Force-push.
func TestForcePush(t *testing.T) {
	h := newOpened(t)
	author := h.authorClone(t)
	a1 := authorCommit(t, author, "refs.bib", "% one\n")
	a2 := authorCommit(t, author, "refs.bib", "% two\n")
	write(t, h.clone, "main.tex", "the collaborator's version\n")
	h.commit(t, "Rewrite")
	local := h.head(t)

	// An ordinary push is refused: it would lose the author's commits.
	wantError(t, h.call(t, "POST", testRepo+"/git/push", nil), 409, "rejected")

	// The preview lists exactly the remote commits a force-push erases.
	preview := ok[previewBody](t, h.call(t, "GET", testRepo+"/git/force-push/preview", nil))
	if preview.RemoteSHA == nil || *preview.RemoteSHA != a2 || !slices.Equal(shas(preview.Commits), []string{a2, a1}) {
		t.Fatalf("preview = %v %v, want %s erasing %v", preview.RemoteSHA, shas(preview.Commits), a2, []string{a2, a1})
	}
	if preview.Commits[0].Subject != "Edit refs.bib" || preview.Commits[0].AuthorName != "Ada Author" {
		t.Fatalf("preview commit = %+v", preview.Commits[0])
	}
	if got := gitIn(t, h.bare, "rev-parse", "main"); got != a2 {
		t.Fatalf("the preview moved the remote to %s", got)
	}

	// The remote moves after the preview: the lease fails and nothing is erased.
	a3 := authorCommit(t, author, "refs.bib", "% three\n")
	force := func(expected string) *httptest.ResponseRecorder {
		return h.call(t, "POST", testRepo+"/git/force-push", map[string]string{"expectedRemoteSha": expected})
	}
	wantError(t, force(a2), 409, "rejected")
	if got := gitIn(t, h.bare, "rev-parse", "main"); got != a3 {
		t.Fatalf("a stale force-push moved the remote to %s", got)
	}
	// The confirmation must name what the user saw.
	wantError(t, h.call(t, "POST", testRepo+"/git/force-push", map[string]string{}), 400, "bad_request")
	wantError(t, force("--force"), 400, "bad_request")

	// A fresh preview shows the new commit too, and confirming it pushes.
	preview = ok[previewBody](t, h.call(t, "GET", testRepo+"/git/force-push/preview", nil))
	if *preview.RemoteSHA != a3 || !slices.Equal(shas(preview.Commits), []string{a3, a2, a1}) {
		t.Fatalf("second preview = %v %v", *preview.RemoteSHA, shas(preview.Commits))
	}
	if st := ok[statusBody](t, force(a3)); st.Ahead != 0 || st.Behind != 0 {
		t.Fatalf("after the force-push: %+v", st)
	}
	if got := gitIn(t, h.bare, "rev-parse", "main"); got != local {
		t.Fatalf("remote main = %s, want %s", got, local)
	}
}

// Scenario: Discard.
func TestDiscard(t *testing.T) {
	h := newOpened(t)
	clean := tree(t, h.clone)
	write(t, h.clone, ".git/info/exclude", "*.aux\n")
	write(t, h.clone, "main.aux", "ignored build litter\n")
	write(t, h.clone, "main.tex", "a paragraph to throw away\n")
	write(t, h.clone, "notes/draft.tex", "an untracked draft\n")
	os.Remove(filepath.Join(h.clone, "refs.bib"))
	dirty := tree(t, h.clone)

	// The preview shows the diff that would be removed, and removes nothing.
	preview := ok[struct {
		Diff        string
		Files       []struct{ Path, Status string }
		Fingerprint string
	}](t, h.call(t, "GET", testRepo+"/git/discard/preview", nil))
	for _, want := range []string{"+a paragraph to throw away", "+an untracked draft", "+++ b/notes/draft.tex", "--- a/refs.bib"} {
		if !strings.Contains(preview.Diff, want) {
			t.Errorf("the preview diff lacks %q:\n%s", want, preview.Diff)
		}
	}
	if strings.Contains(preview.Diff, "main.aux") {
		t.Error("the preview lists an ignored file, which discard keeps")
	}
	if got := (statusBody{Files: preview.Files}).files(); got != "modified main.tex, untracked notes/draft.tex, deleted refs.bib" {
		t.Errorf("preview files: %s", got)
	}
	if !maps.Equal(tree(t, h.clone), dirty) {
		t.Fatal("the preview changed the working tree")
	}
	if got := h.status(t).files(); got != "modified main.tex, untracked notes/draft.tex, deleted refs.bib" {
		t.Fatalf("the preview changed what Git sees: %s", got)
	}

	// A discard must name what the user was shown. A change since the
	// preview, even to a file the preview listed, refuses it and keeps both.
	wantError(t, h.call(t, "POST", testRepo+"/git/discard", map[string]string{}), 400, "bad_request")
	write(t, h.clone, "notes/draft.tex", "an untracked draft, written after the preview\n")
	write(t, h.clone, "notes/late.tex", "a file made after the preview\n")
	late := tree(t, h.clone)
	wantError(t, h.call(t, "POST", testRepo+"/git/discard", map[string]string{"fingerprint": preview.Fingerprint}), 409, "changed")
	if !maps.Equal(tree(t, h.clone), late) {
		t.Fatal("a refused discard changed the working tree")
	}
	os.Remove(filepath.Join(h.clone, "notes", "late.tex"))
	write(t, h.clone, "notes/draft.tex", "an untracked draft\n")

	// Only the confirmed discard restores the tree. Ignored files stay.
	if st := ok[statusBody](t, h.call(t, "POST", testRepo+"/git/discard", map[string]string{"fingerprint": preview.Fingerprint})); len(st.Files) != 0 {
		t.Fatalf("after discard: %s", st.files())
	}
	clean["main.aux"] = "ignored build litter\n"
	if !maps.Equal(tree(t, h.clone), clean) {
		t.Fatalf("after discard the tree is %v", slices.Sorted(maps.Keys(tree(t, h.clone))))
	}
}

func TestDiff(t *testing.T) {
	h := newOpened(t)
	diff := func(query string) string {
		return ok[struct{ Diff string }](t, h.call(t, "GET", testRepo+"/git/diff"+query, nil)).Diff
	}
	if got := diff(""); got != "" {
		t.Fatalf("clean tree: %q", got)
	}
	write(t, h.clone, "main.tex", "changed\n")
	write(t, h.clone, "new [draft].tex", "untracked\n")

	all := diff("")
	if !strings.Contains(all, "+changed") || !strings.Contains(all, "+untracked") || !strings.Contains(all, "diff --git a/main.tex b/main.tex") {
		t.Fatalf("diff:\n%s", all)
	}
	// One path, taken literally even when it looks like a pattern.
	if one := diff("?path=new%20%5Bdraft%5D.tex"); !strings.Contains(one, "+untracked") || strings.Contains(one, "main.tex") {
		t.Fatalf("diff of one path:\n%s", one)
	}
	if got := diff("?path=*.tex"); got != "" {
		t.Fatalf("a path was read as a pattern:\n%s", got)
	}
	for _, path := range []string{"../outside.tex", "/etc/passwd", "sections/../../x"} {
		wantError(t, h.call(t, "GET", testRepo+"/git/diff?path="+path, nil), 400, "bad_path")
	}
	// Reading a diff stages nothing.
	if got := h.status(t).files(); got != "modified main.tex, untracked new [draft].tex" {
		t.Fatalf("after diff: %s", got)
	}
}

func TestCommit(t *testing.T) {
	h := newOpened(t)
	wantError(t, h.call(t, "POST", testRepo+"/git/commit", map[string]string{"message": "Nothing"}), 409, "nothing_to_commit")

	// Without a Git identity the commit is by the GitHub account, at its
	// no-reply address.
	write(t, h.clone, "main.tex", "first\n")
	write(t, h.clone, "sections/new.tex", "untracked files are committed too\n")
	wantError(t, h.call(t, "POST", testRepo+"/git/commit", map[string]string{"message": "  "}), 400, "bad_request")
	before := h.head(t)
	if st := h.commit(t, "First change"); len(st.Files) != 0 || st.Head == before {
		t.Fatalf("after commit: %+v", st)
	}
	const format = "--format=%an <%ae> | %cn <%ce> | %s"
	if got, want := gitIn(t, h.clone, "log", "-1", format), "Gale Harper <583231+gharper@users.noreply.github.com> | Gale Harper <583231+gharper@users.noreply.github.com> | First change"; got != want {
		t.Fatalf("commit by %q, want %q", got, want)
	}

	// A configured Git identity wins.
	write(t, os.Getenv("GIT_CONFIG_GLOBAL"), "", "[user]\n\tname = Galen H\n\temail = gale@lab.example\n")
	write(t, h.clone, "main.tex", "second\n")
	h.commit(t, "Second change")
	if got, want := gitIn(t, h.clone, "log", "-1", format), "Galen H <gale@lab.example> | Galen H <gale@lab.example> | Second change"; got != want {
		t.Fatalf("commit by %q, want %q", got, want)
	}

	// A detached HEAD needs a branch before the first commit.
	gitIn(t, h.clone, "switch", "--quiet", "--detach")
	write(t, h.clone, "main.tex", "third\n")
	wantError(t, h.call(t, "POST", testRepo+"/git/commit", map[string]string{"message": "Third"}), 409, "detached")
	ok[statusBody](t, h.call(t, "POST", testRepo+"/git/branches", map[string]string{"name": "rescue"}))
	if st := h.commit(t, "Third change"); st.Branch == nil || *st.Branch != "rescue" || len(st.Files) != 0 {
		t.Fatalf("commit on the new branch: %+v", st)
	}
}

func TestPullMergesAndReportsConflicts(t *testing.T) {
	h := newOpened(t)
	author := h.authorClone(t)

	// With nothing local, a pull fast-forwards.
	a1 := authorCommit(t, author, "main.tex", "the author's first line\n")
	if st := ok[statusBody](t, h.call(t, "POST", testRepo+"/git/fetch", nil)); st.Behind != 1 || st.Head == a1 {
		t.Fatalf("after fetch: %+v", st)
	}
	if st := ok[statusBody](t, h.call(t, "POST", testRepo+"/git/pull", nil)); st.Head != a1 || st.Behind != 0 || st.Merging {
		t.Fatalf("fast-forward pull: %+v", st)
	}

	// Both sides change the same line: the pull stops in a merge.
	authorCommit(t, author, "main.tex", "the author's second line\n")
	write(t, h.clone, "main.tex", "the collaborator's line\n")
	h.commit(t, "Collaborator edit")
	local := h.head(t)
	st := ok[statusBody](t, h.call(t, "POST", testRepo+"/git/pull", nil))
	if !st.Merging || !slices.Equal(*st.Conflicts, []string{"main.tex"}) || st.files() != "conflicted main.tex" {
		t.Fatalf("conflicting pull: %+v", st)
	}
	if data, _ := os.ReadFile(filepath.Join(h.clone, "main.tex")); !strings.Contains(string(data), "<<<<<<<") {
		t.Fatalf("main.tex has no conflict markers: %q", data)
	}
	// Committing with markers left in would publish them.
	e := errorBody(t, h.call(t, "POST", testRepo+"/git/commit", map[string]string{"message": "Merge"}), 409, "conflicts")
	if files, _ := json.Marshal(e["files"]); string(files) != `["main.tex"]` {
		t.Errorf("conflicts error files = %s", files)
	}

	// Aborting returns to the commit before the pull.
	if st := ok[statusBody](t, h.call(t, "POST", testRepo+"/git/merge/abort", nil)); st.Merging || st.Head != local || len(st.Files) != 0 {
		t.Fatalf("after abort: %+v", st)
	}
	wantError(t, h.call(t, "POST", testRepo+"/git/merge/abort", nil), 409, "not_merging")

	// Pull again, resolve in the editor, and the commit concludes the merge.
	ok[statusBody](t, h.call(t, "POST", testRepo+"/git/pull", nil))
	write(t, h.clone, "main.tex", "both lines, reconciled\n")
	if st := h.status(t); !st.Merging || len(*st.Conflicts) != 0 || st.files() != "modified main.tex" {
		t.Fatalf("after resolving: %+v", st)
	}
	st = h.commit(t, "Merge the author's changes")
	if st.Merging || len(st.Files) != 0 || st.Ahead != 2 || st.Behind != 0 {
		t.Fatalf("after the merge commit: %+v", st)
	}
	if parents := strings.Fields(gitIn(t, h.clone, "log", "-1", "--format=%P")); len(parents) != 2 || parents[0] != local {
		t.Fatalf("merge commit parents = %v", parents)
	}

	// A branch with no upstream has nothing to pull.
	ok[statusBody](t, h.call(t, "POST", testRepo+"/git/branches", map[string]string{"name": "side"}))
	wantError(t, h.call(t, "POST", testRepo+"/git/pull", nil), 409, "no_upstream")
}

// Scenario: Branch removed on GitHub.
func TestBranchRemovedOnGitHub(t *testing.T) {
	h := newOpened(t)
	author := h.authorClone(t)
	ok[statusBody](t, h.call(t, "POST", testRepo+"/git/branches", map[string]string{"name": "edits"}))
	write(t, h.clone, "main.tex", "the collaborator's edit\n")
	h.commit(t, "Edit")
	ok[statusBody](t, h.call(t, "POST", testRepo+"/git/push", nil))
	sent := h.head(t)

	// The pull request is closed and its branch deleted on GitHub, while main moves on.
	gitIn(t, h.bare, "branch", "-D", "edits")
	newMain := authorCommit(t, author, "refs.bib", "% moved on\n")
	before := tree(t, h.clone)

	e := errorBody(t, h.call(t, "POST", testRepo+"/git/pull", nil), 409, "upstream_gone")
	if msg, _ := e["message"].(string); strings.Contains(msg, "@{upstream}") {
		t.Errorf("the message is Git's own: %q", msg)
	}
	if !maps.Equal(tree(t, h.clone), before) || h.head(t) != sent {
		t.Fatal("Get latest changed the working tree")
	}
	// It still fetched, so main is up to date.
	if got := gitIn(t, h.clone, "rev-parse", "refs/remotes/origin/main"); got != newMain {
		t.Errorf("origin/main = %s, want %s", got, newMain)
	}

	var gone struct {
		statusBody
		UpstreamGone *bool `json:"upstreamGone"`
	}
	gone.statusBody = h.status(t)
	json.Unmarshal(h.call(t, "GET", testRepo+"/git/status", nil).Body.Bytes(), &gone)
	if gone.Upstream != nil || gone.UpstreamGone == nil || !*gone.UpstreamGone || gone.Ahead != 0 || gone.Behind != 0 {
		t.Fatalf("status after the branch was removed: %+v gone=%v", gone.statusBody, gone.UpstreamGone)
	}
	// The log no longer labels the removed remote branch, but keeps the local one.
	for _, c := range ok[logBody](t, h.call(t, "GET", testRepo+"/git/log", nil)).Commits {
		if c.SHA == sent && (!slices.Contains(c.Refs, "refs/heads/edits") || slices.Contains(c.Refs, "refs/remotes/origin/edits")) {
			t.Errorf("refs of the sent commit: %v", c.Refs)
		}
	}
	// A pull request needs the branch on GitHub again.
	wantError(t, h.call(t, "POST", testRepo+"/pulls", map[string]string{"title": "Again"}), 409, "not_pushed")
	// The force-push preview has nothing to erase.
	if p := ok[previewBody](t, h.call(t, "GET", testRepo+"/git/force-push/preview", nil)); p.RemoteSHA == nil || *p.RemoteSHA != "" || len(p.Commits) != 0 {
		t.Errorf("force-push preview: %+v", p)
	}

	// Send puts the branch back and tracks it again.
	if st := ok[statusBody](t, h.call(t, "POST", testRepo+"/git/push", nil)); st.Upstream == nil || *st.Upstream != "origin/edits" || st.Ahead != 0 {
		t.Fatalf("after Send: %+v", st)
	}
	if got := gitIn(t, h.bare, "rev-parse", "edits"); got != sent {
		t.Fatalf("remote edits = %s, want %s", got, sent)
	}

	// Opening the shared link again from a clone on a removed branch moves to main.
	gitIn(t, h.bare, "branch", "-D", "edits")
	ok[statusBody](t, h.call(t, "POST", testRepo+"/git/fetch", nil))
	if o := h.open(t, repoURL); o.Ref.Name != "main" || o.Ref.SHA != newMain {
		t.Fatalf("open: %+v", o)
	}
}

func TestBranchesAndCheckout(t *testing.T) {
	h := newOpened(t)
	author := h.authorClone(t)
	gitIn(t, author, "switch", "--quiet", "-c", "remote-only")
	remoteOnly := authorCommit(t, author, "main.tex", "on the remote branch\n")
	ok[statusBody](t, h.call(t, "POST", testRepo+"/git/fetch", nil))

	branch := func(name string) *httptest.ResponseRecorder {
		return h.call(t, "POST", testRepo+"/git/branches", map[string]string{"name": name})
	}
	checkout := func(name string) *httptest.ResponseRecorder {
		return h.call(t, "POST", testRepo+"/git/checkout", map[string]string{"branch": name})
	}

	// A new branch starts at HEAD and carries uncommitted changes over.
	write(t, h.clone, "main.tex", "work in progress\n")
	if st := ok[statusBody](t, branch("draft")); *st.Branch != "draft" || st.files() != "modified main.tex" {
		t.Fatalf("new branch: %+v", st)
	}
	wantError(t, branch("draft"), 409, "branch_exists")
	for _, name := range []string{"", "-f", "has space", "a..b", "ends.lock"} {
		wantError(t, branch(name), 400, "bad_branch")
	}

	// Switching branches with uncommitted work is refused, and nothing moves.
	before := tree(t, h.clone)
	e := errorBody(t, checkout("main"), 409, "dirty")
	if files, _ := json.Marshal(e["files"]); string(files) != `[{"path":"main.tex","status":"modified"}]` {
		t.Errorf("dirty files = %s", files)
	}
	if !maps.Equal(tree(t, h.clone), before) || gitIn(t, h.clone, "branch", "--show-current") != "draft" {
		t.Fatal("a refused checkout changed the clone")
	}

	h.commit(t, "Draft")
	if st := ok[statusBody](t, checkout("main")); *st.Branch != "main" {
		t.Fatalf("checkout main: %+v", st)
	}
	// A branch that exists only on GitHub gets a local branch that tracks it.
	if st := ok[statusBody](t, checkout("remote-only")); *st.Branch != "remote-only" || st.Head != remoteOnly || st.Upstream == nil || *st.Upstream != "origin/remote-only" {
		t.Fatalf("checkout of a remote branch: %+v", st)
	}
	wantError(t, checkout("nowhere"), 404, "not_found")
	wantError(t, checkout("--detach"), 404, "not_found")
}

type snapshotStatus struct {
	statusBody
	Snapshot *struct {
		Subject  string
		Date     string
		ReturnTo *string `json:"returnTo"`
	}
}

// Scenarios: View an earlier version, Back to the branch, Branch from an
// earlier version, Uncommitted work blocks viewing.
func TestViewAnEarlierVersion(t *testing.T) {
	h := newOpened(t)
	first := h.head(t)
	firstText := tree(t, h.clone)["main.tex"]
	write(t, h.clone, "main.tex", "the later text\n")
	h.commit(t, "Later")
	later := h.head(t)

	view := func(body map[string]string) *httptest.ResponseRecorder {
		return h.call(t, "POST", testRepo+"/git/checkout", body)
	}
	status := func() snapshotStatus {
		return ok[snapshotStatus](t, h.call(t, "GET", testRepo+"/git/status", nil))
	}
	if !strings.Contains(h.call(t, "GET", testRepo+"/git/status", nil).Body.String(), `"snapshot":null`) {
		t.Fatal("on a branch the status lacks snapshot: null")
	}

	// Viewing an earlier version puts the clone on it, detached.
	st := ok[snapshotStatus](t, view(map[string]string{"commit": first[:10]}))
	if st.Branch != nil || st.Head != first || st.Snapshot == nil || st.Snapshot.Subject != "Initial manuscript" ||
		st.Snapshot.Date == "" || st.Snapshot.ReturnTo == nil || *st.Snapshot.ReturnTo != "main" {
		t.Fatalf("snapshot status: %+v %+v", st.statusBody, st.Snapshot)
	}
	if got := tree(t, h.clone)["main.tex"]; got != firstText {
		t.Fatalf("main.tex on the snapshot = %q, want %q", got, firstText)
	}

	// A snapshot cannot be changed: the save is refused and the disk keeps its bytes.
	file := h.call(t, "GET", testRepo+"/file?path=main.tex", nil)
	save := map[string]string{"baseHash": file.Header().Get("X-Revisions-Hash"), "text": "an edit to the past\n"}
	wantError(t, h.call(t, "PUT", testRepo+"/file?path=main.tex", save), 409, "detached")
	if got := tree(t, h.clone)["main.tex"]; got != firstText {
		t.Fatalf("a refused save changed main.tex to %q", got)
	}

	// Moving from one snapshot to another still knows the way back.
	if st := ok[snapshotStatus](t, view(map[string]string{"commit": later})); st.Head != later || st.Branch != nil ||
		st.Snapshot == nil || st.Snapshot.Subject != "Later" || *st.Snapshot.ReturnTo != "main" {
		t.Fatalf("second snapshot: %+v %+v", st.statusBody, st.Snapshot)
	}

	// Uncommitted work blocks viewing another version, and nothing moves.
	write(t, h.clone, "notes.txt", "made outside Revisions\n")
	before := tree(t, h.clone)
	e := errorBody(t, view(map[string]string{"commit": first}), 409, "dirty")
	if files, _ := json.Marshal(e["files"]); string(files) != `[{"path":"notes.txt","status":"untracked"}]` {
		t.Errorf("dirty files = %s", files)
	}
	if !maps.Equal(tree(t, h.clone), before) || h.head(t) != later {
		t.Fatal("a refused view changed the clone")
	}
	os.Remove(filepath.Join(h.clone, "notes.txt"))

	for _, sha := range []string{"0123456789abcdef0123456789abcdef01234567", "--all", "HEAD"} {
		wantError(t, view(map[string]string{"commit": sha}), 404, "not_found")
	}
	wantError(t, view(map[string]string{"commit": first, "branch": "main"}), 400, "bad_request")

	// Back to the branch.
	if st := ok[snapshotStatus](t, view(map[string]string{"branch": "main"})); st.Branch == nil || *st.Branch != "main" || st.Head != later || st.Snapshot != nil {
		t.Fatalf("back on main: %+v %+v", st.statusBody, st.Snapshot)
	}

	// A branch started from an earlier version can be edited.
	ok[snapshotStatus](t, view(map[string]string{"commit": first}))
	if st := ok[statusBody](t, h.call(t, "POST", testRepo+"/git/branches", map[string]string{"name": "from-first"})); st.Branch == nil || *st.Branch != "from-first" || st.Head != first {
		t.Fatalf("branch from the snapshot: %+v", st)
	}
	file = h.call(t, "GET", testRepo+"/file?path=main.tex", nil)
	save["baseHash"] = file.Header().Get("X-Revisions-Hash")
	ok[map[string]any](t, h.call(t, "PUT", testRepo+"/file?path=main.tex", save))

	// With no branch left to go back to, the way back is the default branch.
	h.commit(t, "Edit the past")
	ok[snapshotStatus](t, view(map[string]string{"commit": first}))
	gitIn(t, h.clone, "branch", "-D", "from-first", "main")
	if st := status(); st.Snapshot == nil || st.Snapshot.ReturnTo == nil || *st.Snapshot.ReturnTo != "main" {
		t.Fatalf("fallback: %+v", st.Snapshot)
	}
	// The local branch is gone, so it comes back from GitHub's copy.
	if st := ok[snapshotStatus](t, view(map[string]string{"branch": "main"})); *st.Branch != "main" || st.Head != gitIn(t, h.bare, "rev-parse", "main") {
		t.Fatalf("back to the default branch: %+v", st.statusBody)
	}
}

func TestLogAndCommitDetail(t *testing.T) {
	h := newOpened(t)
	root := h.head(t)
	author := h.authorClone(t)
	gitIn(t, author, "switch", "--quiet", "-c", "other")
	other := authorCommit(t, author, "refs.bib", "% on another branch\n")
	ok[statusBody](t, h.call(t, "POST", testRepo+"/git/fetch", nil))
	write(t, h.clone, "main.tex", "line one\nline two\n")
	h.commit(t, "Rewrite the opening\n\nA longer explanation.")
	local := h.head(t)

	// The log covers every local and remote branch, not only the current one.
	log := ok[logBody](t, h.call(t, "GET", testRepo+"/git/log", nil))
	got := shas(log.Commits)
	slices.Sort(got)
	want := []string{root, other, local}
	slices.Sort(want)
	if !slices.Equal(got, want) || log.Pulls == nil {
		t.Fatalf("log = %v (pulls %v), want %v", got, log.Pulls, want)
	}
	for _, c := range log.Commits {
		if c.SHA == other && !slices.Equal(c.Refs, []string{"refs/remotes/origin/other"}) {
			t.Errorf("remote-only commit refs = %v", c.Refs)
		}
		if c.SHA == local && c.Subject != "Rewrite the opening" {
			t.Errorf("subject = %q", c.Subject)
		}
	}
	if one := ok[logBody](t, h.call(t, "GET", testRepo+"/git/log?limit=1", nil)); len(one.Commits) != 1 {
		t.Fatalf("limit=1 returned %d commits", len(one.Commits))
	}

	detail := ok[struct{ SHA, Message, AuthorName, Date, Diff string }](t, h.call(t, "GET", testRepo+"/git/commits/"+local[:12], nil))
	if detail.SHA != local || detail.Message != "Rewrite the opening\n\nA longer explanation." || detail.AuthorName != "Gale Harper" || detail.Date == "" ||
		!strings.Contains(detail.Diff, "+line two") || !strings.HasPrefix(detail.Diff, "diff --git a/main.tex b/main.tex") {
		t.Fatalf("commit detail = %+v", detail)
	}
	for _, sha := range []string{"0123456789abcdef0123456789abcdef01234567", "--all", "HEAD"} {
		wantError(t, h.call(t, "GET", testRepo+"/git/commits/"+sha, nil), 404, "not_found")
	}
}

func TestNetworkGitRoutesNeedSignIn(t *testing.T) {
	h := newOpened(t)
	t.Setenv("REVISIONS_GITHUB_TOKEN", "")
	for _, route := range []string{"POST /git/fetch", "POST /git/pull", "POST /git/push", "GET /git/force-push/preview", "POST /pulls"} {
		method, path, _ := strings.Cut(route, " ")
		wantError(t, h.call(t, method, testRepo+path, map[string]string{"title": "x", "expectedRemoteSha": ""}), 401, "auth_required")
	}
	// Local work goes on signed out; pushing is simply not on offer.
	if st := h.status(t); st.Permissions == nil || st.Permissions.Push {
		t.Fatalf("signed-out status: %+v", st.Permissions)
	}
	if log := ok[logBody](t, h.call(t, "GET", testRepo+"/git/log", nil)); len(log.Commits) != 1 || log.Pulls == nil {
		t.Fatalf("signed-out log: %+v", log)
	}
}

// A commit message is the author's to write, and may hold the separator the
// log uses between fields. Such a commit must still be listed, above all in
// the force-push preview that says what will be erased.
func TestForcePushPreviewListsCommitsWithOddSubjects(t *testing.T) {
	h := newOpened(t)
	author := h.authorClone(t)
	write(t, author, "refs.bib", "% odd\n")
	gitIn(t, author, "add", "-A")
	gitIn(t, author, "commit", "--quiet", "-m", "Looks\x1fharmless")
	gitIn(t, author, "push", "--quiet", "origin", "HEAD")
	odd := gitIn(t, author, "rev-parse", "HEAD")
	write(t, h.clone, "main.tex", "the collaborator's version\n")
	h.commit(t, "Rewrite")

	preview := ok[previewBody](t, h.call(t, "GET", testRepo+"/git/force-push/preview", nil))
	if !slices.Equal(shas(preview.Commits), []string{odd}) || preview.Commits[0].Subject != "Looks\x1fharmless" {
		t.Fatalf("preview = %+v, want the commit %s", preview.Commits, odd)
	}
	found := false
	for _, c := range ok[logBody](t, h.call(t, "GET", testRepo+"/git/log", nil)).Commits {
		found = found || c.SHA == odd
	}
	if !found {
		t.Error("the log leaves the commit out")
	}
}
