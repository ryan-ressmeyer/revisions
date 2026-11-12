package server

import (
	"errors"
	"net/http"
	"os/exec"
	"regexp"
	"runtime"
	"sync"

	"github.com/ryan-ressmeyer/revisions/internal/settings"
)

// appDeps holds what these routes need. Add fields here and set them at the top
// of registerApp; no other file has to change.
type appDeps struct {
	quit     chan struct{} // closed when the page asks Revisions to stop
	quitOnce sync.Once
}

// registerApp registers /api/env, /api/settings, and /api/quit.
func (s *Server) registerApp(mux *http.ServeMux) {
	s.app = appDeps{quit: make(chan struct{})}
	mux.HandleFunc("GET /api/env", s.getEnv)
	mux.HandleFunc("GET /api/settings", s.getSettings)
	mux.HandleFunc("PUT /api/settings", s.putSettings)
	mux.HandleFunc("POST /api/quit", s.postQuit)
}

// Quitting is closed once a page has asked Revisions to quit. The program
// then stops the HTTP server, which lets requests in flight finish.
func (s *Server) Quitting() <-chan struct{} { return s.app.quit }

func (s *Server) postQuit(w http.ResponseWriter, r *http.Request) {
	s.build.builder.CancelAll()
	writeJSON(w, http.StatusOK, struct{}{})
	s.app.quitOnce.Do(func() { close(s.app.quit) })
}

var versionNumber = regexp.MustCompile(`\d+\.\d+[\w.]*`)

// toolVersion runs a program with its version flag and returns the first
// version number it prints, or "" when it prints none.
func toolVersion(program, flag string) string {
	out, _ := exec.Command(program, flag).Output()
	return versionNumber.FindString(string(out))
}

func (s *Server) getEnv(w http.ResponseWriter, r *http.Request) {
	type tool struct {
		Found   bool   `json:"found"`
		Version string `json:"version"`
	}
	var git, latexmk tool
	if p, err := exec.LookPath("git"); err == nil {
		git = tool{true, toolVersion(p, "--version")}
	}
	if p := s.build.find("latexmk"); p != "" {
		latexmk = tool{true, toolVersion(p, "-v")}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"platform": runtime.GOOS,
		"git":      git,
		"latexmk":  latexmk,
		"synctex":  map[string]bool{"found": s.build.find("synctex") != ""},
	})
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	current, err := settings.Load(s.paths.ConfigDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, current)
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) {
	var next settings.Settings
	if !readJSON(w, r, &next) {
		return
	}
	switch err := settings.Save(s.paths.ConfigDir, next); {
	case errors.Is(err, settings.ErrInvalid):
		writeError(w, http.StatusBadRequest, "bad_settings", err.Error())
	case err != nil:
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
	default:
		writeJSON(w, http.StatusOK, next)
	}
}
