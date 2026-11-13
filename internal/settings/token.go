package settings

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/ryan-ressmeyer/revisions/internal/host"
	"github.com/zalando/go-keyring"
)

const (
	tokenService = "revisions"
	tokenAccount = "github-token"
	tokenFile    = "github-token"
)

// TokenStore keeps complete credentials in the keychain or a private file.
// A file, including an empty sign-out marker, takes precedence over the
// keychain so an unavailable keychain can never resurrect older credentials.
type TokenStore struct {
	dir         string
	setKeychain func(string, string, string) error
}

func NewTokenStore(configDir string) *TokenStore {
	return &TokenStore{dir: configDir, setKeychain: keyring.Set}
}
func tokenUseKeychain() bool            { return os.Getenv("REVISIONS_TOKEN_STORE") != "file" }
func (s *TokenStore) tokenPath() string { return filepath.Join(s.dir, tokenFile) }

// Read accepts the plain token stored by earlier releases as well as records.
func (s *TokenStore) Read() (host.Credential, error) {
	data, err := os.ReadFile(s.tokenPath())
	if errors.Is(err, os.ErrNotExist) {
		if !tokenUseKeychain() {
			return host.Credential{}, nil
		}
		var value string
		value, err = keyring.Get(tokenService, tokenAccount)
		if errors.Is(err, keyring.ErrNotFound) {
			return host.Credential{}, nil
		}
		data = []byte(value)
	}
	if err != nil {
		return host.Credential{}, err
	}
	value := strings.TrimSpace(string(data))
	if strings.HasPrefix(value, "{") {
		var credential host.Credential
		err = json.Unmarshal(data, &credential)
		return credential, err
	}
	return host.Credential{Token: value}, nil
}

// Write replaces the whole credential pair; no partial rotation is stored.
func (s *TokenStore) Write(credential host.Credential) error {
	data, err := json.Marshal(credential)
	if err != nil {
		return err
	}
	// Stage the full replacement first. A failed keychain write or cleanup
	// then leaves a complete, authoritative pair, never an empty marker.
	if err := s.writeFile(data); err != nil {
		return err
	}
	if tokenUseKeychain() && s.setKeychain(tokenService, tokenAccount, string(data)) == nil {
		return tokenRemove(s.tokenPath())
	}
	return nil
}

// Get and Set retain the plain-access-token API for legacy callers.
func (s *TokenStore) Get() (string, error)   { c, err := s.Read(); return c.Token, err }
func (s *TokenStore) Set(token string) error { return s.Write(host.Credential{Token: token}) }

// Delete leaves a non-secret marker even when the keychain is unavailable.
func (s *TokenStore) Delete() error {
	_, err := os.Stat(s.tokenPath())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	keychainActive := errors.Is(err, os.ErrNotExist) && tokenUseKeychain()
	if err := s.writeFile(nil); err != nil {
		return err
	}
	// An authoritative fallback file already masks an inactive keychain.
	// Do not require that unavailable backend just to forget a file sign-in.
	if keychainActive {
		if err := keyring.Delete(tokenService, tokenAccount); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			return err
		}
	}
	return nil
}

func (s *TokenStore) writeFile(data []byte) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(s.dir, ".github-token-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), s.tokenPath())
}

func tokenRemove(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
