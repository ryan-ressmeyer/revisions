package settings

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadGivesDefaultsBeforeAnythingIsSaved(t *testing.T) {
	got, err := Load(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if got != (Settings{AuthorID: "", AuthorName: "", BuildTimeoutSeconds: 300}) {
		t.Fatalf("got %+v", got)
	}
}

func TestSaveThenLoad(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "not-yet-created")
	want := Settings{AuthorID: "GH2", AuthorName: "Gale Harper", BuildTimeoutSeconds: 900}
	if err := Save(dir, want); err != nil {
		t.Fatal(err)
	}
	got, err := Load(dir)
	if err != nil || got != want {
		t.Fatalf("Load = %+v, %v; want %+v", got, err, want)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("config directory holds %d entries, want only the settings file", len(entries))
	}
}

func TestSaveRejectsInvalidSettings(t *testing.T) {
	dir := t.TempDir()
	good := Settings{AuthorID: "RR", AuthorName: "Ryan", BuildTimeoutSeconds: 300}
	if err := Save(dir, good); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []Settings{
		{AuthorID: "R R", BuildTimeoutSeconds: 300},
		{AuthorID: "r-r", BuildTimeoutSeconds: 300},
		{AuthorID: "rr}", BuildTimeoutSeconds: 300},
		{AuthorID: "José", BuildTimeoutSeconds: 300},
		{AuthorID: "RR", BuildTimeoutSeconds: 9},
		{AuthorID: "RR", BuildTimeoutSeconds: 7201},
		{AuthorID: "RR", BuildTimeoutSeconds: 0},
	} {
		if err := Save(dir, bad); !errors.Is(err, ErrInvalid) {
			t.Errorf("Save(%+v) = %v, want ErrInvalid", bad, err)
		}
	}
	if got, _ := Load(dir); got != good {
		t.Errorf("a rejected save changed the settings to %+v", got)
	}
	for _, ok := range []Settings{
		{AuthorID: "", BuildTimeoutSeconds: 10},
		{AuthorID: "abcXYZ019", AuthorName: "Zoë O'Neil", BuildTimeoutSeconds: 7200},
	} {
		if err := Save(dir, ok); err != nil {
			t.Errorf("Save(%+v) = %v", ok, err)
		}
	}
}

// A hand-edited timeout outside the limits must not make every build time out.
func TestLoadReplacesAnOutOfRangeTimeout(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"authorId":"RR","buildTimeoutSeconds":0}`), 0o600)
	got, err := Load(dir)
	if err != nil || got != (Settings{AuthorID: "RR", BuildTimeoutSeconds: 300}) {
		t.Fatalf("Load = %+v, %v", got, err)
	}
}

// A settings file written by another version must not break the app.
func TestLoadFillsInWhatTheFileLacks(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"authorId":"RR","future":true}`), 0o600)
	got, err := Load(dir)
	if err != nil || got != (Settings{AuthorID: "RR", BuildTimeoutSeconds: 300}) {
		t.Fatalf("Load = %+v, %v", got, err)
	}
}
