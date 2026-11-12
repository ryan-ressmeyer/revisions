# Scenario tests

Every Scenario in `specs/overview.md`, grouped by Requirement, with the automated test that covers it. Replace `pending` with the test when you write it: a Go test as `path/file_test.go: TestName`, a Vitest or Playwright test as `path/file.test.ts: "test title"`.

## Open a shared GitHub URL

| Scenario | Test |
|---|---|
| First open | `internal/server/routes_auth_test.go: TestOpenFirstOpen`; `web/e2e/start.spec.ts: "First open: a pasted link opens the entry file in the editor"` |
| Existing clone | `internal/server/routes_auth_test.go: TestOpenExistingClone` |

## Refuse to switch over uncommitted work

| Scenario | Test |
|---|---|
| Dirty clone | `internal/server/routes_auth_test.go: TestOpenDirtyClone`; `web/e2e/start.spec.ts: "Dirty clone: refuses to switch, explains why, and offers the copy as it is"` |

## Entry-file selection

| Scenario | Test |
|---|---|
| Several candidates | `internal/server/routes_files_test.go: TestProjectOffersEveryEntryCandidate`, `TestChoosingAnotherEntry`; `internal/workspace/project_test.go: TestEntryIsTheFirstFileWithDocumentclass`; `web/e2e/editing.spec.ts: "Several candidates: opens the first entry file and offers the other"` |
| Config override | `internal/server/routes_files_test.go: TestConfigEntryOverridesDetection`; `internal/workspace/project_test.go: TestConfigNamesEntryAndEngine` |

## Split view with SyncTeX

| Scenario | Test |
|---|---|
| PDF to source | `internal/server/routes_build_test.go: TestBuildLifecycle/SyncTeX_round_trip`; `web/e2e/build.spec.ts: "PDF to source: double-click and Ctrl-click open the file at that line"` |
| Source to PDF | `internal/server/routes_build_test.go: TestBuildLifecycle/SyncTeX_round_trip`; `web/e2e/build.spec.ts: "Source to PDF: Show in PDF scrolls to the cursor's place and marks it"` |
| Hide a view | `web/e2e/layout.spec.ts: "Panes: the editor or the PDF can be hidden, the choice is remembered, and Changes & history still opens"`; `web/e2e/build.spec.ts: "Hidden panes: a click in the PDF and Show in PDF bring back the pane they need"` |

## File tree

| Scenario | Test |
|---|---|
| Open from the tree | `web/e2e/layout.spec.ts: "File tree: folders first, the main document marked, text opens, images preview, others explain"`, `"File tree: files added or removed on disk appear and go without a reload"`; `internal/server/routes_files_test.go: TestStateTreeChangesWhenFilesComeAndGo` |

## Fully editable inline view

| Scenario | Test |
|---|---|
| Unknown macro | `web/src/core/latex/plan.test.ts: "Unknown macro: an unrecognised command gets no decorations"`; `web/e2e/rich.spec.ts: "Unknown macro: shows as raw source that is editable in place"` |
| Cursor entry | `web/src/core/latex/plan.test.ts: "Cursor entry: a selection inside a display equation reveals only that equation"`; `web/e2e/rich.spec.ts: "Cursor entry: a display equation shows its source while the cursor is in it"` |
| Unresolved citation | `web/src/core/latex/plan.test.ts: "Unresolved citation: keys and labels resolve against the repository"`; `web/e2e/rich.spec.ts: "Unresolved citation: chips say whether keys resolve, across files and before a build"` |
| Manuscript macros | `web/src/core/latex/macros.test.ts` (every definition form, include order, hostile definitions, macros for KaTeX, values); `web/src/core/latex/plan.test.ts: "the fixture: stats from an \\input file in the preamble reach an included section"`, `"a value macro in prose is drawn as its value, in all three forms"`, `"math carries the macros it uses, and a changed definition changes the widget"`; `web/e2e/rich.spec.ts: "User macros: formulas use the manuscript's definitions, values show in prose, and a changed definition redraws"` |

## Single line breaks flow

| Scenario | Test |
|---|---|
| Paragraph flows | `web/src/core/latex/plan.test.ts: "a single line break inside a paragraph flows, with a mark at the join"`, `"hard breaks stay: \\\\, comments, block commands, blank lines"`, `"never inside display math, verbatim, tables or the preamble"`; `web/e2e/rich.spec.ts: "Soft line breaks: a paragraph flows with marks, and deleting one joins the lines with one space"` |
| Join two lines | `web/src/core/latex/plan.test.ts: "Deleting the mark joins the lines with exactly one space"`; `web/e2e/rich.spec.ts: "Soft line breaks: a paragraph flows with marks, and deleting one joins the lines with one space"` |

## Responsive inline view

| Scenario | Test |
|---|---|
| Quiet disk check | `web/e2e/rich.spec.ts: "Large manuscript: a quiet poll redraws nothing, and scrolling stays quick"` |

## Comments as `changes` macros

| Scenario | Test |
|---|---|
| Add comment | `web/src/core/changes/changes.test.ts: "Add comment: the selection is wrapped in a \\highlight with the author ID and comment"`; `web/e2e/rich.spec.ts: "Add comment, New author, Package not loaded: the first comment declares the author and loads changes"`, `"Add comment: a refused selection says why"` |
| Resolve comment | `web/src/core/changes/changes.test.ts: "Resolve comment: the \\highlight is removed and its text kept byte for byte"`; `web/e2e/rich.spec.ts: "Resolve comment: the macro goes and the text stays"` |
| Highlight without a comment | `web/src/core/changes/changes.test.ts: "Highlight: the selection is wrapped in a \\highlight with the author ID and no comment"`, `"Highlight: refused for the same selections as a comment"`; `web/src/core/changes/compile.test.ts` (builds one); `web/e2e/rich.spec.ts: "Highlight: marks the selection with no comment, and Remove takes it away"` |

## Author identity

| Scenario | Test |
|---|---|
| New author | `web/src/core/changes/changes.test.ts: "New author: a preamble that loads changes gets only the author, in the next colour"`; `web/e2e/rich.spec.ts: "Add comment, New author, Package not loaded: the first comment declares the author and loads changes"` |
| Package not loaded | `web/src/core/changes/changes.test.ts: "Package not loaded: \\usepackage{changes} and the author go just before \\begin{document}"`; `web/e2e/rich.spec.ts: "Add comment, New author, Package not loaded: the first comment declares the author and loads changes"` |

## Tracked changes toggle

| Scenario | Test |
|---|---|
| Default plain edit | `web/e2e/rich.spec.ts: "Default plain edit: with tracking off, typing leaves no markup"` |
| Tracked edit | `web/src/core/changes/track.test.ts: "Tracked edit: replacing a word records a \\replaced with the author ID"`; `web/e2e/rich.spec.ts: "Tracked edit: typing a word gives one \\added, replacing one gives \\replaced"`, `"Tracked edit: an edit that cannot be tracked goes in plainly and says so"` |
| Accept all | `web/src/core/changes/changes.test.ts: "Accept all: every tracked change is applied, nested ones included, and comments stay"`; `web/e2e/rich.spec.ts: "Accept all: every tracked change is applied and comments stay"` |

## Show or hide markup

| Scenario | Test |
|---|---|
| Clean reading view | `web/src/core/latex/plan.test.ts: "Markup hidden: inserted text reads plainly and deleted text, old text and notes are hidden"`; `web/src/core/changes/guard.test.ts: "guardEdit with markup hidden"`; `web/e2e/rich.spec.ts: "Markup off: a clean reading view that hides deletions and comments and changes no bytes"` |
| Tracked edit with markup hidden | `web/e2e/rich.spec.ts: "Markup off: a clean reading view that hides deletions and comments and changes no bytes"` |

## Colour scheme

| Scenario | Test |
|---|---|
| Choose a scheme | `web/e2e/editing.spec.ts: "Colour scheme: follows the system until chosen, applies at once, and holds before first paint after a reload"` |

## Byte-preserving writes

| Scenario | Test |
|---|---|
| Mixed line endings | `internal/server/routes_files_test.go: TestMixedLineEndingsSurviveAnEdit`; `internal/workspace/save_test.go: TestSaveWritesExactBytes` |
| One-word edit | `internal/server/routes_files_test.go: TestOneWordEditTouchesOneLine` |
| No-op save | `internal/server/routes_files_test.go: TestNoOpSaveDoesNotWrite`; `internal/workspace/save_test.go: TestSaveWithoutChangeDoesNotWrite` |

## Stale-write rejection

| Scenario | Test |
|---|---|
| External change | `internal/server/routes_files_test.go: TestStaleSaveIsRejected`; `internal/workspace/save_test.go: TestSaveRejectsAStaleBase`, `TestConcurrentSavesFromOneBaseLetOneWin` |

## Autosave and auto-reload

| Scenario | Test |
|---|---|
| Clean reload | `web/src/core/sync/sync.test.ts: "Clean reload: a disk change with no pending edits is adopted silently"`; `web/e2e/editing.spec.ts: "Clean reload: a change on disk appears in the editor without action"` |
| Collision | `web/src/core/sync/sync.test.ts: "Collision: a stale save keeps the rejected text and stops autosave until reload"`; `web/e2e/editing.spec.ts: "Collision: a stale save shows the rejected text with Copy and Reload"` |

## Unsaved-work warning

| Scenario | Test |
|---|---|
| Close with pending edits | `web/src/core/sync/sync.test.ts: "Close with pending edits: unsaved work lasts from the first edit until the save is confirmed"`; `web/e2e/editing.spec.ts: "Close with pending edits: the browser warns before the tab closes"` |

## Quit

| Scenario | Test |
|---|---|
| Quit | `cmd/revisions/main_test.go: TestQuitStopsServing`; `internal/server/routes_app_test.go: TestQuitAnswersThenAsksToStop`, `TestQuitRefusesAForeignPage`; `internal/server/routes_build_test.go: TestQuitCancelsTheRunningBuild`; `web/e2e/editing.spec.ts: "Quit: the last edit is saved, the program stops, and the page says so without errors"` (the real binary exits with code 0) |

## Explicit PDF builds

| Scenario | Test |
|---|---|
| Edit after build | `internal/server/routes_build_test.go: TestBuildLifecycle/Edit_after_build`; `web/e2e/build.spec.ts: "Edit after build: the PDF is marked out of date and is not rebuilt"` |
| Failed build | `internal/server/routes_build_test.go: TestBuildLifecycle/Failed_build`; `web/e2e/build.spec.ts: "Failed build: the last good PDF stays and the error is shown"` |
| Log of the PDF on screen | `internal/build/build_test.go: TestTheGoodPDFKeepsTheLogOfItsBuild`; `internal/server/routes_build_test.go: TestBuildLifecycle/Failed_build`; `web/e2e/build.spec.ts: "Build log: shows the log of the build whose PDF is on screen, after a failed build"` |

## Local build isolation

| Scenario | Test |
|---|---|
| Build output | `internal/server/routes_build_test.go: TestBuildLifecycle/Build_output` |
| Runaway build | `internal/server/routes_build_test.go: TestRunawayBuildTimesOut`; `internal/build/kill_unix_test.go: TestTimeoutKillsTheWholeProcessTree` |
| Longer timeout | `internal/server/routes_build_test.go: TestLongerTimeoutLetsASlowBuildFinish`; `web/e2e/editing.spec.ts: "Settings persist: the build time limit survives a reload"` (the setting in the UI) |

## TeX detection and guidance

| Scenario | Test |
|---|---|
| Missing TeX | `internal/server/routes_build_test.go: TestBuildWithoutTeXAsksForAnInstall`; `internal/build/build_test.go: TestFindToolSearchesPathThenWellKnownDirs`; `web/e2e/build.spec.ts: "Missing TeX: shows install guidance instead of building"` |

## Git detection and guidance

| Scenario | Test |
|---|---|
| Missing Git | `internal/server/routes_auth_test.go: TestOpenMissingGit`; `web/e2e/start.spec.ts: "Missing Git: shows install guidance for the platform"` |

## Self-service install on three platforms

| Scenario | Test |
|---|---|
| Fresh Mac | Manual, on a Mac that has never had the command line developer tools, Git, or TeX installed, using only `docs/install-macos.md` and a GitHub account that can read a test manuscript repository. (1) Start the MacTeX download from the link in step 1. (2) Open Terminal and paste the install line from step 2; pass when it prints `Installed revisions v…`, `Git: not found.`, and macOS shows the command line developer tools window; click Install and Agree and wait. (3) Open MacTeX.pkg and install it. (4) Press Command-Space, type Revisions, press Return; pass when a browser tab opens on the sign-in screen and no "cannot be opened" warning appears. (5) Sign in with GitHub through the one-time code. (6) Paste the shared link under Open a manuscript and click Open. (7) Click Build PDF, add a comment, commit it, and choose Send. (8) Run the install line again; pass when it reports the version and the next Spotlight launch works. Pass when every step works from the page alone, without the author or any command not on the page. Needs a published release. Installer on a real macOS runner: `cmd/revisions/install_test.go: TestInstallScript` in CI's `install` job, which also opens the installed `.app`. |
| Install and upgrade | `cmd/revisions/install_test.go: TestInstallScript` (runs `install.sh` on Linux and macOS and `install.ps1` on Windows against a local release, then upgrades; CI's `install` job also opens the app from its `.app` bundle or Start menu shortcut and checks that the upgrade stops it) |
| Tampered download | `cmd/revisions/install_test.go: TestInstallScript` |

## Path containment

| Scenario | Test |
|---|---|
| Escaping path | `internal/server/routes_files_test.go: TestEscapingPathIsRejected`; `internal/workspace/path_test.go: TestResolveRejectsPathsThatLeaveTheRoot`, `TestResolveRefusesTheGitDirectory` |
| Symlink | `internal/server/routes_files_test.go: TestSymlinkIsRefused`; `internal/workspace/path_test.go: TestResolveRefusesSymbolicLinks` |

## Loopback hardening

| Scenario | Test |
|---|---|
| Foreign origin | `internal/server/server_test.go: TestForeignOriginRejected`, `TestMutatingRequestNeedsOrigin`, `TestNoCORSHeaders` |
| DNS rebinding | `internal/server/server_test.go: TestWrongHostRejected` |

## GitHub sign-in

| Scenario | Test |
|---|---|
| Device sign-in | `internal/server/routes_auth_test.go: TestDeviceSignIn`; `web/e2e/start.spec.ts: "Device sign-in: shows the one-time code and signs in once GitHub confirms it"` |
| Read-only collaborator | `internal/server/routes_git_test.go: TestReadOnlyCollaborator`; `web/e2e/git.spec.ts: "Read-only collaborator: no Send, Force-push, or pull request, and a reason"` |

## Git operations

| Scenario | Test |
|---|---|
| Open a pull request | `internal/server/routes_git_test.go: TestOpenAPullRequest`; `web/e2e/git.spec.ts: "Open a pull request: a branch is sent and its pull request shows in the graph"` |
| Branch removed on GitHub | `internal/server/routes_git_test.go: TestBranchRemovedOnGitHub`; `web/e2e/git.spec.ts: "Branch removed on GitHub: Get latest explains it and Send puts it back"` |

## View an earlier version

| Scenario | Test |
|---|---|
| View an earlier version | `internal/server/routes_git_test.go: TestViewAnEarlierVersion`; `web/e2e/git.spec.ts: "View this version: an earlier version is read-only, builds, and the banner goes back to the branch"` |
| Back to the branch | `internal/server/routes_git_test.go: TestViewAnEarlierVersion`; `web/e2e/git.spec.ts: "View this version: an earlier version is read-only, builds, and the banner goes back to the branch"` |
| Branch from an earlier version | `internal/server/routes_git_test.go: TestViewAnEarlierVersion`; `web/e2e/git.spec.ts: "Snapshot: a commit link opens a read-only snapshot, and a branch from it can be edited and committed"` |
| Uncommitted work blocks viewing | `internal/server/routes_git_test.go: TestViewAnEarlierVersion`; `web/e2e/git.spec.ts: "View this version: refused while there are uncommitted changes"` |
| PDF from another version | `internal/server/routes_build_test.go: TestPDFFromAnotherVersionIsOutOfDate`; `web/e2e/git.spec.ts: "View this version: an earlier version is read-only, builds, and the banner goes back to the branch"` |

## Destructive-operation confirmation

| Scenario | Test |
|---|---|
| Force-push | `internal/server/routes_git_test.go: TestForcePush`; `web/e2e/git.spec.ts: "Force-push: lists the remote commits to erase and pushes only after the confirm"`, `"Force-push: when GitHub moves after the preview, nothing is pushed and the list is refreshed"` |
| Discard | `internal/server/routes_git_test.go: TestDiscard`; `web/e2e/git.spec.ts: "Discard: shows the diff and restores the file only after the confirm"`, `"Discard: a change made after the preview is not discarded, and the preview is refreshed"` |
