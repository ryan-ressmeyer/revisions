package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestInstallScript runs this platform's installer the way the install
// instructions do, curl piped into sh or Invoke-RestMethod piped into
// Invoke-Expression, against a local copy of a release. It then upgrades in
// place and refuses a download that does not match its checksum.
//
// With REVISIONS_TEST_LAUNCH=1, as in CI, it also opens the installed app the
// way a person does (the .app bundle on macOS, the Start menu shortcut on
// Windows) and checks that it answers on port 4747 and that an upgrade stops
// it. That opens a browser and uses the real home folder, so it is off by
// default.
func TestInstallScript(t *testing.T) {
	if runtime.GOOS != "windows" {
		if _, err := exec.LookPath("curl"); err != nil {
			t.Skip("curl is not installed")
		}
	}
	release := t.TempDir()
	asset := "revisions-" + runtime.GOOS + "-" + runtime.GOARCH + exe
	for _, name := range []string{"install.sh", "install.ps1"} {
		b, err := os.ReadFile(filepath.Join("..", "..", "scripts", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(release, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	publish := func(version string) {
		bin := buildRevisions(t, release, asset, version)
		b, err := os.ReadFile(bin)
		if err != nil {
			t.Fatal(err)
		}
		sums := fmt.Sprintf("%x  %s\n", sha256.Sum256(b), asset)
		if err := os.WriteFile(filepath.Join(release, "SHA256SUMS"), []byte(sums), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// GitHub serves release assets as application/octet-stream.
	files := http.FileServer(http.Dir(release))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		files.ServeHTTP(w, r)
	}))
	defer srv.Close()

	// The real path, because a launched app reports it: macOS resolves /var to
	// /private/var, and Windows expands short names such as RUNNER~1.
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	local, roaming := filepath.Join(home, "AppData", "Local"), filepath.Join(home, "AppData", "Roaming")
	env := append(os.Environ(), "HOME="+home, "XDG_DATA_HOME=", "LOCALAPPDATA="+local, "APPDATA="+roaming,
		"REVISIONS_DOWNLOAD_URL="+srv.URL)
	install := func() (string, error) {
		cmd := exec.Command("sh", "-c", "curl -fsSL "+srv.URL+"/install.sh | sh")
		if runtime.GOOS == "windows" {
			cmd = exec.Command("powershell", "-NoProfile", "-Command", "irm -UseBasicParsing "+srv.URL+"/install.ps1 | iex")
		}
		cmd.Env = env
		out, err := cmd.CombinedOutput()
		return string(out), err
	}

	var installed, launcher string
	switch runtime.GOOS {
	case "darwin":
		launcher = filepath.Join(home, "Applications", "Revisions.app")
		installed = filepath.Join(launcher, "Contents", "MacOS", "revisions")
	case "windows":
		installed = filepath.Join(local, "Programs", "Revisions", "revisions.exe")
		launcher = filepath.Join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "Revisions.lnk")
	default:
		installed = filepath.Join(home, ".local", "bin", "revisions")
		launcher = filepath.Join(home, ".local", "share", "applications", "revisions.desktop")
	}
	wantVersion := func(want string) {
		t.Helper()
		out, err := exec.Command(installed, "--version").Output()
		if err != nil || strings.TrimSpace(string(out)) != "revisions "+want {
			t.Fatalf("installed --version: %q, %v; want revisions %s", out, err, want)
		}
	}

	publish("v0.0.1-test")
	out, err := install()
	if err != nil {
		t.Fatalf("install: %v\n%s", err, out)
	}
	t.Logf("installer output:\n%s", out)
	wantVersion("v0.0.1-test")
	for _, want := range []string{"Git:", "LaTeX:"} {
		if !strings.Contains(out, want) {
			t.Errorf("the installer did not report %q", want)
		}
	}
	if _, err := os.Stat(launcher); err != nil {
		t.Fatalf("no launcher: %v", err)
	}
	switch runtime.GOOS {
	case "linux":
		entry, _ := os.ReadFile(launcher)
		if !strings.Contains(string(entry), "Exec=\""+installed+"\"\n") {
			t.Errorf("desktop entry does not start the installed binary:\n%s", entry)
		}
	case "darwin":
		// curl does not quarantine what it downloads, so Gatekeeper does not
		// assess the unsigned app.
		if attrs, _ := exec.Command("xattr", "-r", launcher).Output(); strings.Contains(string(attrs), "com.apple.quarantine") {
			t.Errorf("the installed app is quarantined:\n%s", attrs)
		}
	case "windows":
		// Invoke-WebRequest adds no Mark of the Web, so SmartScreen does not
		// stop the unsigned program.
		if _, err := os.Stat(installed + ":Zone.Identifier"); err == nil {
			t.Error("the installed program carries the Mark of the Web")
		}
	}

	// The release build's version reaches GET /api/ping too.
	port := freePort(t)
	server := exec.Command(installed, "--no-browser", "--port", fmt.Sprint(port))
	server.Env = append(os.Environ(), "REVISIONS_HOME="+filepath.Join(home, "Revisions"),
		"REVISIONS_CONFIG_DIR="+filepath.Join(home, "config"), "REVISIONS_CACHE_DIR="+filepath.Join(home, "cache"))
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	got := pingVersion(port, 10*time.Second)
	server.Process.Kill()
	server.Wait()
	if got != "v0.0.1-test" {
		t.Fatalf("ping version %q, want v0.0.1-test", got)
	}

	launched := os.Getenv("REVISIONS_TEST_LAUNCH") == "1" && runtime.GOOS != "linux"
	if launched {
		open := exec.Command("open", launcher)
		if runtime.GOOS == "windows" {
			open = exec.Command("powershell", "-NoProfile", "-Command", "Start-Process -FilePath '"+launcher+"'")
		}
		if out, err := open.CombinedOutput(); err != nil {
			t.Fatalf("opening the app: %v\n%s", err, out)
		}
		if got := pingVersion(4747, 30*time.Second); got != "v0.0.1-test" {
			t.Fatalf("the app opened from %s answers ping with %q", launcher, got)
		}
	}

	publish("v0.0.2-test")
	if out, err := install(); err != nil {
		t.Fatalf("upgrade: %v\n%s", err, out)
	}
	wantVersion("v0.0.2-test")
	if launched {
		for deadline := time.Now().Add(10 * time.Second); pingVersion(4747, 0) != ""; time.Sleep(200 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatal("the upgrade left the old version running")
			}
		}
	}

	// A download that does not match SHA256SUMS is refused and the installed
	// program stays as it was.
	f, err := os.OpenFile(filepath.Join(release, asset), os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.Write([]byte("tampered"))
	f.Close()
	if out, err := install(); err == nil || !strings.Contains(out, "checksum") {
		t.Fatalf("a tampered download was not refused: %v\n%s", err, out)
	}
	wantVersion("v0.0.2-test")
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// pingVersion returns the version Revisions reports on port, waiting up to
// wait for it to answer, or "" when nothing answers.
func pingVersion(port int, wait time.Duration) string {
	client := http.Client{Timeout: time.Second}
	for deadline := time.Now().Add(wait); ; time.Sleep(200 * time.Millisecond) {
		if resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/api/ping", port)); err == nil {
			var ping struct{ Version string }
			json.NewDecoder(resp.Body).Decode(&ping)
			resp.Body.Close()
			return ping.Version
		}
		if time.Now().After(deadline) {
			return ""
		}
	}
}
