package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

func sha(data string) string {
	sum := sha256.Sum256([]byte(data))
	return hex.EncodeToString(sum[:])
}

const bom = "\xEF\xBB\xBF"

// Each case saves text over a file holding disk and names the exact bytes the
// file must hold afterwards.
var saveCases = []struct{ name, disk, text, want string }{
	{"one word in an LF file", "alpha\nbeta gamma\ndelta\n", "alpha\nbeta GAMMA\ndelta\n", "alpha\nbeta GAMMA\ndelta\n"},
	{"one word in a CRLF file", "a\r\nb c\r\nd\r\n", "a\nb C\nd\n", "a\r\nb C\r\nd\r\n"},
	{"one line in a lone-CR file", "a\rb\rc\r", "a\nB\nc\n", "a\rB\rc\r"},

	// Scenario: Mixed line endings. Majority CRLF.
	{"mixed, edit one line", "one\r\ntwo\nthree\r\nfour\nfive\r\nsix\r\n", "one\ntwo\nTHREE\nfour\nfive\nsix\n", "one\r\ntwo\nTHREE\r\nfour\nfive\r\nsix\r\n"},
	{"mixed, edit an LF line", "one\r\ntwo\nthree\r\nfour\nfive\r\nsix\r\n", "one\nTWO\nthree\nfour\nfive\nsix\n", "one\r\nTWO\nthree\r\nfour\nfive\r\nsix\r\n"},
	{"mixed, new lines take the majority CRLF", "one\r\ntwo\nthree\r\nfour\nfive\r\nsix\r\n", "one\ntwo\nnew1\nnew2\nthree\nfour\nfive\nsix\n", "one\r\ntwo\nnew1\r\nnew2\r\nthree\r\nfour\nfive\r\nsix\r\n"},
	{"mixed, new lines take the majority LF", "one\ntwo\r\nthree\nfour\n", "one\ntwo\nnew\nthree\nfour\n", "one\ntwo\r\nnew\nthree\nfour\n"},
	{"mixed with lone CR, new lines take the majority CR", "a\rb\r\nc\rd\r", "a\nb\nnew\nc\nd\n", "a\rb\r\nnew\rc\rd\r"},
	{"CR directly before CRLF", "a\r\r\nb\n", "a\n\nB\n", "a\r\r\nB\n"},

	{"edit at the start", "first\r\nsecond\nthird\r\n", "FIRST\nsecond\nthird\n", "FIRST\r\nsecond\nthird\r\n"},
	{"insert at the very start", "first\r\nsecond\r\n", "zero\nfirst\nsecond\n", "zero\r\nfirst\r\nsecond\r\n"},
	{"edit at the end", "a\r\nb\nlast\r\n", "a\nb\nLAST\n", "a\r\nb\nLAST\r\n"},
	{"append a line", "a\r\nb\r\n", "a\nb\nc\n", "a\r\nb\r\nc\r\n"},

	{"no trailing newline, edit the last line", "a\nb", "a\nbb", "a\nbb"},
	{"no trailing newline, append a line", "a\r\nb", "a\nb\nc", "a\r\nb\r\nc"},
	{"no trailing newline, add one", "a\r\nb", "a\nb\n", "a\r\nb\r\n"},
	{"remove the trailing newline", "a\r\nb\n", "a\nb", "a\r\nb"},

	{"delete a middle line", "a\r\nb\nc\r\nd\n", "a\nc\nd\n", "a\r\nc\r\nd\n"},
	{"delete several lines", "a\r\nb\nc\r\nd\ne\r\n", "a\ne\n", "a\r\ne\r\n"},
	{"delete the last line", "a\r\nb\n", "a\n", "a\r\n"},
	{"delete the first line", "a\r\nb\nc\r\n", "b\nc\n", "b\nc\r\n"},
	{"join two lines", "a\r\nb\nc\r\n", "ab\nc\n", "ab\nc\r\n"},
	{"split a line", "ab\nc\r\nd\r\n", "a\nb\nc\nd\n", "a\r\nb\nc\r\nd\r\n"},
	{"delete everything", "a\r\nb\r\n", "", ""},
	{"fill an empty file", "", "hello\nworld\n", "hello\nworld\n"},

	{"BOM kept when the text omits it", bom + "a\r\nb\r\n", "a\nB\n", bom + "a\r\nB\r\n"},
	{"BOM kept when the text carries it", bom + "a\r\nb\r\n", bom + "a\nB\n", bom + "a\r\nB\r\n"},
	{"BOM kept on an edit at the start", bom + "a\nb\n", "A\nb\n", bom + "A\nb\n"},
	{"BOM kept when everything is deleted", bom + "a\n", "", bom},

	// é and è share their first byte, so the changed range starts and ends
	// inside a character.
	{"multi-byte change sharing a lead byte", "naïve café\r\nüber\n", "naïve cafè\nüber\n", "naïve cafè\r\nüber\n"},
	{"multi-byte change sharing a trail byte", "x\r\naé\n", "x\naĩ\n", "x\r\naĩ\n"},
	{"multi-byte to ASCII", "naïve café\r\nüber\n", "naive café\nüber\n", "naive café\r\nüber\n"},
	{"insert between multi-byte characters", "日本語\r\n한국어\n", "日本猫語\n한국어\n", "日本猫語\r\n한국어\n"},
	{"four-byte characters", "a😀b\r\nc\n", "a😃b\nc\n", "a😃b\r\nc\n"},
	{"multi-byte at both file edges", "é\r\nmiddle\r\nü", "è\nmiddle\nû", "è\r\nmiddle\r\nû"},

	// The contract says text uses \n; CRLF in it must not leak into the file.
	{"CRLF in the incoming text is a line break", "a\nb\nc\n", "a\r\nB\r\nc\r\n", "a\nB\nc\n"},
}

func TestSaveWritesExactBytes(t *testing.T) {
	for _, c := range saveCases {
		t.Run(c.name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "main.tex")
			if err := os.WriteFile(path, []byte(c.disk), 0o644); err != nil {
				t.Fatal(err)
			}

			hash, written, err := Save(root, "main.tex", sha(c.disk), c.text)
			if err != nil {
				t.Fatal(err)
			}
			got, _ := os.ReadFile(path)
			if string(got) != c.want {
				t.Fatalf("file holds %q, want %q", got, c.want)
			}
			if hash != sha(c.want) {
				t.Errorf("returned hash %s is not the hash of the file", hash)
			}
			if written != (c.disk != c.want) {
				t.Errorf("written = %v", written)
			}

			// Saving what the editor now shows changes nothing.
			if _, written, err := Save(root, "main.tex", hash, c.text); err != nil || written {
				t.Errorf("second save: written=%v err=%v", written, err)
			}
			if got, _ := os.ReadFile(path); string(got) != c.want {
				t.Errorf("second save changed the file to %q", got)
			}
		})
	}
}

// Scenario: No-op save.
func TestSaveWithoutChangeDoesNotWrite(t *testing.T) {
	for _, disk := range []string{"a\r\nb\nc\r", bom + "a\r\nb", "plain\n", ""} {
		root := t.TempDir()
		path := filepath.Join(root, "main.tex")
		if err := os.WriteFile(path, []byte(disk), 0o644); err != nil {
			t.Fatal(err)
		}
		before, _ := os.Stat(path)

		text, _, err := ReadFile(root, "main.tex")
		if err != nil {
			t.Fatal(err)
		}
		// What an editor shows for these bytes: every line break as \n.
		view := lineView(text)
		hash, written, err := Save(root, "main.tex", sha(disk), view)
		if err != nil || written || hash != sha(disk) {
			t.Fatalf("%q: hash=%s written=%v err=%v", disk, hash, written, err)
		}
		after, _ := os.Stat(path)
		// A rename would give the path a new file even with equal bytes.
		if !os.SameFile(before, after) || !after.ModTime().Equal(before.ModTime()) {
			t.Errorf("%q: the file was rewritten", disk)
		}
	}
}

func lineView(data []byte) string {
	var out []byte
	for i := 0; i < len(data); i++ {
		switch {
		case data[i] == '\r' && i+1 < len(data) && data[i+1] == '\n':
			out = append(out, '\n')
			i++
		case data[i] == '\r':
			out = append(out, '\n')
		default:
			out = append(out, data[i])
		}
	}
	return string(out)
}

// Scenario: External change.
func TestSaveRejectsAStaleBase(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "main.tex")
	os.WriteFile(path, []byte("loaded\n"), 0o644)
	base := sha("loaded\n")
	os.WriteFile(path, []byte("changed elsewhere\n"), 0o644)

	_, written, err := Save(root, "main.tex", base, "my edit\n")
	var stale *StaleError
	if !errors.As(err, &stale) || written {
		t.Fatalf("written=%v err=%v, want a StaleError", written, err)
	}
	if stale.Hash != sha("changed elsewhere\n") {
		t.Errorf("StaleError carries %s, want the hash of the disk file", stale.Hash)
	}
	if got, _ := os.ReadFile(path); string(got) != "changed elsewhere\n" {
		t.Errorf("the disk file was changed to %q", got)
	}
}

func TestSaveRefusesFilesThatAreNotUTF8(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "latin1.tex")
	disk := "caf\xe9\n"
	os.WriteFile(path, []byte(disk), 0o644)

	data, hash, err := ReadFile(root, "latin1.tex")
	if err != nil || string(data) != disk || hash != sha(disk) {
		t.Fatalf("ReadFile = %q, %s, %v; the file must stay readable", data, hash, err)
	}
	if _, written, err := Save(root, "latin1.tex", hash, "café\n"); !errors.Is(err, ErrNotUTF8) || written {
		t.Fatalf("written=%v err=%v, want ErrNotUTF8", written, err)
	}
	if got, _ := os.ReadFile(path); string(got) != disk {
		t.Errorf("the file was changed to %q", got)
	}
}

func TestSaveKeepsTheFileModeAndLeavesNoTemporaryFiles(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "run.sh")
	os.WriteFile(path, []byte("echo a\n"), 0o755)

	if _, written, err := Save(root, "run.sh", sha("echo a\n"), "echo b\n"); err != nil || !written {
		t.Fatalf("written=%v err=%v", written, err)
	}
	info, _ := os.Stat(path)
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o755 {
		t.Errorf("mode is %v, want 0755", info.Mode().Perm())
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 {
		t.Errorf("directory holds %d entries after the save, want only the file", len(entries))
	}
}

func TestSaveNeverCreatesOrEscapes(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "repo")
	writeTree(t, parent, map[string]string{"outside.tex": "out\n", "repo/main.tex": "in\n"})

	if _, _, err := Save(root, "new.tex", sha(""), "x\n"); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("saving a missing file: %v, want a not-exist error", err)
	}
	if _, err := os.Stat(filepath.Join(root, "new.tex")); err == nil {
		t.Error("the save created a file")
	}
	if _, _, err := Save(root, "../outside.tex", sha("out\n"), "x\n"); !errors.Is(err, ErrBadPath) {
		t.Errorf("saving outside the root: %v, want ErrBadPath", err)
	}
	if got, _ := os.ReadFile(filepath.Join(parent, "outside.tex")); string(got) != "out\n" {
		t.Errorf("the outside file was changed to %q", got)
	}
}

// Two editors that loaded the same version race to save. The per-file lock
// lets exactly one win; the other is told its base is stale.
func TestConcurrentSavesFromOneBaseLetOneWin(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "main.tex"), []byte("base\n"), 0o644)

	var wg sync.WaitGroup
	results := make([]error, 16)
	for i := range results {
		wg.Go(func() {
			_, _, results[i] = Save(root, "main.tex", sha("base\n"), fmt.Sprintf("edit %d\n", i))
		})
	}
	wg.Wait()

	won := 0
	for _, err := range results {
		var stale *StaleError
		switch {
		case err == nil:
			won++
		case !errors.As(err, &stale):
			t.Errorf("unexpected error: %v", err)
		}
	}
	if won != 1 {
		t.Errorf("%d saves succeeded, want exactly 1", won)
	}
}
