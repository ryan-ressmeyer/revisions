// Package build runs latexmk outside the repository, keeps the last good PDF,
// and answers SyncTeX queries against it. See "Builds" in
// specs/architecture.md.
package build

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
)

// FindTool returns the absolute path of a TeX program such as latexmk or
// synctex, or "" when it is not installed. It searches PATH and then the
// standard install directories, because a server started before TeX was
// installed does not see the updated PATH.
func FindTool(name string) string { return findTool(name, wellKnownGlobs()) }

func findTool(name string, globs []string) string {
	if p, err := exec.LookPath(name); err == nil {
		if abs, err := filepath.Abs(p); err == nil {
			return abs
		}
	}
	for _, glob := range globs {
		dirs, _ := filepath.Glob(glob)
		slices.Sort(dirs)
		slices.Reverse(dirs) // /usr/local/texlive/2026 before /usr/local/texlive/2025
		for _, dir := range dirs {
			// With a directory in the name, LookPath checks that one file,
			// including the Windows executable extensions.
			if p, err := exec.LookPath(filepath.Join(dir, name)); err == nil {
				return p
			}
		}
	}
	return ""
}

// wellKnownGlobs lists where MacTeX, TeX Live, TinyTeX, and MiKTeX put their
// programs.
func wellKnownGlobs() []string {
	globs := []string{
		"/Library/TeX/texbin",
		"/usr/local/texlive/*/bin/*",
		`C:\texlive\*\bin\*`,
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		globs = append(globs,
			filepath.Join(home, "Library", "TinyTeX", "bin", "*"),
			filepath.Join(home, "bin"), // MiKTeX on macOS and Linux links its programs here
		)
	}
	for _, env := range []string{"LOCALAPPDATA", "ProgramFiles"} {
		if dir := os.Getenv(env); dir != "" {
			globs = append(globs,
				filepath.Join(dir, "Programs", "MiKTeX", "miktex", "bin", "x64"),
				filepath.Join(dir, "MiKTeX", "miktex", "bin", "x64"),
			)
		}
	}
	return globs
}
