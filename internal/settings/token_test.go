package settings

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/ryan-ressmeyer/revisions/internal/host"

	"github.com/zalando/go-keyring"
)

// tokenFiles lists what the store left in its directory.
func tokenFiles(t *testing.T, dir string) []string {
	t.Helper()
	names, err := filepath.Glob(filepath.Join(dir, "*"))
	if err != nil {
		t.Fatal(err)
	}
	return names
}

func TestTokenStoreUsesTheKeychain(t *testing.T) {
	keyring.MockInit()
	dir := t.TempDir()
	store := NewTokenStore(dir)

	if got, err := store.Get(); err != nil || got != "" {
		t.Fatalf("empty store: %q, %v", got, err)
	}
	if err := store.Set("gho_secret"); err != nil {
		t.Fatal(err)
	}
	if got, err := NewTokenStore(dir).Get(); err != nil || got != "gho_secret" {
		t.Fatalf("after Set: %q, %v", got, err)
	}
	if files := tokenFiles(t, dir); len(files) != 0 {
		t.Fatalf("the keychain was available, yet the store wrote %v", files)
	}
	if err := store.Delete(); err != nil {
		t.Fatal(err)
	}
	if got, err := store.Get(); err != nil || got != "" {
		t.Fatalf("after Delete: %q, %v", got, err)
	}
}

func TestTokenStoreFallsBackToAPrivateFile(t *testing.T) {
	keyring.MockInitWithError(errors.New("no keychain on this machine"))
	dir := filepath.Join(t.TempDir(), "config") // not created yet
	store := NewTokenStore(dir)

	if err := store.Set("gho_secret"); err != nil {
		t.Fatal(err)
	}
	files := tokenFiles(t, dir)
	if len(files) != 1 {
		t.Fatalf("want one token file, got %v", files)
	}
	if info, err := os.Stat(files[0]); err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		t.Fatalf("token file mode %v, %v; want 0600", info.Mode().Perm(), err)
	}
	if got, err := NewTokenStore(dir).Get(); err != nil || got != "gho_secret" {
		t.Fatalf("after Set: %q, %v", got, err)
	}
	if err := store.Delete(); err != nil {
		t.Fatal(err)
	}
	if got, err := store.Get(); err != nil || got != "" {
		t.Fatalf("after Delete: %q, %v, files %v", got, err, tokenFiles(t, dir))
	}
}

func TestCredentialRecordSurvivesRestartAndLegacyMigration(t *testing.T) {
	t.Setenv("REVISIONS_TOKEN_STORE", "file")
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, tokenFile), []byte("legacy-token\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	store := NewTokenStore(dir)
	old, err := store.Read()
	if err != nil || old.Token != "legacy-token" || old.RefreshToken != "" || !old.ExpiresAt.IsZero() {
		t.Fatalf("legacy: %+v, %v", old, err)
	}
	want := host.Credential{Token: "access", RefreshToken: "refresh", ExpiresAt: time.Now().UTC().Truncate(time.Second), RefreshExpiresAt: time.Now().UTC().Add(time.Hour).Truncate(time.Second)}
	if err := store.Write(want); err != nil {
		t.Fatal(err)
	}
	got, err := NewTokenStore(dir).Read()
	if err != nil || got != want {
		t.Fatalf("restart: %+v, %v", got, err)
	}
	info, _ := os.Stat(filepath.Join(dir, tokenFile))
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode())
	}
	if err := os.WriteFile(filepath.Join(dir, tokenFile), []byte(`{"token":`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Read(); err == nil {
		t.Fatal("corrupt record treated as a token")
	}
}

func TestCredentialStagingSurvivesKeychainFailure(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("requires directory permissions enforced for this user")
	}
	keyring.MockInitWithError(errors.New("keychain unavailable"))
	t.Setenv("REVISIONS_TOKEN_STORE", "")
	dir := t.TempDir()
	store := NewTokenStore(dir)
	if err := os.WriteFile(filepath.Join(dir, tokenFile), []byte("old-fallback"), 0600); err != nil {
		t.Fatal(err)
	}
	want := host.Credential{Token: "new-access", RefreshToken: "new-refresh", ExpiresAt: time.Now().UTC().Add(time.Hour).Truncate(time.Second)}
	store.setKeychain = func(service, account, value string) error {
		if err := os.Chmod(dir, 0500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(dir, 0700) })
		if f, err := os.CreateTemp(dir, "must-not-write-*"); err == nil {
			f.Close()
			t.Fatal("failure fixture did not prevent a second file write")
		}
		return keyring.Set(service, account, value)
	}
	if err := store.Write(want); err != nil {
		t.Fatalf("lost staged pair when keychain and a second file write were unavailable: %v", err)
	}
	if got, err := NewTokenStore(dir).Read(); err != nil || got != want {
		t.Fatalf("staged replacement lost: %+v %v", got, err)
	}
}

func TestFailedKeychainMigrationCleanupRetainsCompleteRecord(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("requires directory permissions enforced for this user")
	}
	keyring.MockInit()
	t.Setenv("REVISIONS_TOKEN_STORE", "")
	dir := t.TempDir()
	store := NewTokenStore(dir)
	if err := os.WriteFile(filepath.Join(dir, tokenFile), []byte("old-fallback"), 0600); err != nil {
		t.Fatal(err)
	}
	want := host.Credential{Token: "new-access", RefreshToken: "new-refresh", ExpiresAt: time.Now().UTC().Add(time.Hour).Truncate(time.Second), RefreshExpiresAt: time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)}
	store.setKeychain = func(service, account, value string) error {
		if err := keyring.Set(service, account, value); err != nil {
			return err
		}
		if err := os.Chmod(dir, 0500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(dir, 0700) })
		return nil
	}
	if err := store.Write(want); err == nil {
		t.Fatal("failed migration cleanup falsely reported success")
	}
	if got, err := NewTokenStore(dir).Read(); err != nil || got != want {
		t.Fatalf("failed cleanup masked the new pair across restart: %+v %v", got, err)
	}
	if info, err := os.Stat(filepath.Join(dir, tokenFile)); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("staged record is not private: %v %v", info, err)
	}
}

func TestTokenStoreFileShadowsStaleKeychain(t *testing.T) {
	keyring.MockInit()
	dir := t.TempDir()
	store := NewTokenStore(dir)
	if err := store.Set("old-keychain"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REVISIONS_TOKEN_STORE", "file")
	if err := store.Set("new-file"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REVISIONS_TOKEN_STORE", "")
	if got, err := store.Get(); err != nil || got != "new-file" {
		t.Fatalf("stale resurrection: %q, %v", got, err)
	}
	t.Setenv("REVISIONS_TOKEN_STORE", "file")
	if err := store.Delete(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REVISIONS_TOKEN_STORE", "")
	if got, err := store.Get(); err != nil || got != "" {
		t.Fatalf("deleted credential resurrected: %q, %v", got, err)
	}
}

func TestFileSignOutDoesNotNeedAnInactiveKeychain(t *testing.T) {
	keyring.MockInitWithError(errors.New("keychain unavailable"))
	store := NewTokenStore(t.TempDir())
	if err := store.Set("fallback-token"); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete(); err != nil {
		t.Fatalf("inactive keychain blocked file signout: %v", err)
	}
	if got, err := store.Get(); err != nil || got != "" {
		t.Fatalf("not signed out: %q %v", got, err)
	}
}

func TestActiveKeychainDeletionFailureIsSurfacedAndMasked(t *testing.T) {
	keyring.MockInitWithError(errors.New("keychain locked"))
	store := NewTokenStore(t.TempDir())
	if err := store.Delete(); err == nil {
		t.Fatal("active keychain failure swallowed")
	}
	if got, err := store.Get(); err != nil || got != "" {
		t.Fatalf("failed deletion could resurrect keychain credential: %q %v", got, err)
	}
}

func TestTokenStoreDoesNotHideReadFailures(t *testing.T) {
	keyring.MockInitWithError(errors.New("keychain locked"))
	if _, err := NewTokenStore(t.TempDir()).Get(); err == nil {
		t.Fatal("keychain error was swallowed")
	}
}

func TestTokenStoreEnvForcesTheFile(t *testing.T) {
	keyring.MockInit()
	t.Setenv("REVISIONS_TOKEN_STORE", "file")
	dir := t.TempDir()
	store := NewTokenStore(dir)

	if err := store.Set("gho_secret"); err != nil {
		t.Fatal(err)
	}
	if _, err := keyring.Get(tokenService, tokenAccount); !errors.Is(err, keyring.ErrNotFound) {
		t.Fatalf("the keychain was written although the file store was forced: %v", err)
	}
	if got, err := store.Get(); err != nil || got != "gho_secret" {
		t.Fatalf("after Set: %q, %v", got, err)
	}
}
