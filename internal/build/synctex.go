package build

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/ryan-ressmeyer/revisions/internal/workspace"
)

// ErrNoPDF reports a SyncTeX query before any build has succeeded.
var ErrNoPDF = errors.New("no PDF has been built")

// ErrNoMatch reports a SyncTeX query that has no counterpart: a source file
// the PDF was not built from, or a PDF location that comes from a file outside
// the repository.
var ErrNoMatch = errors.New("no matching location")

// Box is a rectangle on a PDF page, in points from the page's top-left corner.
type Box struct {
	Page   int     `json:"page"` // 1-based
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// Location is a place in a source file.
type Location struct {
	Path   string `json:"path"`   // relative to the repository root
	Line   int    `json:"line"`   // 1-based
	Column int    `json:"column"` // 0-based; 0 when SyncTeX does not know it
}

// synctex runs the synctex program against the good PDF of a repository, in
// the directory of the entry file that PDF was built from, and returns the
// fields of the first result it prints. args builds the arguments from the
// PDF's path and the working directory.
func (b *Builder) synctex(id workspace.RepoID, root, program string, args func(pdf, entryDir string) []string) (fields map[string]string, entryDir string, err error) {
	b.good.RLock()
	defer b.good.RUnlock()
	meta := b.meta(id)
	if meta.PDFVersion == 0 {
		return nil, "", ErrNoPDF
	}
	entryDir = filepath.Join(root, filepath.FromSlash(path.Dir(meta.Entry)))

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, program, args(filepath.Join(b.dir(id, "good"), meta.PDF), entryDir)...)
	cmd.Dir = entryDir
	out, err := cmd.Output()
	if err != nil {
		return nil, "", fmt.Errorf("synctex: %w", err)
	}

	// The output is "SyncTeX result begin", then Key:Value lines, with every
	// further result starting at another "Output:" line.
	fields = map[string]string{}
	for line := range strings.Lines(string(out)) {
		key, value, ok := strings.Cut(strings.TrimRight(line, "\r\n"), ":")
		if !ok {
			continue
		}
		if key == "Output" && len(fields) > 0 {
			break
		}
		fields[key] = value
	}
	return fields, entryDir, nil
}

// Forward finds where a source position appears in the good PDF. file is
// relative to the repository root.
func (b *Builder) Forward(id workspace.RepoID, root, program, file string, line, column int) (Box, error) {
	fields, _, err := b.synctex(id, root, program, func(pdf, entryDir string) []string {
		// A name relative to the working directory is completed by synctex
		// with the real path of that directory, which is what TeX recorded.
		input, err := filepath.Rel(entryDir, filepath.Join(root, filepath.FromSlash(file)))
		if err != nil {
			input = file
		}
		return []string{"view", "-i", fmt.Sprintf("%d:%d:%s", line, column, input), "-o", pdf}
	})
	if err != nil {
		return Box{}, err
	}
	page, pageErr := strconv.Atoi(fields["Page"])
	var n [4]float64
	for i, key := range []string{"h", "v", "W", "H"} {
		if n[i], err = strconv.ParseFloat(fields[key], 64); err != nil || pageErr != nil {
			return Box{}, ErrNoMatch
		}
	}
	// h and v are the left edge and the bottom of the box; H is its full
	// height.
	return Box{Page: page, X: n[0], Y: n[1] - n[3], Width: n[2], Height: n[3]}, nil
}

// Inverse finds the source position behind a point on a page of the good
// PDF. x and y are in points from the page's top-left corner.
func (b *Builder) Inverse(id workspace.RepoID, root, program string, page int, x, y float64) (Location, error) {
	fields, entryDir, err := b.synctex(id, root, program, func(pdf, _ string) []string {
		return []string{"edit", "-o", fmt.Sprintf("%d:%g:%g:%s", page, x, y, pdf)}
	})
	if err != nil {
		return Location{}, err
	}
	line, err := strconv.Atoi(fields["Line"])
	rel, ok := repoRelative(root, entryDir, fields["Input"])
	if err != nil || !ok {
		return Location{}, ErrNoMatch
	}
	column, _ := strconv.Atoi(fields["Column"])
	return Location{Path: rel, Line: line, Column: max(column, 0)}, nil
}
