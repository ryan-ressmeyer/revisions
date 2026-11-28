# Grill: Commit Review and Top-Bar Sync (Session 01)
format: structured-notes
date: 2026-11-27
source: conversation (Ryan Ressmeyer with Claude Code, commit review and top-bar sync interview, 2026-11-26 to 2026-11-27)

## Summary
Interview about two requests: a Commit button in the Changes & history action row, and up and down arrows beside Changes & history for commits to send and commits waiting on GitHub. Commit already existed as a form below the graph, so the real problem was the room for reviewing changes. Commit now opens a focused review window, which also shows an earlier commit's diff read-only. The top-bar chip gains ↑ and ↓ counts and a crossed-out cloud when GitHub could not be reached. This reverses Q13 of the Git workflow interview [2]. Questions are condensed; answers are verbatim in their own section.

## Background
Before the first question, the agent read the specs and the panel code at commit `77060c0` [3]:

- Commit already existed. The "Describe your changes" form sits in the detail pane below the commit graph, which takes up to 45% of the panel's height. It appears only while the "Uncommitted changes" row is selected. The action row holds Get latest, Send, Branch…, Pull request…, and Force-push…, with no Commit.
- The panel covers the PDF pane, so its width follows the editor/PDF divider (20–80% of the window).
- The top-bar chip beside Changes & history already read "Not committed", "N not sent", or both [1].
- `specs/git-workflow.md` said that neither top-bar signal depends on contacting GitHub and that GitHub's side appears only inside Changes & history [1]. That came from Q13 and Q17 of the Git workflow interview, where the user cited the top bar's limited space [2].
- The diff is line by line. A manuscript with one paragraph per line shows a one-word edit as the whole paragraph removed and added again.

## Decisions

### Review window
- Commit sits to the right of Get latest in the action row: Get latest · Commit · Send · Branch… · Pull request… (request, Q3).
- Commit opens a centred window of about tablet width (roughly 60rem) and most of the screen's height. It holds only the review: the changed files, the diff, the description box, Commit, and Discard changes…. The graph stays in the side panel behind it (Q1, Q2, Q3).
- A pop-out button on the detail pane opens the same window. On an earlier commit, the window shows that commit's diff, read-only (Q3).
- In uncommitted changes, clicking a diff line or its "Line N" heading closes the window and puts the cursor on that line in the editor. Commit reopens the window. Earlier commits do not offer the jump, because today's text may have moved (Q4).
- Word-level highlighting inside a changed line is wanted, as its own change after this one (Q5).

### Top bar
- The chip reads `Not committed · ↑N ↓M`. Words stay for uncommitted changes. Arrows replace the counts and match the icons on Send and Get latest. A tooltip and the screen-reader label spell them out (Q6).
- The spec's rules that the top bar never depends on GitHub and that GitHub's side appears only in the panel are removed (Q6).
- When the last check could not reach GitHub, the chip shows a network-trouble icon instead of dimming the count, so the out-of-date state is always communicated (Q7).
- GitHub is also checked when the Revisions tab regains focus (Q8).

### Proposals accepted with the summary
The agent proposed these during the interview. The user did not object and approved the summary that listed them.
- Commit is disabled when nothing has changed, and on a snapshot, with "Create a branch first". During a merge it opens with the description prefilled.
- After a commit, the window closes and the panel reports as before. The small form below the graph stays.
- ↓ is the number of commits waiting on GitHub as of the last check. It is hidden on a snapshot, on a branch never sent, and on a branch removed from GitHub.
- The icon is a crossed-out cloud, the cloud the graph uses for branches on GitHub. It shows whenever the last check failed, even with no ↓, with the tooltip "GitHub could not be reached since <time>, so changes waiting there may not show". It clears when a check, Get latest, or Send reaches GitHub. Signed out shows no ↓ and no icon, because the existing sign-in notice covers it.
- A check on focus is skipped while another Git operation runs, as every check is.
- `GET R/state` gains `behind`, because the top bar reads that poll and not the panel's status. `specs/architecture.md` changes in the same commit.

## Interview (verbatim answers)
Questions are condensed from the session. Answers are reproduced verbatim.

**Request.**
> I'd like to add a feature to make a commit instead of just sending changes to github in revisions. There's also no way to see if there are changes you need to pull from the main screen unless you hit changes & history. I was thinking that it would be nice to add a commit button to the right of Get latest on the changes and history panel, and also add an up an down arrow next to the changes and history to indicate when you have changes to pull from github or changes you've made that can be pushed to github. Does this make sense? Let's think through this change deeply before actually implementing it. You can ask me probing questions that I'll answer in natural language to capture nuance.

**Q1. When you last wanted to commit and could not, was it that (a) you never saw the "Describe your changes" box, (b) it was pushed below the graph, (c) a selected commit had hidden it, (d) you expected Send to commit, or (e) something else?**
> I think the problem has more to do with how the uncommitted changes is just a small panel at the bottom of the changes and history page page, and that there is no way to change how much space that takes up. Maybe we could add a pop out button in the top right of the panel so that it takes up most of the screen so it's easy review the changes you've made if they are substantial. Probably we wouldn't want this to be full width, but more like a tablet view so that it's a reasonable width to read edits and write commit messages and such.

**Q2. What should the popped-out view hold: (a) the whole panel, bigger, (b) the whole panel with the graph and the changes side by side, or (c) only the review: changed files, diff, and commit box?**
> I was thinking (c), since this is meant to be narrowly focused on reviewing a commit.

**Q3. Should the Commit button next to Get latest open this review window?**
> Yes. I guess for an earlier commit it can just be for looking at a diff. That's useful.

**Q4. On spotting a typo while reviewing: (a) close and find the place by hand, (b) click a diff line to close the window and put the cursor on that line in the editor, or (c) something else?**
> Yes, (b) seems very useful.

**Q5. The diff: (a) keep it line by line, (b) highlight only the changed words within a removed/added pair, or (c) do (b) as its own change after this one?**
> (c) sounds good

**Q6. Beside Changes & history: (a) words, `Not committed · 2 not sent · 3 to get`, (b) arrows for the counts, `Not committed · ↑2 ↓3`, or (c) arrows on the button itself?**
> (b) Arrows for the counts, words for the rest is good. We can also modify the spec to remove this requirement.

**Q7. When the last check could not reach GitHub: (a) the last count, unmarked, (b) the count marked as possibly out of date, for example dimmed, or (c) no ↓ until a check succeeds?**
> I want it to be marked somehow as out of date. Although I don't like the idea of diming it. Maybe adding a network issue icon or something? I just want to be sure that state is communicated to the user.

**Q8. After a failed check the icon can stay up to 5 minutes once the network is back: (a) accept that, or (b) also check GitHub when the tab regains focus?**
> (b) is fine since it's a quick check.

**Summary approval.**
> Looks excellent. Go ahead in a branch.

## References
- [1] `specs/git-workflow.md`, Requirement: Where the work stands, and Alternatives considered, "GitHub's side on the top-bar button", at commit `77060c0`.
- [2] `notes/grill-git-workflow-01.md`, Q13 and Q17.
- [3] `web/src/ui/Git.tsx` (the action row, `ChangesView`, `CommitView`), `web/src/ui/Project.tsx` (the chip and the GitHub check), `web/src/ui/Diff.tsx`, and `web/src/ui/styles.css`, at commit `77060c0`.
