package gitx

import (
	"context"
	"errors"
	"strconv"
	"strings"
)

// ErrBadBranch reports a name that cannot be a branch.
var ErrBadBranch = errors.New("not a valid branch name")

// checkBranch keeps a name from being read as an option.
func checkBranch(name string) error {
	if name == "" || strings.HasPrefix(name, "-") {
		return ErrBadBranch
	}
	return nil
}

// CheckBranchName returns ErrBadBranch unless name can be a local branch.
// Such a name holds no glob character, space, or control character.
func CheckBranchName(ctx context.Context, dir, name string) error {
	if err := checkBranch(name); err != nil {
		return err
	}
	if _, err := git(ctx, dir, "check-ref-format", "refs/heads/"+name); err != nil {
		return ErrBadBranch
	}
	return nil
}

// OnlyOn lists the commits of the local branch name, whose tip is head, that
// no other local branch, remote-tracking branch, or pull-request reference
// holds. name must have passed CheckBranchName.
func OnlyOn(ctx context.Context, dir, name, head string) ([]LogCommit, error) {
	// --exclude names a branch without refs/heads/ for --branches; a valid
	// branch name holds no glob character, so it matches only itself.
	return log(ctx, dir, head, "--not", "--exclude="+name, "--branches", "--remotes", "--glob=refs/pull/*")
}

// NotOnRemote lists the commits reachable from HEAD or a local branch and
// from no remote-tracking branch or pull-request reference: those that
// deleting the clone would lose. head is "" before the first commit.
func NotOnRemote(ctx context.Context, dir, head string) ([]LogCommit, error) {
	revs := []string{"--branches", "--not", "--remotes", "--glob=refs/pull/*"}
	if head != "" {
		revs = append([]string{head}, revs...)
	}
	return log(ctx, dir, revs...)
}

// DeleteBranch deletes the local branch name only while it points at head,
// then removes its tracking configuration (branch.<name>.*).
func DeleteBranch(ctx context.Context, dir, name, head string) error {
	if _, err := git(ctx, dir, "update-ref", "-d", "refs/heads/"+name, head); err != nil {
		return err
	}
	_, err := git(ctx, dir, "config", "--remove-section", "branch."+name)
	var e *Error
	if errors.As(err, &e) && strings.Contains(e.Stderr, "no such section") {
		return nil
	}
	return err
}

// MoveBranch points the local branch name at the commit to, only while it
// still points at old.
func MoveBranch(ctx context.Context, dir, name, to, old string) error {
	_, err := git(ctx, dir, "update-ref", "refs/heads/"+name, to, old)
	return err
}

// Finished is a local branch whose GitHub branch was removed and whose commits
// GitHub keeps all of.
type Finished struct {
	Name string
	Head string
	Pull int // a pull request whose reference holds Head, or 0
}

// FinishedBranches lists the finished branches: each tracked a branch of
// origin that is now gone, and has no commit outside the remote-tracking
// branches and pull-request references. skip, the current branch when it has
// uncommitted changes, is left out.
func FinishedBranches(ctx context.Context, dir, skip string) ([]Finished, error) {
	out, err := git(ctx, dir, "for-each-ref", "--format=%(refname:strip=2) %(objectname) %(upstream) %(upstream:track)", "refs/heads")
	if err != nil {
		return nil, err
	}
	finished := []Finished{}
	for line := range strings.Lines(out) {
		// Ref names hold no spaces, so the fields split cleanly.
		f := strings.SplitN(strings.TrimSpace(line), " ", 4)
		if len(f) != 4 || f[0] == skip || !strings.HasPrefix(f[2], "refs/remotes/origin/") || f[3] != "[gone]" {
			continue
		}
		unsent, err := git(ctx, dir, "rev-list", "--count", f[1], "--not", "--remotes", "--glob=refs/pull/*")
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(unsent) != "0" {
			continue
		}
		b := Finished{Name: f[0], Head: f[1]}
		pulls, err := git(ctx, dir, "for-each-ref", "--contains="+f[1], "--format=%(refname)", "refs/pull/")
		if err != nil {
			return nil, err
		}
		for ref := range strings.Lines(pulls) {
			n, _ := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(ref), "refs/pull/"), "/head"))
			b.Pull = max(b.Pull, n) // the newest pull request
		}
		finished = append(finished, b)
	}
	return finished, nil
}

// Switch checks out the existing local branch.
func Switch(ctx context.Context, dir, branch string) error {
	if err := checkBranch(branch); err != nil {
		return err
	}
	_, err := git(ctx, dir, "switch", "--quiet", "--no-guess", branch)
	return err
}

// CreateBranch creates the branch and switches to it; uncommitted changes
// carry over. With start "" the branch begins at HEAD. Otherwise it begins at
// the ref start, which becomes its upstream when track is set.
func CreateBranch(ctx context.Context, dir, name, start string, track bool) error {
	if err := CheckBranchName(ctx, dir, name); err != nil {
		return err
	}
	args := []string{"switch", "--quiet", "-c", name}
	if start != "" {
		mode := "--no-track"
		if track {
			mode = "--track"
		}
		args = append(args, mode, start)
	}
	_, err := git(ctx, dir, args...)
	return err
}

// Detach checks out the commit sha with no branch.
func Detach(ctx context.Context, dir, sha string) error {
	_, err := git(ctx, dir, "switch", "--quiet", "--detach", "--end-of-options", sha)
	return err
}

// ReturnBranch is where a detached HEAD goes back to: the branch most recently
// checked out that still exists here, else origin's default branch, else "".
//
// ponytail: looks back 20 checkouts through Git's @{-n}; after more snapshot
// hops than that it offers the default branch. Parse the HEAD reflog in one
// call if anyone ever hops further.
func ReturnBranch(ctx context.Context, dir string) string {
	for n := 1; n <= 20; n++ {
		out, err := git(ctx, dir, "rev-parse", "--symbolic-full-name", "@{-"+strconv.Itoa(n)+"}")
		if err != nil {
			break // no older checkout, or one of a branch since deleted
		}
		// A detached checkout prints nothing.
		if name, ok := strings.CutPrefix(strings.TrimSpace(out), "refs/heads/"); ok {
			if _, exists, _ := Resolve(ctx, dir, "refs/heads/"+name); exists {
				return name
			}
		}
	}
	return DefaultBranch(ctx, dir)
}

// DefaultBranch is origin's default branch as of the clone or the last
// `remote set-head` (refs/remotes/origin/HEAD), or "" when unknown.
func DefaultBranch(ctx context.Context, dir string) string {
	out, err := git(ctx, dir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimPrefix(strings.TrimSpace(out), "origin/")
}

// HeadCommit describes the commit HEAD is on.
func HeadCommit(ctx context.Context, dir string) (LogCommit, error) {
	commits, err := log(ctx, dir, "--max-count=1", "HEAD")
	if err == nil && len(commits) == 0 {
		err = &Error{Command: "log", Stderr: "no commit at HEAD"}
	}
	if err != nil {
		return LogCommit{}, err
	}
	return commits[0], nil
}

// FastForward moves the current branch forward to ref.
func FastForward(ctx context.Context, dir, ref string) error {
	_, err := git(ctx, dir, "merge", "--quiet", "--ff-only", "--end-of-options", ref)
	return err
}
