// Package update finds a newer release of Revisions on GitHub and replaces
// the running program with it.
package update

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"time"
)

const (
	releases  = "https://github.com/ryan-ressmeyer/revisions/releases"
	latestAPI = "https://api.github.com/repos/ryan-ressmeyer/revisions/releases/latest"
	// The programs are about 20 MB.
	maxProgram = 200 << 20
)

// ErrNotWritable means the program's folder does not let this user replace it.
var ErrNotWritable = errors.New("Revisions may not change the folder it runs from")

// urls returns the address of the latest-release API and the base of the
// download addresses. REVISIONS_RELEASES_URL replaces both, for tests only:
// the latest release is then read from <it>/latest and the assets from
// <it>/download/<tag>/<name>.
func urls() (latest, download string) {
	if base := os.Getenv("REVISIONS_RELEASES_URL"); base != "" {
		return base + "/latest", base + "/download"
	}
	return latestAPI, releases + "/download"
}

// NotesURL is the release page of tag, with its release notes.
func NotesURL(tag string) string { return releases + "/tag/" + tag }

// Command is the install command of this platform, the manual way to update.
func Command() string {
	if runtime.GOOS == "windows" {
		return "irm -UseBasicParsing " + releases + "/latest/download/install.ps1 | iex"
	}
	return "curl -fsSL " + releases + "/latest/download/install.sh | sh"
}

// A redirect may not leave HTTPS: GitHub sends downloads on to its own
// storage over HTTPS.
var client = &http.Client{
	Timeout: 10 * time.Minute,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if req.URL.Scheme != via[0].URL.Scheme || len(via) > 5 {
			return errors.New("redirected away from the release")
		}
		return nil
	},
}

// get fetches url with no credentials, cookies, or anything about the user.
func get(ctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "revisions")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("%s answered %s", url, resp.Status)
	}
	return resp, nil
}

// Latest returns the tag of the newest published release that is not a
// draft or a pre-release, as GitHub's latest-release API reports it.
func Latest(ctx context.Context) (string, error) {
	latest, _ := urls()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, latest, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "revisions")
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s answered %s", latest, resp.Status)
	}
	var body struct {
		Tag string `json:"tag_name"`
	}
	err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body)
	return body.Tag, err
}

var releaseTag = regexp.MustCompile(`^v(\d+)\.(\d+)\.(\d+)$`)

// Release reports whether version is a release version, vX.Y.Z. Only such a
// build looks for updates.
func Release(version string) bool { return releaseTag.MatchString(version) }

// Executable is the path of the running program with symbolic links
// resolved, so that an update replaces the program itself.
func Executable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

// Newer reports whether latest is a release version (vX.Y.Z) higher than
// current. A build whose own version is not a release version, such as dev,
// never updates.
func Newer(current, latest string) bool {
	c, l := releaseTag.FindStringSubmatch(current), releaseTag.FindStringSubmatch(latest)
	if c == nil || l == nil {
		return false
	}
	for i := 1; i <= 3; i++ {
		a, _ := strconv.Atoi(c[i])
		b, _ := strconv.Atoi(l[i])
		if a != b {
			return b > a
		}
	}
	return false
}

// Install downloads tag's program for this computer and its SHA256SUMS,
// checks the program against them, and moves it over exe. On any failure exe
// is left as it was.
func Install(ctx context.Context, tag, exe string) error {
	if !releaseTag.MatchString(tag) {
		return fmt.Errorf("%q is not a release version. Nothing was changed.", tag)
	}
	name := "revisions-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	_, download := urls()
	dir := filepath.Dir(exe)

	// The new program is written next to the old one, so that a rename puts
	// it in place in one step.
	tmp, err := os.CreateTemp(dir, ".revisions-update-*")
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return fmt.Errorf("%w, %s. Nothing was changed.", ErrNotWritable, dir)
		}
		return fmt.Errorf("Revisions could not write next to itself in %s (%v). Nothing was changed.", dir, err)
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	resp, err := get(ctx, download+"/"+tag+"/"+name)
	if err != nil {
		return fmt.Errorf("Revisions %s for this computer could not be downloaded (%v). Nothing was changed.", tag, err)
	}
	sum := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, sum), io.LimitReader(resp.Body, maxProgram+1))
	resp.Body.Close()
	if err == nil && n > maxProgram {
		err = errors.New("the file is larger than any Revisions program")
	}
	if err == nil {
		err = tmp.Close()
	}
	if err != nil {
		return fmt.Errorf("Revisions %s could not be downloaded (%v). Nothing was changed.", tag, err)
	}

	want, err := checksum(ctx, download+"/"+tag+"/SHA256SUMS", name)
	if err != nil {
		return fmt.Errorf("The checksum of Revisions %s could not be read (%v). Nothing was changed.", tag, err)
	}
	if !bytes.Equal(sum.Sum(nil), want) {
		return errors.New("The download does not match the release's checksum, so it was not installed. Nothing was changed.")
	}

	mode := os.FileMode(0o755)
	if info, err := os.Stat(exe); err == nil {
		mode = info.Mode().Perm()
	}
	if err := os.Chmod(tmp.Name(), mode); err != nil {
		return fmt.Errorf("Revisions could not prepare the new version (%v). Nothing was changed.", err)
	}
	if err := replace(tmp.Name(), exe); err != nil {
		return fmt.Errorf("Revisions could not put the new version in place (%v). Nothing was changed.", err)
	}
	return nil
}

// checksum returns the SHA-256 that the SHA256SUMS file at url lists for name.
func checksum(ctx context.Context, url, name string) ([]byte, error) {
	resp, err := get(ctx, url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	lines := bufio.NewScanner(io.LimitReader(resp.Body, 1<<20))
	for lines.Scan() {
		var hexSum, file string
		if _, err := fmt.Sscan(lines.Text(), &hexSum, &file); err == nil && file == name {
			return hex.DecodeString(hexSum)
		}
	}
	return nil, fmt.Errorf("the release lists no checksum for %s", name)
}

// replace moves the program at from over exe. Windows cannot overwrite or
// delete a running program but can rename it, so there the running program is
// first moved aside to exe.old, which Cleanup removes after the restart.
func replace(from, exe string) error {
	if runtime.GOOS != "windows" {
		return os.Rename(from, exe)
	}
	old := exe + ".old"
	os.Remove(old) // left by an earlier update, if its removal failed
	if err := os.Rename(exe, old); err != nil {
		return err
	}
	if err := os.Rename(from, exe); err != nil {
		os.Rename(old, exe)
		return err
	}
	return nil
}

// Cleanup removes the program that an update on Windows moved aside. The old
// process may still be exiting, and Windows keeps its file until it has, so
// Cleanup tries for a few seconds. Elsewhere nothing is moved aside, and a
// file of that name is someone else's.
func Cleanup(exe string) {
	if runtime.GOOS != "windows" {
		return
	}
	old := exe + ".old"
	for range 20 {
		if err := os.Remove(old); err == nil || errors.Is(err, os.ErrNotExist) {
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
}
