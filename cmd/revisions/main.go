// Command revisions serves the Revisions web UI on a loopback port and opens
// it in the system browser.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/ryan-ressmeyer/revisions/internal/server"
	"github.com/ryan-ressmeyer/revisions/internal/workspace"
	"github.com/ryan-ressmeyer/revisions/web"
)

// version is set at release time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	port := flag.Int("port", 4747, "loopback port to serve on")
	noBrowser := flag.Bool("no-browser", false, "do not open the system browser")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("revisions", version)
		return
	}

	if err := run(*port, !*noBrowser); err != nil {
		fmt.Fprintln(os.Stderr, "revisions:", err)
		os.Exit(1)
	}
}

func run(port int, browser bool) error {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	url := "http://" + addr

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		if !isRevisions(url) {
			return err
		}
		fmt.Println("Revisions is already running at", url)
		if browser {
			openBrowser(url)
		}
		return nil
	}

	paths, err := workspace.PathsFromEnv()
	if err != nil {
		return err
	}
	fmt.Println("Revisions is running at", url)
	if browser {
		openBrowser(url)
	}
	srv := &http.Server{Handler: server.New(paths, version, port, web.Dist()), ReadHeaderTimeout: 10 * time.Second}
	return srv.Serve(ln)
}

// isRevisions reports whether a Revisions instance answers at url.
func isRevisions(url string) bool {
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(url + "/api/ping")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var ping struct{ App string }
	return json.NewDecoder(resp.Body).Decode(&ping) == nil && ping.App == "revisions"
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "revisions: could not open the browser:", err)
	}
}
