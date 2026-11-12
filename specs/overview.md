# Revisions Overview

## Summary

Revisions lets an author share a LaTeX manuscript held in a GitHub repository with a collaborator who is capable but not technical. The collaborator opens a shared GitHub URL. Revisions clones the repository to their machine, compiles it locally, and shows the PDF beside an Overleaf-style inline editor, with SyncTeX linking the two. The collaborator edits, comments, and tracks changes using the LaTeX `changes` package, then commits, pushes, branches, or opens a pull request from a commit-graph view. Version 1 runs as a local server opened in the system browser. It is a clean rewrite of Redraft and keeps only the Redraft safety lessons that the user re-justified.

## Motivation

Redraft [2] had weak constraints from the start. Incremental changes accumulated cruft, and the author lost touch with the codebase, which made it hard to plan further changes [1, Q1]. Redraft also never reached the collaboration workflow that motivated it. Its README lists Git operations, comments, review, and authentication as outside its milestone [2].

The target user is a co-author who reads and edits prose but does not use Git, LaTeX toolchains, or a terminal by choice. The first real collaborator uses a Mac and needs the experience to be seamless [1, Q33–Q34]. The author should not have to help with installation or with any single session [1, Q34].

The old repository is read-only evidence of earlier choices. It is not a feature checklist for this rewrite.

## Guide-level explanation

**Sharing.** The author pushes a commit and sends the collaborator a GitHub URL for a commit, branch, or pull request [1, Q2, Q26].

**Opening.** The collaborator pastes the URL into Revisions. On first use, Revisions clones the repository to the collaborator's machine. If a clone already exists, Revisions checks out the shared commit. If that clone has uncommitted work, Revisions refuses and explains why [1, Q3, Q27]. Revisions finds the manuscript's entry file automatically, and the collaborator can choose another one [1, Q36].

**Reading and editing.** The screen splits into a read-only PDF and an editable inline view, in the style of Overleaf. Clicking in either pane jumps to the matching location in the other through SyncTeX [1, Q37]. The inline view renders common LaTeX constructs as formatted text, and anything it does not recognize stays visible as editable raw source. Moving the cursor into a rendered construct reveals its source [1, Q9–Q10]. Edits autosave. The collaborator rebuilds the PDF with a button or a keyboard shortcut. An out-of-date warning appears while the PDF lags the source, and a failed build leaves the last good PDF in place [1, Q16].

**Commenting and tracking changes.** The collaborator highlights text and attaches a comment. The comment lives in the LaTeX source as a `changes` macro, and a Resolve button removes it [1, Q6, Q30]. Tracked changes are off by default. When the collaborator turns them on for a session, edits are recorded as `changes` markup, and each tracked change has Accept and Reject buttons. Accept all and Reject all apply to every tracked change [1, Q8, Q38].

**Sending changes back.** A GitKraken-style commit graph shows local and remote history. Within the permissions of their own GitHub account, the collaborator can review diffs, commit, pull, push, create or switch branches, open a pull request, force-push, and discard changes [1, Q11–Q12, Q28]. Force-push and discard each show what they will destroy and require one confirmation [1, Q29]. Any commit in the history can be viewed as a read-only snapshot, from which the collaborator goes back to their branch or starts a new one [9].

**Installing.** The collaborator follows a written page for macOS, Linux, or Windows that installs Git and a TeX distribution and then pastes one command. The command downloads Revisions from the latest GitHub Release of the public repository, which is MIT licensed, and puts it where the platform's app launcher finds it [9]. If `latexmk` is missing, Revisions guides them to install MacTeX, MiKTeX, or TeX Live [1, Q21, Q34].

## Reference-level explanation

**Architecture.** Revisions is native-first. TeX compiles on the collaborator's machine, and no hosted compile server exists [1, Q18–Q19]. The application is a local HTTP server bound to loopback and opened in the system browser. The UI is a web app so that a desktop shell can wrap it later [1, Q20]. The server is written in Go and the UI in TypeScript [7]. Code layout and the HTTP contract are in `specs/architecture.md`.

**Manuscript source of truth.** The Git working tree holds the manuscript. Comments and tracked changes are LaTeX source, using the `changes` package [1, Q6–Q7]. Revisions keeps no separate database of comments or edits.

**Configuration.** A `.revisions.toml` file at the repository root MAY name the entry file, overriding auto-detection [1, Q36]. It MAY also name the TeX engine [7]. The `changes` author ID is a per-user Revisions setting, with a default suggested from the GitHub account [1, Q31]. The build timeout is also a per-user setting [7].

**Builds.** `latexmk` chooses between Biber and BibTeX. Figures must be in a format the engine reads natively. EPS and SVG conversion need shell escape, which is disabled, so they are unsupported [7].

**Git host seam.** GitHub is the only host in v1. Host-specific operations, including sign-in, URL parsing, and pull-request creation, sit behind a narrow interface so that hosts such as Forgejo can be added later [1, Q12].

**Non-goals.** Version 1 excludes the following [1, Q24–Q25]:

- real-time co-editing;
- hosted compilation, or any operated server beyond a static share page;
- bundling or managing a TeX distribution;
- automatic compilation on edit;
- document formats other than LaTeX;
- a merge-conflict UI beyond Git itself, so conflicts are resolved in the raw editor;
- a reference-management UI, so `.bib` files are edited as raw source and citations are only validated;
- offline features beyond what the local server provides.

**Deferred.** These are out of scope for v1 but not ruled out [1, Q20, Q24, Q26]:

- signed desktop installers;
- in-browser WebAssembly (WASM) compilation;
- Git hosts other than GitHub;
- a static share page, hosted on kamaji, that turns a shared URL into a one-click open button.

**Definition of the first usable version.** The first collaborator, starting from a Mac with nothing preinstalled, installs Revisions and its prerequisites from written instructions without the author's help. They then complete the journey above against a real manuscript repository. OpenIrisDPI is the reference and test repository, and a private manuscript repository is the working repository [1, Q33–Q35].

## Requirements

### Requirement: Open a shared GitHub URL

Revisions SHALL accept a GitHub commit, branch, or pull-request URL and bring a local clone to the referenced commit. It SHALL clone the repository when no local clone exists.

#### Scenario: First open

- WHEN a collaborator with no local clone opens a shared commit URL
- THEN Revisions clones the repository to the collaborator's machine and checks out that commit

#### Scenario: Existing clone

- WHEN a collaborator with a clean local clone opens a URL for a different commit
- THEN Revisions fetches and checks out the shared commit

### Requirement: Refuse to switch over uncommitted work

Revisions SHALL refuse to open a different commit while the local clone has uncommitted changes, and SHALL explain why.

#### Scenario: Dirty clone

- WHEN the local clone has uncommitted edits and the collaborator opens a URL for another commit
- THEN Revisions leaves the working tree unchanged and explains that the uncommitted work must be committed or discarded first

### Requirement: Entry-file selection

Revisions SHALL use the entry file named in `.revisions.toml` when present. Otherwise it SHALL detect `.tex` files that contain `\documentclass`, use the first one detected (using alphabetical order), and let the user select another. 

#### Scenario: Several candidates

- WHEN a repository without `.revisions.toml` contains two `.tex` files with `\documentclass`
- THEN Revisions opens the first detected file and offers the other as a selectable entry file

#### Scenario: Config override

- WHEN `.revisions.toml` names an entry file
- THEN Revisions uses that file without auto-detection

### Requirement: Split view with SyncTeX

Revisions SHALL show a read-only PDF view beside an editable inline view and SHALL link them in both directions through SyncTeX. The user SHALL be able to hide either view, and the choice SHALL be remembered in the browser. A SyncTeX jump SHALL show the view it lands in, and the Changes & history panel SHALL open even while the PDF is hidden [8].

#### Scenario: PDF to source

- WHEN the user clicks a location in the PDF
- THEN the inline view scrolls to and places the cursor at the corresponding source location

#### Scenario: Source to PDF

- WHEN the user invokes SyncTeX from a location in the inline view
- THEN the PDF view scrolls to and marks the corresponding output location

#### Scenario: Hide a view

- WHEN the user chooses to show only the editor and reloads the page
- THEN the PDF stays hidden until the user shows it or invokes SyncTeX from the editor

### Requirement: File tree

Revisions SHALL show the repository's files as a tree in a sidebar that can be folded away, folders first, with the main document marked and the open file highlighted. Choosing a text file SHALL open it in the editor, after saving the current file; choosing an image SHALL show it read-only; any other file SHALL give a one-line explanation that it cannot be opened. The tree SHALL work from the keyboard [8].

#### Scenario: Open from the tree

- WHEN the user chooses a text file in a folder of the tree
- THEN the editor shows that file and the tree highlights it

### Requirement: Fully editable inline view

Every part of the source SHALL be editable in the inline view. Revisions SHALL render sections, emphasis, lists, citations, cross-references, inline math, display equations, figures, tables, and `changes` markup. Unrecognized LaTeX SHALL appear inline as editable raw source. Moving the cursor into a rendered construct SHALL reveal its source. The exception is `changes` markup: its macro syntax SHALL stay hidden in the inline view even while the cursor is inside the changed text, show only in the raw source view, and be protected from edits that would remove part of it. Citations and cross-references SHALL show whether they resolve. Validity SHALL come from parsing the repository's `.bib` files and `\label` commands directly, so that it is available before the first build [7]. Macros the manuscript defines with `\newcommand`, `\renewcommand`, `\providecommand`, `\DeclareRobustCommand`, or a simple `\def`, in the entry file and the files it includes, SHALL be used to render math, a later definition winning. In prose, a use of such a macro that takes no arguments and stands for plain text or a number SHALL show that text, name the macro on hover, and reveal its source when the cursor enters it; other macros in prose stay raw source, and definitions stay as written [10].

#### Scenario: Unknown macro

- WHEN the source contains a command the renderer does not recognize
- THEN the inline view shows that command as raw source the user can edit in place

#### Scenario: Cursor entry

- WHEN the cursor moves into a rendered display equation
- THEN the inline view shows the equation's LaTeX source for editing

#### Scenario: Unresolved citation

- WHEN a `\cite` key matches no bibliography entry
- THEN the inline view marks that citation as unresolved

#### Scenario: Manuscript macros

- WHEN a file the preamble inputs defines `\newcommand{\NumNeurons}{83}` and `\newcommand{\Gain}{G_{\text{post}}}`, and the text uses `\NumNeurons{}` in prose and `$\Gain$` in math
- THEN the prose shows 83 and names `\NumNeurons` on hover, and the formula renders without an error

### Requirement: Single line breaks flow

In the inline view, a single line break between two lines of running prose SHALL NOT break the line: the text SHALL flow as one paragraph, with a faint `↳` mark at the join in place of the break. A line break after `\\`, at the end of a line with a `%` comment, next to a line that holds only block commands such as `\begin`, `\end`, `\item`, a heading, or `\label`, or inside display math, verbatim text, a table, or the preamble SHALL stay a visible break. Deleting the mark SHALL remove the line break from the source and leave exactly one space between the words. Typing Enter SHALL still insert a line break. The raw source view is unaffected [8].

#### Scenario: Paragraph flows

- WHEN a paragraph in the source is written over several lines
- THEN the inline view shows it as one paragraph with a mark at each join

#### Scenario: Join two lines

- WHEN the user deletes a line-break mark with Backspace after it or Delete before it
- THEN the source has the two lines joined by exactly one space

### Requirement: Responsive inline view

The inline view SHALL stay responsive on a manuscript of the size of a full journal article, with long paragraphs on single lines and hundreds of formulas. Opening a project SHALL show the open file's text before the other files of the project load. A disk check that finds nothing changed SHALL redraw nothing, and a formula or figure SHALL be drawn once and reused when it scrolls back into view [8].

#### Scenario: Quiet disk check

- WHEN the disk check runs and no file has changed
- THEN the inline view redraws no rendered formula, citation, or figure

### Requirement: Comments as `changes` macros

Revisions SHALL store each comment as a `\highlight[id=…, comment={…}]{text}` macro in the source. Each comment SHALL stand alone with no replies or threads. A Resolve button SHALL remove the macro and keep the highlighted text [1, Q30]. The user SHALL also be able to highlight text without a comment, stored as `\highlight[id=…]{text}`, under the same rules; a Remove button takes it away as Resolve does [8].

#### Scenario: Add comment

- WHEN the user selects text and adds a comment
- THEN Revisions wraps the selection in a `\highlight` macro carrying the user's author ID and comment text

#### Scenario: Resolve comment

- WHEN the user presses Resolve on a comment
- THEN Revisions removes the `\highlight` macro and leaves the previously highlighted text unchanged

#### Scenario: Highlight without a comment

- WHEN the user selects text and presses Highlight
- THEN Revisions wraps the selection in a `\highlight` macro carrying the user's author ID and no comment

### Requirement: Author identity

Revisions SHALL use the author ID from its settings for `changes` markup, suggesting a default from the GitHub account. It SHALL add a `\definechangesauthor` line to the preamble when the author is not yet defined. It SHALL add `\usepackage{changes}` to the preamble when the manuscript does not load the package [7].

#### Scenario: New author

- WHEN a user whose author ID is not defined in the preamble adds their first comment
- THEN Revisions adds the `\definechangesauthor` declaration for that ID to the preamble

#### Scenario: Package not loaded

- WHEN a user adds a comment or tracked change to a manuscript that does not load `changes`
- THEN Revisions adds `\usepackage{changes}` to the preamble

### Requirement: Tracked changes toggle

Tracked changes SHALL be off by default and SHALL be toggled per session. While tracking is on, insertions, deletions, and replacements SHALL be written as `\added`, `\deleted`, and `\replaced`. Each tracked change SHALL offer Accept and Reject, and the editor SHALL offer Accept all and Reject all.

#### Scenario: Default plain edit

- WHEN a user edits prose without turning tracking on
- THEN the source receives a plain edit with no `changes` markup

#### Scenario: Tracked edit

- WHEN tracking is on and the user replaces a word
- THEN the source records a `\replaced` macro with the user's author ID

#### Scenario: Accept all

- WHEN the user chooses Accept all
- THEN every tracked change is applied and its markup is removed from the source

### Requirement: Show or hide markup

The inline view SHALL offer a Markup toggle, on by default. With markup off, the inline view SHALL read as if every tracked change were accepted and no comment existed: comment highlights and inserted text show as plain text, and deleted text, the old text of replacements, and notes are hidden. The review panel SHALL close. Hidden text SHALL be protected from edits as hidden markup is, edits made with tracking on SHALL still be recorded as tracked changes, and the source on disk SHALL not change. The raw source view is unaffected [8].

#### Scenario: Clean reading view

- WHEN the user turns Markup off in a file with comments and tracked changes
- THEN deleted text and comment highlights disappear from the inline view and the file on disk is unchanged

#### Scenario: Tracked edit with markup hidden

- WHEN tracking is on, Markup is off, and the user replaces a word
- THEN the source records a `\replaced` macro and the inline view shows only the new word

### Requirement: Colour scheme

Settings SHALL offer Appearance: System, Light, or Dark, with System as the default. The choice SHALL belong to the viewer's browser, not to the manuscript or the server's settings, and SHALL apply before the page first paints, so a reload never flashes the other scheme [8].

#### Scenario: Choose a scheme

- WHEN the user chooses Light in Settings on a computer set to dark mode and reloads the page
- THEN the page is light from its first paint

### Requirement: Byte-preserving writes

Revisions SHALL write only the minimal byte range that an edit changes and SHALL never reformat untouched source, so that diffs stay small by default. Line breaks inside the changed range SHALL take the file's majority line ending, and line breaks outside it SHALL keep their original bytes. A file that is not valid UTF-8 SHALL open read-only [7].

#### Scenario: Mixed line endings

- WHEN the user edits one line of a file that mixes CRLF and LF line endings
- THEN every other line keeps its original line ending

#### Scenario: One-word edit

- WHEN the user changes one word in a paragraph
- THEN the resulting Git diff touches only that word's line, with whitespace and line endings elsewhere unchanged

#### Scenario: No-op save

- WHEN a save contains no change from the file on disk
- THEN Revisions does not write the file

### Requirement: Stale-write rejection

Each save SHALL carry the hash of the file version it was based on. Revisions SHALL reject a save whose base hash does not match the file on disk.

#### Scenario: External change

- WHEN a file changes on disk after the editor loaded it and the editor then saves
- THEN Revisions rejects the save and leaves the disk file unchanged

### Requirement: Autosave and auto-reload

Revisions SHALL autosave edits frequently and SHALL auto-reload a file from disk when it has no pending local edits. On a collision, it SHALL show an error with a Reload button and SHALL display the rejected text for copying before reload. Revisions SHALL NOT use a single-session lock. Autosave SHALL run 1 s after the last change and before any build or Git operation. The disk check SHALL run every 2 s and when the window gains focus [7].

#### Scenario: Clean reload

- WHEN a file changes on disk and the editor has no pending edits to it
- THEN the editor shows the new disk contents without user action

#### Scenario: Collision

- WHEN a save is rejected as stale
- THEN the editor shows an error, displays the rejected text for copying, and offers a Reload button

### Requirement: Unsaved-work warning

Revisions SHALL warn before the browser tab closes while edits are unsaved. It SHALL NOT persist drafts in browser storage.

#### Scenario: Close with pending edits

- WHEN the user closes the tab before an autosave completes
- THEN the browser shows a leave-page warning

### Requirement: Quit

Revisions SHALL offer Quit Revisions in Settings, because the installed app has no window of its own on macOS and Linux. Quitting SHALL first save pending edits, and SHALL refuse and say why when they cannot be saved. It SHALL cancel any running build. The server SHALL answer the request, then stop and let requests in flight finish. The page SHALL then say plainly that Revisions has stopped, that the tab can be closed, and how to start it again, and SHALL send no further requests. The quit request SHALL pass the same loopback hardening as every other request [10].

#### Scenario: Quit

- WHEN the user chooses Quit Revisions in Settings less than a second after typing
- THEN the edit is saved, the program exits, and the page says that Revisions has stopped and how to start it again

### Requirement: Explicit PDF builds

Revisions SHALL compile only when the user presses the build button or shortcut. It SHALL show an out-of-date warning while the PDF lags the source. A failed build SHALL keep the last good PDF visible and show the error. The log of the build that made the PDF on screen SHALL stay available after later failed builds [8].

#### Scenario: Edit after build

- WHEN the user edits source after a successful build
- THEN the PDF view shows an out-of-date warning and does not rebuild

#### Scenario: Failed build

- WHEN a build fails
- THEN the last good PDF stays visible and the compiler error is shown

#### Scenario: Log of the PDF on screen

- WHEN a build fails after a successful one and the user opens the build log of the PDF
- THEN Revisions shows the log of the successful build, not the failed one

### Requirement: Local build isolation

Builds SHALL run `latexmk` on the user's machine with shell escape disabled, output written to a directory outside the repository, a timeout, and a cap on retained log size. The timeout SHALL be a user setting with a default of 300 s, because a slow machine with a large manuscript can need longer. The user SHALL be able to cancel a running build. The retained log SHALL be capped at 1 MiB. Builds SHALL ignore `latexmkrc` files, which are executable code [7].

#### Scenario: Build output

- WHEN a build completes
- THEN the repository working tree contains no new PDF or auxiliary files

#### Scenario: Runaway build

- WHEN a build exceeds the timeout
- THEN Revisions terminates it and reports a timeout

#### Scenario: Longer timeout

- WHEN the user raises the build timeout in settings
- THEN a build that runs longer than the default but shorter than the new limit completes

### Requirement: TeX detection and guidance

Revisions SHALL detect `latexmk` on `PATH` and in the standard install directories of MacTeX, TeX Live, and MiKTeX [7]. When it is missing, Revisions SHALL guide the user to install MacTeX, MiKTeX, or TeX Live, as appropriate to their platform. Revisions SHALL NOT bundle or manage a TeX distribution.

#### Scenario: Missing TeX

- WHEN the user requests a build and `latexmk` is not on `PATH`
- THEN Revisions shows platform-specific installation guidance instead of attempting the build

### Requirement: Git detection and guidance

Revisions SHALL detect the system Git. When it is missing, Revisions SHALL guide the user to install it for their platform. Revisions SHALL NOT bundle Git [7].

#### Scenario: Missing Git

- WHEN the user opens a shared URL and Git is not installed
- THEN Revisions shows platform-specific installation guidance instead of attempting the clone

### Requirement: Self-service install on three platforms

Revisions SHALL provide copy-paste commands or web-based instructions for installing it and its prerequisites on macOS, Linux, and Windows, assuming nothing is preinstalled. Where a step can be done without a terminal, the instructions SHALL offer that path.

Releases SHALL be published as GitHub Releases of `ryan-ressmeyer/revisions` [9]. Each platform SHALL have a one-line install command that downloads the latest release for the computer, checks it against the release's SHA-256 checksums, and installs it for the current user without administrator rights, so that it opens from Spotlight, the Start menu, or the desktop's applications menu. Running the command again SHALL upgrade in place. The command SHALL then say in plain language whether Git and TeX were found and what to do if not. Git and TeX SHALL be detected and guided, not bundled [9].

#### Scenario: Fresh Mac

- WHEN a collaborator with a fresh Mac follows the macOS instructions
- THEN they reach a working Revisions session without the author's involvement

#### Scenario: Install and upgrade

- WHEN a collaborator runs the install command, opens Revisions from the platform's launcher, and later runs the command again after a new release
- THEN the first run installs Revisions for their user, and the second stops the running copy and replaces it with the new version

#### Scenario: Tampered download

- WHEN the downloaded program does not match the release's checksum
- THEN the install command leaves any installed Revisions unchanged and says why

### Requirement: Path containment

Every file path Revisions reads or writes SHALL resolve inside the repository root. Revisions SHALL refuse symbolic links. It SHALL refuse paths inside the repository's `.git` directory, because writing hooks or configuration there would execute code.

#### Scenario: Escaping path

- WHEN a request names a path containing `..` that resolves outside the repository
- THEN Revisions rejects the request without reading or writing the file

#### Scenario: Symlink

- WHEN a requested path is a symbolic link
- THEN Revisions refuses it

### Requirement: Loopback hardening

The local server SHALL validate the `Host` header and the request `Origin`, and SHALL require a per-process token on every request that mutates state or uses the user's GitHub credentials.

#### Scenario: Foreign origin

- WHEN a web page from another origin sends a request to the local server
- THEN the server rejects it

#### Scenario: DNS rebinding

- WHEN a request arrives with a `Host` header other than the loopback address and port
- THEN the server rejects it

### Requirement: GitHub sign-in

Collaborators SHALL sign in with their own GitHub account through OAuth. GitHub permissions SHALL decide which operations they can perform. Sign-in SHALL use the OAuth device flow, which needs no client secret. The token SHALL be stored in the operating-system keychain when one is available [7].

#### Scenario: Device sign-in

- WHEN a signed-out collaborator starts sign-in
- THEN Revisions shows a one-time code and the GitHub page to enter it on, and becomes signed in once GitHub confirms the code

#### Scenario: Read-only collaborator

- WHEN a signed-in collaborator lacks write access to the repository
- THEN Revisions does not offer pushing to that repository's branches

### Requirement: Git operations

Revisions SHALL offer viewing changes and diffs, commit, pull, push, create or switch branch, open a pull request, force-push, and discard changes, each within the collaborator's GitHub permissions. It SHALL present history as a GitKraken-style commit graph. Merge conflicts SHALL be resolved in the raw editor.

#### Scenario: Open a pull request

- WHEN a collaborator with push access to a branch commits, pushes, and chooses Open PR
- THEN Revisions creates the pull request on GitHub and shows it in the commit graph

#### Scenario: Branch removed on GitHub

- WHEN the collaborator's branch was deleted on GitHub, for example after its pull request was closed, and they choose Get latest
- THEN Revisions leaves the working tree unchanged, says in plain language that the branch was removed from GitHub, and offers Send to put it back

### Requirement: View an earlier version

A commit selected in the history SHALL offer View this version, which puts the clone on that commit as a snapshot (a detached HEAD), so the editor shows the files as they were and a build compiles that version. Revisions SHALL refuse while there are uncommitted changes, as it refuses to switch branches. While on a snapshot, the project SHALL show a banner that names the version by its date and subject, says in plain language that it cannot be changed here, and offers Back to the branch most recently left, or to the default branch when there is none, and Start a branch from this version. The editor SHALL be read-only on a snapshot and the server SHALL refuse saves there, whether the snapshot came from the history or from a commit URL. A PDF built from another version SHALL be marked out of date. Revisions SHALL NOT restore an earlier version onto a branch or rewrite history [9].

#### Scenario: View an earlier version

- WHEN the user selects an earlier commit in the history and chooses View this version
- THEN the editor shows the files as they were at that commit, refuses edits, and a banner names the version and offers the way back

#### Scenario: Back to the branch

- WHEN the user chooses Back to the branch in the snapshot banner
- THEN the clone is on that branch again and the editor accepts edits

#### Scenario: Branch from an earlier version

- WHEN the user chooses Start a branch from this version and names the branch
- THEN a new branch starts at that commit and the editor accepts edits

#### Scenario: Uncommitted work blocks viewing

- WHEN the clone has uncommitted changes and the user chooses View this version
- THEN Revisions leaves the working tree unchanged and lists the changes that must be committed or discarded first

#### Scenario: PDF from another version

- WHEN the PDF was built from one version and the user moves to another
- THEN the PDF view shows the out-of-date warning

### Requirement: Destructive-operation confirmation

Force-push SHALL list the remote commits it will erase and SHALL use `--force-with-lease`. Discard SHALL show the diff it will remove. Each SHALL require one explicit confirmation.

#### Scenario: Force-push

- WHEN the user chooses force-push
- THEN Revisions lists the remote commits that will be erased and pushes with `--force-with-lease` only after confirmation

#### Scenario: Discard

- WHEN the user chooses discard
- THEN Revisions shows the diff to be removed and discards it only after confirmation

## Alternatives considered

**Web-first with server-side TeX.** The user chose this first [1, Q5]. It was reversed because the user does not want to operate a compile server, and local compilation keeps builds available without depending on a hosted service [1, Q17–Q19].

**In-browser WASM compilation.** It would standardize builds while keeping them local [1, Q18]. At the user's request, BusyTeX, texlyre-busytex, Siglum, and SwiftLaTeX were reviewed [3–6]. None showed end-to-end compilation of a real journal manuscript. The review found experimental status, small communities, 120–430 MB downloads, uncertain Biber support, no EPS or SVG conversion, and an AGPL license on the most complete wrapper. The user judged the option too immature for v1 and deferred it [1, Q19].

**Native desktop application.** Rejected for v1 because of the cost of signing and shipping apps for Apple and Windows. A web UI keeps a desktop shell possible later [1, Q20].

**Comments in a sidecar file, server database, or Git-host review comments.** Rejected in favor of LaTeX macros so that comments travel with the source [1, Q6].

**Always tracking changes.** Rejected in favor of a per-session toggle with plain edits by default [1, Q8].

**Protected chips for unknown LaTeX.** Redraft protected unrecognized constructs and sent them to a separate Source View [2]. The user called this a poor design and expects to edit anything in the inline view [1, Q9].

**Single-session lock.** Rejected in favor of frequent autosave, auto-reload, and collision errors, so the view always reflects the current source [1, Q16].

**Storage-backed durable drafts.** Redraft kept failed saves in browser storage tied to session and snapshot identity [2]. Replaced by a leave-page warning and showing rejected text for copying [1, Q22].

**Auto-stash or WIP commit when switching commits.** Rejected in favor of refusing and explaining [1, Q27].

**Backup refs for force-push and discard.** Rejected in favor of confirmation that shows the consequences [1, Q29].

## Prior art

**Redraft** [2] is the predecessor. The user re-examined each of its safety mechanisms against its complexity cost and kept the following [1, Q13–Q23].

- **Byte preservation**, because silent reformatting would produce large diffs.
- **Stale-write rejection**, reduced to one base-file hash per save. Redraft checked every snapshotted dependency [2].
- **Explicit builds**, with an out-of-date warning and the last good PDF retained.
- **Build isolation**, reduced to an output directory outside the repository, shell escape off, a timeout, and a log cap. Redraft also copied the whole project to a temporary directory and checked it for special files [2].
- **Unsaved-work protection**, reduced to a leave-page warning and copyable rejected text.
- **Path containment and loopback hardening**, which now also protect the user's GitHub token.

Redraft's OpenIrisDPI trust profile, protected objects, and separate Source View are not carried forward.

**Overleaf** is the model for the split layout, SyncTeX navigation, citation and reference status, and retaining the last good PDF [1, Q10, Q16, Q37]. **GitKraken** is the model for the commit graph [1, Q28]. The LaTeX **`changes`** package supplies the comment and tracked-change markup [1, Q7].

## Unresolved questions

- [NEEDS CLARIFICATION: How a kamaji-hosted share page would reach collaborators outside the tailnet. Deferred.]

## Sources

- [1] `notes/grill-rewrite-overview-01.md`. Interview, session 01, 2026-11-09. Q numbers refer to its questions.
- [2] `~/repos/redraft-editor/README.md`. Redraft's editing, source preservation, safety boundary, and trust profile. Read-only reference.
- [3] https://github.com/TeXlyre/texlyre-busytex. Cited through [1].
- [4] https://github.com/busytex/busytex. Cited through [1].
- [5] https://github.com/SiglumProject/siglum. Cited through [1].
- [6] https://github.com/SwiftLaTeX/SwiftLaTeX. Cited through [1].
- [7] `notes/decisions-v1-kickoff.md`. Stack choice and the decisions that closed the earlier open questions, 2026-11-10.
- [8] `notes/feedback-demo-01.md`. Feedback on the first demo build, 2026-11-11.
- [9] `notes/feedback-demo-02.md`. Feedback on the second demo build and the publication decisions, 2026-11-11.
- [10] The owner's request of 2026-11-11, "add a quit button and fix the stats macros", made after the installed app could only be stopped on macOS by logging out, and after a real manuscript's stats macros showed as errors and raw source in the inline view.
