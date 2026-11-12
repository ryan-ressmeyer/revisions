package server

import (
	"bytes"
	"errors"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/ryan-ressmeyer/revisions/internal/workspace"
)

// filesDeps holds what these routes need. Add fields here and set them at the top
// of registerFiles; no other file has to change.
type filesDeps struct {
	refreshed sync.Map // RepoID -> true once Git's index was refreshed
}

// registerFiles registers R/project, R/entry, R/state, and R/file.
func (s *Server) registerFiles(mux *http.ServeMux) {
	const R = "/api/repos/{host}/{owner}/{name}"
	mux.HandleFunc("GET "+R+"/project", s.getProject)
	mux.HandleFunc("PUT "+R+"/entry", s.putEntry)
	mux.HandleFunc("GET "+R+"/state", s.getState)
	mux.HandleFunc("GET "+R+"/file", s.getFile)
	mux.HandleFunc("PUT "+R+"/file", s.putFile)
}

// writeWorkspaceError answers a failure from internal/workspace.
func writeWorkspaceError(w http.ResponseWriter, err error) {
	var stale *workspace.StaleError
	switch {
	case errors.Is(err, workspace.ErrBadPath):
		writeError(w, http.StatusBadRequest, "bad_path", "That path cannot be opened in Revisions.")
	case errors.Is(err, fs.ErrNotExist):
		writeError(w, http.StatusNotFound, "not_found", "That file does not exist.")
	case errors.As(err, &stale):
		writeError(w, http.StatusConflict, "stale", "The file changed on disk after it was loaded.", map[string]any{"hash": stale.Hash})
	case errors.Is(err, workspace.ErrNotUTF8):
		writeError(w, http.StatusUnprocessableEntity, "not_utf8", "The file is not UTF-8 text, so it is read-only.")
	case errors.Is(err, workspace.ErrBadEntry):
		writeError(w, http.StatusBadRequest, "bad_entry", "That file is not a LaTeX document that can be built.")
	case errors.Is(err, workspace.ErrGitMissing):
		writeError(w, http.StatusFailedDependency, "git_missing", "Git is not installed.")
	default:
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
	}
}

// project resolves the route's repository and reads its project. On failure
// it writes the error response and returns false.
func (s *Server) project(w http.ResponseWriter, r *http.Request) (workspace.RepoID, string, workspace.Project, bool) {
	id, root, ok := s.repo(w, r)
	if !ok {
		return id, root, workspace.Project{}, false
	}
	proj, err := s.paths.LoadProject(id)
	if err != nil {
		writeWorkspaceError(w, err)
		return id, root, proj, false
	}
	return id, root, proj, true
}

func (s *Server) getProject(w http.ResponseWriter, r *http.Request) {
	if _, _, proj, ok := s.project(w, r); ok {
		writeJSON(w, http.StatusOK, proj)
	}
}

// getState is the UI's one poll target: what changed on disk, in the build,
// and in Git since it last looked.
func (s *Server) getState(w http.ResponseWriter, r *http.Request) {
	id, root, proj, ok := s.project(w, r)
	if !ok {
		return
	}
	// ponytail: the index is refreshed once per clone and process, under the
	// Git lock so it never races a Git route. An index made stale later, by a
	// tool that touches every file, stays slow until the next commit or restart;
	// refresh when a poll finds many files to rehash if that ever happens.
	if _, done := s.files.refreshed.Load(id); !done && s.git.mu.TryLock() {
		workspace.RefreshIndex(root)
		s.git.mu.Unlock()
		s.files.refreshed.Store(id, true)
	}
	git, err := workspace.GitStatus(root)
	if err != nil {
		writeWorkspaceError(w, err)
		return
	}
	hashes := workspace.Hashes(root, proj.Files)
	b := s.build.builder.Status(id, proj.Fingerprint())
	writeJSON(w, http.StatusOK, map[string]any{
		"hashes": hashes,
		"tree":   proj.Tree(),
		"build":  map[string]any{"state": b.State, "pdfVersion": b.PDFVersion, "stale": b.Stale},
		"git":    git,
	})
}

func (s *Server) putEntry(w http.ResponseWriter, r *http.Request) {
	id, _, ok := s.repo(w, r)
	if !ok {
		return
	}
	var body struct{ Path string }
	if !readJSON(w, r, &body) {
		return
	}
	if err := s.paths.SetEntry(id, body.Path); err != nil {
		writeWorkspaceError(w, err)
		return
	}
	s.getProject(w, r)
}

// Repository files are untrusted. The type comes from this list and never
// from the content, so a file cannot be served as HTML or SVG.
var contentTypes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".pdf": "application/pdf",
}

func (s *Server) getFile(w http.ResponseWriter, r *http.Request) {
	_, root, ok := s.repo(w, r)
	if !ok {
		return
	}
	rel := r.URL.Query().Get("path")
	// ponytail: the whole file is read to hash it. Fine for manuscripts;
	// stream and hash incrementally if repositories carry very large assets.
	data, hash, err := workspace.ReadFile(root, rel)
	if err != nil {
		writeWorkspaceError(w, err)
		return
	}
	contentType := contentTypes[strings.ToLower(path.Ext(rel))]
	if contentType == "" {
		contentType = "application/octet-stream"
		if workspace.Kind(rel, int64(len(data))) == "text" {
			contentType = "text/plain; charset=utf-8"
		}
	}
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox")
	h.Set("X-Revisions-Hash", hash)
	h.Set("ETag", `"`+hash+`"`)
	// ServeContent answers If-None-Match with 304.
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
}

func (s *Server) putFile(w http.ResponseWriter, r *http.Request) {
	_, root, ok := s.repo(w, r)
	if !ok {
		return
	}
	var body struct{ BaseHash, Text string }
	if !readJSON(w, r, &body) {
		return
	}
	hash, written, err := workspace.Save(root, r.URL.Query().Get("path"), body.BaseHash, body.Text)
	if err != nil {
		writeWorkspaceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"hash": hash, "written": written})
}
