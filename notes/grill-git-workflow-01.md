# Grill: Git Workflow (Session 01)
format: structured-notes
date: 2026-11-17
source: conversation (Ryan Ressmeyer with Claude Code, Git workflow interview on branch feature/git-workflow, 2026-11-16 to 2026-11-17)

## Summary
Interview that replaced an unfinished Git workflow experiment with a smaller interaction model. A commit is the only way to keep unfinished work, so stashes are out. One prompt (Commit, Discard, or Cancel) completes any move blocked by uncommitted changes, including Get latest. Finished branches are detected through GitHub's pull-request references and removed with one click. Pull request… completes in one sweep, even from the shared branch. Revisions checks GitHub periodically. Three small fixes close save races found by a stress test. The experiment was deleted at the user's request. Questions are condensed; answers are verbatim in their own section.

## Background
The user asked for this session after reporting a large yellow read-only banner on a detached commit, and unexpected read-only states around older branches and incoming commits. Inspection had shown that the gate is a detached HEAD, not branch age, and the pull-related report was not reproduced [1]. A previous session had implemented explicit history branching, "Stash and switch", visible stashes, and confirmed local branch deletion, all uncommitted on `feature/git-workflow` [1]. It stalled on a safety blocker: `git stash drop` deletes by list position, so another Git process can shift the list between validation and deletion and the wrong stash is deleted. Git 2.53 offers no expected-commit guard for that command [1]. The user did not approve the proposed replacement, custom saved-work references, and asked to reconsider whether stashing is needed at all, to walk through concrete journeys before choosing controls, and to prefer ordinary Git behaviour and a small interface.

## Decisions

### Unfinished work and moving between versions
- A commit is the only way to keep unfinished work. Native stashes and custom saved-work references are both rejected (Q1).
- No default path: working on the branch that was sent and working on one's own branch are equally available (Q1).
- When uncommitted changes block a move (View this version, switching branch, opening a link, Get latest), one prompt offers Commit, Discard, and Cancel, then completes the move (Q2, Q7).
- Get latest refuses on any uncommitted change, not only when Git would. Git's manual warns that merging with uncommitted changes "may leave you in a state that is hard to back out of in the case of a conflict" [4]. The user preferred the clean rule (Q7).
- A snapshot (detached HEAD) stays read-only (Q3).
- The snapshot indicator offers only "Return to *branch*" and "Start a branch here". "Edit from this version" in history and the chooser among branches at a commit, both from the experiment, are dropped (Q4).
- On a snapshot, the header text "at version abc1234" becomes a clickable "Read-only: earlier version" that opens a small dialog with the reason and both exits. The full-width banner is removed (Q15).

### Finishing work
- Any local branch except the current one can be deleted after one confirmation that shows what would be lost. GitHub is never changed (Q5).
- A branch is finished when it was removed from GitHub and every commit on it is also on another branch or held by a pull request. Revisions then offers to remove it. Removal always takes one click (Q5, Q6).

### Sharing
- No fork path for collaborators without write access. It may be added later (Q10).
- Pull request… completes in one sweep. It sends an unsent branch as part of opening. On the branch the pull request would go into, it asks for a new branch name, moves the unsent commits there, puts the shared branch back level with GitHub, sends, and opens the pull request (Q11).
- Revisions checks GitHub when a project opens, when Changes & history opens, and periodically. It tells the user when GitHub cannot be reached, because their copy may then be out of date (Q12).

### Status display
- GitHub's side (commits to get, and whether GitHub could be reached) shows inside the Changes & history panel only (Q13).
- The top bar signals uncommitted or unsent work. Its form is undecided and will be chosen by the user comparing variants in the running app. The phrase on the button chosen in Q9 is one candidate, not the agreed design (Q9, Q13).

### Save safety
- The released save check stays: a save carries only the hash of the file it was based on. The experiment's per-save checkout identity is dropped (Q8).
- Three small fixes, with the save contract unchanged (Q14):
  1. A save waits while a Git operation that changes files (switch, merge, discard) runs, and that operation's check for uncommitted changes runs inside the same wait. Fetches are excluded, so a save never waits on the network.
  2. Leaving a project saves its pending text first.
  3. Escape cannot close a dialog while its action is running.
- Accepted behaviour: text typed in one window while another window switches branch lands on the new branch as a visible uncommitted change. This matches how Git carries uncommitted edits across a switch (Q14).

### Proposals accepted with the plan
The agent proposed these during the interview. The user did not object to them and approved the plan that listed them.
- The move prompt also appears on Home when opening a link moves an existing clone.
- The commit description in the prompt is required and never prefilled.
- During an unfinished merge there is no prompt, only a refusal that says to finish or undo the merge.
- When the commit or discard succeeds and the move fails, Revisions states both outcomes, stays where it is, and never retries on its own. The same applies to each step of the one-sweep pull request.
- Uncommitted changes carried to a new pull-request branch stay uncommitted, and the dialog says they are not part of the pull request.
- Switching stays stricter than Git: any uncommitted change blocks it.
- Discard stays all-or-nothing.
- Reading history without a checkout is deferred.
- The periodic check runs every 5 minutes, a fixed value, and is skipped while another Git operation runs. It only fetches. "GitHub could not be reached" is reported separately from a rejected sign-in, and neither blocks editing, committing, or building. The sign-in requirement's ban on a background keepalive is reworded so that renewal is allowed when a periodic check needs it, but never for its own sake.
- The no-write-access note shows when a project opens and beside the commit box.
- A file that is read-only because of its encoding keeps its own label and reason, without branch exits.
- The Git requirements move from `specs/overview.md` into `specs/git-workflow.md`.
- The experiment is deleted rather than kept on a local branch (the user's amendment to the plan).

## Investigations

### Pull-request references after a squash merge
After a squash merge, Git sees a branch's commits nowhere else, so a local branch looks as if it holds unique work. GitHub keeps every pull request's head commit under `refs/pull/<n>/head`, and the docs state that this namespace is read-only [2]. The docs do not state how long the references are kept, or whether they survive a deleted head branch [2, 3].

- **Local test.** In real repositories, a branch was squash-merged and deleted on the remote. After a plain `git fetch --prune`, `git rev-list` reported 2 commits found only on the local branch. After also fetching `+refs/pull/*/head:refs/pull/*/head`, it reported 0, and `git for-each-ref --contains` named `refs/pull/12/head`. After one more unsent commit, it reported 1. The fetched references did not appear in `git log --branches --remotes`.
- **GitHub check.** `git ls-remote` against the public repository `cli/cli` returned `refs/pull/3/head`, `refs/pull/5/head`, and `refs/pull/9/head`. Each matched the head commit the REST API reports. These pull requests were merged or closed in 2019, and none of their head branches still exists [5].
- **Conclusion.** Retention is observed, not documented. If a reference were missing, the branch would not be offered for removal, so the design fails safe.

### Save and checkout race stress test
One Opus subagent tested the released code (`ca51d00`), exported to a scratch directory, with Playwright typing real keystrokes during Git operations [6]. It ran 15 iterations per case at natural timing, and 10 with a `git` shim that slept 0.5–2 s before `switch`, `merge`, `reset`, `restore`, `checkout`, and `fetch`.

| Case | Natural timing | Widened timing |
|---|---|---|
| Switch, view, back, Get latest, discard in one window | No text crossed or lost | View: 4 of 10 saved edits into the read-only snapshot |
| Escape while a switch runs | No problem | 9 of 10 carried or crossed text to the new branch |
| Second window switches branch | 12 of 15 crossed, text visible | 5 of 10 crossed or carried |
| Second window confirms Discard | Collision shown or nothing discarded | 4 of 10 lost text silently |
| Second window views a version | 9 of 15 showed a save error, text kept | 6 of 10 saved edits into the snapshot |
| `git switch` in a terminal | 15 of 15 crossed or carried | Not run |
| Open a link from Home within ~1 s of typing | 5 of 15 crossed | No problem |

- Local Git operations took 14–34 ms (median about 25 ms) at natural timing.
- The snapshot write left an editor that was locked yet reported unsaved changes. Back was refused and Commit was disabled, so Discard or a new branch were the only exits.
- The silent loss matches a gap that the released discard code already admits in a comment (`internal/server/routes_git.go:568` at `ca51d00`).
- A "pause typing while a switch runs" fix in one window would help none of the cases that occur at natural timing. This led to the three fixes in Q14.
- Whether real GitHub fetches widen the window in practice was not tested.

## Open questions
- [NEEDS CLARIFICATION: The form of the top-bar signal for uncommitted or unsent work, to be chosen by the user comparing variants in the running app.]

## Interview (verbatim answers)
Questions are condensed from the session. Answers are reproduced verbatim.

**Request (the user's words after the pasted brief).**
> Do not write code yourself unless it is a small change. We want to write code through opus subagent(s) once we have a spec that we are happy about. I want to make sure to have a spec covering this topic that we are completely happy with first before implementing.

**Q1. Which workflow model, and what should a revision round's normal path be: the shared branch, one's own branch plus a pull request, or no default?** The models offered were commit-only (A), commit-only plus reading history without a checkout (B), native stashes (C), and custom saved-work references (D).
> I think that model A makes sense. I care a lot about simplicity and having parsimonious interactions and workflows so removing new feature to have a small core of functionality seems ideal. I'd say that there should be no default. Users can either work on their own branch or on a shared branch that was sent. The choice is theirs.

**Q2. When uncommitted changes block a move: (a) refuse and explain, or (b) one prompt with Commit, Discard, and Cancel that finishes the move?**
> I'd prefer option b so that users can complete their intended action in a single sweep without having to navigate elsewhere. It also makes it clear exactly what's happening, although we do need to make sure everything is handled cleanly and consistently in this new flow.

**Q3. Should a snapshot stay read-only (a), or be editable with the branch named at commit time (b)?**
> Yes, I'd like to have (a) be the behavior. I'm also not sure how merge behavior is handled currently. I have never merged in revisions.

**Q4. Which exits should the snapshot indicator offer: (a) the two released exits, (b) also branches containing the version, or (c) the experiment's additions?**
> Option (a), keep it minimal

**Q5. Local branch deletion: (a) none, (b) only when nothing would be lost, or (c) any branch but the current one, with a confirmation that shows what would be lost?**
> (c) is what I'd like. I think this is a legitimate issue with git where squash merges leave no trace of the old commit history. We should think about how exactly to approach this well. I'm looking for a brilliant "Aha" kind of solution where it's easy to keep things tidy (like removing branches remotely) while propigating that tidiness to the users if they already have a local version without explicitly forcing them to lose work or a branch. Push back on this if there isn't an easy way.

**Q6. Finished branches detected through pull-request references: should removal always take a click (a), or be automatic for branches not in use (b)?**
> Great work. I like this. Yes, always requires a click to remove a branch.

**Q7. Get latest with uncommitted changes: (a) the same prompt as moving, or (b) Git's behaviour, with the prompt only when Git refuses?**
> Yes, (a) is the way to go. I'd rahter have it be clean.

**Q8. Keep the experiment's per-save checkout identity (b), or drop it and keep the released check (a)?**
> Let's drop it and keep the current check. I'd like you to have a subagent stress test though to see if we can actually create this issue to know if we need to add the small fix.

**Q9. Should the top bar say where the work stands: (a) the dot, (b) one short phrase on the button, or (c) (b) plus "Saved on this computer"?** Superseded in part by Q13.
> Yes, B is great.

**Q10. A collaborator without write access: (a) no fork path, or (b) add a fork path?**
> As released is fine. The fork path can be added later as needed.

**Q11. Pull request…: (a) as released, (b) one sweep for an unsent branch, or (c) one sweep that also handles the shared branch?**
> Yes, (c) is the best option and it's the most intuitive since it lets you develop on main then package a pull request.

**Q12. When to check GitHub: (a) only on Get latest, (b) also when a project or the panel opens, or (c) (b) plus periodically?**
> I'd actually opt for (c) since a fetch is cheap. It should also catch when network is down and report to the user that they could be out of sync with the host.

**Q13. Where GitHub's side shows: (a) inside the panel only, or (b) as a second part on the button?**
> This should be inside the panel. The issue is that the button on the top bar has very limited space, we don't want to overload it. As is we actually might be overloading it already. We will have to do A/B testing with me to see what the best way to design it will be.

**Q14. After the stress test: (a) fix nothing, (b) three small fixes, or (c) restore the full save guard?**
> Let's go with (b), the three small fixes

**Q15. The read-only indicator: (a) the header text becomes it, (b) a slim strip above the editor, or (c) build both and compare?**
> Yes, let's go with a)

**Plan approval.**
> I'd advocate for actually just removing the experiment. There's no purpose keeping it since this supercedes. Otherwise this looks good.

## References
- [1] `/tmp/revisions-git-workflow-handoff-2026-11-15.md`. The previous session's implementation report, including the reproduced stash-deletion race. A local file, not part of the repository.
- [2] GitHub Docs, "Checking out pull requests locally": https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/checking-out-pull-requests-locally. States that `refs/pull/` is read-only.
- [3] GitHub Docs, "Deleting and restoring branches in a pull request": https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-branches-in-your-repository/deleting-and-restoring-branches-in-a-pull-request.
- [4] `git-merge(1)`, Git 2.53.0, the warning on running `git merge` with uncommitted changes.
- [5] `git ls-remote https://github.com/cli/cli` and the GitHub REST API for pull requests 3, 5, and 9, checked 2026-11-16.
- [6] Stress-test report, specification, and logs, in the session scratch directory `/tmp/claude-1000/-home-ryanress-repos-revisions/4a231330-ae29-4de9-8e40-86f7a5beeb10/scratchpad/save-race/`. Temporary; the numbers above are the record.
