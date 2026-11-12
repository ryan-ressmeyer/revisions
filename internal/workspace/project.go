package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

// MaxTextSize is the largest file the editor loads as text.
const MaxTextSize = 2 << 20

// ErrBadEntry reports a chosen entry file that is not a detected candidate.
var ErrBadEntry = errors.New("not an entry-file candidate")

// File is one regular file of the working tree.
type File struct {
	Path    string `json:"path"` // relative to the repository root, forward slashes
	Kind    string `json:"kind"` // "text", "image", or "other"
	Size    int64  `json:"size"`
	modTime time.Time
}

// Project describes a clone: its files, the document to build, and the engine.
type Project struct {
	Entry           string   `json:"entry"` // empty when there is nothing to build
	EntryCandidates []string `json:"entryCandidates"`
	EntryFromConfig bool     `json:"entryFromConfig"`
	Engine          string   `json:"engine"`
	Files           []File   `json:"files"`
}

var textExts = map[string]bool{
	".tex": true, ".bib": true, ".sty": true, ".cls": true, ".bst": true, ".bbx": true, ".cbx": true,
	".lbx": true, ".dbx": true, ".def": true, ".cfg": true, ".clo": true, ".ltx": true, ".tikz": true,
	".txt": true, ".md": true, ".toml": true, ".yaml": true, ".yml": true, ".json": true, ".csv": true,
	".gitignore": true, ".gitattributes": true,
}

// Raster formats a browser shows in an <img>. PDF figures are "other".
var imageExts = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true}

// Kind classifies a file by extension and size as "text", "image", or "other".
func Kind(name string, size int64) string {
	ext := strings.ToLower(path.Ext(name))
	switch {
	case textExts[ext] && size <= MaxTextSize:
		return "text"
	case imageExts[ext]:
		return "image"
	}
	return "other"
}

// lsFiles runs git ls-files and returns the slash paths it prints.
func lsFiles(root string, args ...string) ([]string, error) {
	out, err := runGit(root, append([]string{"ls-files", "-z"}, args...)...)
	if err != nil {
		return nil, err
	}
	names := strings.Split(strings.TrimSuffix(string(out), "\x00"), "\x00")
	slices.Sort(names)
	return slices.Compact(names), nil // a conflicted file is listed once per stage
}

// listFiles returns every tracked or untracked, non-ignored regular file.
// Symbolic links, submodules, and tracked files that are gone are left out.
func listFiles(root string) ([]File, error) {
	names, err := lsFiles(root, "--cached", "--others", "--exclude-standard")
	if err != nil {
		return nil, err
	}
	files := []File{}
	for _, name := range names {
		info, err := os.Lstat(filepath.Join(root, filepath.FromSlash(name)))
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		files = append(files, File{Path: name, Kind: Kind(name, info.Size()), Size: info.Size(), modTime: info.ModTime()})
	}
	return files, nil
}

// LoadProject reads the state of a clone from disk. See the "Entry-file
// selection" requirement in specs/overview.md.
func (p Paths) LoadProject(id RepoID) (Project, error) {
	root := p.CloneDir(id)
	files, err := listFiles(root)
	if err != nil {
		return Project{}, err
	}
	proj := Project{Engine: "pdflatex", EntryCandidates: []string{}, Files: files}

	config := readConfig(root)
	if e := config["engine"]; e == "xelatex" || e == "lualatex" {
		proj.Engine = e
	}
	if entry, ok := config["entry"]; ok {
		proj.EntryFromConfig = true
		if _, err := Resolve(root, entry); err == nil && safeEntryName(entry) {
			proj.Entry = entry
		}
		return proj, nil
	}

	if proj.EntryCandidates, err = entryCandidates(root); err != nil {
		return Project{}, err
	}
	if chosen := p.chosenEntry(id); slices.Contains(proj.EntryCandidates, chosen) {
		proj.Entry = chosen
	} else if len(proj.EntryCandidates) > 0 {
		proj.Entry = proj.EntryCandidates[0]
	}
	return proj, nil
}

// entryCandidates returns the tracked .tex files that contain an uncommented
// \documentclass, sorted by path.
func entryCandidates(root string) ([]string, error) {
	names, err := lsFiles(root, "--cached", "--", "*.tex")
	if err != nil {
		return nil, err
	}
	candidates := []string{}
	for _, name := range names {
		path, err := Resolve(root, name)
		if err != nil || !safeEntryName(name) {
			continue
		}
		if info, err := os.Lstat(path); err != nil || info.Size() > MaxTextSize {
			continue
		} else if f, err := readFacts(path, info); err == nil && f.documentclass {
			candidates = append(candidates, name)
		}
	}
	return candidates, nil
}

// latexmk hands the entry file's name to a shell inside double quotes, where
// a backtick or $ still runs a command, a " or \ ends or escapes the quoting,
// and on Windows a % expands a variable. A file whose name holds one of those,
// or a control character, is never built. Its directories are entered with
// chdir and never reach a command line.
func safeEntryName(rel string) bool {
	return !strings.ContainsFunc(path.Base(rel), func(r rune) bool {
		return r < 0x20 || r == 0x7f || strings.ContainsRune("`$\"\\%", r)
	})
}

// hasDocumentclass reports whether src has a \documentclass that no % on the
// same line comments out. This is the only LaTeX the server reads.
func hasDocumentclass(src string) bool {
	const cmd = `\documentclass`
	for line := range strings.FieldsFuncSeq(src, func(r rune) bool { return r == '\n' || r == '\r' }) {
		for i := 0; i < len(line); i++ {
			if line[i] == '%' {
				break
			}
			if strings.HasPrefix(line[i:], cmd) {
				return true
			}
			if line[i] == '\\' {
				i++ // \% is a literal percent sign, \\ a line break
			}
		}
	}
	return false
}

// readConfig returns the top-level string keys of .revisions.toml, or nothing
// when the file is absent or unusable.
//
// ponytail: reads only `key = "value"` and `key = 'value'` lines before the
// first [table]; other TOML (multi-line strings, arrays, dotted keys) is
// ignored. Swap in a real TOML parser when the file needs more than strings.
func readConfig(root string) map[string]string {
	config := map[string]string{}
	data, _, err := ReadFile(root, ".revisions.toml")
	if err != nil {
		return config
	}
	for line := range strings.Lines(string(data)) {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			break
		}
		key, rest, ok := strings.Cut(line, "=")
		key, rest = strings.TrimSpace(key), strings.TrimSpace(rest)
		if !ok || key == "" || strings.HasPrefix(key, "#") || rest == "" {
			continue
		}
		switch rest[0] {
		case '"':
			// QuotedPrefix finds the closing quote, so a trailing comment is
			// left behind. Go's escapes cover the TOML ones a path needs.
			if quoted, err := strconv.QuotedPrefix(rest); err == nil {
				if value, err := strconv.Unquote(quoted); err == nil {
					config[key] = value
				}
			}
		case '\'':
			if value, _, ok := strings.Cut(rest[1:], "'"); ok {
				config[key] = value
			}
		}
	}
	return config
}

// The user's entry choice is per-machine state under the config directory. It
// never goes into the repository.
func (p Paths) repoStateFile(id RepoID) string {
	return filepath.Join(p.ConfigDir, "repos", id.Host, id.Owner, id.Name+".json")
}

type repoState struct {
	Entry string `json:"entry"`
}

func (p Paths) chosenEntry(id RepoID) string {
	var st repoState
	if data, err := os.ReadFile(p.repoStateFile(id)); err == nil {
		json.Unmarshal(data, &st)
	}
	return st.Entry
}

// SetEntry records the user's choice of entry file for a clone. The choice
// must be one of the detected candidates.
func (p Paths) SetEntry(id RepoID, entry string) error {
	candidates, err := entryCandidates(p.CloneDir(id))
	if err != nil {
		return err
	}
	if !slices.Contains(candidates, entry) {
		return ErrBadEntry
	}
	data, err := json.Marshal(repoState{Entry: entry})
	if err != nil {
		return err
	}
	file := p.repoStateFile(id)
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	return WriteFileAtomic(file, data, 0o600)
}

// Fingerprint identifies the working tree a build reads: the entry file, the
// engine, and the path, size, and modification time of every file.
func (p Project) Fingerprint() string {
	h := sha256.New()
	fmt.Fprintf(h, "%q %q\n", p.Entry, p.Engine)
	for _, f := range p.Files {
		fmt.Fprintf(h, "%q %d %d\n", f.Path, f.Size, f.modTime.UnixNano())
	}
	return hex.EncodeToString(h.Sum(nil))
}

// Tree identifies the file list: the path and kind of every file. Unlike the
// fingerprint, an edit to a file leaves it unchanged.
func (p Project) Tree() string {
	h := sha256.New()
	for _, f := range p.Files {
		fmt.Fprintf(h, "%q %s\n", f.Path, f.Kind)
	}
	return hex.EncodeToString(h.Sum(nil))
}
