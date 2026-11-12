// Command revisions serves the Revisions web UI on a loopback port and opens
// it in the system browser.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"time"

	"github.com/ryan-ressmeyer/revisions/internal/server"
	"github.com/ryan-ressmeyer/revisions/internal/update"
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

// restartedEnv marks a program started by an update in place of the old one.
// The browser tab is already open and reloads itself, and the old program may
// still be letting go of the port.
const restartedEnv = "REVISIONS_RESTARTED"

func run(port int, browser bool) error {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	url := "http://" + addr
	restarted := os.Getenv(restartedEnv) == "1"
	os.Unsetenv(restartedEnv)

	ln, err := net.Listen("tcp", addr)
	for deadline := time.Now().Add(30 * time.Second); err != nil && restarted && time.Now().Before(deadline); {
		time.Sleep(100 * time.Millisecond)
		ln, err = net.Listen("tcp", addr)
	}
	if err != nil {
		if restarted || !isRevisions(url) {
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
	if browser && !restarted {
		openBrowser(url)
	}
	if exe, err := update.Executable(); err == nil {
		go update.Cleanup(exe)
	}
	h := server.New(paths, version, port, web.Dist())
	err = serve(ln, h)
	if exe := h.Restart(); exe != "" {
		// Requests still running after 30 s are dropped, as on quit.
		fmt.Println("Revisions was updated and restarts.")
		return restart(exe)
	}
	if err != nil {
		return err
	}
	fmt.Println("Revisions has stopped.")
	return nil
}

// restart runs exe, the updated program, with this program's arguments and
// environment, so it serves the same port with the same folders. On macOS and
// Linux it replaces this process, which keeps its place under the launcher or
// terminal. Windows has no such call, so there exe starts as a new process in
// the same console window and this one exits.
func restart(exe string) error {
	env := append(os.Environ(), restartedEnv+"=1")
	if runtime.GOOS != "windows" {
		return syscall.Exec(exe, os.Args, env)
	}
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Env, cmd.Stdin, cmd.Stdout, cmd.Stderr = env, os.Stdin, os.Stdout, os.Stderr
	return cmd.Start()
}

// serve answers on ln until a page asks Revisions to quit, then stops
// accepting requests, lets the ones in flight finish, and returns.
func serve(ln net.Listener, h *server.Server) error {
	srv := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second}
	stopped := make(chan error, 1)
	go func() {
		<-h.Quitting()
		// A Git command can take a while; past this the program exits anyway.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		stopped <- srv.Shutdown(ctx)
	}()
	if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return <-stopped
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
