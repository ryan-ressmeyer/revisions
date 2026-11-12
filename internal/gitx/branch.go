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
	if err := checkBranch(name); err != nil {
		return err
	}
	if _, err := git(ctx, dir, "check-ref-format", "refs/heads/"+name); err != nil {
		return ErrBadBranch
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
