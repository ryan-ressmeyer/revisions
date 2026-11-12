package server

import (
	"context"
	"errors"
	"net/http"
	"os/exec"
	"regexp"
	"runtime"
	"sync"
	"time"

	"github.com/ryan-ressmeyer/revisions/internal/settings"
	"github.com/ryan-ressmeyer/revisions/internal/update"
)

// appDeps holds what these routes need. Add fields here and set them at the top
// of registerApp; no other file has to change.
type appDeps struct {
	quit     chan struct{} // closed when the page asks Revisions to stop
	quitOnce sync.Once
	restart  string // the program to start in place of this one; set before quit closes

	mu        sync.Mutex
	available string     // the tag of a newer release, or ""
	updating  sync.Mutex // held while an update downloads
}

// registerApp registers /api/env, /api/settings, /api/quit, and /api/update.
func (s *Server) registerApp(mux *http.ServeMux) {
	s.app = appDeps{quit: make(chan struct{})}
	mux.HandleFunc("GET /api/env", s.getEnv)
	mux.HandleFunc("GET /api/settings", s.getSettings)
	mux.HandleFunc("PUT /api/settings", s.putSettings)
	mux.HandleFunc("POST /api/quit", s.postQuit)
	mux.HandleFunc("GET /api/update", s.getUpdate)
	mux.HandleFunc("POST /api/update", s.postUpdate)
	// A dev build, or any build without a release version, never asks.
	if update.Release(s.version) {
		go s.checkForUpdates()
	}
}

// Quitting is closed once a page has asked Revisions to quit or an update
// has been installed. The program then stops the HTTP server, which lets
// requests in flight finish.
func (s *Server) Quitting() <-chan struct{} { return s.app.quit }

// Restart is the program to start in place of this one once the server has
// stopped, after an update; "" when the program should just exit.
func (s *Server) Restart() string { return s.app.restart }

// checkForUpdates asks GitHub for the latest release on start and every six
// hours. A failed check changes nothing and is not reported.
func (s *Server) checkForUpdates() {
	for {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		if tag, err := update.Latest(ctx); err == nil {
			if !update.Newer(s.version, tag) {
				tag = ""
			}
			s.app.mu.Lock()
			s.app.available = tag
			s.app.mu.Unlock()
		}
		cancel()
		time.Sleep(6 * time.Hour)
	}
}

func (s *Server) availableUpdate() string {
	s.app.mu.Lock()
	defer s.app.mu.Unlock()
	return s.app.available
}

func (s *Server) getUpdate(w http.ResponseWriter, r *http.Request) {
	tag, notes := s.availableUpdate(), ""
	if tag != "" {
		notes = update.NotesURL(tag)
	}
	writeJSON(w, http.StatusOK, map[string]string{"version": s.version, "available": tag, "notesUrl": notes})
}

// postUpdate installs the newer release over this program, answers, and then
// stops the server so that main starts the new program on the same port.
func (s *Server) postUpdate(w http.ResponseWriter, r *http.Request) {
	if !s.app.updating.TryLock() {
		writeError(w, http.StatusConflict, "updating", "Revisions is already being updated.")
		return
	}
	defer s.app.updating.Unlock()
	tag := s.availableUpdate()
	if tag == "" {
		writeError(w, http.StatusConflict, "no_update", "There is no newer version of Revisions to install.")
		return
	}
	exe, err := update.Executable()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if err := update.Install(r.Context(), tag, exe); err != nil {
		status, code := http.StatusBadGateway, "update_failed"
		if errors.Is(err, update.ErrNotWritable) {
			status, code = http.StatusConflict, "not_writable"
		}
		writeError(w, status, code, err.Error(), map[string]any{"command": update.Command()})
		return
	}
	s.build.builder.CancelAll()
	s.app.restart = exe
	writeJSON(w, http.StatusOK, map[string]string{"version": tag})
	s.app.quitOnce.Do(func() { close(s.app.quit) })
}

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
