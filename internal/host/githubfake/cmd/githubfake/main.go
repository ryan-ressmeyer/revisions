// Command githubfake serves the fake GitHub for browser tests, which run the
// real revisions binary and so cannot use the fake in-process.
//
// Usage:
//
//	go run ./internal/host/githubfake/cmd/githubfake \
//	    -remotes /tmp/e2e/remotes \
//	    -seed owner/name=testdata/manuscript \
//	    -push=true -auto-approve
//
//	-remotes dir      directory that holds the bare repositories
//	                  (default: a new temporary directory)
//	-seed o/n=dir     create repository o/n with one commit on main holding
//	                  the contents of dir; repeat for more repositories
//	-push=false       make every seeded repository read-only for the account
//	-auto-approve     the device flow succeeds on the first poll, as if the
//	                  user had already entered the code
//	-addr host:port   address to listen on (default 127.0.0.1:0, a free port)
//
// It prints one line of JSON on standard output and then serves until killed:
//
//	{"apiUrl":"http://127.0.0.1:41873","webUrl":"file:///tmp/e2e/remotes","token":"gho_fakeaccesstoken"}
//
// Start revisions with REVISIONS_GITHUB_API_URL=<apiUrl>,
// REVISIONS_GITHUB_URL=<webUrl>, REVISIONS_GITHUB_CLIENT_ID=<anything>, and
// REVISIONS_TOKEN_STORE=file. Shared URLs are still written as
// https://github.com/<owner>/<name>/... . To skip the sign-in screen, also set
// REVISIONS_GITHUB_TOKEN=<token>. The signed-in account is Gale Harper
// (login gharper).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/ryan-ressmeyer/revisions/internal/host/githubfake"
)

func main() {
	ln, line, fake, err := setup(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "githubfake:", err)
		os.Exit(1)
	}
	fmt.Println(line)
	if err := http.Serve(ln, fake); err != nil {
		fmt.Fprintln(os.Stderr, "githubfake:", err)
		os.Exit(1)
	}
}

// setup applies the flags and returns the listener to serve the fake on and
// the JSON line to print.
func setup(args []string) (net.Listener, string, *githubfake.Fake, error) {
	flags := flag.NewFlagSet("githubfake", flag.ContinueOnError)
	remotes := flags.String("remotes", "", "directory of bare repositories (default: a temporary directory)")
	push := flags.Bool("push", true, "the account may push to the seeded repositories")
	approve := flags.Bool("auto-approve", false, "the device flow succeeds on the first poll")
	addr := flags.String("addr", "127.0.0.1:0", "address to listen on")
	var seeds []string
	flags.Func("seed", "owner/name=dir: create the repository from the contents of dir (repeatable)", func(v string) error {
		if repo, dir, ok := strings.Cut(v, "="); !ok || !strings.Contains(repo, "/") || dir == "" {
			return fmt.Errorf("want owner/name=dir")
		}
		seeds = append(seeds, v)
		return nil
	})
	if err := flags.Parse(args); err != nil {
		return nil, "", nil, err
	}

	if *remotes == "" {
		dir, err := os.MkdirTemp("", "githubfake-")
		if err != nil {
			return nil, "", nil, err
		}
		*remotes = dir
	}
	root, err := filepath.Abs(*remotes)
	if err != nil {
		return nil, "", nil, err
	}
	fake := githubfake.New(root)
	for _, seed := range seeds {
		repo, src, _ := strings.Cut(seed, "=")
		if src, err = filepath.Abs(src); err != nil {
			return nil, "", nil, err
		}
		if err := githubfake.Seed(root, repo, src); err != nil {
			return nil, "", nil, err
		}
		fake.SetPush(repo, *push)
	}
	if *approve {
		fake.SetDevice("approved")
	}

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		return nil, "", nil, err
	}
	line, err := json.Marshal(map[string]string{
		"apiUrl": "http://" + ln.Addr().String(),
		"webUrl": githubfake.FileURL(root),
		"token":  githubfake.Token,
	})
	return ln, string(line), fake, err
}
