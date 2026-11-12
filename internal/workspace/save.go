package workspace

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// ErrNotUTF8 reports a save to a file whose bytes are not valid UTF-8. Such a
// file is read-only.
var ErrNotUTF8 = errors.New("file is not valid UTF-8")

// StaleError reports a save based on a version of the file that is no longer
// the one on disk. Hash is the hash of the disk file.
type StaleError struct{ Hash string }

func (e *StaleError) Error() string { return "file changed on disk" }

// Hash is the hex SHA-256 that identifies a file version.
func Hash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// ReadFile returns the bytes and hash of a repository file.
func ReadFile(root, rel string) ([]byte, string, error) {
	path, err := Resolve(root, rel)
	if err != nil {
		return nil, "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, "", err
	}
	return data, Hash(data), nil
}

// facts is what the poll and entry detection learn by reading a file.
type facts struct {
	size          int64
	mod           time.Time
	hash          string
	documentclass bool
}

// ponytail: one entry per file ever read, never freed, and a change that
// keeps a file's size and modification time is not seen until another change
// (saves are unaffected: they compare the bytes on disk). Evict by repository
// if a process ever opens thousands of them.
var factsCache sync.Map // absolute path -> facts

// readFacts reads the regular file at path, whose Lstat is info, unless it
// was read before and its size and modification time are unchanged.
func readFacts(path string, info fs.FileInfo) (facts, error) {
	if f, ok := factsCache.Load(path); ok {
		if f := f.(facts); f.size == info.Size() && f.mod.Equal(info.ModTime()) {
			return f, nil
		}
	}
	start := time.Now()
	data, err := os.ReadFile(path)
	if err != nil {
		return facts{}, err
	}
	f := facts{info.Size(), info.ModTime(), Hash(data), hasDocumentclass(string(data))}
	// A file can be rewritten within its timestamp's granularity (up to 2 s
	// on some file systems) and keep its time, so only remember a file that
	// was older than that when it was read.
	if start.Sub(info.ModTime()) > 2*time.Second {
		factsCache.Store(path, f)
	}
	return f, nil
}

// statFacts resolves rel inside root and returns its facts.
func statFacts(root, rel string) (facts, error) {
	path, err := Resolve(root, rel)
	if err != nil {
		return facts{}, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return facts{}, err
	}
	return readFacts(path, info)
}

// Hashes returns the hash of every text file in files, reading only the ones
// that changed since they were last read. A file that cannot be read is left
// out.
func Hashes(root string, files []File) map[string]string {
	hashes := map[string]string{}
	for _, f := range files {
		if f.Kind != "text" {
			continue
		}
		if facts, err := statFacts(root, f.Path); err == nil {
			hashes[f.Path] = facts.hash
		}
	}
	return hashes
}

// ponytail: one mutex per saved path, never freed. A manuscript has tens of
// files; evict idle entries if a process ever saves millions of distinct paths.
var saveLocks sync.Map // absolute path -> *sync.Mutex

// Save replaces the content of an existing file with text, as described under
// "Byte-preserving saves" in specs/architecture.md. text uses \n line breaks.
// It returns the hash of the file afterwards and whether the file was written.
func Save(root, rel, baseHash, text string) (hash string, written bool, err error) {
	path, err := Resolve(root, rel)
	if err != nil {
		return "", false, err
	}
	lock, _ := saveLocks.LoadOrStore(path, new(sync.Mutex))
	lock.(*sync.Mutex).Lock()
	defer lock.(*sync.Mutex).Unlock()

	// Resolve again under the lock: the file may have been replaced by a link
	// while this save waited.
	if path, err = Resolve(root, rel); err != nil {
		return "", false, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return "", false, err
	}
	disk, err := os.ReadFile(path)
	if err != nil {
		return "", false, err
	}
	if current := Hash(disk); current != baseHash {
		return "", false, &StaleError{Hash: current}
	}
	if !utf8.Valid(disk) {
		return "", false, ErrNotUTF8
	}

	patched := patch(disk, text)
	if bytes.Equal(patched, disk) {
		return baseHash, false, nil
	}
	if err := WriteFileAtomic(path, patched, info.Mode().Perm()); err != nil {
		return "", false, err
	}
	return Hash(patched), true, nil
}

const utf8BOM = "\xEF\xBB\xBF"

// patch maps text onto disk. Bytes before the first and after the last
// difference are kept exactly as they are on disk, whatever their line
// endings; the changed middle is written with the file's majority line ending.
func patch(disk []byte, text string) []byte {
	// The contract promises \n, but a stray \r from a client must not turn
	// into a new kind of line ending on disk.
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")

	// A byte-order mark is not text. Browsers strip it when decoding, so keep
	// the one on disk whether or not the incoming text still carries it.
	text = strings.TrimPrefix(text, utf8BOM)
	start := 0
	if bytes.HasPrefix(disk, []byte(utf8BOM)) {
		start = len(utf8BOM)
	}

	// Walk forward while disk and text agree. d and t index disk and text; a
	// line break is one step in text and one or two bytes on disk.
	d, t := start, 0
	for d < len(disk) && t < len(text) {
		c, width := disk[d], 1
		if c == '\r' {
			c = '\n'
			if d+1 < len(disk) && disk[d+1] == '\n' {
				width = 2
			}
		}
		if c != text[t] {
			break
		}
		d += width
		t++
	}

	// Walk backward the same way, never crossing into the common prefix.
	de, te := len(disk), len(text)
	for de > d && te > t {
		c, width := disk[de-1], 1
		switch {
		case c == '\n' && de-2 >= d && disk[de-2] == '\r':
			width = 2
		case c == '\r':
			c = '\n'
		}
		if c != text[te-1] {
			break
		}
		de -= width
		te--
	}

	middle := text[t:te]
	if eol := majorityLineEnding(disk); eol != "\n" {
		middle = strings.ReplaceAll(middle, "\n", eol)
	}
	out := make([]byte, 0, d+len(middle)+len(disk)-de)
	out = append(out, disk[:d]...)
	out = append(out, middle...)
	return append(out, disk[de:]...)
}

// majorityLineEnding returns the most common line break in data, preferring
// \n and then \r\n on a tie.
func majorityLineEnding(data []byte) string {
	crlf := bytes.Count(data, []byte("\r\n"))
	lf := bytes.Count(data, []byte("\n")) - crlf
	cr := bytes.Count(data, []byte("\r")) - crlf
	switch {
	case lf >= crlf && lf >= cr:
		return "\n"
	case crlf >= cr:
		return "\r\n"
	}
	return "\r"
}

// WriteFileAtomic writes data to a temporary file beside path and renames it
// over path, so a reader or a crash never sees a half-written file.
func WriteFileAtomic(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".revisions-*.tmp")
	if err != nil {
		return err
	}
	_, err = tmp.Write(data)
	if err == nil {
		err = tmp.Chmod(mode)
	}
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), path)
	}
	if err != nil {
		os.Remove(tmp.Name())
	}
	return err
}
