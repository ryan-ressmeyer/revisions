// Package server is the HTTP face of Revisions: request hardening, JSON
// helpers, the embedded UI, and the routes of the contract in
// specs/architecture.md.
package server

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"io/fs"
	"net/http"
	"strconv"
	"strings"

	"github.com/ryan-ressmeyer/revisions/internal/workspace"
)

// Server holds what every route shares. Each route area keeps its own
// dependencies in the struct declared in its routes_*.go file (appDeps in
// routes_app.go, and so on) and fills it in at the top of its register
// function, so adding a dependency never touches this file.
type Server struct {
	paths   workspace.Paths
	version string
	port    string
	token   string // per-process secret required in X-Revisions-Token
	ui      fs.FS
	index   []byte // index.html with the token written in; nil when the UI is not built
	handler http.Handler

	app   appDeps
	auth  authDeps
	files filesDeps
	build buildDeps
	git   gitDeps
}

const tokenPlaceholder = "__REVISIONS_TOKEN__"

// New builds the server for the given loopback port. ui is the built web UI
// with index.html at its root.
func New(paths workspace.Paths, version string, port int, ui fs.FS) *Server {
	s := &Server{paths: paths, version: version, port: strconv.Itoa(port), token: rand.Text(), ui: ui}
	if index, err := fs.ReadFile(ui, "index.html"); err == nil {
		s.index = bytes.ReplaceAll(index, []byte(tokenPlaceholder), []byte(s.token))
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/ping", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"app": "revisions", "version": s.version})
	})
	s.registerApp(mux)
	s.registerAuth(mux)
	s.registerFiles(mux)
	s.registerBuild(mux)
	s.registerGit(mux)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "No such API route.")
	})
	mux.HandleFunc("/", s.serveUI)
	s.handler = s.harden(mux)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.handler.ServeHTTP(w, r) }

// harden applies the "Request hardening" rules of specs/architecture.md to
// every request before any route sees it.
func (s *Server) harden(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")

		// A page on another site that resolves its own name to 127.0.0.1 (DNS
		// rebinding) still sends its own name as Host.
		if r.Host != "127.0.0.1:"+s.port && r.Host != "localhost:"+s.port {
			writeError(w, http.StatusForbidden, "bad_host", "This address is not the Revisions app.")
			return
		}

		// Browsers attach Origin to every cross-origin request and to every
		// same-origin request that is not GET or HEAD.
		origins := r.Header.Values("Origin")
		own := len(origins) == 1 && origins[0] == "http://"+r.Host
		read := r.Method == http.MethodGet || r.Method == http.MethodHead
		if !own && (len(origins) > 0 || !read) {
			writeError(w, http.StatusForbidden, "bad_origin", "The request did not come from the Revisions page.")
			return
		}

		isPing := r.Method == http.MethodGet && r.URL.Path == "/api/ping"
		if strings.HasPrefix(r.URL.Path, "/api/") && !isPing &&
			subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Revisions-Token")), []byte(s.token)) != 1 {
			writeError(w, http.StatusForbidden, "bad_token", "The page is out of date. Reload it.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// The app shell runs only same-origin scripts. Inline styles are needed by
// CodeMirror and KaTeX; blob: and data: images show repository files fetched
// with the token; blob: workers are for pdf.js.
const shellCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' blob: data:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; " +
	"object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// serveUI serves a built UI file when the path names one and the app shell
// otherwise, so client-side routes survive a reload.
func (s *Server) serveUI(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/")
	if info, err := fs.Stat(s.ui, name); err == nil && !info.IsDir() && name != "index.html" {
		http.ServeFileFS(w, r, s.ui, name)
		return
	}
	if s.index == nil {
		writeError(w, http.StatusServiceUnavailable, "ui_missing", "The web UI is not built. Run make build.")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", shellCSP)
	w.Header().Set("Cache-Control", "no-store")
	w.Write(s.index)
}

// repo resolves the {host}/{owner}/{name} route parameters to a repository id
// and its existing clone directory. When there is no such clone it writes
// 404 not_found and returns false.
func (s *Server) repo(w http.ResponseWriter, r *http.Request) (workspace.RepoID, string, bool) {
	id, dir, err := s.paths.Clone(r.PathValue("host"), r.PathValue("owner"), r.PathValue("name"))
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "That repository is not on this computer.")
		return id, dir, false
	}
	return id, dir, true
}
