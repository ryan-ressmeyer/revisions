package gitx

import (
	"context"
	"errors"
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

// FastForward moves the current branch forward to ref.
func FastForward(ctx context.Context, dir, ref string) error {
	_, err := git(ctx, dir, "merge", "--quiet", "--ff-only", "--end-of-options", ref)
	return err
}
