# Revisions Git Workflow

## Summary

This spec defines how a collaborator reads history, revises, keeps unfinished work, receives co-authors' changes, shares revisions, and tidies up. Revisions uses ordinary Git behind a small set of controls. A commit is the only way to keep unfinished work. One prompt commits or discards uncommitted changes and then completes the move they blocked. Finished branches are found through GitHub's pull-request references and removed with one click. `specs/overview.md` keeps the product overview and GitHub sign-in.

## Motivation

Revisions serves co-authors who may not understand Git [2, Q11]. The owner found the full-width read-only banner on an earlier version too heavy, and met read-only states that they did not expect [1]. An earlier attempt at a fuller workflow added native stashes, explicit history branching, and confirmed branch deletion. It stalled because `git stash drop` deletes by list position. Another Git process can shift the list between validation and deletion, so the wrong saved work is deleted, and Git offers no guard against that [1]. The owner chose to rebuild the workflow around a small core instead [1, Q1].

Three gaps in the released workflow shape this spec:

- Work can be committed but never sent, and nothing on screen says so once the commit message disappears.
- Finished branches accumulate on the collaborator's computer, and after a squash merge Git cannot tell that their commits were taken in.
- Revisions learns about co-authors' commits only when the collaborator presses Get latest.

## Guide-level explanation

**Three levels of saved.** An edit is saved to disk a second after typing stops. A commit records it on this computer. Send puts the commits on GitHub, where co-authors see them. The top bar signals uncommitted changes and commits not yet sent, so a collaborator who closes the panel still sees that their revisions have not reached anyone.

**Where to revise.** A collaborator may revise on the branch they were sent or start their own branch. Revisions sets no default [1, Q1].

**Reading history.** Choosing View this version in the history shows the manuscript as it was at that commit. This snapshot is read-only. The header, which names the branch while on one, reads "Read-only: earlier version" instead. Clicking it explains why and offers two exits: Return to the branch most recently left, and Start a branch here [1, Q3, Q4, Q15].

**Moving with unfinished work.** Viewing a version, switching branch, opening a link, and Get latest all need a clean working copy. When there are uncommitted changes, one prompt lists them and offers Commit, Discard, or Cancel. After a commit or a confirmed discard, Revisions completes the move [1, Q2, Q7].

**Receiving changes.** Revisions checks GitHub when a project opens, when Changes & history opens, and every 5 minutes. The panel shows how many commits are waiting and whether GitHub could be reached. Get latest combines them with the collaborator's work. Where both changed the same lines, the collaborator edits out the conflict markers in the raw editor and commits, or undoes the merge [1, Q12, Q13].

**Sharing.** Send pushes the current branch. Pull request… sends the branch if needed and opens the pull request in one step. A collaborator who revised directly on the shared branch can still package that work as a pull request: Revisions asks for a branch name, moves the unsent commits onto it, and returns the shared branch to match GitHub [1, Q11].

**Finishing.** After the author merges a pull request and deletes its branch on GitHub, the collaborator's copy of that branch is finished. Revisions notices on its next check and offers to remove it, saying that everything on it is kept on GitHub. One click removes it; nothing is removed without that click. Any other local branch can be deleted after a confirmation that lists the commits that exist only on it [1, Q5, Q6].

## Reference-level explanation

### Terms

- **Snapshot.** A commit checked out without a branch (a detached HEAD).
- **Move.** An operation that changes which version the working copy holds: View this version, Return to a branch, switching branch, opening a link that moves an existing clone, and Get latest.
- **Uncommitted changes.** Changed or untracked files, as `R/git/status` reports them.
- **Unsent commits.** Commits reachable from the current branch and from no remote-tracking branch or pull-request reference.
- **Kept on GitHub.** Reachable from a remote-tracking branch or a pull-request reference, as of the last fetch.
- **Finished branch.** A local branch whose GitHub branch was removed, whose commits are all kept on GitHub, and which has no uncommitted changes when it is the current branch.

### The move prompt

Before a move, Revisions saves pending editor text. If the save fails, nothing else happens, with one exception: a snapshot refuses every save, so text it refused does not block a move from it. That text stays shown for copying, with Reload, and is saved nowhere, not even on the version the move reaches [1]. If the working copy is clean, the move runs. Otherwise the prompt names the destination, lists the changed files, and offers:

- **Commit.** The ordinary commit form, with a required description that is never prefilled. Revisions commits every change on the current branch, then moves.
- **Discard.** The existing discard confirmation with its diff. After confirmation, Revisions discards, then moves.
- **Cancel.** Nothing changes.

On a snapshot, Commit is not offered, because a snapshot cannot be committed to. While a merge is unfinished there is no prompt. Revisions refuses the move and says to finish or undo the merge first.

When the commit or discard succeeds and the move fails, Revisions says what was committed or discarded, and that the move did not happen and why. It stays where it is and never retries on its own.

Creating a branch at the current version is not a move. Uncommitted changes come along, as released. Switching stays stricter than Git. Any uncommitted change blocks it, including changes Git would carry across.

On Home, opening a link that would move an existing clone with uncommitted changes shows the same prompt for that clone. "Open this copy as it is" remains available.

### Pull request in one sweep

Pull request… asks for a title, description, and base branch, as released. The base defaults to the repository's default branch.

- **On a branch other than the base,** Revisions sends the branch if it has unsent commits or no GitHub branch, then opens the pull request.
- **On the base branch,** the dialog also asks for a new branch name. Revisions creates that branch at the current commit, moving onto it with any uncommitted changes. It then moves the local base branch back to its GitHub branch, sends the new branch, and opens the pull request. The dialog says that uncommitted changes come along but are not part of the pull request.

Revisions refuses before any step when there is nothing to propose (no commit on the current branch is missing from the base's GitHub branch), when a merge is unfinished, or when the account cannot push. When a step fails, Revisions states which steps were done and which were not, and never retries on its own.

Moving the local base branch loses nothing, because its unsent commits are then on the new branch. It also prevents the leftover a squash merge would otherwise cause, because the local base never holds commits that GitHub took in under another form.

### Finished branches and pull-request references

GitHub keeps every pull request's head commit at `refs/pull/<n>/head`. That namespace is read-only [4], and the references outlive the branch they came from [1]. Every fetch of `origin` also fetches `+refs/pull/*/head:refs/pull/*/head` and prunes as it does for branches. These references stay out of the commit graph, which lists only branches and remote-tracking branches.

A branch's commits are kept on GitHub when `git rev-list <branch> --not --remotes --glob=refs/pull/*` lists nothing. After a squash merge, the branch's own commits are still held by its pull request's reference, so a squash-merged branch counts as finished. That retention is observed, not documented. If a reference were missing, the branch would not be offered for removal, so the check fails safe [1].

Removing a finished branch never touches GitHub. When the finished branch is the current one, removal first switches to the repository's default branch, the one `R/git/status` names as `defaultBranch`, then deletes. If the switch succeeds and the deletion fails, Revisions says so.

Two cases are not detected and stay with manual deletion: a merged pull request whose branch is left on GitHub, and a branch removed from GitHub that never had a pull request.

### Checking GitHub

The page fetches when a project opens, when Changes & history opens, and every 5 minutes while a project is open. The interval is fixed. A check is skipped while another Git operation runs, and when signed out. A check only fetches: it never changes the working copy or the current branch.

The panel shows the number of commits waiting on GitHub for the current branch and when GitHub was last reached, by a check, Get latest, or Send. When a check cannot reach GitHub, the panel says that GitHub could not be reached since that time, so the copy may be out of date. A rejected sign-in during a check shows the existing reconnect explanation. Neither failure blocks editing, committing, or building.

A check is an ordinary authenticated request, so it renews an expiring credential the same way any request does. It is not a keepalive.

### Saves around Git operations

A save waits while a Git operation that changes the working copy or HEAD runs: commit, merge and merge abort, checkout and branch creation, discard, the local steps of the one-sweep pull request, and the checkout done by opening a link. Each such operation checks for uncommitted changes while saves wait. A save never waits on the network: fetching, pushing, and calls to GitHub do not hold saves back.

With that ordering, a save arriving during a discard either lands before the discard checks its preview, so nothing is discarded, or lands afterwards and is rejected as stale with its text shown. A save arriving during View this version either lands first, so the move prompt appears, or is refused on the snapshot with its text kept.

Leaving a project for Home saves pending text first. A dialog whose action is running cannot be closed with Escape.

Text typed in one window while another window switches branch is saved onto the new branch as an uncommitted change, visible in the editor and in Changes & history. This matches how Git carries uncommitted edits across a switch, and is accepted [1, Q14].

## Requirements

### Requirement: Open a shared GitHub URL

Revisions SHALL accept a GitHub commit, branch, or pull-request URL and bring a local clone to the referenced commit. It SHALL clone the repository when no local clone exists. A commit URL whose commit is no longer the tip of exactly one GitHub branch SHALL open as a snapshot.

#### Scenario: First open

- WHEN a collaborator with no local clone opens a shared commit URL
- THEN Revisions clones the repository to the collaborator's machine and checks out that commit

#### Scenario: Existing clone

- WHEN a collaborator with a clean local clone opens a URL for a different commit
- THEN Revisions fetches and checks out the shared commit

#### Scenario: Commit link after newer pushes

- WHEN the author shares a commit URL and then pushes again to that branch, and the collaborator opens the URL
- THEN Revisions opens the commit as a snapshot, and the read-only indicator explains why and offers the way to edit

### Requirement: Link a folder on this computer

Home SHALL accept the path of a folder that already holds a Git repository outside the Revisions folder, so that a manuscript kept and used elsewhere opens without a second clone. A folder inside a repository SHALL link the whole repository. The repository's `origin` SHALL name the repository on GitHub, over HTTPS or SSH, and SHALL decide the repository it is. Linking SHALL need neither sign-in nor GitHub. From then on Revisions SHALL treat the folder as that repository's clone everywhere, including when a link to the repository is opened, and Home SHALL list it with its folder. Revisions SHALL reach an SSH `origin` over HTTPS with the signed-in account, as it does every clone, and SHALL leave the repository's Git configuration unchanged. A folder that does not exist, is not a Git repository, or has no `origin` on GitHub SHALL be refused with a plain explanation that it is not set up correctly, and nothing SHALL be linked. A repository that already has a copy in another folder on this computer SHALL be refused, naming that folder [6].

#### Scenario: Link a folder

- WHEN the user links a folder inside a clone kept outside the Revisions folder, then opens a link to the same repository
- THEN the project opens on that folder, edits save there, Home lists it with its folder, and no second clone is made

#### Scenario: Folder with an SSH remote

- WHEN a linked repository's `origin` is `git@github.com:<owner>/<name>.git` and the user gets the latest changes
- THEN Revisions fetches with the signed-in account, and `origin` is unchanged

#### Scenario: Folder not set up correctly

- WHEN the user links a folder that is missing, is not a Git repository, has no `origin`, or has an `origin` that is not on GitHub
- THEN Revisions says the folder is not set up correctly and why, and links nothing

#### Scenario: Repository already on this computer

- WHEN the user links a folder whose repository Revisions already holds in another folder
- THEN Revisions refuses and names the folder that holds it

### Requirement: Manage a repository from Home

Each repository Home lists SHALL have a menu with Show in folder, Copy path, Properties, and either Remove, for a copy in the Revisions folder, or Unlink, for a linked folder. Show in folder SHALL open the repository's folder in the system file manager. Copy path SHALL put the folder's absolute path on the clipboard. Properties SHALL show the repository with a link to it on GitHub, whether it is a copy in the Revisions folder or a linked folder, the folder, the `origin` remote as Git stores it, the current branch or the snapshot on screen, the latest commit with its short id, subject, and date, the default branch, and how many files have uncommitted changes and how many commits on the current branch are not on GitHub. Remove and Unlink SHALL each say exactly what they will do and require one confirmation. Remove SHALL delete the copy's folder and SHALL list, before confirmation, every file with uncommitted changes and every commit on a local branch or HEAD that no GitHub branch or pull-request reference holds, because those are lost. Unlink SHALL only stop Revisions using the folder and SHALL leave the folder, its files, and its Git history as they are. Neither SHALL change GitHub. Revisions SHALL delete only a folder inside the Revisions folder, reached without symbolic links, and SHALL do nothing when what the confirmation showed has changed since. Both SHALL forget the repository's last PDF [7].

#### Scenario: Show in folder and copy path

- WHEN the user chooses Show in folder or Copy path in a repository's menu on Home
- THEN the file manager opens on the repository's folder, or the folder's path is on the clipboard

#### Scenario: Properties

- WHEN the user chooses Properties in a repository's menu on Home
- THEN Revisions shows the repository, its kind, folder, `origin`, branch, latest commit, default branch, and the work that is not on GitHub

#### Scenario: Remove a copy

- WHEN the user removes a copy in the Revisions folder that has no work missing from GitHub, and confirms
- THEN the confirmation names the folder it deletes and says nothing on GitHub changes, and afterwards the folder is gone and Home no longer lists the repository

#### Scenario: Remove a copy with work not on GitHub

- WHEN the user removes a copy that has uncommitted changes or commits no GitHub branch holds
- THEN the confirmation lists those files and commits as lost, and nothing is deleted if they change before the user confirms

#### Scenario: Unlink a folder

- WHEN the user unlinks a linked folder and confirms
- THEN Home no longer lists the repository, and the folder, its files, and its Git history are unchanged

### Requirement: Uncommitted work before a move

Before a move, Revisions SHALL save pending editor text and SHALL do nothing more if that fails, except that text refused on a snapshot SHALL NOT block a move from it and SHALL stay shown for copying without being saved anywhere. With uncommitted changes, it SHALL show one prompt that names the destination, lists the changed files, and offers Commit, Discard, and Cancel. It SHALL complete the move only after the chosen commit or confirmed discard succeeds. Commit SHALL require a description and SHALL NOT prefill one. Commit SHALL NOT be offered on a snapshot. During an unfinished merge, Revisions SHALL refuse the move without a prompt. When the commit or discard succeeds and the move fails, Revisions SHALL report both outcomes, stay where it is, and SHALL NOT retry on its own. Any uncommitted change SHALL block a move, including changes Git would carry across [1, Q2, Q7].

#### Scenario: Dirty clone

- WHEN the local clone has uncommitted edits and the collaborator opens a URL for another commit from Home
- THEN Revisions leaves the working tree unchanged and shows the prompt for that clone, with Open this copy as it is still available

#### Scenario: View with uncommitted changes

- WHEN the clone has uncommitted changes and the user chooses View this version
- THEN Revisions lists the changes, offers Commit, Discard, and Cancel, and leaves the checkout unchanged until one of the first two succeeds

#### Scenario: Commit and move

- WHEN the user chooses Commit in the prompt, enters a description, and confirms
- THEN Revisions commits every change on the current branch and then completes the move

#### Scenario: Discard and move

- WHEN the user chooses Discard in the prompt and confirms the diff
- THEN Revisions discards the changes and then completes the move

#### Scenario: Cancel

- WHEN the user chooses Cancel in the prompt
- THEN nothing is committed, discarded, or moved

#### Scenario: Move fails after a commit

- WHEN the commit in the prompt succeeds and the move then fails
- THEN Revisions says that the work was committed and that the move did not happen, with the reason, stays on the current version, and does not retry

#### Scenario: Refused text on a snapshot

- WHEN a snapshot refused a save of the user's text and the user chooses Return
- THEN Revisions returns to the branch, keeps the refused text shown for copying, and saves it nowhere

#### Scenario: Unfinished merge

- WHEN a merge is unfinished and the user attempts a move
- THEN Revisions refuses without a prompt and says to finish or undo the merge first

### Requirement: View an earlier version

A commit selected in the history SHALL offer View this version, which puts the clone on that commit as a snapshot, so the editor shows the files as they were and a build compiles that version. The editor SHALL be read-only on a snapshot and the server SHALL refuse saves there, whether the snapshot came from the history or from a commit URL. On a snapshot, the header text that names the branch SHALL read "Read-only: earlier version" and SHALL open a dialog that names the version by its date and subject, explains in plain language why it cannot be changed, and offers Return to the branch most recently left (or the default branch when there is none), Start a branch here, and Close. Start a branch here SHALL ask for the branch name. No full-width banner SHALL be shown. A file that is read-only because it is not UTF-8 SHALL show its own reason beside its name, without offering a branch. A branch SHALL stay editable whatever its age and whether a pull advanced it. A PDF built from another version SHALL be marked out of date. Revisions SHALL NOT restore an earlier version onto a branch or rewrite history [1, Q3, Q4, Q15; 3].

#### Scenario: View an earlier version

- WHEN the user selects an earlier commit in the history and chooses View this version
- THEN the editor shows the files as they were at that commit, refuses edits, and the header reads Read-only: earlier version

#### Scenario: Read-only reason

- WHEN the user clicks Read-only: earlier version in the header
- THEN a dialog names the version by date and subject, explains why it cannot be changed, and offers Return to the branch and Start a branch here

#### Scenario: Back to the branch

- WHEN the user chooses Return to the branch in that dialog
- THEN the clone is on that branch again and the editor accepts edits

#### Scenario: Branch from an earlier version

- WHEN the user chooses Start a branch here and names the branch
- THEN a new branch starts at that commit and the editor accepts edits

#### Scenario: Branch age does not lock editing

- WHEN the user opens an old branch, or Get latest advances the current branch
- THEN the editor stays editable

#### Scenario: Encoding read-only reason

- WHEN a file is not valid UTF-8
- THEN its read-only label explains the encoding and does not offer a branch

#### Scenario: PDF from another version

- WHEN the PDF was built from one version and the user moves to another
- THEN the PDF view shows the out-of-date warning

### Requirement: Get latest

Get latest SHALL fetch and then merge the current branch's GitHub branch. It is a move, so uncommitted changes SHALL bring up the move prompt, and the server SHALL refuse to merge while any uncommitted change exists. Merge conflicts SHALL be resolved by editing out the markers in the raw editor and committing, and Undo this merge SHALL restore the copy as it was before Get latest [1, Q7].

#### Scenario: Get latest with uncommitted changes

- WHEN the user has uncommitted changes in a file the incoming commits do not touch and chooses Get latest
- THEN Revisions shows the move prompt and merges only after a commit or confirmed discard

#### Scenario: Conflict

- WHEN Get latest finds that the user's commits and the incoming commits change the same lines
- THEN Revisions lists the conflicted files, accepts a commit only once their markers are removed, and offers Undo this merge

#### Scenario: Branch removed on GitHub

- WHEN the collaborator's branch was deleted on GitHub, for example after its pull request was closed, and they choose Get latest
- THEN Revisions leaves the working tree unchanged, says in plain language that the branch was removed from GitHub, and offers Send to put it back

### Requirement: Check GitHub for changes

While signed in, Revisions SHALL fetch from GitHub when a project opens, when Changes & history opens, and every 5 minutes while a project is open, skipping a check while another Git operation runs. A check SHALL NOT change the working copy or the current branch. Changes & history SHALL show the number of commits waiting for the current branch and when GitHub was last reached. When a check cannot reach GitHub, the panel SHALL say so with the time of the last successful check. A failed check SHALL NOT block editing, committing, or building [1, Q12, Q13].

#### Scenario: Check on opening

- WHEN a co-author pushed to the current branch since the collaborator last opened the project, and the collaborator opens it
- THEN Changes & history shows the waiting commits without the collaborator pressing anything

#### Scenario: Periodic check

- WHEN a co-author pushes to the current branch while the project is open
- THEN the waiting commits appear in Changes & history within 5 minutes

#### Scenario: GitHub unreachable

- WHEN a check cannot reach GitHub
- THEN Changes & history says that GitHub has not been reached since the last successful check, and editing, committing, and building continue

### Requirement: Where the work stands

With Changes & history closed, the top bar SHALL signal when there are uncommitted changes and when there are unsent commits. Neither signal SHALL depend on contacting GitHub. GitHub's side SHALL appear only inside Changes & history. The count on Send SHALL be the number of unsent commits [1, Q9, Q13]. The top bar SHALL have two rows at every width: where you are (the project, its branch or snapshot, and the main document) above what you do (the files, the panes in the middle of the bar, Changes & history, and the build). A chip beside Changes & history SHALL read "Not committed", "N not sent", or both joined by " · ", and SHALL never depend on GitHub [1, Q17].

#### Scenario: Uncommitted changes

- WHEN the user edits a file and the edit is saved
- THEN the top bar signals uncommitted changes

#### Scenario: Unsent commits

- WHEN the user commits on a branch that has never been sent
- THEN the top bar signals unsent commits with their number, and the signal clears after Send

### Requirement: Send and open a pull request

Revisions SHALL push the current branch on Send. Pull request… SHALL send the current branch when needed and open the pull request in one action. On the base branch it SHALL ask for a new branch name, create that branch at the current commit with any uncommitted changes, move the local base branch back to its GitHub branch, send the new branch, and open the pull request, stating that uncommitted changes are not part of it. It SHALL refuse before any step when there is nothing to propose, during an unfinished merge, or without push permission. When a step fails, it SHALL report which steps were done and SHALL NOT retry on its own. A collaborator without push permission SHALL see, when the project opens and beside the commit box, that sharing needs write access the author grants on GitHub [1, Q10, Q11].

#### Scenario: Open a pull request

- WHEN a collaborator with push access commits on their own branch and chooses Pull request… without sending first
- THEN Revisions sends the branch, creates the pull request on GitHub, and shows it in the commit graph

#### Scenario: Pull request from the shared branch

- WHEN a collaborator has unsent commits on the base branch and chooses Pull request…
- THEN Revisions asks for a branch name, moves the unsent commits to that branch, leaves the base branch matching GitHub, sends the new branch, and opens the pull request

#### Scenario: Nothing to propose

- WHEN the current branch has no commits missing from the base's GitHub branch and the user chooses Pull request…
- THEN Revisions changes nothing and says there is nothing to propose yet

#### Scenario: Pull request step fails

- WHEN the new branch is created but sending it fails
- THEN Revisions says that the branch was created and the base moved, that nothing was sent, and why, and does not retry

#### Scenario: No write access

- WHEN a signed-in collaborator without push permission opens a project
- THEN Revisions explains that sharing needs write access the author grants on GitHub, and repeats it beside the commit box

### Requirement: Delete a local branch

Revisions SHALL offer deletion of any local branch except the current one, after one confirmation. The confirmation SHALL list the commits on that branch that no other local branch, remote-tracking branch, or pull-request reference holds, or say that every commit is kept elsewhere. Confirmation SHALL be refused when the branch or that list changed since the preview. Deletion SHALL NOT change GitHub [1, Q5].

#### Scenario: Delete a branch with unique commits

- WHEN the user previews deletion of a local branch holding commits found nowhere else, and confirms
- THEN the preview lists those commits, and Revisions deletes only the local branch

#### Scenario: Delete a squash-merged branch

- WHEN the user previews deletion of a branch whose pull request was squash-merged
- THEN the preview says that every commit is kept on GitHub

#### Scenario: Changed deletion preview

- WHEN the branch gains a commit after the preview and the user confirms
- THEN Revisions deletes nothing and shows a fresh preview

### Requirement: Tidy finished branches

After a check, Revisions SHALL list each finished branch in Changes & history with an explanation that everything on it is kept on GitHub, naming the pull request that holds it when there is one, and a button that removes it. Removal SHALL require that click every time and SHALL NOT change GitHub. When the finished branch is the current one, removal SHALL switch to the default branch first. A branch with an unsent commit, or with uncommitted changes while current, SHALL NOT be listed [1, Q5, Q6].

#### Scenario: Finished after a squash merge

- WHEN the author squash-merges the collaborator's pull request and deletes its branch on GitHub, and Revisions next checks GitHub
- THEN Changes & history lists the branch as finished and kept in that pull request, and removes the local branch only when the collaborator clicks

#### Scenario: Unsent work keeps a branch

- WHEN a branch removed from GitHub holds one commit that was never sent
- THEN Revisions does not list it as finished

#### Scenario: Finished current branch

- WHEN the collaborator removes the finished branch they are on
- THEN Revisions switches to the default branch and then deletes the finished branch

### Requirement: Saves around Git operations

A save SHALL wait while a Git operation that changes the working copy or HEAD runs, and each such operation SHALL check for uncommitted changes while saves wait. A save SHALL NOT wait on a network operation. Leaving a project SHALL save pending text first. A dialog SHALL NOT close on Escape while its action runs. Text saved by another window after a branch switch MAY land on the new branch as a visible uncommitted change [1, Q14].

#### Scenario: Discard while another window types

- WHEN one window confirms Discard while another window's save arrives
- THEN either nothing is discarded and the preview is refreshed, or the save is rejected as stale with its text shown; the text is never lost silently

#### Scenario: Save during View this version

- WHEN a save arrives while View this version runs
- THEN the save lands before the move, which then shows the move prompt, or it is refused on the snapshot with its text kept; nothing is written into the snapshot

#### Scenario: Leave with pending text

- WHEN the user goes to Home less than a second after typing
- THEN the text is saved on the version where it was typed before Home appears

#### Scenario: Escape while working

- WHEN the user presses Escape while a dialog's switch is running
- THEN the dialog stays open until the switch finishes

#### Scenario: Save during a slow fetch

- WHEN a fetch is waiting on GitHub and the editor saves
- THEN the save completes without waiting for the fetch

### Requirement: Git operations

Revisions SHALL offer viewing changes and diffs, commit, Get latest, Send, create or switch branch, View this version, open a pull request, force-push, discard changes, and delete a local branch, each within the collaborator's GitHub permissions. It SHALL present history as a GitKraken-style commit graph [2, Q28]. Commit SHALL include every change.

#### Scenario: Commit

- WHEN the user enters a description and commits
- THEN every change is in the commit and the top bar signals an unsent commit

### Requirement: Destructive-operation confirmation

Force-push SHALL list the remote commits it will erase and SHALL use `--force-with-lease`. Discard SHALL show the diff it will remove. Each SHALL require one explicit confirmation [2, Q29].

#### Scenario: Force-push

- WHEN the user chooses force-push
- THEN Revisions lists the remote commits that will be erased and pushes with `--force-with-lease` only after confirmation

#### Scenario: Discard

- WHEN the user chooses discard
- THEN Revisions shows the diff to be removed and discards it only after confirmation

## Alternatives considered

**Native Git stashes.** Built in an earlier attempt and rejected. `git stash drop` deletes by list position, which another Git process can shift between validation and deletion, and stashes are a second store of work outside the history [1, Q1].

**Saved work under custom references.** Would allow safe deletion, but Revisions would own capture, restore, cleanup, and interoperability with other Git tools. Rejected with stashes [1, Q1].

**Refusing to move over uncommitted work.** The released behaviour, chosen first [2, Q27]. Replaced by the move prompt so that the user completes the intended action in one sweep [1, Q2].

**Merging over uncommitted changes on Get latest.** Git allows it when the incoming commits touch other files. Rejected because it is a second rule beside the move rule, and Git's manual warns that it may leave a state that is hard to back out of after a conflict [1, Q7; 5].

**An editable snapshot, with a branch named at commit time.** Ordinary Git supports it, and most read-only states would disappear. Rejected because someone can edit an old version believing it is current, and the move prompt would need a second form [1, Q3].

**Reading history without a checkout.** The working copy would stay put while an earlier version is shown, so viewing would never need the prompt. Deferred: it needs the server to serve and build a second file tree, and with commit-only the rule stays simple [1, Q1].

**More exits from a snapshot.** "Edit from this version" in the history, and a chooser among branches at that commit. Dropped to keep the snapshot dialog to two exits [1, Q4].

**Deleting only branches whose commits exist elsewhere.** Safe by construction, but after a squash merge Git sees the commits nowhere else, so finished branches could not be deleted [1, Q5].

**Removing finished branches automatically.** Rejected. Removal always takes a click [1, Q6].

**A checkout identity on every save.** Built in the earlier attempt to stop a late save from crossing a switch. Dropped to keep the save contract. A stress test then found the cases that the save ordering in this spec closes [1, Q8, Q14].

**Pausing typing while a switch runs.** Would help only slow switches in one window, and none of the cases the stress test found at normal speed [1, Q14].

**A fork path for collaborators without write access.** Deferred until needed. Sharing requires write access, which the author grants on GitHub [1, Q10].

**GitHub's side on the top-bar button.** Rejected for lack of space; it stays inside the panel [1, Q13].

**A phrase on the Changes & history button, or a compact mark with a count.** The phrase replaced the button's label ("Changes not committed", then "2 commits not sent"); the mark kept the label and added a dot and an unsent count. Both were built and compared in the running app beside the chip, and rejected for the chip [1, Q17].

**A full-width banner or a strip above the editor on a snapshot.** Replaced by the header indicator, which adds nothing to the top bar [1, Q15].

## Prior art

**Git** refuses `git branch -d` for a branch it judges unmerged, by reachability. After a squash merge it judges a taken-in branch unmerged, which is the gap the pull-request references close here.

**The earlier attempt** [1] contributed the compact read-only indicator, the reason dialog, and confirmed branch deletion, all carried forward in reduced form.

## Unresolved questions

None.

## Sources

- [1] `notes/grill-git-workflow-01.md`. Interview, Git workflow session 01, 2026-11-16 to 2026-11-17, including the pull-request reference check and the save race stress test. Q numbers refer to its questions.
- [2] `notes/grill-rewrite-overview-01.md`. Interview, session 01, 2026-11-09. Q numbers refer to its questions.
- [3] `notes/feedback-demo-02.md`. Feedback that introduced View this version and the removed-branch message, 2026-11-11.
- [4] GitHub Docs, "Checking out pull requests locally": https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/checking-out-pull-requests-locally.
- [5] `git-merge(1)`, Git 2.53.0.
- [6] The owner's request of 2026-11-20 to open repositories kept and used outside the Revisions folder, with an error saying a repository is not set up correctly when it is not a Git repository or not linked to GitHub, and the owner's choice to reach SSH remotes over HTTPS with the signed-in account.
- [7] The owner's request of 2026-11-22 for a menu on each repository on Home with Show in folder, Copy path, Properties, and Remove or Unlink, with a confirmation that says exactly what removing or unlinking will do.
