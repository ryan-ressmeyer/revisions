# Revisions Architecture

## Summary

Revisions is one Go binary that serves an embedded TypeScript web UI on a loopback port. The server owns bytes, processes, Git, and GitHub. The browser owns everything that understands LaTeX. This spec fixes the repository layout, the division of responsibility, the HTTP contract between the two halves, and the engineering rules that keep the codebase small. `specs/overview.md` defines what the product does; this spec defines how the code is arranged to do it.

## Motivation

Redraft accumulated cruft because nothing constrained where new behaviour went [1]. Revisions has two halves built by different agents at different times. A written contract lets each half be built and tested alone, and gives the author one document that explains where any behaviour lives.

## Reference-level explanation

### Division of responsibility

- **Server (Go).** File reads and hash-checked saves, path containment, entry-file detection, `latexmk` builds, SyncTeX queries, Git operations, GitHub sign-in and API calls, settings, and request hardening. The server never parses LaTeX beyond finding `\documentclass`.
- **Browser core (`web/src/core`, pure TypeScript).** The LaTeX scanner, the render plan for the inline view, `changes` markup operations, tracked-change transforms, bibliography and label indexing, and commit-graph layout. Core imports nothing from the DOM, React, or CodeMirror, so every rule in it is unit-tested as a pure function.
- **Browser UI (`web/src/ui`).** React components, the CodeMirror editor, the pdf.js viewer, and the API client. UI code holds no LaTeX rules; it asks core. Per-viewer conveniences, such as the colour scheme, pane layout, and file-tree state, live in `localStorage`; manuscript text never does. `web/public/theme.js`, a classic same-origin script in `index.html`, sets `<html data-theme>` before first paint, and the CSS variables follow that attribute.

### Stack

- Go, standard library only, with one exception: `github.com/zalando/go-keyring` for the operating-system keychain. HTTP routing uses `net/http` method-and-path patterns.
- TypeScript in strict mode, React, CodeMirror 6, pdf.js (`pdfjs-dist`), KaTeX, built with Vite. Tests use Vitest. Biome lints and formats.
- End-to-end tests use Playwright with the installed Chrome channel against the real binary.
- Git and TeX are external programs run as child processes. Revisions links no Git or TeX library.

### Repository layout

```
cmd/revisions/        main: flags, single-instance check, start server, open browser
internal/server/      routes, middleware (Host, Origin, token), JSON helpers
internal/workspace/   clone locations, path containment, file read and save, entry detection, .revisions.toml
internal/build/       tool discovery, latexmk runner, limits, last-good PDF, SyncTeX
internal/gitx/        Git CLI wrapper
internal/host/        Host interface; internal/host/github; internal/host/githubfake (tests)
internal/settings/    user settings and token storage
web/                  package.json, Vite and Playwright config, embed.go (embeds web/dist)
web/src/core/         pure TypeScript domain logic
web/src/ui/           React UI
web/src/api/          typed client for the HTTP contract
web/e2e/              Playwright tests
testdata/manuscript/  small fixture manuscript used by Go and Playwright tests
docs/                 install instructions, scenario-tests.md
scripts/              install.sh, install.ps1
```

### Locations on disk

| Purpose | Default | Override |
|---|---|---|
| Clones | `~/Revisions/<host>/<owner>/<name>` | `REVISIONS_HOME` |
| Settings and local state | `os.UserConfigDir()/revisions` | `REVISIONS_CONFIG_DIR` |
| Build output | `os.UserCacheDir()/revisions/build/<repo id hash>` | `REVISIONS_CACHE_DIR` |

The config directory holds `settings.json` and, for each clone, `repos/<host>/<owner>/<name>.json` with the user's chosen entry file. Each override replaces the root of its row: `~/Revisions`, `os.UserConfigDir()/revisions`, or `os.UserCacheDir()/revisions`. Tests set all three overrides and never touch the real home directory. A repository id is `<host>/<owner>/<name>`, for example `github.com/ryan-ressmeyer/OpenIrisDPI`. Each segment becomes a directory name, so it holds only letters, digits, `.`, `_`, and `-`, and does not end in a dot. A host therefore carries no port.

### Process model

The binary binds `127.0.0.1` on port 4747, or the port given by `--port`. If the port is taken by another Revisions instance, which it tests with `GET /api/ping`, it opens the browser at that instance and exits. `--no-browser` suppresses opening the browser. `--version` prints `revisions <version>` and exits. The version is `dev` unless the build sets `main.version`, which the release build does from the tag; `GET /api/ping` reports the same value.

### Request hardening

- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`.
- A request that carries an `Origin` header must carry the server's own origin. Every request that is not `GET` or `HEAD` must carry it.
- Every `/api/` request except `GET /api/ping` must carry the per-process token in `X-Revisions-Token`. The server writes the token into `index.html` when it serves the page, as the content of `<meta name="revisions-token">`, and serves the page with `Cache-Control: no-store`. Images and the PDF are fetched with the header and shown through blob URLs, except SVG figures: an SVG can hold script, and a blob URL has the app's origin, so an SVG is shown through a `data:` URL, which opens in an opaque origin.
- A request that fails one of these checks is answered 403 with code `bad_host`, `bad_origin`, or `bad_token`.
- The server sends no CORS headers. The app shell is served with a Content-Security-Policy that allows only same-origin scripts. It also allows inline styles, `blob:` and `data:` images, `data:` fonts, `blob:` workers, and same-origin connections, and nothing else.
- Repository files are untrusted. They are served with `X-Content-Type-Options: nosniff`, a content type from a fixed allowlist, and `Content-Security-Policy: sandbox`. The UI never assigns manuscript text to `innerHTML`, and KaTeX runs with `trust` off.
- JSON bodies are capped at 8 MiB.

### HTTP contract

All bodies are JSON unless stated. An error response has the HTTP status and the body `{"error": {"code": "<code>", "message": "<text for the user>"}}`. Any extra fields named below sit inside the `error` object beside `code`. `R` stands for `/api/repos/{host}/{owner}/{name}`.

Every route can answer 404 `not_found` for an unknown route or a repository with no local clone, 400 `bad_json` for a body that does not parse, 413 `too_large` for a body over the cap, and 500 `internal` for a failure the server did not expect. A route under `R` that reads the working tree can answer 424 `git_missing`.

Names and semantics here are binding. An agent that must change the contract changes this section in the same commit and says so in its report.

#### Application

| Method and path | Result |
|---|---|
| `GET /api/ping` | `{app: "revisions", version}`. No token required. |
| `GET /api/env` | `{platform, git: {found, version}, latexmk: {found, version}, synctex: {found}}`. `platform` is `darwin`, `linux`, or `windows`. `version` is `""` when the program is not found. |
| `GET /api/settings` | `{authorId, authorName, buildTimeoutSeconds}`. |
| `PUT /api/settings` | Same shape, with every field required. Validates `authorId` as ASCII letters and digits, possibly empty, and `buildTimeoutSeconds` as 10 to 7200. Error: 400 `bad_settings`. |
| `GET /api/auth` | `{signedIn, user: {login, name, avatarUrl}, suggestedAuthorId}`. `user` is null when signed out, and when signed in while GitHub is unreachable. `suggestedAuthorId` is the initials of the account's name in upper case, or else its login, keeping ASCII letters and digits. |
| `POST /api/auth/device` | Starts the device flow. `{userCode, verificationUri, expiresIn, interval}`. Error: 503 `not_configured` when the build has no OAuth client ID. |
| `POST /api/auth/device/poll` | `{status}` where status is `pending`, `ok`, `expired`, or `denied`. The page may poll at any rate: the server forwards a poll to GitHub only when GitHub's interval has passed and answers `pending` otherwise. With no sign-in in progress the status is `expired`. |
| `POST /api/auth/signout` | Deletes the stored token. Answers like `GET /api/auth`. |
| `GET /api/repos` | Local clones: `[{id, branch, head}]`. `branch` is null on a detached HEAD. |
| `POST /api/open` | Body `{url}`. Brings a clone to the shared ref. `{repo, ref: {kind, name, sha}}` describes what is checked out afterwards: `kind` is `branch` with the local branch in `name`, or `commit` with an empty `name` on a detached HEAD. Errors: 400 `bad_url`, 401 `auth_required`, 404 `not_found`, 409 `dirty` with `files` as in `R/git/status`, 424 `git_missing`, 502 `git_failed`. |

#### Project and files

| Method and path | Result |
|---|---|
| `GET R/project` | `{entry, entryCandidates, entryFromConfig, engine, files: [{path, kind, size}]}`. `kind` is `text`, `image`, or `other`. `entry` is `""` when there is nothing to build. |
| `PUT R/entry` | Body `{path}`. Stores the chosen entry file in local state, not in the repository. Returns the project, as `GET R/project` does. Error: 400 `bad_entry` when the path is not one of `entryCandidates`. |
| `GET R/state` | One poll target: `{hashes: {<path>: <sha256>}, tree, build: {state, pdfVersion, stale}, git: {head, branch, dirty}}`. `tree` is a hash of the path and kind of every file in `R/project`'s `files`: it changes when a file is added or removed, not when one is edited, and the UI then reloads the project. `hashes` covers text files up to 2 MiB; the server reads a file again only when its size or modification time changed, or its modification time is less than 2 s older than its last read, so a change that keeps both is not reported (a save still compares the bytes on disk). The first poll of a clone refreshes Git's index. `branch` is null on a detached HEAD. `dirty` counts untracked files. |
| `GET R/file?path=` | Raw bytes. `X-Revisions-Hash` holds the SHA-256 of the bytes and is also the `ETag`; a matching `If-None-Match` answers 304. Errors: 400 `bad_path`, 404 `not_found`. |
| `PUT R/file?path=` | Body `{baseHash, text}`. `{hash, written}`. Errors: 400 `bad_path`, 404 `not_found`, 409 `detached` on a detached HEAD, where the clone shows a snapshot that is never changed, 409 `stale` with the current `hash`, 422 `not_utf8`. A save never creates a file. |

`text` in a save uses `\n` line breaks. The server maps it onto the bytes on disk as described under Byte-preserving saves.

`files` lists every tracked or untracked, non-ignored regular file, sorted by path. Symbolic links and submodules are left out. `text` is a file with a known text extension, such as `.tex` or `.bib`, of at most 2 MiB. `image` is PNG, JPEG, or GIF. Everything else, including a PDF figure, is `other`.

`entryCandidates` holds the tracked `.tex` files with an uncommented `\documentclass`, sorted by path. An entry file, detected or configured, must have a name without a backtick, `$`, `"`, `\`, `%`, or control character; `latexmk` passes the name to a shell inside double quotes, where those would run a command, end the quoting, or expand a variable. When `.revisions.toml` names an entry, `entryFromConfig` is true and `entryCandidates` is empty; `entry` is then `""` if that file cannot be used. Otherwise `entry` is the user's stored choice while it is still a candidate, and the first candidate if not.

A file is served as `text/plain; charset=utf-8` when its kind is `text`, as its own type when it is a PNG, JPEG, GIF, or PDF, and as `application/octet-stream` otherwise.

#### Path containment

A `path` is relative to the repository root and uses forward slashes. The server answers 400 `bad_path` for an absolute path, a `.` or `..` component, a backslash, a colon, a NUL, a symbolic link as any component, and anything that is not a regular file. It also refuses every path inside a `.git` directory, because a write to hooks or configuration there would run code.

#### Build and SyncTeX

| Method and path | Result |
|---|---|
| `POST R/build` | Starts a build, or returns the running one. 202 with the build status. Errors: 424 `latexmk_missing`, 409 `no_entry` when the project has no entry file. |
| `GET R/build` | `{state, startedAt, finishedAt, log, errors: [{path, line, message}], pdfVersion, stale}`. `state` is `none`, `running`, `succeeded`, `failed`, `timeout`, or `canceled`. |
| `DELETE R/build` | Cancels the running build, waits until its processes are killed, and returns the build status. With no build running it only returns the status. |
| `GET R/pdf` | The last good PDF. 404 `no_pdf` when no build has succeeded. |
| `GET R/pdf/log` | `{log, builtAt}`: the log of the build that made the last good PDF, capped at 1 MiB like `log`, and when that build finished. A later failed build does not change it. 404 `no_pdf` when no build has succeeded. |
| `GET R/synctex/forward?path=&line=&column=` | `{page, x, y, width, height}` in PDF points from the top-left of the page. `line` and `page` count from 1 and `column` from 0; `column` may be omitted. Errors: 400 `bad_path`, 400 `bad_query`, 404 `no_pdf`, 404 `no_match`, 424 `synctex_missing`. |
| `GET R/synctex/inverse?page=&x=&y=` | `{path, line, column}`. `path` is relative to the repository root. `column` is 0 when SyncTeX does not know it. Errors as for forward; 404 `no_match` also covers a location whose source lies outside the repository. |

`pdfVersion` is 0 until a build succeeds, increases by one on each successful build, and survives a restart. `stale` is true when the working tree differs from the tree the last good PDF was built from, and false while there is no PDF. `startedAt` and `finishedAt` are RFC 3339 times, or null when there is none. After a restart `state` is `none` until the next build. `log` holds the output so far while a build runs. An error in a file outside the repository has `path` `""`, `line` 0, and the whole output line as `message`.

#### Git and pull requests

| Method and path | Result |
|---|---|
| `GET R/git/status` | `{branch, head, upstream, upstreamGone, ahead, behind, files: [{path, status}], merging, conflicts, permissions: {push}}`. `branch` is null on a detached HEAD, `upstream` is null when the branch has none, and `upstreamGone` is true when the branch tracked a GitHub branch that a fetch found removed, for example after its pull request was closed; `upstream` is then null and `ahead` and `behind` are 0. A branch that was never sent has `upstreamGone` false. `head` is empty before the first commit. `files` covers every change against HEAD, sorted by path; `status` is `modified`, `added`, `deleted`, `renamed`, `untracked`, or `conflicted`. `conflicts` lists the paths that are `conflicted`. `permissions.push` is false when signed out or when GitHub cannot be reached; the server asks GitHub at most every 30 s. `snapshot` is null on a branch; on a detached HEAD it is `{subject, date, returnTo}`: the subject and author date (ISO 8601) of the commit on screen, and the branch that going back switches to. `returnTo` is the branch most recently checked out that still exists locally (Git's `@{-n}`), else the remote's default branch (`origin/HEAD`), else null. |
| `GET R/git/diff?path=` | Unified diff of the working tree against HEAD, including untracked files and excluding ignored ones. `path` is optional and is taken literally, not as a pattern. Body is `{diff}`. Error: 400 `bad_path`. |
| `GET R/git/log?limit=` | `{commits: [{sha, parents, authorName, date, subject, refs}], pulls: [{number, title, state, headSha, headRef, url}]}`. Covers all local and remote branches, children before parents. `limit` defaults to 200. `refs` holds `HEAD` and full ref names such as `refs/heads/main` and `refs/remotes/origin/main`. `date` is the author date in ISO 8601. `pulls` lists the open pull requests, and is empty when signed out or when GitHub cannot be reached. `state` is `open`, `closed`, or `merged`. |
| `GET R/git/commits/{sha}` | `{sha, message, authorName, date, diff}`. `sha` may be abbreviated. |
| `POST R/git/commit` | Body `{message}`. Stages every change and commits. Concludes a merge when one is in progress. Errors: 409 `detached`, 409 `conflicts` with `files`, 409 `nothing_to_commit`. |
| `POST R/git/fetch` | Fetches `origin`. |
| `POST R/git/pull` | Fetches, then merges the upstream branch. A conflict is not an error; `merging` and `conflicts` report it. Errors: 409 `detached`, 409 `no_upstream`, 409 `upstream_gone` when the fetch found the branch removed on GitHub, which leaves the working tree as it was, 409 `dirty` with `files` when uncommitted changes block the merge. |
| `POST R/git/merge/abort` | Aborts the merge in progress. Error: 409 `not_merging`. |
| `POST R/git/push` | Pushes the current branch and sets its upstream. Errors: 403 `no_push_permission`, 409 `detached`, 409 `rejected` when the remote has new commits. |
| `GET R/git/force-push/preview` | Fetches, then `{remoteSha, commits}` listing the remote commits a force-push would erase, in the shape of the log's commits. `remoteSha` is empty when the remote has no such branch. Error: 409 `detached`. |
| `POST R/git/force-push` | Body `{expectedRemoteSha}`, the `remoteSha` of the preview. Pushes with `--force-with-lease=<branch>:<expectedRemoteSha>`. Errors: 403 `no_push_permission`, 409 `detached`, 409 `rejected` when the remote moved after the preview. |
| `POST R/git/branches` | Body `{name}`. Creates the branch at HEAD and switches to it. Uncommitted changes carry over. Errors: 400 `bad_branch`, 409 `branch_exists`. |
| `POST R/git/checkout` | Body `{branch}`, a branch name without `refs/` or `origin/`, or `{commit}`, a commit SHA that may be abbreviated. A branch that exists only on the remote gets a local branch that tracks it. A commit is checked out as a snapshot, on a detached HEAD; a clone already detached at it stays as it is. Errors: 400 `bad_request` when both are named, 404 `not_found`, 409 `dirty` with `files`. |
| `GET R/git/discard/preview` | `{diff, files, fingerprint}` for everything a discard would remove. `diff` is that of `R/git/diff` and `files` that of `R/git/status`. `fingerprint` is a hash of the diff, the files, and whether a merge is in progress. |
| `POST R/git/discard` | Body `{fingerprint}`, that of the preview the user confirmed. Restores tracked files to HEAD and deletes untracked, non-ignored files. Also ends a merge in progress. Errors: 400 `bad_request` without a fingerprint, 409 `changed` when the preview would now differ, which discards nothing. |
| `POST R/pulls` | Body `{title, body, base}`. Opens a pull request from the current branch. `base` defaults to the repository's default branch. Returns the pull-request object, shaped as in the log. Errors: 409 `detached`, 409 `not_pushed` when the branch is not on the remote or has unpushed commits, 422 `pull_rejected` with GitHub's reason. |

Every `POST` under `R/git/` answers with the new status, in the shape of `GET R/git/status`.

Routes that talk to GitHub (`fetch`, `pull`, `push`, both force-push routes, and `R/pulls`) answer 401 `auth_required` when signed out. A route that runs Git answers 424 `git_missing` when Git is not installed and 502 `git_failed` when Git fails; the message carries Git's own. A failed call to GitHub is 502 `host_failed` with GitHub's reason, or 502 `host_unreachable`. A body that parses but lacks a required value is 400 `bad_request`. The token store failing is 500 `storage_failed`.

A path is `conflicted` when Git left it unmerged and the file still has a line that starts with `<<<<<<<` or `>>>>>>>`. The user resolves a conflict by editing the markers out in the raw editor; nothing is staged by hand. An unmerged path with no markers counts as resolved to what is in the working tree, so a conflicted binary file keeps the local version. `POST R/git/commit` is refused with `conflicts` while any path is `conflicted`.

### Opening a shared URL

The host parses the URL into a repository and a ref. Accepted forms are the repository root, `/tree/<branch>`, `/commit/<sha>`, and `/pull/<number>`. The repository root means the default branch. Everything after `/tree/` is the branch name, so a branch may contain slashes and a URL of a folder inside a branch is not accepted. Segments after the pull-request number are ignored.

1. Sign-in is required first. Without a token the server answers 401 `auth_required`. Then come 400 `bad_url`, 424 `git_missing`, and 404 `not_found` when GitHub does not show the repository or pull request to the account.
2. With no clone, the server clones into the clone location.
3. With a clone, the server fetches. If the clone already sits at the target commit, nothing changes. If the working tree is dirty and the target differs, the server answers 409 `dirty` and leaves the tree untouched. Dirty means changed or untracked files, or a merge in progress.
4. A branch URL checks out that branch, creating a tracking branch when needed, and fast-forwards it when possible. A local branch with unpushed commits cannot fast-forward and stays where it is, so the target commit of a branch URL is the commit that branch ends on. 404 `not_found` when the remote has no such branch.
5. A commit URL checks out the branch whose remote tip is that commit when exactly one exists and the local branch of that name is absent or can fast-forward to it. Otherwise it checks out the commit detached, as a snapshot, the same state as viewing an earlier version from the history: saves are refused and the editor is read-only until the user goes back to a branch or starts one. A clone that already sits at the commit stays on its branch. 404 `not_found` when the fetch did not bring the commit.
6. A pull-request URL checks out the head branch when the head is in the same repository. A pull request from a fork fetches `refs/pull/<n>/head` into `refs/remotes/pull/<n>` and checks it out as local branch `pr-<n>`, which has no upstream.

### Git execution

Every Git call goes through one function in `internal/gitx` that sets `GIT_TERMINAL_PROMPT=0` and, for network commands, supplies the token as an `http.<host url>.extraHeader` setting through `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, and `GIT_CONFIG_VALUE_n`. The token never appears in arguments, in `.git/config`, or in logs. Commits use the user's Git identity when one is configured and otherwise the name and no-reply address of the signed-in GitHub account.

- The same function sets `LC_ALL=C`, an empty `GIT_ASKPASS`, and `GIT_OPTIONAL_LOCKS=0`, and runs Git directly, never through a shell. A network command also empties `credential.helper`, so only the signed-in account's token is used.
- Output is read only in machine formats: `status --porcelain=v2 -z`, `push --porcelain`, and `--format` strings with unit separators.
- The diff against HEAD is computed through a scratch copy of the index, so reading a diff stages nothing in the clone.
- The server serializes requests that change a clone.
- The token is stored in the operating-system keychain. When the keychain is unavailable, or `REVISIONS_TOKEN_STORE=file`, it is stored in a mode-0600 file in the settings directory.

### Host seam

`internal/host` defines one interface: parse a URL, run the device flow, describe the user, report repository permissions, read, list, and create pull requests, and give the clone URL and Git authentication header. `internal/host/github` is the only implementation. Its web and API base URLs come from `REVISIONS_GITHUB_URL` and `REVISIONS_GITHUB_API_URL` when set, which is how tests point it at `githubfake` and at local bare repositories. The OAuth client ID is the variable `ClientID` in `internal/host/github/github.go`, its one home, which the release build compiles in as it stands. It is public, not a secret. `REVISIONS_GITHUB_CLIENT_ID` overrides it when set, and an empty value turns sign-in off. `REVISIONS_GITHUB_TOKEN` bypasses sign-in.

- The host segment of a repository id is always `github.com`, and shared URLs are always `github.com` URLs, whatever the base URLs are.
- The device-flow endpoints are served from the web base URL. When that is not an HTTP URL, as in tests where it is a `file://` directory of bare repositories, they are served from the API base URL.
- `internal/host/githubfake` fakes exactly the endpoints the GitHub implementation calls. `internal/host/githubfake/cmd/githubfake` runs it as a process for the end-to-end tests; its usage is at the top of that file.

### Byte-preserving saves

The server holds one lock per file and performs each save as follows.

1. Read the file and compare its SHA-256 with `baseHash`. A mismatch answers 409 `stale`.
2. View the disk bytes as lines, treating `\r\n`, `\n`, and `\r` each as one line break.
3. Find the longest common prefix and suffix between that view and the incoming text.
4. Keep the original bytes of the prefix and suffix. Encode the changed middle with the file's majority line ending.
5. If nothing changed, do not write. Otherwise write a temporary file in the same directory and rename it over the original, keeping the file mode.

A leading UTF-8 byte-order mark is not part of the text: the one on disk is kept whether or not `text` carries it. A `\r\n` or `\r` in `text` counts as one line break. On a tie the majority line ending is `\n`, then `\r\n`.

A file that is not valid UTF-8 is served for reading and refuses saves with 422 `not_utf8`.

### Builds

- The command is `latexmk -norc` with the engine flag, `-interaction=nonstopmode`, `-file-line-error`, `-synctex=1`, `-no-shell-escape`, and `-outdir` in the build cache. The working directory is the entry file's directory. `-norc` matters because a `latexmkrc` is executable Perl.
- The output directory mirrors the source directories below the entry file's directory, because TeX writes the `.aux` file of `\include{sub/chapter}` into `sub/` there and does not create it.
- The engine is `pdflatex` unless `.revisions.toml` sets `engine` to `xelatex` or `lualatex`.
- One build runs per repository. The timeout is read from settings when the build starts. On timeout or cancel, the whole process group is killed.
- The server keeps the last 1 MiB of output and extracts `file:line: message` errors from it.
- On success the PDF, its `.synctex.gz`, and the build's log are copied to a `good` directory, and the working-tree fingerprint and finish time are recorded. A failed build never touches `good`.
- The fingerprint is a hash over the entry file, the engine, and the path, size, and modification time of every tracked or untracked non-ignored file.
- Tool discovery searches `PATH`, then `/Library/TeX/texbin`, `/usr/local/texlive/*/bin/*`, `~/Library/TinyTeX/bin/*`, and the MiKTeX install directories. The directory found is prepended to the build's `PATH`.
- SyncTeX uses the `synctex` command-line tool from the same directory, run in the entry file's directory against the `good` PDF.

Compilation is a trusted-local operation. Disabling shell escape and `latexmkrc` removes the direct code-execution paths, but TeX can still read files the user can read.

### Editor model

- The editor is one CodeMirror instance per open file. The document is always the exact source text. Rich mode adds decorations computed by core; Source mode shows the same document without them. No second representation of the document exists.
- Core's scanner is tolerant: it never throws, and the source ranges of its nodes tile the input exactly. Anything it does not recognize is plain text, which the editor shows as raw source.
- A rendered construct is revealed as source when the selection touches its range. `changes` markup is the exception: its macro syntax stays hidden and atomic in Rich mode, and core's `guardEdit` redirects plain edits that would delete part of it. With Markup off, `buildPlan`'s `markup: false` also hides deleted text, old text, and notes, and `guardEdit(…, markup = false)` protects them the same way.
- Core's plan marks each single line break inside running prose as a `softbreak` widget, which never reveals, so CodeMirror joins the two lines into one visual line. Deleting it arrives as the deletion of that `\n`; core's `joinSoftBreak` turns that into one space. Document line numbers are unchanged, so SyncTeX and go-to-line keep working; Rich mode shows no line-number gutter.
- Tracked changes are a transaction filter. Core maps each user edit plus the author ID to the edit that should be applied instead.
- Autosave sends the whole document text with the base hash 1 s after the last change, and before any build or Git operation. The UI polls `GET R/state` every 2 s and on focus, and reloads any file whose hash changed and that has no pending edits.
- The open file loads first. Every other `.tex` and `.bib` text file then loads in parallel, so labels and citation keys resolve across files without a build; their status re-renders when the files arrive.
- KaTeX runs once per distinct formula and figures are rasterised once per path; a widget scrolled back into view reuses that output. Widgets compare equal when their data is equal, so a re-plan with nothing changed keeps every widget's DOM. CodeMirror draws only about 1000 px beyond the visible area and offers no supported setting to draw more, so the cost of drawing a new line is what keeps scrolling smooth.

### Engineering rules

- Behaviour is written test-first. Each Scenario in `specs/overview.md` maps to at least one automated test, recorded in `docs/scenario-tests.md`.
- Go tests use real Git repositories in temporary directories and the real `latexmk` when it is installed. Tests that need TeX skip when it is absent.
- No abstraction has a single caller-facing purpose it does not yet serve. The host seam is the one deliberate exception, because the overview requires it.
- A deliberate shortcut carries a `ponytail:` comment that names its ceiling and the upgrade path.
- `make test` runs every unit test, `make e2e` runs Playwright, `make lint` runs `gofmt`, `go vet`, `tsc`, and Biome, and `make build` produces `bin/revisions`.

## Alternatives considered

**All-TypeScript on Node.** One language and shared types, but the collaborator would need a Node runtime, or the project would depend on single-executable packaging that is still unstable. Rejected by the user in favour of Go [2].

**A Git library instead of the Git program.** Pure-Go and JavaScript Git libraries do not perform three-way merges, which pull requires. Detecting and guiding a Git install matches the TeX approach [2].

**A GitHub App instead of an OAuth App.** Its tokens reach only repositories where the app is installed, which is narrower. It also requires the author to install the app on every manuscript repository and on any fork a collaborator pushes to. The OAuth App with the device flow needs no per-repository setup [2].

**Parsing `.synctex.gz` in the browser.** It would remove the dependency on the `synctex` tool. Every supported TeX distribution ships the tool, so the parser is not needed yet.

**A LaTeX parsing library.** Available parsers build a full syntax tree and are not designed to tolerate half-typed input on every keystroke. The inline view needs only a shallow structure with exact offsets.

## Unresolved questions

- [NEEDS CLARIFICATION: The OAuth App client ID. The author must register the app.]
- [NEEDS CLARIFICATION: Where release binaries are hosted, which determines the install commands.]

## Sources

- [1] `notes/grill-rewrite-overview-01.md`. Interview, session 01, 2026-11-09. Q1 gives the motivation for the rewrite.
- [2] `notes/decisions-v1-kickoff.md`. Stack choice, delegated decisions, and the build spike, 2026-11-10.
