<img src="docs/icon/icon.svg" alt="" width="96" height="96">

# Revisions

Revisions lets an author share a LaTeX manuscript held in a GitHub repository with a co-author who does not use Git or a TeX toolchain by choice. The co-author pastes a GitHub link, and Revisions clones the repository to their own machine and opens it in the browser as an editor beside the compiled PDF. A repository already on the computer can be linked from its folder instead of cloned again.

## What it does

- **Rich text editing.** Headings, math, figures, citations, and cross-references are drawn in place, and the file on disk stays plain LaTeX. A Source view shows the raw text.
- **Review.** Comments, highlights, and tracked changes are written as macros of the LaTeX `changes` package, so they compile into the PDF and survive in any other editor.
- **Local builds.** `latexmk` runs on the user's machine with shell escape off and all build output kept outside the repository. Clicking in the PDF jumps to the source, and the reverse. A button above the PDF downloads it.
- **Git without the vocabulary.** A panel shows the commit graph and offers Get latest, Send, Branch, Pull request, Force-push, and Discard. Each destructive action first lists what it will erase.
- **Byte-preserving saves.** A save changes only the bytes the user edited, so line endings and untouched lines stay as they were.

`specs/overview.md` states the requirements. `specs/architecture.md` describes the code and the HTTP contract between the server and the browser.

## Installing

Each page takes a reader with nothing installed to an open manuscript, including Git and LaTeX:

- [macOS](docs/install-macos.md)
- [Windows](docs/install-windows.md)
- [Linux](docs/install-linux.md)

The installers are `scripts/install.sh` (macOS and Linux) and `scripts/install.ps1` (Windows). Each downloads the latest release for the computer, checks it against the release's `SHA256SUMS`, installs it for the current user without administrator rights, and adds Revisions to Spotlight, the Start menu, or the applications menu. Running one again upgrades in place. After that, Revisions can update itself: when a newer release is out it shows **Version X is available**, and its **Update** button downloads the release's program, checks it against `SHA256SUMS`, replaces the running program, and restarts it in the same browser tab. Revisions checks when it starts and every six hours, and **Check for updates** in Settings checks at once. The check asks GitHub's public releases API for the latest release and sends no token and nothing about the user.

## Status

Version 1 is in development. Pushing a `v*` tag builds and publishes a release (`.github/workflows/release.yml`); the latest is v0.3.0. Version 0.1.0 predates the Update button, so moving from it takes the install command once. Sign-in uses the Revisions OAuth App, whose client ID is in `internal/host/github/github.go`; no collaborator has signed in through it yet. Collaborators have tested the app on macOS and Windows. The installers are tested on Linux here and, in CI, on macOS and Windows, where CI also opens the installed app.

## Building from source

Building needs Go and Node.js. Running needs Git and a TeX distribution that provides `latexmk`.

```sh
make build   # produces bin/revisions with the web UI embedded
make test    # Go and Vitest unit tests
make lint    # gofmt, go vet, tsc, Biome
make e2e     # Playwright against the built binary; needs Chrome
```

To skip the GitHub sign-in while developing, pass a token through the environment; sign-in, sign-out, and reconnect are off while it is set. With the GitHub CLI installed:

```sh
REVISIONS_GITHUB_TOKEN=$(gh auth token) bin/revisions
```

Revisions listens on `127.0.0.1:4747` and opens the system browser. Clones are kept under `~/Revisions/`.

## Licence

MIT. See `LICENSE`.
