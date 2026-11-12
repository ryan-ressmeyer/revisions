package update

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		current, latest string
		want            bool
	}{
		{"v0.1.0", "v0.2.0", true},
		{"v0.9.0", "v0.10.0", true}, // numbers, not text
		{"v0.10.0", "v0.9.0", false},
		{"v1.0.0", "v0.99.99", false}, // never a downgrade
		{"v0.1.0", "v0.1.0", false},
		{"v0.1.9", "v0.1.10", true},
		{"v0.1.0", "v1.0.0", true},
		{"v0.1.0", "v0.2.0-rc1", false}, // never a pre-release
		{"v0.1.0", "0.2.0", false},
		{"v0.1.0", "v0.2", false},
		{"v0.1.0", "", false},
		{"v0.1.0", "v0.2.0/../../x", false},
		{"dev", "v9.0.0", false}, // a build without a release version never updates
		{"v0.1.0-test", "v9.0.0", false},
	} {
		if got := Newer(c.current, c.latest); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", c.current, c.latest, got, c.want)
		}
	}
}

// release serves a release the way GitHub does: the latest-release API at
// /latest and the assets at /download/<tag>/<name>. The test override points
// Latest and Install at it.
type release struct {
	tag    string
	assets map[string][]byte
	asked  []*http.Request
}

func serve(t *testing.T, r *release) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.asked = append(r.asked, req)
		if req.URL.Path == "/latest" {
			fmt.Fprintf(w, `{"tag_name": %q, "html_url": "https://example.invalid", "prerelease": false}`, r.tag)
			return
		}
		b, ok := r.assets[strings.TrimPrefix(req.URL.Path, "/download/"+r.tag+"/")]
		if !ok {
			http.NotFound(w, req)
			return
		}
		w.Write(b)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("REVISIONS_RELEASES_URL", srv.URL)
}

var asset = "revisions-" + runtime.GOOS + "-" + runtime.GOARCH + map[bool]string{true: ".exe"}[runtime.GOOS == "windows"]

// newRelease holds program as this platform's asset, with matching checksums.
func newRelease(program []byte) *release {
	sums := fmt.Sprintf("%x  revisions-other-arch\n%x  %s\n", sha256.Sum256([]byte("x")), sha256.Sum256(program), asset)
	return &release{tag: "v0.2.0", assets: map[string][]byte{asset: program, "SHA256SUMS": []byte(sums)}}
}

// installed writes a stand-in for the running program and returns its path.
func installed(t *testing.T) string {
	t.Helper()
	exe := filepath.Join(t.TempDir(), "revisions"+map[bool]string{true: ".exe"}[runtime.GOOS == "windows"])
	if err := os.WriteFile(exe, []byte("old program"), 0o755); err != nil {
		t.Fatal(err)
	}
	return exe
}

// unchanged fails unless exe still holds the old program and nothing else
// was left in its folder.
func unchanged(t *testing.T, exe string) {
	t.Helper()
	if b, _ := os.ReadFile(exe); string(b) != "old program" {
		t.Fatalf("the program was changed to %q", b)
	}
	entries, _ := os.ReadDir(filepath.Dir(exe))
	if len(entries) != 1 {
		t.Fatalf("the folder holds %v", entries)
	}
}

func TestLatestAsksForThePublishedReleaseAndSendsNothingElse(t *testing.T) {
	r := &release{tag: "v0.3.1"}
	serve(t, r)
	t.Setenv("REVISIONS_GITHUB_TOKEN", "secret")
	got, err := Latest(t.Context())
	if err != nil || got != "v0.3.1" {
		t.Fatalf("Latest = %q, %v", got, err)
	}
	req := r.asked[0]
	if req.Method != "GET" || req.URL.Path != "/latest" || req.URL.RawQuery != "" {
		t.Errorf("asked %s %s", req.Method, req.URL)
	}
	for name := range req.Header {
		switch name {
		case "Accept", "Accept-Encoding", "User-Agent":
		default:
			t.Errorf("sent header %s: %q", name, req.Header.Get(name))
		}
	}
	if ua := req.Header.Get("User-Agent"); ua != "revisions" {
		t.Errorf("User-Agent %q", ua)
	}
}

func TestInstallReplacesTheProgram(t *testing.T) {
	serve(t, newRelease([]byte("new program")))
	exe := installed(t)
	if err := Install(t.Context(), "v0.2.0", exe); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "new program" {
		t.Fatalf("the program is %q", b)
	}
	info, _ := os.Stat(exe)
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o755 {
		t.Errorf("mode %v", info.Mode())
	}
	// On Windows the running program is moved aside to revisions.exe.old;
	// Cleanup removes it once that program has exited.
	Cleanup(exe)
	if entries, _ := os.ReadDir(filepath.Dir(exe)); len(entries) != 1 {
		t.Fatalf("left behind %v", entries)
	}
}

func TestInstallRefusesABadChecksum(t *testing.T) {
	r := newRelease([]byte("new program"))
	r.assets[asset] = []byte("tampered program")
	serve(t, r)
	exe := installed(t)
	err := Install(t.Context(), "v0.2.0", exe)
	if err == nil || !strings.Contains(err.Error(), "checksum") || !strings.Contains(err.Error(), "Nothing was changed") {
		t.Fatalf("got %v", err)
	}
	unchanged(t, exe)
}

func TestInstallRefusesAReleaseWithoutThisPlatform(t *testing.T) {
	r := newRelease([]byte("new program"))
	delete(r.assets, asset)
	serve(t, r)
	exe := installed(t)
	err := Install(t.Context(), "v0.2.0", exe)
	if err == nil || !strings.Contains(err.Error(), "Nothing was changed") {
		t.Fatalf("got %v", err)
	}
	unchanged(t, exe)

	// Nor a checksum file that does not list it.
	r = newRelease([]byte("new program"))
	r.assets["SHA256SUMS"] = []byte("0000  revisions-other-arch\n")
	serve(t, r)
	if err := Install(t.Context(), "v0.2.0", exe); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("got %v", err)
	}
	unchanged(t, exe)
}

func TestInstallSaysWhenTheFolderIsNotWritable(t *testing.T) {
	if runtime.GOOS == "windows" || os.Getuid() == 0 {
		t.Skip("needs a folder this user cannot write to")
	}
	serve(t, newRelease([]byte("new program")))
	exe := installed(t)
	dir := filepath.Dir(exe)
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o755) })
	err := Install(t.Context(), "v0.2.0", exe)
	if !errors.Is(err, ErrNotWritable) || !strings.Contains(err.Error(), dir) {
		t.Fatalf("got %v", err)
	}
	unchanged(t, exe)
}

func TestTheDefaultsAreTheReleasesOfThePublicRepository(t *testing.T) {
	t.Setenv("REVISIONS_RELEASES_URL", "")
	latest, download := urls()
	if latest != "https://api.github.com/repos/ryan-ressmeyer/revisions/releases/latest" ||
		download != "https://github.com/ryan-ressmeyer/revisions/releases/download" {
		t.Fatalf("got %s and %s", latest, download)
	}
	if got := NotesURL("v0.2.0"); got != "https://github.com/ryan-ressmeyer/revisions/releases/tag/v0.2.0" {
		t.Fatalf("notes at %s", got)
	}
	if !strings.Contains(Command(), "https://github.com/ryan-ressmeyer/revisions/releases/latest/download/install.") {
		t.Fatalf("command %q", Command())
	}
}
