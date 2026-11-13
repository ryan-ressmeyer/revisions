package server

import (
	"fmt"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/ryan-ressmeyer/revisions/internal/host/github"
	"github.com/ryan-ressmeyer/revisions/internal/host/githubfake"
)

func TestFailedNetworkGitProvesAuthWithTheOperationToken(t *testing.T) {
	for _, route := range []string{"/git/fetch", "/git/pull", "/git/push", "/git/force-push/preview", "/git/force-push"} {
		t.Run(route, func(t *testing.T) {
			h := newRecoveryHost(t)
			backend := filepath.Join(gitIn(t, "", "--exec-path"), "git-http-backend")
			if runtime.GOOS == "windows" {
				backend += ".exe"
			}
			if _, err := os.Stat(backend); err != nil {
				t.Skip("git-http-backend not installed")
			}
			var reject atomic.Bool
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if reject.Load() {
					w.Header().Set("WWW-Authenticate", `Basic realm="test"`)
					http.Error(w, "rejected", 401)
					return
				}
				(&cgi.Handler{Path: backend, Env: []string{"GIT_PROJECT_ROOT=" + h.fake.Remotes, "GIT_HTTP_EXPORT_ALL=1"}}).ServeHTTP(w, r)
			}))
			defer remote.Close()
			t.Setenv("REVISIONS_GITHUB_URL", remote.URL)
			h.auth.host = github.New()
			h.open(t, repoURL)
			ok[authBody](t, h.call(t, "GET", "/api/auth", nil)) // warm the cache
			reject.Store(true)
			h.onlyUser.Store(true)
			h.reject.Store(401)
			method := "POST"
			var body any
			if strings.HasSuffix(route, "preview") {
				method = "GET"
			}
			if route == "/git/force-push" {
				body = map[string]string{"expectedRemoteSha": gitIn(t, h.clone, "rev-parse", "HEAD")}
			}
			rec := h.call(t, method, testRepo+route, body)
			wantError(t, rec, 401, "auth_required")
			if strings.Contains(rec.Body.String(), githubfake.Token) {
				t.Fatal("token leaked")
			}
			if a := ok[authBody](t, h.call(t, "GET", "/api/auth", nil)); a.SignedIn {
				t.Fatal("warm identity hid rejected Git credential")
			}
		})
	}
}

func TestFailedNetworkGitWithoutProvenUnauthorizedKeepsCredential(t *testing.T) {
	for _, code := range []int{403, 503} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			h := newRecoveryHost(t)
			h.open(t, repoURL)
			down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "unavailable", 503) }))
			defer down.Close()
			gitIn(t, h.clone, "remote", "set-url", "origin", down.URL+"/owner/name.git")
			h.onlyUser.Store(true)
			h.reject.Store(int32(code))
			wantError(t, h.call(t, "POST", testRepo+"/git/fetch", nil), 502, "git_failed")
			if token, err := h.auth.tokens.Get(); err != nil || token != githubfake.Token {
				t.Fatalf("lost credential: %q %v", token, err)
			}
		})
	}
}
