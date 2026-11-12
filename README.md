# Revisions

Revisions lets an author share a LaTeX manuscript held in a GitHub repository with a co-author who does not use Git or a TeX toolchain by choice. The co-author pastes a GitHub link, and Revisions clones the repository to their own machine and opens it in the browser as an editor beside the compiled PDF.

## What it does

- **Rich text editing.** Headings, math, figures, citations, and cross-references are drawn in place, and the file on disk stays plain LaTeX. A Source view shows the raw text.
- **Review.** Comments, highlights, and tracked changes are written as macros of the LaTeX `changes` package, so they compile into the PDF and survive in any other editor.
- **Local builds.** `latexmk` runs on the user's machine with shell escape off and all build output kept outside the repository. Clicking in the PDF jumps to the source, and the reverse.
- **Git without the vocabulary.** A panel shows the commit graph and offers Get latest, Send, Branch, Pull request, Force-push, and Discard. Each destructive action first lists what it will erase.
- **Byte-preserving saves.** A save changes only the bytes the user edited, so line endings and untouched lines stay as they were.

`specs/overview.md` states the requirements. `specs/architecture.md` describes the code and the HTTP contract between the server and the browser.

## Status

Version 1 is in development. No release has been published, and sign-in with a GitHub account is not configured in this repository yet. The app has been run on Linux only; macOS and Windows are untested.

## Building from source

Building needs Go and Node.js. Running needs Git and a TeX distribution that provides `latexmk`.

```sh
make build   # produces bin/revisions with the web UI embedded
make test    # Go and Vitest unit tests
make lint    # gofmt, go vet, tsc, Biome
make e2e     # Playwright against the built binary; needs Chrome
```

Until sign-in is configured, pass a GitHub token through the environment. With the GitHub CLI installed:

```sh
REVISIONS_GITHUB_TOKEN=$(gh auth token) bin/revisions
```

Revisions listens on `127.0.0.1:4747` and opens the system browser. Clones are kept under `~/Revisions/`.

## Licence

MIT. See `LICENSE`.
