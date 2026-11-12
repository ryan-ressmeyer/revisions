package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestUpdateReplacesTheRunningProgram is the in-app update end to end, with
// real programs: an installed v0.0.1 finds v0.0.2 on a local copy of the
// release page, refuses a download that does not match its checksum, then
// installs the good one over itself and restarts on the same port with the
// same settings, leaving nothing behind in its folder.
func TestUpdateReplacesTheRunningProgram(t *testing.T) {
	asset := "revisions-" + runtime.GOOS + "-" + runtime.GOARCH + exe
	tmp := t.TempDir()
	// Where the installer puts the program: inside the app bundle on macOS.
	dir := filepath.Join(tmp, "bin")
	if runtime.GOOS == "darwin" {
		dir = filepath.Join(tmp, "Applications", "Revisions.app", "Contents", "MacOS")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	program := buildRevisions(t, dir, "revisions"+exe, "v0.0.1")
	release := filepath.Join(tmp, "release")
	os.Mkdir(release, 0o755)
	newer, err := os.ReadFile(buildRevisions(t, release, asset, "v0.0.2"))
	if err != nil {
		t.Fatal(err)
	}
	sums := fmt.Sprintf("%x  %s\n", sha256.Sum256([]byte("something else")), asset)

	var asked []string
	files := http.StripPrefix("/download/v0.0.2/", http.FileServer(http.Dir(release)))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.URL.Path)
		switch r.URL.Path {
		case "/latest":
			w.Write([]byte(`{"tag_name": "v0.0.2"}`))
		case "/download/v0.0.2/SHA256SUMS":
			w.Write([]byte(sums))
		default:
			files.ServeHTTP(w, r)
		}
	}))
	defer srv.Close()

	port := freePort(t)
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	log, err := os.Create(filepath.Join(tmp, "log"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	// A file, not a buffer: a restarted program on Windows inherits the
	// output, and Wait would otherwise wait for it too.
	cmd := exec.Command(program, "--no-browser", "--port", fmt.Sprint(port))
	cmd.Stdout, cmd.Stderr = log, log
	cmd.Env = append(os.Environ(), "REVISIONS_HOME="+filepath.Join(tmp, "home"),
		"REVISIONS_CONFIG_DIR="+filepath.Join(tmp, "config"), "REVISIONS_CACHE_DIR="+filepath.Join(tmp, "cache"),
		"REVISIONS_RELEASES_URL="+srv.URL, "REVISIONS_GITHUB_TOKEN=")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	t.Cleanup(func() {
		if token := pageToken(base); token != "" {
			call(t, base, token, "POST", "/api/quit", "")
		}
		cmd.Process.Kill()
		if t.Failed() {
			b, _ := os.ReadFile(log.Name())
			t.Logf("program output:\n%s", b)
		}
	})
	if got := pingVersion(port, 10*time.Second); got != "v0.0.1" {
		t.Fatalf("ping version %q", got)
	}
	token := pageToken(base)

	// The check runs in the background on start.
	var update struct{ Version, Available, NotesURL string }
	for deadline := time.Now().Add(10 * time.Second); update.Available == ""; time.Sleep(100 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("no update offered: %+v; release server asked for %v", update, asked)
		}
		json.Unmarshal([]byte(call(t, base, token, "GET", "/api/update", "")), &update)
	}
	if update.Version != "v0.0.1" || update.Available != "v0.0.2" ||
		update.NotesURL != "https://github.com/ryan-ressmeyer/revisions/releases/tag/v0.0.2" {
		t.Fatalf("GET /api/update: %+v", update)
	}

	call(t, base, token, "PUT", "/api/settings", `{"authorId":"GH","authorName":"Gale Harper","buildTimeoutSeconds":900}`)

	// The update goes through the same hardening as every other route.
	for _, h := range [][2]string{{"Origin", "https://evil.example"}, {"X-Revisions-Token", "wrong"}} {
		req, _ := http.NewRequest("POST", base+"/api/update", nil)
		req.Header.Set("Origin", base)
		req.Header.Set("X-Revisions-Token", token)
		req.Header.Set(h[0], h[1])
		resp, err := http.DefaultClient.Do(req)
		if err != nil || resp.StatusCode != 403 {
			t.Fatalf("with %s %s: %v %v", h[0], h[1], resp.Status, err)
		}
		resp.Body.Close()
	}

	// A download that does not match its checksum is refused, and the running
	// version keeps working.
	got := call(t, base, token, "POST", "/api/update", "")
	if !strings.Contains(got, `"code":"update_failed"`) || !strings.Contains(got, "checksum") ||
		!strings.Contains(got, `"command":"`) {
		t.Fatalf("a bad checksum answered %s", got)
	}
	if v := pingVersion(port, 0); v != "v0.0.1" {
		t.Fatalf("after a refused update ping says %q", v)
	}
	wantInstalled(t, program, "v0.0.1")

	sums = fmt.Sprintf("%x  %s\n", sha256.Sum256(newer), asset)
	if got := call(t, base, token, "POST", "/api/update", ""); got != `{"version":"v0.0.2"}`+"\n" {
		t.Fatalf("update answered %s", got)
	}
	v := ""
	for deadline := time.Now().Add(30 * time.Second); v != "v0.0.2" && time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		v = pingVersion(port, 0)
	}
	if v != "v0.0.2" {
		t.Fatalf("after the update ping says %q", v)
	}
	wantInstalled(t, program, "v0.0.2")

	// On Windows the old process starts the new one and exits. Elsewhere the
	// process becomes the new program in place, so it is still running.
	if runtime.GOOS == "windows" {
		select {
		case err := <-exited:
			if err != nil {
				t.Fatalf("the old process exited with %v", err)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("the old process is still running")
		}
	} else {
		select {
		case err := <-exited:
			t.Fatalf("the process exited (%v) instead of becoming the new version", err)
		default:
		}
	}

	// Same settings, so the same configuration folder; a new page token.
	newToken := pageToken(base)
	if newToken == "" || newToken == token {
		t.Fatalf("token after restart %q", newToken)
	}
	var settings struct{ AuthorID string }
	json.Unmarshal([]byte(call(t, base, newToken, "GET", "/api/settings", "")), &settings)
	if settings.AuthorID != "GH" {
		t.Fatalf("the restarted program lost its settings: %+v", settings)
	}
	// A dev or up-to-date build offers nothing.
	if got := call(t, base, newToken, "GET", "/api/update", ""); !strings.Contains(got, `"available":""`) {
		t.Fatalf("after the update: %s", got)
	}

	// Nothing is left beside the program: no download, and on Windows the old
	// program, moved aside, is removed once it has exited.
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(200 * time.Millisecond) {
		entries, _ := os.ReadDir(dir)
		if len(entries) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the program's folder holds %v", entries)
		}
	}

	call(t, base, newToken, "POST", "/api/quit", "")
	if runtime.GOOS != "windows" {
		select {
		case err := <-exited:
			if err != nil {
				t.Fatalf("quit after the update: %v", err)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("the updated program did not quit")
		}
	}
	for deadline := time.Now().Add(10 * time.Second); pingVersion(port, 0) != ""; time.Sleep(200 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the updated program still answers after quitting")
		}
	}
}

func wantInstalled(t *testing.T, program, version string) {
	t.Helper()
	out, err := exec.Command(program, "--version").Output()
	if err != nil || strings.TrimSpace(string(out)) != "revisions "+version {
		t.Fatalf("installed program: %q, %v; want %s", out, err, version)
	}
}

// pageToken reads the token from the served page, as the UI does, or
// returns "" when nothing answers.
func pageToken(base string) string {
	resp, err := (&http.Client{Timeout: 2 * time.Second}).Get(base + "/")
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	page, _ := io.ReadAll(resp.Body)
	m := regexp.MustCompile(`name="revisions-token" content="([^"]+)"`).FindSubmatch(page)
	if m == nil {
		return ""
	}
	return string(m[1])
}

// call sends one API request the way the page does and returns the body.
func call(t *testing.T, base, token, method, path, body string) string {
	t.Helper()
	req, _ := http.NewRequest(method, base+path, strings.NewReader(body))
	req.Header.Set("Origin", base)
	req.Header.Set("X-Revisions-Token", token)
	resp, err := (&http.Client{Timeout: 5 * time.Minute}).Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}
