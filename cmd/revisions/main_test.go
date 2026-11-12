package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/ryan-ressmeyer/revisions/internal/server"
	"github.com/ryan-ressmeyer/revisions/internal/workspace"
)

func TestIsRevisionsRecognizesARunningInstance(t *testing.T) {
	ts := httptest.NewUnstartedServer(nil)
	port := ts.Listener.Addr().(*net.TCPAddr).Port
	ts.Config.Handler = server.New(workspace.Paths{}, "test", port, fstest.MapFS{})
	ts.Start()
	defer ts.Close()

	if !isRevisions(ts.URL) {
		t.Fatal("a running Revisions instance was not recognized")
	}
}

func TestIsRevisionsRejectsOtherPrograms(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"app":"something-else"}`))
	}))
	defer other.Close()
	if isRevisions(other.URL) {
		t.Fatal("another program on the port was taken for Revisions")
	}

	closed := httptest.NewServer(nil)
	closed.Close()
	if isRevisions(closed.URL) {
		t.Fatal("a closed port was taken for Revisions")
	}
}
