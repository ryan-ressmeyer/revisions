//go:build unix

package build

import (
	"os/exec"
	"testing"
	"time"
)

// processesUsing reports whether any process has dir on its command line.
// latexmk passes the output directory to the TeX engine, so this finds the
// engine as well as latexmk.
func processesUsing(dir string) bool {
	return exec.Command("pgrep", "-f", dir).Run() == nil
}

// Scenario: Runaway build (the process side: nothing is left running).
func TestTimeoutKillsTheWholeProcessTree(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("pgrep"); err != nil {
		t.Skip("pgrep is not installed")
	}
	f := newFixture(t, map[string]string{"main.tex": doc("\\def\\x{\\x}\\x")})

	f.b.Start(testID, f.root, f.project(t), f.latexmk, 3*time.Second)
	running := false
	for deadline := time.Now().Add(2500 * time.Millisecond); !running && time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		running = processesUsing(f.paths.CacheDir)
	}
	if !running {
		t.Fatal("no build process was seen running, so this test cannot tell whether it was killed")
	}

	st := f.wait(t)
	if st.State != "timeout" {
		t.Fatalf("state %q, want timeout\n%s", st.State, st.Log)
	}
	if took := st.FinishedAt.Sub(*st.StartedAt); took < 3*time.Second || took > 12*time.Second {
		t.Errorf("the build ended after %v, want just over the 3 s limit", took)
	}
	if processesUsing(f.paths.CacheDir) {
		t.Error("a build process outlived the timeout")
	}
}
