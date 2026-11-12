package server

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/ryan-ressmeyer/revisions/internal/workspace"
)

const (
	testHost   = "127.0.0.1:4747"
	testOrigin = "http://127.0.0.1:4747"
)

var testUI = fstest.MapFS{
	"index.html":    {Data: []byte(`<html><head><meta name="revisions-token" content="__REVISIONS_TOKEN__"></head><body>shell</body></html>`)},
	"assets/app.js": {Data: []byte("console.log('app')")},
}

func newTestServer(t *testing.T) *Server {
	t.Helper()
	paths := workspace.Paths{Home: t.TempDir(), ConfigDir: t.TempDir(), CacheDir: t.TempDir()}
	return New(paths, "test-version", 4747, testUI)
}

// do sends one request with a valid Host. headers are name, value pairs; a
// "Host" pair replaces the request host.
func do(s *Server, method, path string, headers ...string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	req.Host = testHost
	for i := 0; i < len(headers); i += 2 {
		if headers[i] == "Host" {
			req.Host = headers[i+1]
		} else {
			req.Header.Set(headers[i], headers[i+1])
		}
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

// pageToken reads the token the way the UI does: from the served page.
func pageToken(t *testing.T, s *Server) string {
	t.Helper()
	m := regexp.MustCompile(`<meta name="revisions-token" content="([^"]*)">`).FindStringSubmatch(do(s, "GET", "/").Body.String())
	if m == nil {
		t.Fatal("served page has no revisions-token meta tag")
	}
	return m[1]
}

func wantError(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	var body struct {
		Error struct{ Code, Message string }
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("status %d, body %q is not an error body: %v", rec.Code, rec.Body, err)
	}
	if rec.Code != status || body.Error.Code != code || body.Error.Message == "" {
		t.Fatalf("got %d %+v, want %d %s with a message", rec.Code, body.Error, status, code)
	}
}

func TestPingNeedsNoToken(t *testing.T) {
	rec := do(newTestServer(t), "GET", "/api/ping")
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("got %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["app"] != "revisions" || body["version"] != "test-version" {
		t.Fatalf("got %v", body)
	}
}

// Scenario: Foreign origin.
func TestForeignOriginRejected(t *testing.T) {
	s := newTestServer(t)
	token := pageToken(t, s)
	for _, origin := range []string{"https://evil.example", "http://127.0.0.1:9999", "null"} {
		wantError(t, do(s, "GET", "/api/ping", "Origin", origin), 403, "bad_origin")
		wantError(t, do(s, "POST", "/api/anything", "Origin", origin, "X-Revisions-Token", token), 403, "bad_origin")
		wantError(t, do(s, "GET", "/", "Origin", origin), 403, "bad_origin")
	}
}

func TestOwnOriginAccepted(t *testing.T) {
	s := newTestServer(t)
	if rec := do(s, "GET", "/api/ping", "Origin", testOrigin); rec.Code != 200 {
		t.Fatalf("127.0.0.1 origin: got %d", rec.Code)
	}
	if rec := do(s, "GET", "/api/ping", "Host", "localhost:4747", "Origin", "http://localhost:4747"); rec.Code != 200 {
		t.Fatalf("localhost origin: got %d", rec.Code)
	}
}

// Scenario: DNS rebinding.
func TestWrongHostRejected(t *testing.T) {
	s := newTestServer(t)
	for _, host := range []string{"evil.example", "evil.example:4747", "127.0.0.1", "127.0.0.1:9999", "localhost", ""} {
		wantError(t, do(s, "GET", "/api/ping", "Host", host), 403, "bad_host")
		wantError(t, do(s, "GET", "/", "Host", host), 403, "bad_host")
	}
}

func TestTokenRequiredOnAPI(t *testing.T) {
	s := newTestServer(t)
	wantError(t, do(s, "GET", "/api/anything"), 403, "bad_token")
	wantError(t, do(s, "GET", "/api/anything", "X-Revisions-Token", "wrong"), 403, "bad_token")
	wantError(t, do(s, "HEAD", "/api/anything"), 403, "bad_token")
	wantError(t, do(s, "POST", "/api/ping", "Origin", testOrigin), 403, "bad_token")
	// With the token the request passes hardening and reaches the router.
	wantError(t, do(s, "GET", "/api/anything", "X-Revisions-Token", pageToken(t, s)), 404, "not_found")
}

func TestMutatingRequestNeedsOrigin(t *testing.T) {
	s := newTestServer(t)
	token := pageToken(t, s)
	for _, method := range []string{"POST", "PUT", "DELETE", "PATCH", "OPTIONS"} {
		wantError(t, do(s, method, "/api/anything", "X-Revisions-Token", token), 403, "bad_origin")
	}
	wantError(t, do(s, "POST", "/api/anything", "X-Revisions-Token", token, "Origin", testOrigin), 404, "not_found")
}

func TestIndexCarriesTokenAndCSP(t *testing.T) {
	s := newTestServer(t)
	rec := do(s, "GET", "/")
	if rec.Code != 200 || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") {
		t.Fatalf("got %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	token := pageToken(t, s)
	if len(token) < 20 || strings.Contains(rec.Body.String(), "__REVISIONS_TOKEN__") {
		t.Fatalf("token %q was not written into the page", token)
	}
	if other := pageToken(t, newTestServer(t)); other == token {
		t.Fatal("two servers share a token")
	}
	csp := rec.Header().Get("Content-Security-Policy")
	for _, want := range []string{"default-src 'self'", "script-src 'self';", "style-src 'self' 'unsafe-inline'", "img-src 'self' blob: data:", "worker-src 'self' blob:", "connect-src 'self'"} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP %q lacks %q", csp, want)
		}
	}
	// The token changes on every start, so the page must not be cached.
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q", got)
	}
}

func TestUIFilesAndFallback(t *testing.T) {
	s := newTestServer(t)
	if rec := do(s, "GET", "/assets/app.js"); rec.Code != 200 || rec.Body.String() != "console.log('app')" {
		t.Fatalf("asset: got %d %q", rec.Code, rec.Body)
	}
	for _, path := range []string{"/github.com/owner/name", "/index.html", "/assets"} {
		if rec := do(s, "GET", path); rec.Code != 200 || !strings.Contains(rec.Body.String(), "shell") {
			t.Errorf("%s: got %d %q, want the app shell", path, rec.Code, rec.Body)
		}
	}
}

func TestNoCORSHeaders(t *testing.T) {
	s := newTestServer(t)
	token := pageToken(t, s)
	for _, rec := range []*httptest.ResponseRecorder{
		do(s, "GET", "/"),
		do(s, "GET", "/api/ping"),
		do(s, "GET", "/api/ping", "Origin", testOrigin),
		do(s, "GET", "/api/ping", "Origin", "https://evil.example"),
		do(s, "OPTIONS", "/api/ping", "Origin", "https://evil.example", "Access-Control-Request-Method", "POST"),
		do(s, "OPTIONS", "/api/ping", "Origin", testOrigin, "Access-Control-Request-Method", "POST", "X-Revisions-Token", token),
		do(s, "POST", "/api/anything", "Origin", testOrigin, "X-Revisions-Token", token),
	} {
		for name := range rec.Header() {
			if strings.HasPrefix(name, "Access-Control-") {
				t.Errorf("response carries %s", name)
			}
		}
	}
}

func TestErrorBodyCarriesExtraFields(t *testing.T) {
	rec := httptest.NewRecorder()
	writeError(rec, 409, "stale", "The file changed on disk.", map[string]any{"hash": "abc"})
	var body map[string]map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	e := body["error"]
	if rec.Code != 409 || e["code"] != "stale" || e["message"] != "The file changed on disk." || e["hash"] != "abc" {
		t.Fatalf("got %d %v", rec.Code, body)
	}
}

func TestReadJSON(t *testing.T) {
	read := func(body []byte) (*httptest.ResponseRecorder, bool, string) {
		var v struct{ Text string }
		rec := httptest.NewRecorder()
		ok := readJSON(rec, httptest.NewRequest("PUT", "/api/x", bytes.NewReader(body)), &v)
		return rec, ok, v.Text
	}

	if _, ok, text := read([]byte(`{"text":"hello"}`)); !ok || text != "hello" {
		t.Fatalf("valid body: ok=%v text=%q", ok, text)
	}
	rec, ok, _ := read([]byte(`{"text":`))
	if ok {
		t.Fatal("malformed body accepted")
	}
	wantError(t, rec, 400, "bad_json")

	big := append(append([]byte(`{"text":"`), bytes.Repeat([]byte("a"), 8<<20)...), `"}`...)
	rec, ok, _ = read(big)
	if ok {
		t.Fatal("body over 8 MiB accepted")
	}
	wantError(t, rec, 413, "too_large")
}

func TestRepoFromRoute(t *testing.T) {
	s := newTestServer(t)
	dir := filepath.Join(s.paths.Home, "github.com", "owner", "name")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	route := func(host, owner, name string) (*httptest.ResponseRecorder, workspace.RepoID, string, bool) {
		req := httptest.NewRequest("GET", "/", nil)
		req.SetPathValue("host", host)
		req.SetPathValue("owner", owner)
		req.SetPathValue("name", name)
		rec := httptest.NewRecorder()
		id, got, ok := s.repo(rec, req)
		return rec, id, got, ok
	}

	if _, id, got, ok := route("github.com", "owner", "name"); !ok || got != dir || id.String() != "github.com/owner/name" {
		t.Fatalf("existing clone: %v %q %v", id, got, ok)
	}
	for _, name := range []string{"absent", ".."} {
		rec, _, _, ok := route("github.com", "owner", name)
		if ok {
			t.Fatalf("%q accepted", name)
		}
		wantError(t, rec, 404, "not_found")
	}
}
