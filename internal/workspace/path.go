package workspace

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// ErrBadPath reports a request path that Revisions refuses to touch: one that
// could leave the clone, passes through a symbolic link, lies inside .git, or
// is not a regular file.
var ErrBadPath = errors.New("path refused")

// Resolve maps a repository-relative, forward-slash path to the absolute path
// of an existing regular file inside root. See "Path containment" in
// specs/architecture.md. A missing file gives an error matching
// fs.ErrNotExist; every other refusal gives ErrBadPath.
func Resolve(root, rel string) (string, error) {
	// A backslash or colon means nothing in a repository path, but on Windows
	// they are a separator, a drive letter, or an alternate data stream.
	if rel == "" || strings.ContainsAny(rel, "\\:\x00") {
		return "", ErrBadPath
	}
	parts := strings.Split(rel, "/")
	for _, part := range parts {
		// An empty part covers a leading slash (an absolute path), a doubled
		// slash, and a trailing slash.
		if part == "" || part == "." || part == ".." || strings.EqualFold(part, ".git") {
			return "", ErrBadPath
		}
	}

	// The name check above misses spellings the file system folds into .git
	// (8.3 short names, ignorable Unicode on macOS), so also compare each
	// component with the real .git entry.
	gitInfo, _ := os.Lstat(filepath.Join(root, ".git"))

	p := root
	for i, part := range parts {
		p = filepath.Join(p, part)
		info, err := os.Lstat(p)
		if err != nil {
			// "main.tex/child" fails with ENOTDIR, which is also just absent.
			return "", fmt.Errorf("%s: %w", rel, fs.ErrNotExist)
		}
		last := i == len(parts)-1
		switch {
		case gitInfo != nil && os.SameFile(info, gitInfo):
			return "", ErrBadPath
		case info.Mode()&fs.ModeSymlink != 0:
			return "", ErrBadPath
		case last && !info.Mode().IsRegular():
			return "", ErrBadPath
		case !last && !info.IsDir():
			return "", fmt.Errorf("%s: %w", rel, fs.ErrNotExist)
		}
	}
	return p, nil
}
