package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ryan-ressmeyer/revisions/internal/host"
	"github.com/ryan-ressmeyer/revisions/internal/host/github"
	"github.com/ryan-ressmeyer/revisions/internal/host/githubfake"
)

// Real OAuth/REST HTTP endpoints around the fake's real bare repositories.
type recoveryHost struct {
	*hosted
	reject            atomic.Int32
	refreshStatus     atomic.Int32
	refreshes         atomic.Int32
	onlyUser          atomic.Bool
	failWrite         atomic.Bool
	renewedUserStatus atomic.Int32
	deviceCredential  atomic.Bool
	deviceExchanges   atomic.Int32
}

func newRecoveryHost(t *testing.T) *recoveryHost {
	t.Helper()
	h := &recoveryHost{hosted: newHosted(t)}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/login/oauth/access_token" && r.FormValue("grant_type") == "urn:ietf:params:oauth:grant-type:device_code" && h.deviceCredential.Load() {
			h.deviceExchanges.Add(1)
			fmt.Fprint(w, `{"access_token":"renewed","refresh_token":"refresh-b","expires_in":28800,"refresh_token_expires_in":15000000}`)
			return
		}
		if r.URL.Path == "/login/oauth/access_token" && r.FormValue("grant_type") == "refresh_token" {
			h.refreshes.Add(1)
			if h.failWrite.Load() {
				os.Remove(filepath.Join(h.paths.ConfigDir, "github-token"))
				os.Mkdir(filepath.Join(h.paths.ConfigDir, "github-token"), 0700)
			}
			if code := h.refreshStatus.Load(); code != 0 {
				if code == 400 {
					fmt.Fprint(w, `{"error":"bad_refresh_token"}`)
				} else {
					w.WriteHeader(int(code))
					fmt.Fprint(w, `{"message":"temporary failure"}`)
				}
				return
			}
			if r.FormValue("refresh_token") != "refresh-a" {
				t.Error("wrong refresh token")
			}
			fmt.Fprint(w, `{"access_token":"renewed","refresh_token":"refresh-b","expires_in":28800,"refresh_token_expires_in":15000000}`)
			return
		}
		if r.Header.Get("Authorization") == "Bearer renewed" {
			if code := h.renewedUserStatus.Load(); r.URL.Path == "/user" && code != 0 {
				w.WriteHeader(int(code))
				fmt.Fprint(w, `{"message":"identity unavailable"}`)
				return
			}
			r.Header.Set("Authorization", "Bearer "+githubfake.Token)
		} else if code := h.reject.Load(); code != 0 && r.Header.Get("Authorization") != "" && (!h.onlyUser.Load() || r.URL.Path == "/user") {
			w.WriteHeader(int(code))
			fmt.Fprint(w, `{"message":"rejected"}`)
			return
		}
		h.fake.ServeHTTP(w, r)
	}))
	t.Cleanup(api.Close)
	t.Setenv("REVISIONS_GITHUB_API_URL", api.URL)
	h.auth.host = github.New()
	if err := h.auth.tokens.Set(githubfake.Token); err != nil {
		t.Fatal(err)
	}
	return h
}

func TestDeviceCredentialSurvivesTransientIdentityFailure(t *testing.T) {
	for _, recovery := range []string{"restart", "reconnect"} {
		t.Run(recovery, func(t *testing.T) {
			h := newRecoveryHost(t)
			h.open(t, repoURL)
			before := ok[authBody](t, h.call(t, "GET", "/api/auth", nil))
			if before.User == nil || before.User.Login != "gharper" {
				t.Fatal("missing warm account")
			}
			if !ok[statusResponse](t, h.call(t, "GET", testRepo+"/git/status", nil)).Permissions.Push {
				t.Fatal("missing warm permission")
			}
			h.fake.SetUser(42, "other", "Other Person")
			h.fake.SetPush("owner/name", false)
			h.deviceCredential.Store(true)
			h.renewedUserStatus.Store(503)
			ok[map[string]any](t, h.call(t, "POST", "/api/auth/device", nil))
			wantError(t, h.call(t, "POST", "/api/auth/device/poll", nil), 502, "host_failed")
			c, err := h.auth.tokens.Read()
			if err != nil || c.Token != "renewed" || c.RefreshToken != "refresh-b" || c.ExpiresAt.IsZero() || c.RefreshExpiresAt.IsZero() {
				t.Fatalf("device credential lost after identity failure: %+v %v", c, err)
			}
			a := ok[authState](t, h.call(t, "GET", "/api/auth", nil))
			if !a.SignedIn || a.User != nil || a.Problem == nil || a.Problem.Code != "host_failed" {
				t.Fatalf("stale or falsely validated account: %+v", a)
			}
			if ok[statusResponse](t, h.call(t, "GET", testRepo+"/git/status", nil)).Permissions.Push {
				t.Fatal("old account permission survived device transition")
			}
			if poll := ok[struct{ Status string }](t, h.call(t, "POST", "/api/auth/device/poll", nil)); poll.Status != "expired" {
				t.Fatal("device code exchanged again")
			}
			h.renewedUserStatus.Store(0)
			method, path := "POST", "/api/auth/reconnect"
			if recovery == "restart" {
				h.Server = New(h.paths, "test", 4747, testUI)
				h.page = pageToken(t, h.Server)
				method, path = "GET", "/api/auth"
			}
			after := ok[authBody](t, h.call(t, method, path, nil))
			if !after.SignedIn || after.User == nil || after.User.Login != "other" {
				t.Fatalf("saved device credential did not recover: %+v", after)
			}
			if h.refreshes.Load() != 0 || h.deviceExchanges.Load() != 1 {
				t.Fatalf("minted extra credentials: refresh=%d device=%d", h.refreshes.Load(), h.deviceExchanges.Load())
			}
		})
	}
}

func TestDeviceIdentityRejectionDisconnectsWithoutOldAccountFallback(t *testing.T) {
	h := newRecoveryHost(t)
	ok[authBody](t, h.call(t, "GET", "/api/auth", nil))
	h.deviceCredential.Store(true)
	h.renewedUserStatus.Store(401)
	ok[map[string]any](t, h.call(t, "POST", "/api/auth/device", nil))
	wantError(t, h.call(t, "POST", "/api/auth/device/poll", nil), 401, "auth_required")
	if c, err := h.auth.tokens.Read(); err != nil || c.Token != "" {
		t.Fatalf("rejected device retained old account: %+v %v", c, err)
	}
	a := ok[authState](t, h.call(t, "GET", "/api/auth", nil))
	if a.SignedIn || a.User != nil || a.Problem == nil || a.Problem.Code != "auth_required" {
		t.Fatalf("rejected device state: %+v", a)
	}
}

func TestLatePermissionResponseCannotRefillNewAccountCache(t *testing.T) {
	h := newRecoveryHost(t)
	h.open(t, repoURL)
	entered, release := make(chan struct{}), make(chan struct{})
	var delayed atomic.Bool
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/owner/name" && delayed.CompareAndSwap(false, true) {
			close(entered)
			<-release
			fmt.Fprint(w, `{"default_branch":"main","permissions":{"push":true}}`)
			return
		}
		h.fake.ServeHTTP(w, r)
	}))
	defer api.Close()
	t.Setenv("REVISIONS_GITHUB_API_URL", api.URL)
	h.auth.host = github.New()
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- h.call(t, "GET", testRepo+"/git/status", nil) }()
	<-entered
	h.fake.SetPush("owner/name", false)
	ok[authBody](t, h.call(t, "POST", "/api/auth/reconnect", nil))
	close(release)
	ok[statusResponse](t, <-done)
	after := ok[statusResponse](t, h.call(t, "GET", testRepo+"/git/status", nil))
	if after.Permissions.Push {
		t.Fatal("late permission response refilled cache after reconnect")
	}
}

func TestLateRejectionCannotEraseRenewedCredential(t *testing.T) {
	h := newRecoveryHost(t)
	if err := h.auth.tokens.Write(host.Credential{Token: "renewed", RefreshToken: "refresh-b", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := h.rejectedToken(t.Context(), githubfake.Token); err != nil {
		t.Fatal(err)
	}
	if token, err := h.auth.tokens.Get(); err != nil || token != "renewed" {
		t.Fatalf("late rejection erased newer token: %q %v", token, err)
	}
}

func TestRotatedCredentialSurvivesTransientIdentityFailure(t *testing.T) {
	h := newRecoveryHost(t)
	h.auth.tokens.Write(host.Credential{Token: githubfake.Token, RefreshToken: "refresh-a", ExpiresAt: time.Now().Add(-time.Hour)})
	h.renewedUserStatus.Store(503)
	a := ok[struct {
		SignedIn bool
		Problem  *authProblem
	}](t, h.call(t, "GET", "/api/auth", nil))
	if a.Problem == nil || a.Problem.Code == "auth_required" {
		t.Fatal("transient validation failure misclassified")
	}
	h.renewedUserStatus.Store(0)
	after := ok[authBody](t, h.call(t, "GET", "/api/auth", nil))
	if !after.SignedIn || after.User == nil || h.refreshes.Load() != 1 {
		t.Fatal("new credential was lost after a transient identity failure")
	}
	c, err := h.auth.tokens.Read()
	if err != nil || c.Token != "renewed" {
		t.Fatalf("rotated credential not preserved: %+v %v", c, err)
	}
}

func TestRefreshStorageFailureNeverClaimsDurableSuccess(t *testing.T) {
	h := newRecoveryHost(t)
	if err := h.auth.tokens.Write(host.Credential{Token: githubfake.Token, RefreshToken: "refresh-a", ExpiresAt: time.Now().Add(-time.Hour)}); err != nil {
		t.Fatal(err)
	}
	h.failWrite.Store(true)
	for range 2 {
		wantError(t, h.call(t, "GET", "/api/auth", nil), 500, "storage_failed")
	}
	if h.refreshes.Load() != 1 {
		t.Fatal("reused a refresh token after ambiguous persistence")
	}
}

func TestExplicitReconnectRevalidatesDurablyRecoveredPair(t *testing.T) {
	h := newRecoveryHost(t)
	if err := h.auth.tokens.Write(host.Credential{Token: githubfake.Token, RefreshToken: "refresh-a", ExpiresAt: time.Now().Add(-time.Hour)}); err != nil {
		t.Fatal(err)
	}
	h.failWrite.Store(true)
	failure := h.call(t, "GET", "/api/auth", nil)
	wantError(t, failure, 500, "storage_failed")
	// A migration cleanup failure can return an error with the full new pair
	// already durable. Reconstruct that disk outcome after the write fault.
	if err := os.Remove(filepath.Join(h.paths.ConfigDir, "github-token")); err != nil {
		t.Fatal(err)
	}
	saved := host.Credential{Token: "renewed", RefreshToken: "refresh-b", ExpiresAt: time.Now().Add(time.Hour), RefreshExpiresAt: time.Now().Add(24 * time.Hour)}
	if err := h.auth.tokens.Write(saved); err != nil {
		t.Fatal(err)
	}
	h.failWrite.Store(false)
	wantError(t, h.call(t, "GET", "/api/auth", nil), 500, "storage_failed")
	a := ok[authBody](t, h.call(t, "POST", "/api/auth/reconnect", nil))
	if !a.SignedIn || a.User == nil {
		t.Fatal("explicit reconnect did not validate the saved replacement")
	}
	if h.refreshes.Load() != 1 {
		t.Fatal("reconnect minted another token instead of validating the saved pair")
	}
	if !strings.Contains(failure.Body.String(), "Reconnect GitHub") {
		t.Fatal("storage failure lacks explicit retry guidance")
	}
}

func TestFailedSignOutDoesNotUnblockConsumedRefreshPair(t *testing.T) {
	h := newRecoveryHost(t)
	old := host.Credential{Token: githubfake.Token, RefreshToken: "refresh-a", ExpiresAt: time.Now().Add(-time.Hour)}
	h.auth.tokens.Write(old)
	h.failWrite.Store(true)
	wantError(t, h.call(t, "GET", "/api/auth", nil), 500, "storage_failed")
	wantError(t, h.call(t, "POST", "/api/auth/signout", nil), 500, "storage_failed")
	os.Remove(filepath.Join(h.paths.ConfigDir, "github-token"))
	h.auth.tokens.Write(old)
	h.failWrite.Store(false)
	wantError(t, h.call(t, "GET", "/api/auth", nil), 500, "storage_failed")
	if h.refreshes.Load() != 1 {
		t.Fatal("failed signout unblocked a consumed pair")
	}
}

func TestReconnectRotatesAndRefreshesPermissionsWithoutChangingAuthor(t *testing.T) {
	h := newRecoveryHost(t)
	h.open(t, repoURL)
	before := ok[statusResponse](t, h.call(t, "GET", testRepo+"/git/status", nil))
	if !before.Permissions.Push {
		t.Fatal("missing initial permission")
	}
	if err := h.auth.tokens.Write(host.Credential{Token: githubfake.Token, RefreshToken: "refresh-a"}); err != nil {
		t.Fatal(err)
	}
	settings := ok[map[string]any](t, h.call(t, "GET", "/api/settings", nil))
	h.fake.SetUser(42, "other", "Other Person")
	h.fake.SetPush("owner/name", false)
	a := ok[authBody](t, h.call(t, "POST", "/api/auth/reconnect", nil))
	if a.User == nil || a.User.Login != "other" || h.refreshes.Load() != 1 {
		t.Fatalf("stale identity: %+v", a)
	}
	after := ok[statusResponse](t, h.call(t, "GET", testRepo+"/git/status", nil))
	if after.Permissions.Push {
		t.Fatal("stale push permission")
	}
	current := ok[map[string]any](t, h.call(t, "GET", "/api/settings", nil))
	if fmt.Sprint(current) != fmt.Sprint(settings) {
		t.Fatal("reconnect changed author settings")
	}
}

func TestRejectedMutationRenewsButIsNeverReplayed(t *testing.T) {
	h := newRecoveryHost(t)
	h.open(t, repoURL)
	h.auth.tokens.Write(host.Credential{Token: githubfake.Token, RefreshToken: "refresh-a"})
	h.reject.Store(401)
	wantError(t, h.call(t, "POST", testRepo+"/pulls", map[string]string{"title": "explicit retry only", "base": "main"}), 409, "auth_changed")
	if h.refreshes.Load() != 1 || h.fake.Requests("POST /repos/owner/name/pulls") != 0 {
		t.Fatal("mutation replayed")
	}
	if a := ok[authBody](t, h.call(t, "GET", "/api/auth", nil)); !a.SignedIn {
		t.Fatal("on-demand renewal failed")
	}
}

func TestCancelAndSignOutEndDeviceFlow(t *testing.T) {
	for _, route := range []string{"/api/auth/device/cancel", "/api/auth/signout"} {
		t.Run(route, func(t *testing.T) {
			h := newHosted(t)
			ok[map[string]any](t, h.call(t, "POST", "/api/auth/device", nil))
			ok[map[string]any](t, h.call(t, "POST", route, nil))
			h.fake.SetDevice("approved")
			poll := ok[struct{ Status string }](t, h.call(t, "POST", "/api/auth/device/poll", nil))
			if poll.Status != "expired" {
				t.Fatalf("cancelled flow completed: %+v", poll)
			}
			if a := ok[authBody](t, h.call(t, "GET", "/api/auth", nil)); a.SignedIn {
				t.Fatal("signed in after cancellation")
			}
		})
	}
}

func TestWarmIdentityRejectionIsActionable(t *testing.T) {
	h := newRecoveryHost(t)
	if !ok[authBody](t, h.call(t, "GET", "/api/auth", nil)).SignedIn {
		t.Fatal("not initially signed in")
	}
	h.reject.Store(401)
	wantError(t, h.call(t, "POST", "/api/open", map[string]string{"url": repoURL}), 401, "auth_required")
	a := ok[struct {
		SignedIn bool
		User     any
		Problem  *struct{ Code, Message string }
	}](t, h.call(t, "GET", "/api/auth", nil))
	if a.SignedIn || a.User != nil || a.Problem == nil || a.Problem.Code != "auth_required" {
		t.Fatalf("rejection hidden by warm identity: %+v", a)
	}
	if _, err := os.Stat(h.clone); err == nil {
		t.Fatal("open replayed")
	}
}

func TestRenewalRotatesDurablyOnceAcrossConcurrentRequests(t *testing.T) {
	h := newRecoveryHost(t)
	record := `{"token":"` + githubfake.Token + `","refreshToken":"refresh-a","expiresAt":"2000-01-01T00:00:00Z"}`
	if err := os.WriteFile(filepath.Join(h.paths.ConfigDir, "github-token"), []byte(record), 0600); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			a := ok[authBody](t, h.call(t, "GET", "/api/auth", nil))
			if !a.SignedIn || a.User == nil {
				t.Error("renewal did not restore identity")
			}
		})
	}
	wg.Wait()
	if n := h.refreshes.Load(); n != 1 {
		t.Fatalf("refreshes=%d, want 1", n)
	}
	data, err := os.ReadFile(filepath.Join(h.paths.ConfigDir, "github-token"))
	if err != nil || !strings.Contains(string(data), `"refreshToken":"refresh-b"`) || strings.Contains(string(data), `refresh-a`) {
		t.Fatalf("rotation not durable: %s, %v", data, err)
	}
	restarted := &hosted{Server: New(h.paths, "test", 4747, testUI)}
	restarted.page = pageToken(t, restarted.Server)
	if !ok[authBody](t, restarted.call(t, "GET", "/api/auth", nil)).SignedIn || h.refreshes.Load() != 1 {
		t.Fatal("restart lost renewed credential")
	}
}

func TestRejectedIdentityDoesNotRetryFailedRefreshInTheSameRequest(t *testing.T) {
	h := newRecoveryHost(t)
	h.auth.tokens.Write(host.Credential{Token: githubfake.Token, RefreshToken: "refresh-a"})
	h.reject.Store(401)
	h.refreshStatus.Store(503)
	a := ok[struct {
		SignedIn bool
		Problem  *authProblem
	}](t, h.call(t, "GET", "/api/auth", nil))
	if !a.SignedIn || a.Problem == nil || a.Problem.Code != "host_failed" {
		t.Fatalf("temporary refresh failure: %+v", a)
	}
	if h.refreshes.Load() != 1 {
		t.Fatalf("refresh retried %d times in one request", h.refreshes.Load())
	}
}

func TestRenewalFailuresAreNotAllSignOut(t *testing.T) {
	for _, code := range []int{400, 503} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			h := newRecoveryHost(t)
			record := `{"token":"` + githubfake.Token + `","refreshToken":"refresh-a","expiresAt":"2000-01-01T00:00:00Z"}`
			os.WriteFile(filepath.Join(h.paths.ConfigDir, "github-token"), []byte(record), 0600)
			h.refreshStatus.Store(int32(code))
			a := ok[struct {
				SignedIn bool
				Problem  *struct{ Code string }
			}](t, h.call(t, "GET", "/api/auth", nil))
			if a.Problem == nil {
				t.Fatal("renewal failure hidden")
			}
			token, err := h.auth.tokens.Get()
			if err != nil {
				t.Fatal(err)
			}
			if code == 400 {
				if a.SignedIn || token != "" || a.Problem.Code != "auth_required" {
					t.Fatalf("invalid refresh: %+v %q", a, token)
				}
			} else if !a.SignedIn || token != githubfake.Token || a.Problem.Code == "auth_required" {
				t.Fatalf("temporary failure discarded credential: %+v %q", a, token)
			}
		})
	}
}

func TestLocalHistoryAndStatusExposeAuthLoss(t *testing.T) {
	for _, route := range []string{"/git/status", "/git/log"} {
		t.Run(route, func(t *testing.T) {
			h := newRecoveryHost(t)
			h.open(t, repoURL)
			h.reject.Store(401)
			rec := h.call(t, "GET", testRepo+route, nil)
			body := ok[map[string]any](t, rec)
			if body["authError"] == nil {
				t.Fatalf("local response hid auth loss: %s", rec.Body)
			}
			if route == "/git/log" && len(body["commits"].([]any)) == 0 {
				t.Fatal("lost local history")
			}
		})
	}
}

func TestNonAuthFailuresKeepCredentials(t *testing.T) {
	for _, code := range []int{403, 404, 503} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			h := newRecoveryHost(t)
			h.reject.Store(int32(code))
			rec := h.call(t, "POST", "/api/open", map[string]string{"url": repoURL})
			if rec.Code == 401 {
				t.Fatalf("classified %d as unauthorized", code)
			}
			if token, err := h.auth.tokens.Get(); err != nil || token != githubfake.Token {
				t.Fatalf("credential lost: %q %v", token, err)
			}
		})
	}
}

func TestCredentialReadErrorsAndEnvironmentOverride(t *testing.T) {
	h := newRecoveryHost(t)
	os.Remove(filepath.Join(h.paths.ConfigDir, "github-token"))
	os.Mkdir(filepath.Join(h.paths.ConfigDir, "github-token"), 0700)
	wantError(t, h.call(t, "GET", "/api/auth", nil), 500, "storage_failed")
	wantError(t, h.call(t, "POST", "/api/open", map[string]string{"url": repoURL}), 500, "storage_failed")
	t.Setenv("REVISIONS_GITHUB_TOKEN", "revoked")
	rec := h.call(t, "POST", "/api/auth/device", nil)
	wantError(t, rec, 409, "auth_override")
	if !strings.Contains(rec.Body.String(), "restart") {
		t.Fatal("override has no configuration guidance")
	}
}
