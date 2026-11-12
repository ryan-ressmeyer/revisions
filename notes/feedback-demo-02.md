# Feedback: Second Hands-On Demo and Publication
format: structured-notes
date: 2026-11-11
source: conversation (Ryan Ressmeyer with Claude Code, v1 build session on branch v1)

## Summary
Ryan tried the second demo build, which added the Git panel and the changes from the first round of feedback. He reported one bug, asked whether the Git panel could go back to earlier commits, and chose where and how to publish the project. His messages are quoted verbatim in their own section.

## Bug
- **Get latest on a branch deleted on GitHub.** After he sent a branch, opened a pull request, closed it, and deleted the branch on GitHub, Get latest failed with a raw Git error [1]. Git still reported the deleted branch as the upstream, and the fetch pruned it before the merge. Revisions now reports that the branch was removed from GitHub and offers Send to put it back.

## Requested change
- **Earlier commits.** The Git panel shows a commit's diff but cannot show the manuscript as it was at that commit [1]. Planned: a "View this version" action that opens the manuscript at a commit as a snapshot, with a way back to the branch and a way to start a branch from that version. A one-click restore onto the current branch is not planned unless asked for.

## Decisions
- **Hosting and licence.** A public repository at `ryan-ressmeyer/revisions` with GitHub Releases, under the MIT licence [1].
- **What is published.** The name of the first collaborator and the names of private repositories were removed from the working files, and the test account became a fictional person. The repository was published as a single fresh commit so that the earlier history, which held those names, stays local [2].

## Verbatim
Ryan's message after trying the second demo:

> a public repository at ryan-ressmeyer/revisions with Github Releases and an MIT license sounds great. I was just playing around with it and have lots that I like. An issue I ran into though is that I tried making a branch, thne a new commit, then pushing the commit and making a pull request. Then I discarded the pull request and removed the branch from github. When I then tried to fetch I got the error:
>
> Git could not finish the job. Nothing else was changed.
> Details from Git
>
> git merge: merge: @{upstream} - not something we can merge
>
> . Seems like an edge case that wasn't expected. Also, there's no way to traverse backward in time to previous commits using the git panel. Would that be possible?

Ryan's reply when asked whether to scrub the names and publish a fresh history, or publish the repository as it was:

> Scrub and polish a fresh history.

## References
- [1] This conversation, 2026-11-11, Ryan's message after the second demo.
- [2] This conversation, 2026-11-11, Ryan's reply on what to publish.
