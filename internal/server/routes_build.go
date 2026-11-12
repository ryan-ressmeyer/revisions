package server

import (
	"bytes"
	"errors"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/ryan-ressmeyer/revisions/internal/build"
	"github.com/ryan-ressmeyer/revisions/internal/settings"
	"github.com/ryan-ressmeyer/revisions/internal/workspace"
)

// buildDeps holds what these routes need. Add fields here and set them at the top
// of registerBuild; no other file has to change.
type buildDeps struct {
	builder *build.Builder
	// find locates a TeX program; "" means it is not installed.
	find func(name string) string
	// second is how long one unit of the buildTimeoutSeconds setting lasts.
	// Tests shorten it so that a timeout takes milliseconds.
	second time.Duration
}

// registerBuild registers R/build, R/pdf, and R/synctex/*.
func (s *Server) registerBuild(mux *http.ServeMux) {
	s.build = buildDeps{builder: build.New(s.paths.CacheDir), find: build.FindTool, second: time.Second}

	const R = "/api/repos/{host}/{owner}/{name}"
	mux.HandleFunc("POST "+R+"/build", s.postBuild)
	mux.HandleFunc("GET "+R+"/build", s.getBuild)
	mux.HandleFunc("DELETE "+R+"/build", s.deleteBuild)
	mux.HandleFunc("GET "+R+"/pdf", s.getPDF)
	mux.HandleFunc("GET "+R+"/pdf/log", s.getPDFLog)
	mux.HandleFunc("GET "+R+"/synctex/forward", s.getSyncTeXForward)
	mux.HandleFunc("GET "+R+"/synctex/inverse", s.getSyncTeXInverse)
}

func (s *Server) postBuild(w http.ResponseWriter, r *http.Request) {
	_, _, ok := s.repo(w, r)
	if !ok {
		return
	}
	// Checked before anything else so that a machine without TeX gets install
	// guidance, whatever state the repository is in.
	latexmk := s.build.find("latexmk")
	if latexmk == "" {
		writeError(w, http.StatusFailedDependency, "latexmk_missing", "LaTeX is not installed, so the PDF cannot be built.")
		return
	}
	id, root, proj, ok := s.project(w, r)
	if !ok {
		return
	}
	if proj.Entry == "" {
		writeError(w, http.StatusConflict, "no_entry", "This repository has no LaTeX document to build.")
		return
	}
	// The timeout is read now, so a change in settings applies to the next build.
	current, err := settings.Load(s.paths.ConfigDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	timeout := time.Duration(current.BuildTimeoutSeconds) * s.build.second
	writeJSON(w, http.StatusAccepted, s.build.builder.Start(id, root, proj, latexmk, timeout))
}

func (s *Server) getBuild(w http.ResponseWriter, r *http.Request) {
	if id, _, proj, ok := s.project(w, r); ok {
		writeJSON(w, http.StatusOK, s.build.builder.Status(id, proj.Fingerprint()))
	}
}

func (s *Server) deleteBuild(w http.ResponseWriter, r *http.Request) {
	if id, _, proj, ok := s.project(w, r); ok {
		writeJSON(w, http.StatusOK, s.build.builder.Cancel(id, proj.Fingerprint()))
	}
}

func (s *Server) getPDF(w http.ResponseWriter, r *http.Request) {
	id, _, ok := s.repo(w, r)
	if !ok {
		return
	}
	pdf, _, ok := s.build.builder.ReadPDF(id)
	if !ok {
		writeError(w, http.StatusNotFound, "no_pdf", "No PDF has been built yet.")
		return
	}
	// The PDF is made from repository files, so it is as untrusted as they are.
	h := w.Header()
	h.Set("Content-Type", "application/pdf")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox")
	h.Set("Cache-Control", "no-store")
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(pdf))
}

func (s *Server) getPDFLog(w http.ResponseWriter, r *http.Request) {
	id, _, ok := s.repo(w, r)
	if !ok {
		return
	}
	log, builtAt, ok := s.build.builder.ReadLog(id)
	if !ok {
		writeError(w, http.StatusNotFound, "no_pdf", "No PDF has been built yet.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"log": log, "builtAt": builtAt})
}

// synctexTool finds the synctex program or answers 424.
func (s *Server) synctexTool(w http.ResponseWriter) (string, bool) {
	program := s.build.find("synctex")
	if program == "" {
		writeError(w, http.StatusFailedDependency, "synctex_missing", "The synctex program of the TeX installation was not found.")
	}
	return program, program != ""
}

func writeSyncTeXError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, build.ErrNoPDF):
		writeError(w, http.StatusNotFound, "no_pdf", "No PDF has been built yet.")
	case errors.Is(err, build.ErrNoMatch):
		writeError(w, http.StatusNotFound, "no_match", "That location has no counterpart in the other view.")
	default:
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
	}
}

func badQuery(w http.ResponseWriter) {
	writeError(w, http.StatusBadRequest, "bad_query", "The request has a missing or malformed parameter.")
}

func (s *Server) getSyncTeXForward(w http.ResponseWriter, r *http.Request) {
	id, root, ok := s.repo(w, r)
	if !ok {
		return
	}
	program, ok := s.synctexTool(w)
	if !ok {
		return
	}
	q := r.URL.Query()
	if _, err := workspace.Resolve(root, q.Get("path")); err != nil {
		writeWorkspaceError(w, err)
		return
	}
	line, err := strconv.Atoi(q.Get("line"))
	column := 0
	if err == nil && q.Get("column") != "" {
		column, err = strconv.Atoi(q.Get("column"))
	}
	if err != nil || line < 1 || column < 0 {
		badQuery(w)
		return
	}
	box, err := s.build.builder.Forward(id, root, program, q.Get("path"), line, column)
	if err != nil {
		writeSyncTeXError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, box)
}

func (s *Server) getSyncTeXInverse(w http.ResponseWriter, r *http.Request) {
	id, root, ok := s.repo(w, r)
	if !ok {
		return
	}
	program, ok := s.synctexTool(w)
	if !ok {
		return
	}
	q := r.URL.Query()
	page, err1 := strconv.Atoi(q.Get("page"))
	x, err2 := strconv.ParseFloat(q.Get("x"), 64)
	y, err3 := strconv.ParseFloat(q.Get("y"), 64)
	if err1 != nil || err2 != nil || err3 != nil || page < 1 || math.IsNaN(x+y) || math.IsInf(x+y, 0) {
		badQuery(w)
		return
	}
	loc, err := s.build.builder.Inverse(id, root, program, page, x, y)
	if err != nil {
		writeSyncTeXError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, loc)
}
