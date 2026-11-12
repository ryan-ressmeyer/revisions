//go:build unix

package build

import (
	"os/exec"
	"syscall"
)

// killTreeOnCancel makes cmd the leader of a new process group and makes
// canceling its context kill the whole group: latexmk, the TeX engine, and
// Biber.
//
// ponytail: the group is not tied to the server's life, so a build still
// running when Revisions itself is killed runs on to its own end. Cancel
// builds from a signal handler in main if a looping document ever outlives
// the app.
func killTreeOnCancel(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
}
