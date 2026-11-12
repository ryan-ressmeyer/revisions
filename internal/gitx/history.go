package gitx

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// LogCommit is one commit in a log. Refs holds "HEAD" and the full names of the
// branches at this commit, such as "refs/heads/main" and
// "refs/remotes/origin/main".
type LogCommit struct {
	SHA        string   `json:"sha"`
	Parents    []string `json:"parents"`
	AuthorName string   `json:"authorName"`
	Date       string   `json:"date"` // author date, ISO 8601
	Subject    string   `json:"subject"`
	Refs       []string `json:"refs"`
}

// log runs git log over revs, which the caller builds from trusted parts,
// and parses it. Fields are separated by the unit separator and commits by
// NUL. A subject may itself hold a unit separator, so it comes last and keeps
// whatever follows.
func log(ctx context.Context, dir string, revs ...string) ([]LogCommit, error) {
	args := append([]string{"log", "-z", "--date-order", "--format=%H%x1f%P%x1f%an%x1f%aI%x1f%s"}, revs...)
	out, err := git(ctx, dir, args...)
	commits := []LogCommit{}
	for record := range strings.SplitSeq(out, "\x00") {
		if f := strings.SplitN(record, "\x1f", 5); len(f) == 5 {
			commits = append(commits, LogCommit{SHA: f[0], Parents: strings.Fields(f[1]), AuthorName: f[2], Date: f[3], Subject: f[4], Refs: []string{}})
		}
	}
	for i := range commits {
		if commits[i].Parents == nil {
			commits[i].Parents = []string{}
		}
	}
	return commits, err
}

// Log returns the newest limit commits reachable from HEAD and from every
// local and remote branch, children before parents.
func Log(ctx context.Context, dir string, limit int) ([]LogCommit, error) {
	head, hasHead, err := Resolve(ctx, dir, "HEAD")
	if err != nil {
		return nil, err
	}
	refs := map[string][]string{}
	if hasHead {
		refs[head] = []string{"HEAD"}
	}
	out, err := git(ctx, dir, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/remotes")
	if err != nil {
		return nil, err
	}
	for line := range strings.Lines(out) {
		// refs/remotes/origin/HEAD only repeats the remote's default branch.
		if sha, ref, ok := strings.Cut(strings.TrimSpace(line), " "); ok && !strings.HasSuffix(ref, "/HEAD") {
			refs[sha] = append(refs[sha], ref)
		}
	}
	if len(refs) == 0 {
		return []LogCommit{}, nil // nothing committed or fetched yet
	}

	revs := []string{"--max-count=" + strconv.Itoa(limit), "--branches", "--remotes"}
	if hasHead {
		revs = append(revs, "HEAD")
	}
	commits, err := log(ctx, dir, revs...)
	for i, c := range commits {
		if names := refs[c.SHA]; names != nil {
			commits[i].Refs = names
		}
	}
	return commits, err
}

// ForcePushPreview returns where origin's copy of branch sits ("" when origin
// has no such branch) and the commits there that HEAD lacks: the ones a
// force-push erases. Fetch first.
func ForcePushPreview(ctx context.Context, dir, branch string) (string, []LogCommit, error) {
	remote := "refs/remotes/origin/" + branch
	sha, found, err := Resolve(ctx, dir, remote)
	if err != nil || !found {
		return "", []LogCommit{}, err
	}
	erased, err := log(ctx, dir, remote, "^HEAD")
	return sha, erased, err
}

// CommitDetail is one commit with its full message and diff.
type CommitDetail struct {
	SHA        string `json:"sha"`
	Message    string `json:"message"`
	AuthorName string `json:"authorName"`
	Date       string `json:"date"`
	Diff       string `json:"diff"`
}

// Show describes the commit sha, which may be abbreviated. It returns false
// when the clone has no such commit.
func Show(ctx context.Context, dir, sha string) (CommitDetail, bool, error) {
	full, found, err := Resolve(ctx, dir, sha+"^{commit}")
	if err != nil || !found {
		return CommitDetail{}, false, err
	}
	out, err := git(ctx, dir, "log", "-1", "--format=%H%x1f%an%x1f%aI%x1f%B", "--end-of-options", full)
	if err != nil {
		return CommitDetail{}, false, err
	}
	f := strings.SplitN(out, "\x1f", 4)
	if len(f) != 4 {
		return CommitDetail{}, false, &Error{Command: "log", Stderr: "unexpected output"}
	}
	diff, err := git(ctx, dir, "show", "--format=", "--patch", "--no-color", "--no-ext-diff", "--end-of-options", full)
	return CommitDetail{SHA: f[0], AuthorName: f[1], Date: f[2], Message: strings.TrimRight(f[3], "\n"), Diff: diff}, true, err
}

// Diff returns the unified diff of the working tree against HEAD, untracked
// files included and ignored files not. With path it covers that one path,
// taken literally. The clone's own index is left alone: the diff is computed
// through a scratch copy of it.
func Diff(ctx context.Context, dir, path string) (string, error) {
	scratch, err := os.MkdirTemp("", "revisions-index-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(scratch)
	index := filepath.Join(scratch, "index")
	// Starting from the real index keeps Git from re-reading unchanged files.
	if out, err := git(ctx, dir, "rev-parse", "--absolute-git-dir"); err != nil {
		return "", err
	} else if data, err := os.ReadFile(filepath.Join(strings.TrimSpace(out), "index")); err == nil {
		if err := os.WriteFile(index, data, 0o600); err != nil {
			return "", err
		}
	}
	env := []string{"GIT_INDEX_FILE=" + index}
	if _, err := run(ctx, dir, Auth{}, env, "add", "-A"); err != nil {
		return "", err
	}
	args := []string{"--literal-pathspecs", "diff", "--cached", "--no-color", "--no-ext-diff"}
	if path != "" {
		args = append(args, "--", path)
	}
	return run(ctx, dir, Auth{}, env, args...)
}

// Discard restores every tracked file to HEAD and deletes untracked files
// that are not ignored, which is exactly what Diff shows. It also ends a
// merge in progress.
func Discard(ctx context.Context, dir string) error {
	if _, err := git(ctx, dir, "reset", "--quiet", "--hard"); err != nil {
		return err
	}
	_, err := git(ctx, dir, "clean", "--quiet", "-fd")
	return err
}

// Merge merges ref into the current branch. Stopping on a conflict is not an
// error: GetStatus then reports Merging and Conflicts. fallback is the
// identity for a merge commit when Git has none configured.
func Merge(ctx context.Context, dir, ref string, fallback Identity) error {
	_, err := run(ctx, dir, Auth{}, identityEnv(ctx, dir, fallback), "merge", "--quiet", "--no-edit", "--end-of-options", ref)
	if err != nil {
		if _, merging, _ := Resolve(ctx, dir, "MERGE_HEAD"); merging {
			return nil
		}
	}
	return err
}

// MergeAbort abandons the merge in progress.
func MergeAbort(ctx context.Context, dir string) error {
	_, err := git(ctx, dir, "merge", "--abort")
	return err
}
