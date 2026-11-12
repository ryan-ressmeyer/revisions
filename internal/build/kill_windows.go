//go:build windows

package build

import (
	"os/exec"
	"strconv"
)

// killTreeOnCancel makes canceling cmd's context kill it and every process it
// started: latexmk, the TeX engine, and Biber.
//
// ponytail: taskkill walks the tree by parent id, so a grandchild whose parent
// already exited survives. Use a job object if that ever shows up.
func killTreeOnCancel(cmd *exec.Cmd) {
	cmd.Cancel = func() error {
		return exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
	}
}
