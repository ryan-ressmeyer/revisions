// Package gitx runs the system Git. Every call goes through run, which is the
// one place that decides Git's environment and how the token reaches it. See
// "Git execution" in specs/architecture.md.
package gitx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// ErrMissing reports that Git is not installed.
var ErrMissing = errors.New("git is not installed")

// ErrRejected reports a push the remote refused: it has commits the push
// would lose, or the force-push lease no longer holds.
var ErrRejected = errors.New("push rejected")

// Error is a Git command that exited with a failure.
type Error struct {
	Command string // the subcommand, never its arguments
	Code    int
	Stdout  string
	Stderr  string
}

func (e *Error) Error() string {
	return "git " + e.Command + ": " + strings.TrimSpace(e.Stderr)
}

// Auth is what a network command needs to authenticate: Header is sent to
// URLs under BaseURL and nowhere else. The zero value sends nothing.
type Auth struct {
	BaseURL string // for example "https://github.com/"
	Header  string // for example "Authorization: Basic ..."
}

// Identity is the author used for a commit when Git has none configured.
type Identity struct{ Name, Email string }

// run executes git with args in dir and returns its standard output. It never
// uses a shell and never prompts. auth travels in the environment as an
// http.<BaseURL>.extraHeader setting, so it is absent from the arguments and
// from .git/config.
func run(ctx context.Context, dir string, auth Auth, env []string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=", // fail instead of asking for a password
		"LC_ALL=C",
		"GIT_OPTIONAL_LOCKS=0", // a status poll must not block the user's own Git commands
	)
	secret := ""
	if auth.Header != "" {
		secret = auth.Header[strings.LastIndex(auth.Header, " ")+1:]
		cmd.Env = append(cmd.Env,
			"GIT_CONFIG_COUNT=2",
			"GIT_CONFIG_KEY_0=http."+auth.BaseURL+".extraHeader", "GIT_CONFIG_VALUE_0="+auth.Header,
			// Only the signed-in account's token is used, never a stored credential.
			"GIT_CONFIG_KEY_1=credential.helper", "GIT_CONFIG_VALUE_1=",
		)
	}
	cmd.Env = append(cmd.Env, env...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr

	err := cmd.Run()
	if err == nil {
		return stdout.String(), nil
	}
	if errors.Is(err, exec.ErrNotFound) {
		return "", ErrMissing
	}
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		return "", err
	}
	scrub := func(s string) string {
		if secret == "" {
			return s
		}
		return strings.ReplaceAll(s, secret, "[redacted]")
	}
	return "", &Error{Command: args[0], Code: exit.ExitCode(), Stdout: scrub(stdout.String()), Stderr: scrub(stderr.String())}
}

// git runs a local command: no token, no extra environment.
func git(ctx context.Context, dir string, args ...string) (string, error) {
	return run(ctx, dir, Auth{}, nil, args...)
}

// exited reports whether err is Git exiting with the given code, which several
// commands use to answer "no".
func exited(err error, code int) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == code
}

// Version returns the installed Git version, or ErrMissing.
func Version(ctx context.Context) (string, error) {
	out, err := git(ctx, "", "version")
	return strings.TrimPrefix(strings.TrimSpace(out), "git version "), err
}

// Clone clones url into dir.
func Clone(ctx context.Context, auth Auth, url, dir string) error {
	_, err := run(ctx, "", auth, nil, "clone", "--", url, dir)
	return err
}

// Fetch updates the remote branches of origin. With refspecs it fetches
// exactly those instead.
func Fetch(ctx context.Context, dir string, auth Auth, refspecs ...string) error {
	args := []string{"fetch", "--prune", "origin"}
	if len(refspecs) > 0 {
		args = append([]string{"fetch", "origin", "--"}, refspecs...)
	}
	_, err := run(ctx, dir, auth, nil, args...)
	return err
}

// Commit stages every change and commits it, concluding a merge when one is
// in progress. Git's configured identity wins; fallback is used without one.
func Commit(ctx context.Context, dir, message string, fallback Identity) error {
	if _, err := git(ctx, dir, "add", "-A"); err != nil {
		return err
	}
	_, err := run(ctx, dir, Auth{}, identityEnv(ctx, dir, fallback), "commit", "-m", message)
	return err
}

func identityEnv(ctx context.Context, dir string, fallback Identity) []string {
	name, _ := git(ctx, dir, "config", "--get", "user.name")
	email, _ := git(ctx, dir, "config", "--get", "user.email")
	if (strings.TrimSpace(name) != "" && strings.TrimSpace(email) != "") || fallback.Name == "" {
		return nil
	}
	return []string{
		"GIT_AUTHOR_NAME=" + fallback.Name, "GIT_AUTHOR_EMAIL=" + fallback.Email,
		"GIT_COMMITTER_NAME=" + fallback.Name, "GIT_COMMITTER_EMAIL=" + fallback.Email,
	}
}

// Push pushes branch to origin and sets it as the upstream. With lease it
// force-pushes, and only if the remote branch still sits at *lease ("" means
// the remote branch must not exist). A refusal by the remote is ErrRejected.
func Push(ctx context.Context, dir string, auth Auth, branch string, lease *string) error {
	args := []string{"push", "--porcelain", "--set-upstream"}
	if lease != nil {
		args = append(args, "--force-with-lease="+branch+":"+*lease)
	}
	ref := "refs/heads/" + branch
	_, err := run(ctx, dir, auth, nil, append(args, "origin", ref+":"+ref)...)
	var e *Error
	if errors.As(err, &e) {
		// Porcelain output marks a refused ref with "!": "!\t<from>:<to>\t<reason>".
		for line := range strings.SplitSeq(e.Stdout, "\n") {
			if fields := strings.Split(line, "\t"); len(fields) == 3 && fields[0] == "!" {
				return fmt.Errorf("%w: %s", ErrRejected, fields[2])
			}
		}
	}
	return err
}

// Run runs a local, read-only Git query in dir and returns its output. Other
// packages use it for queries gitx has no function for.
func Run(ctx context.Context, dir string, args ...string) (string, error) {
	return git(ctx, dir, args...)
}
