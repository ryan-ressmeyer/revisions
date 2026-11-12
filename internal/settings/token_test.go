package settings

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

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
	if got, err := store.Get(); err != nil || got != "" || len(tokenFiles(t, dir)) != 0 {
		t.Fatalf("after Delete: %q, %v, files %v", got, err, tokenFiles(t, dir))
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
