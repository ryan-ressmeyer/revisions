// Package settings holds the per-user settings of Revisions, stored as JSON in
// the config directory.
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"

	"github.com/ryan-ressmeyer/revisions/internal/workspace"
)

// ErrInvalid reports settings that fail validation. The error text says which
// field and is fit to show the user.
var ErrInvalid = errors.New("invalid settings")

const (
	DefaultBuildTimeoutSeconds = 300
	MinBuildTimeoutSeconds     = 10
	MaxBuildTimeoutSeconds     = 7200
)

// Settings is the body of GET and PUT /api/settings.
type Settings struct {
	AuthorID            string `json:"authorId"` // the changes-package author id; empty until set
	AuthorName          string `json:"authorName"`
	BuildTimeoutSeconds int    `json:"buildTimeoutSeconds"`
}

// The author id becomes part of LaTeX macro arguments, so it is plain ASCII.
var authorIDPattern = regexp.MustCompile(`^[A-Za-z0-9]*$`)

// Validate returns an error wrapping ErrInvalid when a field is out of range.
func (s Settings) Validate() error {
	if !authorIDPattern.MatchString(s.AuthorID) {
		return fmt.Errorf("%w: the author ID may hold only letters and digits", ErrInvalid)
	}
	if s.BuildTimeoutSeconds < MinBuildTimeoutSeconds || s.BuildTimeoutSeconds > MaxBuildTimeoutSeconds {
		return fmt.Errorf("%w: the build timeout must be between %d and %d seconds", ErrInvalid, MinBuildTimeoutSeconds, MaxBuildTimeoutSeconds)
	}
	return nil
}

func settingsFile(configDir string) string { return filepath.Join(configDir, "settings.json") }

// Load reads the settings, giving defaults for a missing file or field.
func Load(configDir string) (Settings, error) {
	s := Settings{BuildTimeoutSeconds: DefaultBuildTimeoutSeconds}
	data, err := os.ReadFile(settingsFile(configDir))
	if errors.Is(err, fs.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return s, fmt.Errorf("settings file: %w", err)
	}
	if s.BuildTimeoutSeconds < MinBuildTimeoutSeconds || s.BuildTimeoutSeconds > MaxBuildTimeoutSeconds {
		s.BuildTimeoutSeconds = DefaultBuildTimeoutSeconds
	}
	return s, nil
}

// Save validates the settings and writes them atomically.
func Save(configDir string, s Settings) error {
	if err := s.Validate(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return err
	}
	return workspace.WriteFileAtomic(settingsFile(configDir), data, 0o600)
}
