package settings

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/zalando/go-keyring"
)

const (
	tokenService = "revisions"
	tokenAccount = "github-token"
	tokenFile    = "github-token"
)

// TokenStore keeps the GitHub token in the operating-system keychain. When the
// keychain is unavailable, or REVISIONS_TOKEN_STORE=file, it keeps the token
// in a mode-0600 file in the configuration directory instead.
type TokenStore struct{ dir string }

// NewTokenStore returns the store whose fallback file lives in configDir.
func NewTokenStore(configDir string) *TokenStore { return &TokenStore{dir: configDir} }

func tokenUseKeychain() bool { return os.Getenv("REVISIONS_TOKEN_STORE") != "file" }

func (s *TokenStore) tokenPath() string { return filepath.Join(s.dir, tokenFile) }

// Get returns the stored token, or "" when there is none.
func (s *TokenStore) Get() (string, error) {
	if tokenUseKeychain() {
		if token, err := keyring.Get(tokenService, tokenAccount); err == nil {
			return token, nil
		}
	}
	data, err := os.ReadFile(s.tokenPath())
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	return strings.TrimSpace(string(data)), err
}

// Set stores the token, replacing any earlier one.
func (s *TokenStore) Set(token string) error {
	if tokenUseKeychain() && keyring.Set(tokenService, tokenAccount, token) == nil {
		return tokenRemove(s.tokenPath()) // drop a file left from before the keychain worked
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	// Remove first: WriteFile keeps the mode of a file that already exists.
	if err := tokenRemove(s.tokenPath()); err != nil {
		return err
	}
	return os.WriteFile(s.tokenPath(), []byte(token), 0o600)
}

// Delete forgets the token in both places.
func (s *TokenStore) Delete() error {
	if tokenUseKeychain() {
		keyring.Delete(tokenService, tokenAccount) // not found or no keychain: nothing to forget there
	}
	return tokenRemove(s.tokenPath())
}

func tokenRemove(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
