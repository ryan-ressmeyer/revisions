// Package workspace owns where Revisions keeps things on disk and how a
// repository id maps to a clone directory. See "Locations on disk" in
// specs/architecture.md.
package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// ErrNotFound reports a repository id that is invalid or has no local clone.
var ErrNotFound = errors.New("repository not found")

// Paths are the three absolute root directories Revisions uses.
type Paths struct {
	Home      string // clones live at Home/<host>/<owner>/<name>
	ConfigDir string // settings and local state
	CacheDir  string // build output lives under CacheDir/build
}

// PathsFromEnv resolves the roots from REVISIONS_HOME, REVISIONS_CONFIG_DIR,
// and REVISIONS_CACHE_DIR, falling back to the per-user defaults.
func PathsFromEnv() (Paths, error) {
	home, err := root("REVISIONS_HOME", os.UserHomeDir, "Revisions")
	if err != nil {
		return Paths{}, err
	}
	config, err := root("REVISIONS_CONFIG_DIR", os.UserConfigDir, "revisions")
	if err != nil {
		return Paths{}, err
	}
	cache, err := root("REVISIONS_CACHE_DIR", os.UserCacheDir, "revisions")
	if err != nil {
		return Paths{}, err
	}
	return Paths{Home: home, ConfigDir: config, CacheDir: cache}, nil
}

func root(env string, base func() (string, error), name string) (string, error) {
	if dir := os.Getenv(env); dir != "" {
		return filepath.Abs(dir)
	}
	dir, err := base()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, name), nil
}

// RepoID identifies a repository as <host>/<owner>/<name>.
type RepoID struct{ Host, Owner, Name string }

// A segment becomes a directory name on every platform, so it is limited to
// characters that are safe everywhere. Refusing a trailing dot refuses "." and
// "..", and names that Windows would silently rename.
var segment = regexp.MustCompile(`^[A-Za-z0-9._-]*[A-Za-z0-9_-]$`)

// NewRepoID validates the three segments of a repository id.
func NewRepoID(host, owner, name string) (RepoID, error) {
	for _, s := range []string{host, owner, name} {
		if len(s) > 100 || !segment.MatchString(s) {
			return RepoID{}, errors.New("invalid repository id")
		}
	}
	return RepoID{Host: host, Owner: owner, Name: name}, nil
}

// ParseRepoID parses "<host>/<owner>/<name>".
func ParseRepoID(s string) (RepoID, error) {
	parts := strings.Split(s, "/")
	if len(parts) != 3 {
		return RepoID{}, errors.New("invalid repository id")
	}
	return NewRepoID(parts[0], parts[1], parts[2])
}

func (id RepoID) String() string { return id.Host + "/" + id.Owner + "/" + id.Name }

// CloneDir is where the repository's clone lives. It does not check that the
// clone exists.
func (p Paths) CloneDir(id RepoID) string {
	return filepath.Join(p.Home, id.Host, id.Owner, id.Name)
}

// Clone validates the segments and returns the id and its clone directory.
// It returns ErrNotFound when the id is invalid or the directory is absent.
func (p Paths) Clone(host, owner, name string) (RepoID, string, error) {
	id, err := NewRepoID(host, owner, name)
	if err != nil {
		return RepoID{}, "", ErrNotFound
	}
	dir := p.CloneDir(id)
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() {
		return RepoID{}, "", ErrNotFound
	}
	return id, dir, nil
}
