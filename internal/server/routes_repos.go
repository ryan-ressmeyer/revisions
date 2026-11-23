package server

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/ryan-ressmeyer/revisions/internal/gitx"
	"github.com/ryan-ressmeyer/revisions/internal/workspace"
)

// Open hands a URL or a folder to the system's default program, without
// waiting for it.
func Open(target string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", target)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}

func (s *Server) revealFolder(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	if err := s.git.reveal(dir); err != nil {
		writeError(w, http.StatusInternalServerError, "open_failed", "Revisions could not open the folder: "+err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type removal struct {
	Path        string            `json:"path"`
	Linked      bool              `json:"linked"`
	Files       []gitx.FileStatus `json:"files"`
	Commits     []gitx.LogCommit  `json:"commits"`
	Fingerprint string            `json:"fingerprint"`
}

// previewRemoval describes what removing the clone would lose, or answers
// with why it cannot be removed.
func (s *Server) previewRemoval(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) (removal, bool) {
	p := removal{Path: dir, Files: []gitx.FileStatus{}, Commits: []gitx.LogCommit{}}
	_, p.Linked = s.paths.Links()[id.String()]
	if !p.Linked {
		// Never delete through a symbolic link, whatever the folder holds.
		real, err := filepath.EvalSymlinks(dir)
		home, homeErr := filepath.EvalSymlinks(s.paths.Home)
		if err != nil || homeErr != nil || real != filepath.Join(home, id.Host, id.Owner, id.Name) {
			writeError(w, http.StatusConflict, "not_removable", "This copy is reached through a symbolic link, so Revisions will not delete it.")
			return p, false
		}
		st, ok := status(w, r, dir)
		if !ok {
			return p, false
		}
		commits, err := gitx.NotOnRemote(r.Context(), dir, st.Head)
		if err != nil {
			gitFailed(w, err)
			return p, false
		}
		p.Files, p.Commits = st.Files, commits
	}
	summary, _ := json.Marshal(p)
	p.Fingerprint = workspace.Hash(summary)
	return p, true
}

func (s *Server) removePreview(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	if p, ok := s.previewRemoval(w, r, id, dir); ok {
		writeJSON(w, http.StatusOK, p)
	}
}

// removeRepo unlinks a linked folder or deletes a copy in the Revisions
// folder. Saves wait, so none lands in a folder being deleted.
func (s *Server) removeRepo(w http.ResponseWriter, r *http.Request, id workspace.RepoID, dir string) {
	var body struct {
		Fingerprint string `json:"fingerprint"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	removed := s.holdSaves(func() bool {
		p, ok := s.previewRemoval(w, r, id, dir)
		switch {
		case !ok:
			return false
		case body.Fingerprint == "":
			badRequest(w, "A removal must name the preview it confirms.")
			return false
		case p.Fingerprint != body.Fingerprint:
			writeError(w, http.StatusConflict, "changed", "The repository changed after the preview, so nothing was removed. Review it again.")
			return false
		}
		err := s.build.builder.Forget(id)
		if err == nil && p.Linked {
			err = s.paths.Unlink(id)
		} else if err == nil {
			err = os.RemoveAll(dir)
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return false
		}
		return true
	})
	if removed {
		s.files.refreshed.Delete(id)
		w.WriteHeader(http.StatusNoContent)
	}
}
