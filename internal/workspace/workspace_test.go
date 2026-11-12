package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestPathsFromEnvOverrides(t *testing.T) {
	home, config, cache := t.TempDir(), t.TempDir(), t.TempDir()
	t.Setenv("REVISIONS_HOME", home)
	t.Setenv("REVISIONS_CONFIG_DIR", config)
	t.Setenv("REVISIONS_CACHE_DIR", cache)

	p, err := PathsFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if p != (Paths{Home: home, ConfigDir: config, CacheDir: cache}) {
		t.Fatalf("got %+v", p)
	}
}

func TestPathsFromEnvDefaults(t *testing.T) {
	t.Setenv("REVISIONS_HOME", "")
	t.Setenv("REVISIONS_CONFIG_DIR", "")
	t.Setenv("REVISIONS_CACHE_DIR", "")
	userHome, _ := os.UserHomeDir()
	userConfig, _ := os.UserConfigDir()
	userCache, _ := os.UserCacheDir()

	p, err := PathsFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	want := Paths{
		Home:      filepath.Join(userHome, "Revisions"),
		ConfigDir: filepath.Join(userConfig, "revisions"),
		CacheDir:  filepath.Join(userCache, "revisions"),
	}
	if p != want {
		t.Fatalf("got %+v, want %+v", p, want)
	}
}

func TestPathsFromEnvMakesOverridesAbsolute(t *testing.T) {
	t.Setenv("REVISIONS_HOME", "relative-home")
	p, err := PathsFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(p.Home) || filepath.Base(p.Home) != "relative-home" {
		t.Fatalf("Home = %q, want an absolute path ending in relative-home", p.Home)
	}
}

func TestParseRepoID(t *testing.T) {
	for _, s := range []string{
		"github.com/ryan-ressmeyer/OpenIrisDPI",
		"github.com/owner/.github",
		"git.example.org/some_owner/name.tex",
	} {
		id, err := ParseRepoID(s)
		if err != nil {
			t.Errorf("ParseRepoID(%q): %v", s, err)
		}
		if id.String() != s {
			t.Errorf("ParseRepoID(%q).String() = %q", s, id.String())
		}
	}
}

func TestParseRepoIDRejects(t *testing.T) {
	for _, s := range []string{
		"",
		"github.com/owner",
		"github.com/owner/name/extra",
		"github.com//name",
		"github.com/./name",
		"github.com/../name",
		"github.com/owner/..",
		"github.com/owner/...",
		"github.com/owner/name.",
		`github.com/own\er/name`,
		"github.com/owner/na me",
		"github.com/owner/na%2Fme",
		"github.com:443/owner/name",
		"github.com/owner/C:name",
		"github.com/owner/näme",
	} {
		if id, err := ParseRepoID(s); err == nil {
			t.Errorf("ParseRepoID(%q) = %+v, want an error", s, id)
		}
	}
}

func TestCloneDir(t *testing.T) {
	p := Paths{Home: filepath.Join("x", "Revisions")}
	id := RepoID{Host: "github.com", Owner: "owner", Name: "name"}
	want := filepath.Join("x", "Revisions", "github.com", "owner", "name")
	if got := p.CloneDir(id); got != want {
		t.Fatalf("CloneDir = %q, want %q", got, want)
	}
}

func TestClone(t *testing.T) {
	p := Paths{Home: t.TempDir()}
	dir := filepath.Join(p.Home, "github.com", "owner", "name")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	id, got, err := p.Clone("github.com", "owner", "name")
	if err != nil || got != dir || id.String() != "github.com/owner/name" {
		t.Fatalf("Clone = %v, %q, %v", id, got, err)
	}
	// A valid id with no clone, and an id that would escape the clone root.
	for _, parts := range [][3]string{{"github.com", "owner", "absent"}, {"github.com", "..", "name"}} {
		if _, _, err := p.Clone(parts[0], parts[1], parts[2]); !errors.Is(err, ErrNotFound) {
			t.Errorf("Clone(%v) error = %v, want ErrNotFound", parts, err)
		}
	}
}
