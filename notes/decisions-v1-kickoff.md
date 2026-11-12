# Decisions: V1 Implementation Kickoff
format: structured-notes
date: 2026-11-10
source: conversation (Ryan Ressmeyer with Claude Code, v1 kickoff session on branch v1)

## Summary
Ryan approved building version 1 of Revisions from `specs/overview.md`. He chose a Go server with a TypeScript web UI and asked that the build timeout be a user setting. He delegated the remaining open spec questions to the agent, subject to veto; those defaults are listed under Delegated decisions. Three items still need Ryan later: a GitHub OAuth App registration, release hosting, and a licence. The user's statements are quoted verbatim in their own section.

## User decisions
- **Stack:** Go server plus TypeScript web UI [1].
- **Build timeout:** configurable in settings, because a slow machine with a large manuscript can exceed any fixed limit [1].
- **Standing permissions:** create branch `v1` and commit per milestone with single-line messages; install project-local dependencies; look up library and API documentation. Nothing is pushed or published without asking [1].
- **Involvement:** Ryan is consulted only when his input guides development. Planned check-ins are a hands-on demo after the inline editor works, the OAuth App registration, the release-hosting and licence decision, and the final collaborator trial [1].

## Delegated decisions
Each was proposed in the kickoff plan and accepted with "Otherwise looks great" [1].

- **Git:** detect the system Git and guide installation, as for TeX. A Git library cannot perform the merges that pull requires.
- **Sign-in:** GitHub OAuth App with the device flow and the `repo` scope. The token is stored in the operating-system keychain, with a mode-0600 file as fallback. `REVISIONS_GITHUB_TOKEN` overrides sign-in for tests.
- **Citation and reference validity:** parse `.bib` files and `\label` commands directly, so status is available before the first build.
- **Mixed line endings:** bytes outside the edited range are preserved exactly. Line breaks inside the edited range take the file's majority line ending. Files that are not valid UTF-8 open read-only.
- **Autosave and reload:** save 1 s after the last keystroke and before any build or Git operation. Check the disk every 2 s and on window focus.
- **Build limits:** default timeout of 300 s with a Cancel button; retained log capped at 1 MiB; `latexmk -norc`; pdfLaTeX by default.
- **Bibliography and figures:** `latexmk` decides between Biber and BibTeX. Figures must be in a format the engine reads natively. EPS and SVG conversion need shell escape and are unsupported.
- **TeX discovery:** search `PATH` and then the standard install directories of MacTeX, TeX Live, and MiKTeX, because a server started before the TeX install does not see the updated `PATH`.
- **Spec additions:** an optional `engine` key in `.revisions.toml`, and adding `\usepackage{changes}` to the preamble when it is missing.
- **Resolve:** removes the comment macro, as Q30 of the interview implies [2].

## Evidence gathered before the plan
- A scratch copy of the OpenIrisDPI manuscript built with `latexmk -norc -pdf -synctex=1`, shell escape off, and `-outdir` outside the tree. The cold build took 43 s and wrote nothing into the source tree. The `synctex` command-line tool resolved both directions against that output.
- Both manuscripts use biblatex with Biber.
- The private working manuscript keeps its entry file at `manuscript/main.tex` and reads figures from the gitignored `outputs/figures/`. A collaborator cannot build it until the figures are committed.

## Pending for Ryan
- Register a GitHub OAuth App with the device flow enabled and supply its client ID.
- Decide where releases are hosted and which licence applies.
- Commit the figures of the private working manuscript, or change where the manuscript reads them.

## Verbatim
Ryan's kickoff request:

> I've been working on a spec for the revisions project in @specs/overview.md . I want to try and develop a version one of the product. You should be brilliant in developing a fully functional app for the purposes described. Make heavy use of subagents for coding and orchestrate necessary a full product development cycle, getting information and feedback from me (a real human) as it becomes necessary. I only want to be brought in when my input is actually valuable for guiding development. I want this project to stand the test of time, so it should be engineered in a forward looking way that allows it to be maintainable and professional.

Ryan's reply to the plan:

> The build timout should be configurable in settings. I could imagine a slow computer and a big manuscript could take longer in rare cases. Go + TypeScript sound good. Otherwise looks great. Make it so.

## References
- [1] This conversation, 2026-11-10. The plan Ryan approved is summarized under User decisions and Delegated decisions.
- [2] `notes/grill-rewrite-overview-01.md`. Interview that defined the first usable version.
