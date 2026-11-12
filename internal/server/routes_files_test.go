package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// R is the route prefix of the fixture repository.
const R = "/api/repos/github.com/owner/paper"

func sha(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func writeFiles(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// fixtureRepo puts a committed copy of testdata/manuscript, plus extra files,
// where the server keeps the clone of github.com/owner/paper.
func fixtureRepo(t *testing.T, s *Server, extra map[string]string) string {
	t.Helper()
	root := filepath.Join(s.paths.Home, "github.com", "owner", "paper")
	if err := os.CopyFS(root, os.DirFS(filepath.Join("..", "..", "testdata", "manuscript"))); err != nil {
		t.Fatal(err)
	}
	return plainRepo(t, s, extra)
}

// plainRepo commits files, on top of whatever the clone directory already
// holds, as the clone of github.com/owner/paper.
func plainRepo(t *testing.T, s *Server, files map[string]string) string {
	t.Helper()
	root := filepath.Join(s.paths.Home, "github.com", "owner", "paper")
	writeFiles(t, root, files)
	gitIn(t, root, "init", "-q", "-b", "main")
	gitIn(t, root, "add", "-A")
	gitIn(t, root, "commit", "-q", "-m", "fixture")
	return root
}

// api sends a request the way the UI does: with the page token, the page
// origin, and a JSON body when body is not nil. Extra headers are name, value
// pairs.
func api(t *testing.T, s *Server, method, path string, body any, headers ...string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	switch b := body.(type) {
	case nil:
		reader = bytes.NewReader(nil)
	case string:
		reader = bytes.NewReader([]byte(b))
	default:
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(data)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Host = testHost
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("X-Revisions-Token", pageToken(t, s))
	for i := 0; i < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

// decode reads a 200-class JSON response into T.
func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if rec.Code < 200 || rec.Code > 299 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("body %q: %v", rec.Body, err)
	}
	return v
}

func filePath(path string) string { return R + "/file?path=" + url.QueryEscape(path) }

type saveResult struct {
	Hash    string
	Written bool
}

type projectBody struct {
	Entry           string
	EntryCandidates []string
	EntryFromConfig bool
	Engine          string
	Files           []struct {
		Path, Kind string
		Size       int64
	}
}

// Scenario: Several candidates.
func TestProjectOffersEveryEntryCandidate(t *testing.T) {
	s := newTestServer(t)
	root := fixtureRepo(t, s, nil)

	rec := api(t, s, "GET", R+"/project", nil)
	p := decode[projectBody](t, rec)
	if p.Entry != "main.tex" || p.EntryFromConfig || p.Engine != "pdflatex" ||
		!reflect.DeepEqual(p.EntryCandidates, []string{"main.tex", "supplement.tex"}) {
		t.Errorf("project = %+v", p)
	}
	kinds := map[string]string{}
	for _, f := range p.Files {
		kinds[f.Path] = f.Kind
		if info, err := os.Stat(filepath.Join(root, filepath.FromSlash(f.Path))); err != nil || info.Size() != f.Size {
			t.Errorf("%s: size %d does not match the file", f.Path, f.Size)
		}
	}
	want := map[string]string{"main.tex": "text", "supplement.tex": "text", "refs.bib": "text", "sections/methods.tex": "text", "figures/trace.png": "image"}
	if !reflect.DeepEqual(kinds, want) {
		t.Errorf("files = %v, want %v", kinds, want)
	}

	// The body has exactly the fields of the contract.
	keys := decode[map[string]json.RawMessage](t, rec)
	for _, k := range []string{"entry", "entryCandidates", "entryFromConfig", "engine", "files"} {
		if _, ok := keys[k]; !ok {
			t.Errorf("project lacks %q", k)
		}
		delete(keys, k)
	}
	if len(keys) != 0 {
		t.Errorf("project has fields outside the contract: %v", keys)
	}
}

// Scenario: Several candidates (selecting the other one).
func TestChoosingAnotherEntry(t *testing.T) {
	s := newTestServer(t)
	root := fixtureRepo(t, s, nil)

	p := decode[projectBody](t, api(t, s, "PUT", R+"/entry", map[string]string{"path": "supplement.tex"}))
	if p.Entry != "supplement.tex" {
		t.Errorf("PUT entry answered entry %q", p.Entry)
	}
	if p := decode[projectBody](t, api(t, s, "GET", R+"/project", nil)); p.Entry != "supplement.tex" || p.EntryFromConfig {
		t.Errorf("project after the choice = %+v", p)
	}
	if status := gitIn(t, root, "status", "--porcelain", "--ignored"); status != "" {
		t.Errorf("the choice was written into the repository:\n%s", status)
	}

	wantError(t, api(t, s, "PUT", R+"/entry", map[string]string{"path": "sections/methods.tex"}), 400, "bad_entry")
	wantError(t, api(t, s, "PUT", R+"/entry", map[string]string{"path": "../../x.tex"}), 400, "bad_entry")
	wantError(t, api(t, s, "PUT", R+"/entry", "{"), 400, "bad_json")
}

// Scenario: Config override.
func TestConfigEntryOverridesDetection(t *testing.T) {
	s := newTestServer(t)
	fixtureRepo(t, s, map[string]string{".revisions.toml": "entry = \"supplement.tex\"\nengine = \"lualatex\"\n"})

	p := decode[projectBody](t, api(t, s, "GET", R+"/project", nil))
	if p.Entry != "supplement.tex" || !p.EntryFromConfig || p.Engine != "lualatex" {
		t.Errorf("project = %+v", p)
	}
}

func TestRepoRoutesNeedAClone(t *testing.T) {
	s := newTestServer(t)
	for _, path := range []string{"/project", "/state", "/file?path=main.tex"} {
		wantError(t, api(t, s, "GET", R+path, nil), 404, "not_found")
	}
	wantError(t, api(t, s, "PUT", R+"/file?path=main.tex", map[string]string{"baseHash": "", "text": ""}), 404, "not_found")
	wantError(t, api(t, s, "PUT", R+"/entry", map[string]string{"path": "main.tex"}), 404, "not_found")
}

func TestFileIsServedAsUntrustedBytes(t *testing.T) {
	s := newTestServer(t)
	root := fixtureRepo(t, s, map[string]string{
		"page.html":   "<script>alert(1)</script>",
		"drawing.svg": "<svg onload='alert(1)'/>",
		"latin1.tex":  "caf\xe9\r\n",
		"figure.pdf":  "%PDF-1.5",
		"photo.JPG":   "jpeg",
	})

	for path, contentType := range map[string]string{
		"main.tex":             "text/plain; charset=utf-8",
		"sections/methods.tex": "text/plain; charset=utf-8",
		"latin1.tex":           "text/plain; charset=utf-8",
		"refs.bib":             "text/plain; charset=utf-8",
		"figures/trace.png":    "image/png",
		"photo.JPG":            "image/jpeg",
		"figure.pdf":           "application/pdf",
		"page.html":            "application/octet-stream",
		"drawing.svg":          "application/octet-stream",
	} {
		disk, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
		if err != nil {
			t.Fatal(err)
		}
		rec := api(t, s, "GET", filePath(path), nil)
		if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), disk) {
			t.Errorf("%s: status %d, body is not the bytes on disk", path, rec.Code)
		}
		h := rec.Header()
		if h.Get("Content-Type") != contentType {
			t.Errorf("%s: Content-Type %q, want %q", path, h.Get("Content-Type"), contentType)
		}
		if h.Get("X-Content-Type-Options") != "nosniff" || h.Get("Content-Security-Policy") != "sandbox" {
			t.Errorf("%s: nosniff=%q CSP=%q", path, h.Get("X-Content-Type-Options"), h.Get("Content-Security-Policy"))
		}
		if h.Get("X-Revisions-Hash") != sha(disk) || h.Get("ETag") != `"`+sha(disk)+`"` {
			t.Errorf("%s: hash %q, ETag %q, want %s", path, h.Get("X-Revisions-Hash"), h.Get("ETag"), sha(disk))
		}
	}
}

func TestFileNotModified(t *testing.T) {
	s := newTestServer(t)
	root := fixtureRepo(t, s, nil)
	etag := api(t, s, "GET", filePath("main.tex"), nil).Header().Get("ETag")

	rec := api(t, s, "GET", filePath("main.tex"), nil, "If-None-Match", etag)
	if rec.Code != 304 || rec.Body.Len() != 0 {
		t.Fatalf("matching ETag: status %d with %d body bytes, want 304 and none", rec.Code, rec.Body.Len())
	}
	writeFiles(t, root, map[string]string{"main.tex": "changed"})
	if rec := api(t, s, "GET", filePath("main.tex"), nil, "If-None-Match", etag); rec.Code != 200 || rec.Body.String() != "changed" {
		t.Fatalf("after a change: status %d body %q", rec.Code, rec.Body)
	}
}

// Scenario: Escaping path.
func TestEscapingPathIsRejected(t *testing.T) {
	s := newTestServer(t)
	root := fixtureRepo(t, s, nil)
	outside := filepath.Join(filepath.Dir(root), "secret.tex")
	os.WriteFile(outside, []byte("secret\n"), 0o644)

	for _, path := range []string{
		"../secret.tex", "sections/../../secret.tex", "figures/../../../../../../../../etc/passwd",
		outside, "/etc/passwd", `..\secret.tex`, "C:/secret.tex", "", ".git/config", ".git/hooks/pre-commit", "sections",
	} {
		rec := api(t, s, "GET", filePath(path), nil)
		wantError(t, rec, 400, "bad_path")
		if strings.Contains(rec.Body.String(), "secret\n") {
			t.Errorf("%q: the response leaks the outside file", path)
		}
		body := map[string]string{"baseHash": sha([]byte("secret\n")), "text": "overwritten\n"}
		wantError(t, api(t, s, "PUT", filePath(path), body), 400, "bad_path")
	}
	wantError(t, api(t, s, "GET", R+"/file", nil), 400, "bad_path")
	if got, _ := os.ReadFile(outside); string(got) != "secret\n" {
		t.Errorf("the outside file was changed to %q", got)
	}
	if _, err := os.Stat(filepath.Join(root, ".git", "hooks", "pre-commit")); err == nil {
		t.Error("a hook was written into .git")
	}
}

// Scenario: Symlink.
func TestSymlinkIsRefused(t *testing.T) {
	s := newTestServer(t)
	root := fixtureRepo(t, s, nil)
	outside := filepath.Join(filepath.Dir(root), "secret.tex")
	os.WriteFile(outside, []byte("secret\n"), 0o644)
	for link, target := range map[string]string{"link-out.tex": outside, "link-in.tex": "main.tex", "linked-dir": "sections"} {
		if err := os.Symlink(target, filepath.Join(root, link)); err != nil {
			t.Skipf("cannot create symbolic links here: %v", err)
		}
	}

	for _, path := range []string{"link-out.tex", "link-in.tex", "linked-dir/methods.tex"} {
		rec := api(t, s, "GET", filePath(path), nil)
		wantError(t, rec, 400, "bad_path")
		body := map[string]string{"baseHash": sha([]byte("secret\n")), "text": "overwritten\n"}
		wantError(t, api(t, s, "PUT", filePath(path), body), 400, "bad_path")
	}
	if got, _ := os.ReadFile(outside); string(got) != "secret\n" {
		t.Errorf("the link target was changed to %q", got)
	}
	// Links are not offered in the file list either.
	for _, f := range decode[projectBody](t, api(t, s, "GET", R+"/project", nil)).Files {
		if strings.HasPrefix(f.Path, "link") {
			t.Errorf("the project lists the link %s", f.Path)
		}
	}
}

func TestMissingFile(t *testing.T) {
	s := newTestServer(t)
	root := fixtureRepo(t, s, nil)
	wantError(t, api(t, s, "GET", filePath("absent.tex"), nil), 404, "not_found")
	// v1 never creates files.
	wantError(t, api(t, s, "PUT", filePath("absent.tex"), map[string]string{"baseHash": sha(nil), "text": "new\n"}), 404, "not_found")
	if _, err := os.Stat(filepath.Join(root, "absent.tex")); err == nil {
		t.Error("the save created the file")
	}
}

// Scenario: One-word edit.
func TestOneWordEditTouchesOneLine(t *testing.T) {
	s := newTestServer(t)
	// The fixture is LF; the CRLF copy shows that line endings survive too.
	fixture, _ := os.ReadFile(filepath.Join("..", "..", "testdata", "manuscript", "main.tex"))
	root := fixtureRepo(t, s, map[string]string{"crlf.tex": strings.ReplaceAll(string(fixture), "\n", "\r\n")})

	for _, path := range []string{"main.tex", "crlf.tex"} {
		rec := api(t, s, "GET", filePath(path), nil)
		loaded := strings.ReplaceAll(rec.Body.String(), "\r\n", "\n") // what the editor holds
		edited := strings.Replace(loaded, "\\emph{larger} after", "\\emph{greater} after", 1)
		if edited == loaded {
			t.Fatal("the fixture no longer holds the sentence this test edits")
		}

		res := decode[saveResult](t, api(t, s, "PUT", filePath(path), map[string]string{"baseHash": rec.Header().Get("X-Revisions-Hash"), "text": edited}))
		disk, _ := os.ReadFile(filepath.Join(root, path))
		if !res.Written || res.Hash != sha(disk) {
			t.Errorf("%s: save answered %+v; the file hashes to %s", path, res, sha(disk))
		}
		// --numstat counts added and deleted lines.
		if got := gitIn(t, root, "diff", "--numstat", "--", path); got != "1\t1\t"+path {
			t.Errorf("%s: diff --numstat = %q, want one line changed", path, got)
		}
		if got := gitIn(t, root, "diff", "--", path); !strings.Contains(got, "-\\emph{larger} after") || !strings.Contains(got, "+\\emph{greater} after") {
			t.Errorf("%s: unexpected diff:\n%s", path, got)
		}
	}
}

// Scenario: No-op save.
func TestNoOpSaveDoesNotWrite(t *testing.T) {
	s := newTestServer(t)
	root := fixtureRepo(t, s, map[string]string{"mixed.tex": "one\r\ntwo\nthree\rfour"})
	path := filepath.Join(root, "mixed.tex")
	before, _ := os.Stat(path)

	rec := api(t, s, "GET", filePath("mixed.tex"), nil)
	hash := rec.Header().Get("X-Revisions-Hash")
	res := decode[saveResult](t, api(t, s, "PUT", filePath("mixed.tex"), map[string]string{"baseHash": hash, "text": "one\ntwo\nthree\nfour"}))
	if res.Written || res.Hash != hash {
		t.Errorf("save answered %+v, want written=false and the same hash", res)
	}
	after, _ := os.Stat(path)
	if !os.SameFile(before, after) || !after.ModTime().Equal(before.ModTime()) {
		t.Error("the file was rewritten")
	}
	if got := gitIn(t, root, "status", "--porcelain"); got != "" {
		t.Errorf("git status after a no-op save:\n%s", got)
	}
}

// Scenario: Mixed line endings.
func TestMixedLineEndingsSurviveAnEdit(t *testing.T) {
	s := newTestServer(t)
	disk := "one\r\ntwo\nthree\r\nfour\nfive\r\nsix\rseven\r\n"
	root := fixtureRepo(t, s, map[string]string{"mixed.tex": disk})

	hash := api(t, s, "GET", filePath("mixed.tex"), nil).Header().Get("X-Revisions-Hash")
	res := decode[saveResult](t, api(t, s, "PUT", filePath("mixed.tex"), map[string]string{"baseHash": hash, "text": "one\ntwo\nthree\nFOUR\nfive\nsix\nseven\n"}))
	got, _ := os.ReadFile(filepath.Join(root, "mixed.tex"))
	if want := "one\r\ntwo\nthree\r\nFOUR\nfive\r\nsix\rseven\r\n"; string(got) != want || !res.Written {
		t.Errorf("file holds %q, want %q (written=%v)", got, want, res.Written)
	}
}

// Scenario: External change.
func TestStaleSaveIsRejected(t *testing.T) {
	s := newTestServer(t)
	root := fixtureRepo(t, s, nil)
	path := filepath.Join(root, "main.tex")

	loaded := api(t, s, "GET", filePath("main.tex"), nil)
	external := []byte("rewritten by another program\n")
	os.WriteFile(path, external, 0o644)

	rec := api(t, s, "PUT", filePath("main.tex"), map[string]string{"baseHash": loaded.Header().Get("X-Revisions-Hash"), "text": loaded.Body.String() + "my edit\n"})
	wantError(t, rec, 409, "stale")
	var body struct{ Error struct{ Hash string } }
	json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Error.Hash != sha(external) {
		t.Errorf("stale error carries hash %q, want the hash of the disk file", body.Error.Hash)
	}
	if got, _ := os.ReadFile(path); !bytes.Equal(got, external) {
		t.Errorf("the disk file was changed to %q", got)
	}
}

func TestSaveRefusesNonUTF8AndBadBodies(t *testing.T) {
	s := newTestServer(t)
	root := fixtureRepo(t, s, map[string]string{"latin1.tex": "caf\xe9\n"})

	hash := api(t, s, "GET", filePath("latin1.tex"), nil).Header().Get("X-Revisions-Hash")
	wantError(t, api(t, s, "PUT", filePath("latin1.tex"), map[string]string{"baseHash": hash, "text": "café\n"}), 422, "not_utf8")
	if got, _ := os.ReadFile(filepath.Join(root, "latin1.tex")); string(got) != "caf\xe9\n" {
		t.Errorf("the file was changed to %q", got)
	}
	wantError(t, api(t, s, "PUT", filePath("main.tex"), `{"baseHash":`), 400, "bad_json")
}

// age sets the modification time of every file in the clone an hour back, as
// for a manuscript that has not been touched recently, and brings Git's index
// up to date with that.
func age(t *testing.T, root string) {
	t.Helper()
	old := time.Now().Add(-time.Hour)
	filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && !strings.Contains(path, string(filepath.Separator)+".git"+string(filepath.Separator)) {
			os.Chtimes(path, old, old)
		}
		return err
	})
	gitIn(t, root, "update-index", "-q", "--refresh")
}

// The UI polls R/state every 2 s. On a large repository reading every file
// each time costs real CPU, so an unchanged file is not read again; a file
// that cannot be read any more shows that.
func TestIdlePollDoesNotReReadUnchangedFiles(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads files whatever their mode")
	}
	s := newTestServer(t)
	root := fixtureRepo(t, s, nil)
	// chmod changes a file's ctime; Git must not take that as a change.
	gitIn(t, root, "config", "core.trustctime", "false")
	age(t, root)

	first := decode[stateBody](t, api(t, s, "GET", R+"/state", nil))
	project := decode[projectBody](t, api(t, s, "GET", R+"/project", nil))
	for path := range first.Hashes {
		p := filepath.Join(root, filepath.FromSlash(path))
		os.Chmod(p, 0)
		t.Cleanup(func() { os.Chmod(p, 0o644) })
	}

	if again := decode[stateBody](t, api(t, s, "GET", R+"/state", nil)); !reflect.DeepEqual(again.Hashes, first.Hashes) || again.Build.Stale {
		t.Errorf("an idle poll read the files again: hashes %v, want %v", again.Hashes, first.Hashes)
	}
	if p := decode[projectBody](t, api(t, s, "GET", R+"/project", nil)); !reflect.DeepEqual(p.EntryCandidates, project.EntryCandidates) {
		t.Errorf("entry candidates %v, want %v: the files were read again", p.EntryCandidates, project.EntryCandidates)
	}

	// A changed file is read, and a save still checks the bytes on disk.
	main := filepath.Join(root, "main.tex")
	os.Chmod(main, 0o644)
	loaded, _ := os.ReadFile(main)
	os.WriteFile(main, []byte("changed outside\n"), 0o644)
	if st := decode[stateBody](t, api(t, s, "GET", R+"/state", nil)); st.Hashes["main.tex"] != sha([]byte("changed outside\n")) {
		t.Errorf("main.tex hash %s after an outside change", st.Hashes["main.tex"])
	}
	wantError(t, api(t, s, "PUT", filePath("main.tex"), map[string]string{"baseHash": sha(loaded), "text": "mine\n"}), 409, "stale")
}

// A file rewritten within the file system's timestamp granularity can keep
// its size and modification time; such a recent file is always read.
func TestPollSeesASameSizeChangeToARecentFile(t *testing.T) {
	s := newTestServer(t)
	root := fixtureRepo(t, s, map[string]string{"notes.tex": "aaaa\n"})
	main := filepath.Join(root, "notes.tex")
	info, _ := os.Stat(main)
	decode[stateBody](t, api(t, s, "GET", R+"/state", nil))
	os.WriteFile(main, []byte("bbbb\n"), 0o644)
	os.Chtimes(main, info.ModTime(), info.ModTime())
	if st := decode[stateBody](t, api(t, s, "GET", R+"/state", nil)); st.Hashes["notes.tex"] != sha([]byte("bbbb\n")) {
		t.Errorf("notes.tex hash %s, want the new content's", st.Hashes["notes.tex"])
	}
}

// Git's status is fast only while its index knows each file's size and time.
// A clone that was copied or restored has a stale index, and a poll, which
// runs Git without taking its lock, would rehash every file every 2 s.
func TestPollRefreshesAStaleIndex(t *testing.T) {
	s := newTestServer(t)
	root := fixtureRepo(t, s, nil)
	later := time.Now().Add(-time.Minute)
	for _, f := range []string{"main.tex", "refs.bib", "figures/trace.png"} {
		os.Chtimes(filepath.Join(root, filepath.FromSlash(f)), later, later)
	}
	if stale := gitIn(t, root, "diff-files", "--name-only"); stale == "" {
		t.Fatal("the index is not stale; the test sets nothing up")
	}
	decode[stateBody](t, api(t, s, "GET", R+"/state", nil))
	if stale := gitIn(t, root, "diff-files", "--name-only"); stale != "" {
		t.Errorf("after a poll Git's index is still stale for:\n%s", stale)
	}
}

// The file tree follows files added and removed on disk through the poll,
// without reloading the project on every save.
func TestStateTreeChangesWhenFilesComeAndGo(t *testing.T) {
	s := newTestServer(t)
	root := fixtureRepo(t, s, nil)
	poll := func() string { return decode[stateBody](t, api(t, s, "GET", R+"/state", nil)).Tree }

	first := poll()
	if first == "" {
		t.Fatal("state has no tree")
	}
	writeFiles(t, root, map[string]string{"main.tex": "an edit changes no file names\n"})
	if poll() != first {
		t.Error("an edit changed the tree")
	}
	writeFiles(t, root, map[string]string{"figures/new.pdf": "%PDF"})
	added := poll()
	if added == first {
		t.Error("an added figure did not change the tree")
	}
	os.Remove(filepath.Join(root, "figures", "new.pdf"))
	if poll() != first {
		t.Error("removing the figure did not bring the tree back")
	}
}
