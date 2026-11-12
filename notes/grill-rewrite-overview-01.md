# Grill: Revisions Rewrite Overview (Session 01)
format: structured-notes
date: 2026-11-09
source: conversation (Ryan Ressmeyer with Claude Code, grill session for specs/overview.md on branch spec/rewrite-overview)

## Summary
Interview defining the first usable version of Revisions, a clean rewrite of redraft-editor. Revisions is a native-first local app (local server and system browser) for sharing a LaTeX manuscript Git repository with a non-technical collaborator. The app offers an Overleaf-style inline editor, a PDF view with SyncTeX, `changes`-package comments and tracked changes, GitHub sign-in, and a GitKraken-style commit graph. Several early answers were revised mid-interview, as noted under Decisions. Questions are condensed. Answers are verbatim in their own section. The name of a collaborator and of a private repository were withheld when this note was published; those edits are in square brackets.

## Decisions

### Motivation
- Redraft was poorly constrained from the start, so incremental changes accumulated cruft, and the author lost touch with the codebase (Q1). Process constraints for the rewrite are handled by a separate workflow and are out of scope here (Q32).

### Core user journey
- The author shares a GitHub commit, branch, or PR URL with a collaborator. The collaborator opens it in Revisions, which clones the repository (or brings an existing clone to the shared commit) on the collaborator's machine (Q2, Q3).
- The collaborator sees the PDF, the raw LaTeX, and an inline editor in an Overleaf-style split linked by SyncTeX in both directions (Q2, Q37).
- The collaborator edits and comments, then commits, pushes, branches, or opens a PR (Q2, Q11).
- A kamaji-hosted share page that turns the URL into a one-click button is deferred. For v1, a pasted GitHub URL is the entry point (Q26).
- First real collaborator: [name withheld], who is capable but not technical, uses a Mac, and needs a seamless experience (Q33, Q34).
- Reference/test repository: OpenIrisDPI. Real working repository: [a private manuscript repository] (Q35).

### Architecture (revised during the interview)
- Q5 first chose web-first with server-side TeX. After the WASM research, Q18 reversed this to **native-first**: TeX compiles on the user's machine, and no hosted compile server exists.
- Delivery is a local server plus the system browser. The UI is written as a web app so a desktop shell can wrap it later. Signed desktop installers are deferred (Q20, Q24).
- Q4 ("nothing installed") now means: assume nothing is installed beforehand. Install is self-service through copy-paste commands or web instructions, without the author's involvement. No-terminal is preferred, and a terminal is acceptable when unavoidable (Q34).
- Platforms: macOS, Linux, and Windows, with install instructions for Windows from the start (Q34, Q35, Q36).
- TeX: detect `latexmk` on `PATH`, and otherwise guide the user to install MacTeX, MiKTeX, or TeX Live (Q21).
- Entry file: auto-detect `.tex` files containing `\documentclass`, use the first one detected, and let the user select another. A `.revisions.toml` file in the repository overrides detection (Q36). Assumed: "first" means first by path in alphabetical order.

### Editor
- The inline view is fully editable. Unknown LaTeX appears as raw source inline. Protected chips were a poor design and are dropped. The PDF view is read-only (Q9).
- The inline view renders sections, emphasis, lists, citations and cross-references (Overleaf-style, showing whether each resolves), inline math, display equations, figures, tables, and `changes` markup. Moving the cursor into a rendered construct reveals its source (Q10).

### Comments and tracked changes
- Adopt the LaTeX `changes` package (Q7).
- Comments are `\highlight[id=…, comment={…}]{text}` macros in the source. Each is a single comment with no threads. A Resolve button removes the macro and keeps the highlighted text (Q6, Q30).
- The author ID is set once in Revisions settings, with a default suggested from GitHub. Revisions adds `\definechangesauthor` to the preamble if it is missing (Q31).
- Tracked changes are toggled per session and are off by default, so edits are plain. When the toggle is on, edits become `\added`/`\deleted`/`\replaced` (Q8).
- Each tracked change has Accept and Reject buttons, and the editor also offers Accept all and Reject all (Q38).

### Git and GitHub
- Collaborators sign in with their own GitHub account (OAuth), and the host's permissions decide what they can do. GitHub is the only host in v1, behind a narrow seam that leaves room for others such as Forgejo later (Q12).
- All ways to collaborate are exposed, within the collaborator's permissions. The v1 operations are: view changes and diffs, commit, pull, push, create or switch a branch, open a PR, force-push, and discard changes (Q11, Q28).
- The UI is a GitKraken-style commit graph (Q28).
- Force-push lists the remote commits it will erase and uses `--force-with-lease`. Discard shows the diff it will throw away. Each requires one explicit confirmation (Q29).
- Opening a different commit while uncommitted work exists is refused, with an explanation (Q27).

### Safety lessons retained from Redraft (Q13–Q23)
- **Byte preservation.** Write minimal patches only and never reformat. The goal is small diffs by default (Q14).
- **Minimal hash check.** Each save carries the hash of the file version it was based on, and a mismatch is rejected (Q15).
- **No session lock.** Autosave often, and auto-reload from disk when no local edits are pending. On a collision, show an error with a Reload button (Q16).
- **Explicit PDF builds.** Builds use a button or shortcut and show an out-of-date warning. A failed build keeps the last good PDF (Q16).
- **Build isolation.** With native-first, isolation reduces to an output directory outside the repository, shell escape off, a timeout, and a log cap (Q17–Q18).
- **Minimal drafts.** Warn before closing a tab with unsaved changes. On a collision, show the rejected text for copying before reload. Redraft's storage-backed draft machinery is dropped (Q22).
- **Path containment and loopback hardening.** Paths must stay inside the repository root and symlinks are refused. The server checks the `Host` header and `Origin`, and requires a per-process token. This protects the user's GitHub token (Q23).

### Non-goals and deferrals (Q24, Q25)
- **Non-goals:** real-time co-editing; hosted compilation or any operated server beyond a static share page; bundling or managing a TeX distribution; auto-compile; formats other than LaTeX; a merge-conflict UI beyond Git (conflicts are resolved in the raw editor); a reference-management UI (`.bib` is edited as raw source and citations are only validated); offline features beyond the local server.
- **Deferred:** desktop installers; in-browser WASM compilation; Git hosts other than GitHub; the kamaji share page.

### Research finding (Q18, requested by the user)
- The engines reviewed were BusyTeX, texlyre-busytex, Siglum, and SwiftLaTeX. None showed end-to-end compilation of a real journal manuscript. The research found experimental status, small communities, 120–430 MB downloads, uncertain Biber support, no EPS/SVG conversion, and an AGPL license on the most complete wrapper [2–5]. The user judged browser compilation too immature for v1.

## Open questions
- [NEEDS CLARIFICATION: Implementation language and stack. Redraft was TypeScript/Node.]
- [NEEDS CLARIFICATION: GitHub sign-in mechanism for a local app, such as device flow or a GitHub App, given that a local app cannot keep a client secret.]
- [NEEDS CLARIFICATION: How a kamaji-hosted share page would be reachable by collaborators outside the tailnet (deferred).]
- [NEEDS CLARIFICATION: Biber vs BibTeX expectations, and which figure formats must build (EPS/SVG?).]
- [NEEDS CLARIFICATION: Autosave and auto-reload intervals.]
- [NEEDS CLARIFICATION: Confirm that "first" detected entry file means first by path in alphabetical order.]
- [NEEDS CLARIFICATION: Confirm that Resolve means removing the macro, rather than keeping a resolved state in the source.]

## Interview (verbatim answers)
Questions are condensed from the session. Answers are reproduced verbatim.

**Q1. Why a rewrite instead of continuing Redraft?**
> The codebase was poorly constrained from the beginning so there was a lot of incremental modifications that introduced cruft over time. TLDR too much slop. I also fell out of touch with the codebase so I didn't know how to plan effective changes.

**Q2. Walk through a typical session in the first usable version.**
> Ideally it's being able to send a draft to a collaborator as a link to a webpage (probably self hosted for the first draft). The collaborator should be able to open the link, clone a repository (if it's the first time, or be brought up to the specific commit that was shared) with latex code inside, and then seemlessly render the pdf, raw latex, and an inline editor like overleaf's that adds word processing features and the ability to add comments. Then the collaborator should be able to commit, push (or set up a pull request) and then edit in the browser

**Q3. Where does the collaborator's clone live: server, collaborator's machine, or both? Is the order open → edit → commit/push?**
> On the collaborator's machine. I suppose this could also just be a local application with link-based interfaces.

**Q4. What can be assumed installed on a collaborator's machine?**
> Yes, that's right. We cannot assume that the collaborators have anything installed. I'd also like to return to browser vs. local application. Given these constraints would you recommend a local application loosely connected to a webpage or a web-first application?

**Q5. Accept web-first (recommended), with the same app runnable on localhost?**
> Yes, web-first, runnable on localhost too.

**Q6. Where do comments live: LaTeX macros, sidecar file, server DB, or Git host review comments?**
> I'd prefer in the latex source as macros. If there's a way to attach a comment to a highlight thta would be great. Is this natively supported in latex?

**Q7. Adopt an existing package (`changes`) or ship an own macro file?**
> Let's adopt changes. It seems like a great foundation.

**Q8. Browser edits: plain edits, tracked-change markup, or a per-session toggle?**
> C, with plain edits by default.

**Q9. How should the inline editor handle unknown LaTeX: raw inline, protected chip, or fail closed?**
> I'd prefer the raw source, inline and editable. In general the protected chips were a poor design. The user expects to be able to edit anything in the inline view, and nothing in the pdf view.

**Q10. Which constructs must render in v1, and is cursor-entry-reveals-source the expected interaction?**
> 1, 2, 3, 4 (more like overleaf where it's clear if the citation is valid or not), 5 (similar to 4). 6, 7, 8, 9, 10. That is the interaction I expect.

**Q11. Where may a collaborator's commit go: always a branch, the shared branch, or per-link config? Force-push?**
> I think the collaborator should have the ability to choose within their available options given their credentials. Ideally it would expose all ways they could collaborate (force pushing is allowed if they have write access, branching can be done if they'd like, etc.). We'll want a nice way to visualize the commiting / pushing / pull-request process that can be inspired by some other git-based service.

**Q12. Where do credentials come from: own Git host account, link-granted permissions, or both? Which hosts?**
> Just A. Github is the only host we need to start, although having options for both will be nice in the future. It should be built in a way that it is easily extensible to add more hosts in the future.

**Q13. Which Redraft safety mechanisms carry over?**
> It's unclear the issue that each of these solves. I'd like to go through and identify which are required by having you state explicity what the issue they are trying to resolve is so that I can weigh it against the complexity cost it incurs..

**Q14. #1 Byte preservation: keep, drop, or keep with a mixed-newline simplification?**
> Yes, let's keep it. I think the point that you make that silent reformatting could occur is important since we don't want large diffs by default.

**Q15. #2 Keep the minimal hash check? Single-session lock or multiple tabs?**
> Great. Yes, the minimal hash check is a good idea.

**Q16. #3 Explicit builds or auto-compile? Keep the last good PDF?**
> I'd rather not have a single session lock. Maybe we could reduce the collision surface by writing often and automatically as well as automatically reloading often unless there is a collision. On an explicit collision then the error shows up and gives a reload button. The idea is (like a code editor) you are always viewing the up to date version of the source. As for explicit pdf builds, I like the explicit redraft builds and shortcuts with an out of date warning. I don't see the value of auto-compile so much, and keeping the last good PDF is also a good idea (similar to overleaf). I actually don't know if overleaf has the autocompile.

**Q17. #4 Build isolation: who can use a hosted instance (allowlisted users or anyone with a link)?**
> The way I had it in mind I thought that the user's machine would always compile the source. That way it becomes decentralized and not dependent on an internet connection to see builds.

**Q18. Build architecture: in-browser WASM, WASM with a native fallback, or server compile? Is offline a v1 requirement?**
> Ah, this is tricky. If we can build in the browser that would be amazing since we could standardize the build while having it still be local. You should check maturity. I don't want to be hosting a latex compiling server myself though. I would rather have the option to help the user install a functional native latex compiler.

**Q19. Given the WASM maturity findings: (A) browser by default gated on a spike, (B) native-first, or (C) browser with the engine unresolved?**
> Looking at the options I think this is too immature. I'd rather stick with B and do native-first.

**Q20. Local app form: desktop app, local server + system browser, or the server first with a desktop shell later? Bundle TeX or detect and guide?**
> I'd go with C. I don't want the hassle and cost of shipping apps to apple and windows.

**Q21. TeX provisioning: detect and guide, managed TinyTeX, or both?**
> Detect and guide is the way to go.

**Q22. #5 Durable drafts: minimal version? Rejected text shown for copying or saved to a recovery file?**
> Yes, minimal version, show rejected text for copying.

**Q23. #6 Keep path containment and loopback hardening?**
> Yes, keep both.

**Q24. Mark non-goals among 11 candidates.**
> 1, 2, 6, 7, 8 are all good. We may want to add installers in the future, but for now we prototype local.

**Q25. Confirm proposed defaults for items 3, 5, 9, 10, and 11.**
> Yes, those defaults are all fine.

**Q26. What is the share link: static share page, pasted GitHub URL, or both? Uncommitted work when opening a new commit?**
> I was thinking I could host a super light webpage on kamaji. This can be defered for now.

**Q27. Existing clone with uncommitted work opens a different commit: refuse, auto-stash, or auto-commit to WIP?**
> A, refuse and explain.

**Q28. Which Git UI inspiration (GitHub Desktop, VS Code, commit graph, other)? Which operations in v1?**
> A commit-graph view would be nice. I like GitKraken. This candidates are good.

**Q29. Guardrails for force-push and discard: confirm with consequences, plus a backup ref, or a plain confirm?**
> Confirm with conseqeucnes is the way to go.

**Q30. Comment replies and resolution: single comments with resolve = delete, adjacent reply macros, or threads deferred?**
> A is best. I'd like to have the inline editor have better resolve semantics than deleting. Ideally it would let you press a resolve button to remove a comment easily.

**Q31. Where does the `changes` author ID come from?**
> B, set once in revision settings.

**Q32. Which process constraints should the spec make binding?**
> This is out of scope for this session. I'm testing a separate workflow above this that is going to help me keep in touch with the codebase, ideally.

**Q33. Acceptance test draft. Which reference manuscript and first collaborator?**
> [Name withheld]. They are capable, but not technical. It must be seemless for him.

**Q34. How seamless must install be: one terminal command, double-click, or author-assisted setup?**
> Copy paste terminal commands or instructions to follow using websites, etc. Ideally I wouldn't get involved, but he can do anything on his computer with a preference for whatever is easy (no terminal usage ideally, but if it's necessary then there's nothing we can do about it). His PC is a mac, so we should have crossplatform support

**Q35. Which reference manuscript? Is Windows needed in v1?**
> OpenIrisDPI is a reasonable test repo. [A private manuscript repository] is the repository I am actually working on currently.

**Q36. Entry file: auto-detect, config file, or both?**
> We do want windows instruction to start. C is the way to go. Ideally there's only a single valid entry point in the project, but if there isn't then the first one gets detected and the others can be selected.

**Q37. View layout: Overleaf-style split with SyncTeX, split without SyncTeX, or separate screens?**
> A, Overleaf-style split with SyncTeX

**Q38. Accept/Reject buttons for tracked changes, plus Accept all/Reject all?**
> Yes, accept/reject buttons, plus accept all and reject all.

**Q39. Anything else, or done?**
> No, we are done. Good job.

## References
- [1] ~/repos/redraft-editor/README.md — Redraft's editing, source preservation, safety boundary, and trust profile, read as read-only reference.
- [2] https://github.com/TeXlyre/texlyre-busytex — WASM BusyTeX API for TeX Live 2026; AGPL-3.0; bibtex8 and claimed WASM Biber.
- [3] https://github.com/busytex/busytex — base BusyTeX project; MIT scripts; Biber listed as unsupported.
- [4] https://github.com/SiglumProject/siglum — BusyTeX fork with lazy package loading; MIT; small community.
- [5] https://github.com/SwiftLaTeX/SwiftLaTeX — older WASM pdfTeX/XeTeX engine; derived builds lack BibTeX/Biber.
