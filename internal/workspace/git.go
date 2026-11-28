package workspace

import (
	"context"
	"strconv"
	"strings"

	"github.com/ryan-ressmeyer/revisions/internal/gitx"
)

// ErrGitMissing reports that the git program is not installed.
var ErrGitMissing = gitx.ErrMissing

// runGit runs the read-only queries that the project, state, and build
// routes need, through gitx like every other Git call.
func runGit(dir string, args ...string) ([]byte, error) {
	out, err := gitx.Run(context.Background(), dir, args...)
	return []byte(out), err
}

// GitState is the part of the Git status that the UI polls.
type GitState struct {
	Head   string  `json:"head"`   // commit SHA, empty before the first commit
	Branch *string `json:"branch"` // nil on a detached HEAD
	Dirty  bool    `json:"dirty"`  // any tracked change or untracked, non-ignored file
	Unsent int     `json:"unsent"` // commits GitHub keeps nowhere; 0 on a detached HEAD
	Behind int     `json:"behind"` // upstream commits the branch lacks, as of the last fetch
}

// GitStatus reads the head commit, the branch, whether the working tree has
// uncommitted changes, and how many commits are unsent or waiting on GitHub.
func GitStatus(root string) (GitState, error) {
	out, err := runGit(root, "status", "--porcelain=v2", "--branch", "-z")
	if err != nil {
		return GitState{}, err
	}
	var st GitState
	for record := range strings.SplitSeq(string(out), "\x00") {
		switch {
		case record == "":
		case strings.HasPrefix(record, "# branch.oid "):
			if oid := strings.TrimPrefix(record, "# branch.oid "); oid != "(initial)" {
				st.Head = oid
			}
		case strings.HasPrefix(record, "# branch.ab "):
			// Present only while the upstream exists: "+<ahead> -<behind>".
			_, behind, _ := strings.Cut(record, " -")
			st.Behind, _ = strconv.Atoi(behind)
		case strings.HasPrefix(record, "# branch.head "):
			if name := strings.TrimPrefix(record, "# branch.head "); name != "(detached)" {
				st.Branch = &name
			}
		case !strings.HasPrefix(record, "# "):
			st.Dirty = true
		}
	}
	if st.Branch != nil {
		st.Unsent, err = gitx.Unsent(context.Background(), root, *st.Branch, st.Head)
	}
	return st, err
}

// RefreshIndex records the current size and time of unchanged files in Git's
// index. Status polls run without Git's lock and cannot do that themselves,
// so a stale index (a copied or restored clone) would make each of them
// rehash every file. Failure, for example because another Git command holds
// the lock, is ignored.
func RefreshIndex(root string) {
	runGit(root, "update-index", "-q", "--refresh")
}
