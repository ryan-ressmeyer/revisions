package gitx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// FileStatus is one changed path. Status is "modified", "added", "deleted",
// "renamed", "untracked", or "conflicted".
type FileStatus struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

// Status describes the working tree and the current branch.
type Status struct {
	Branch   string // "" on a detached HEAD
	Head     string // "" before the first commit
	Upstream string // for example "origin/main"; "" when the branch has none
	// UpstreamGone is set when the branch tracks a remote branch that no
	// longer exists, for example after its pull request was closed and the
	// branch deleted on GitHub. Upstream is then "".
	UpstreamGone bool
	Ahead        int
	Behind       int
	Files        []FileStatus // every change against HEAD, untracked files included, by path
	Merging      bool
	// Conflicts are the paths Git left unmerged that still hold conflict
	// markers. A merge can be committed once this is empty.
	Conflicts []string
}

// Dirty reports uncommitted work: changed or untracked files, or a merge in
// progress.
func (st Status) Dirty() bool { return len(st.Files) > 0 || st.Merging }

// GetStatus reads the status of the clone in dir.
func GetStatus(ctx context.Context, dir string) (Status, error) {
	st := Status{Files: []FileStatus{}, Conflicts: []string{}}
	out, err := git(ctx, dir, "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all")
	if err != nil {
		return st, err
	}
	records := strings.Split(out, "\x00")
	for i := 0; i < len(records); i++ {
		kind, rest, _ := strings.Cut(records[i], " ")
		// path returns what follows n space-separated fields; a path may hold spaces itself.
		path := func(n int) string {
			fields := strings.SplitN(rest, " ", n+1)
			return fields[len(fields)-1]
		}
		switch kind {
		case "#":
			key, value, _ := strings.Cut(rest, " ")
			switch key {
			case "branch.oid":
				if value != "(initial)" {
					st.Head = value
				}
			case "branch.head":
				if value != "(detached)" {
					st.Branch = value
				}
			case "branch.upstream":
				st.Upstream = value
			case "branch.ab":
				fmt.Sscanf(value, "+%d -%d", &st.Ahead, &st.Behind)
			}
		case "1": // XY sub mH mI mW hH hI path
			status := "modified"
			if xy, _, _ := strings.Cut(rest, " "); strings.Contains(xy, "A") {
				status = "added"
			} else if strings.Contains(xy, "D") {
				status = "deleted"
			}
			st.Files = append(st.Files, FileStatus{path(7), status})
		case "2": // XY sub mH mI mW hH hI Xscore path, then the original path as its own record
			st.Files = append(st.Files, FileStatus{path(8), "renamed"})
			i++
		case "u": // XY sub m1 m2 m3 mW h1 h2 h3 path
			p := path(9)
			file := filepath.Join(dir, filepath.FromSlash(p))
			status := "modified"
			if _, err := os.Lstat(file); err != nil {
				status = "deleted"
			} else if hasConflictMarkers(file) {
				status = "conflicted"
				st.Conflicts = append(st.Conflicts, p)
			}
			st.Files = append(st.Files, FileStatus{p, status})
		case "?":
			st.Files = append(st.Files, FileStatus{rest, "untracked"})
		}
	}
	// Git prints the configured upstream even when its ref is gone, and then
	// leaves out branch.ab, which needs the ref.
	if st.Upstream != "" && !strings.Contains(out, "\x00# branch.ab ") {
		st.Upstream, st.UpstreamGone = "", true
	}
	slices.SortFunc(st.Files, func(a, b FileStatus) int { return strings.Compare(a.Path, b.Path) })
	slices.Sort(st.Conflicts)
	_, st.Merging, err = Resolve(ctx, dir, "MERGE_HEAD")
	return st, err
}

// hasConflictMarkers reports whether the regular file at path has a line
// that starts with Git's "<<<<<<<" or ">>>>>>>" marker.
//
// ponytail: an unmerged path with no markers counts as resolved to whatever is
// in the working tree. That is right for text the user edited and for a file
// one side deleted; a conflicted binary file is silently kept as "ours". Add
// an explicit per-file "resolved" action if manuscripts start conflicting on
// figures.
func hasConflictMarkers(path string) bool {
	if info, err := os.Lstat(path); err != nil || !info.Mode().IsRegular() {
		return false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	for line := range bytes.Lines(data) {
		if bytes.HasPrefix(line, []byte("<<<<<<<")) || bytes.HasPrefix(line, []byte(">>>>>>>")) {
			return true
		}
	}
	return false
}

// Resolve returns the object that rev names, and false when rev names nothing
// in this clone.
func Resolve(ctx context.Context, dir, rev string) (string, bool, error) {
	out, err := git(ctx, dir, "rev-parse", "--quiet", "--verify", "--end-of-options", rev)
	var e *Error
	if errors.As(err, &e) {
		return "", false, nil
	}
	return strings.TrimSpace(out), err == nil, err
}

// IsAncestor reports whether commit a is b or an ancestor of b, which is to
// say whether a branch at a can fast-forward to b.
func IsAncestor(ctx context.Context, dir, a, b string) (bool, error) {
	_, err := git(ctx, dir, "merge-base", "--is-ancestor", a, b)
	if exited(err, 1) {
		return false, nil
	}
	return err == nil, err
}

// RemoteBranchesAt lists the branches of origin whose tip is the commit sha.
func RemoteBranchesAt(ctx context.Context, dir, sha string) ([]string, error) {
	const prefix = "refs/remotes/origin/"
	out, err := git(ctx, dir, "for-each-ref", "--points-at="+sha, "--format=%(refname)", prefix)
	var branches []string
	for ref := range strings.Lines(out) {
		if name := strings.TrimPrefix(strings.TrimSpace(ref), prefix); name != "HEAD" {
			branches = append(branches, name)
		}
	}
	return branches, err
}
