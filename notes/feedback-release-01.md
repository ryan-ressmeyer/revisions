# Feedback: First Release and Comments Where a Margin Note Cannot Go
format: structured-notes
date: 2026-11-12
source: conversation (Ryan Ressmeyer with Claude Code, v1 build sessions on branch v1, 2026-11-11 and 2026-11-12)

## Summary
Ryan installed v0.1.0 and used it on a real manuscript. A comment in a journal template's abstract stopped the PDF build, and a later Build PDF reported a failure with no error. Two build fixes followed. He chose the hybrid for comments where LaTeX cannot place a margin note: margin notes in body text, inline notes elsewhere, switched by a block that Revisions writes into the preamble. He also asked how updates will work and asked for a quit button and working stats macros. His messages are quoted verbatim in their own section.

## Reports
- **Build failure after install.** After installing v0.1.0, Ryan pressed Build PDF and got a failure [1]. The `latexmk` log he pasted reported "Nothing to do" and errors from a previous invocation. The real error, `Float(s) lost`, came from a comment inside the abstract of an `elsarticle` manuscript, which sits in a box that cannot hold a margin note.
- **Updates.** He asked how updates will be handled in future [1].
- **Quit and stats macros.** Earlier the same day he asked for a quit button and for the stats macros of a real manuscript to work in the inline view [2].

## Fixes already made
- **Rebuild after a failure.** A build after one that failed, timed out, or was cancelled starts from an empty output folder, so it shows the real error again and succeeds once the source is fixed, with no cache to clear by hand.
- **Plain-language explanation.** When a build fails with `Float(s) lost` or `Not in outer par mode` and the manuscript has comments, Revisions explains that a comment sits where LaTeX cannot place a margin note and names each comment it finds in such a place.

## Decision: the hybrid
Three options were put to Ryan for comments where a margin note cannot go: the hybrid (margin notes in body text, inline notes where a margin note cannot go), inline notes everywhere, or refusing comments in such places. He chose the hybrid [3].

- The switch lives in the manuscript's preamble, so the manuscript also builds outside Revisions. Revisions writes a short block marked `% Added by Revisions` next to `\usepackage{changes}` with the first comment, or once from the build-failure panel for a manuscript that already has comments.
- The block uses LaTeX hooks to set todonotes to inline in box mode (table cells, `\fbox`, captions while measured), in every place that runs `\@arrayparboxrestore` (floats, minipages, `\parbox`, p columns, footnotes), in `abstract`, and in elsarticle's `frontmatter`. Each setting is local, so body text after such a place keeps margin notes. Every place was checked by compiling it with pdflatex, xelatex and lualatex.
- Comments are now allowed in footnotes and captions in Rich text.

## Planned
- **In-app update check.** Planned in answer to Ryan's question about updates; not yet built.

## Verbatim
Ryan's message after installing v0.1.0 and pressing Build PDF, 2026-11-11 (the pasted `latexmk` log is not reproduced):

> I just got this issue when trying to build pdf: Steps 1-5 worked though

> How will we handle updates in the future also?

Ryan's request earlier the same day:

> add a quit button and fix the stats macros.

Ryan's answer on the three options for comments where a margin note cannot go, 2026-11-12:

> Go with the hybrid

## References
- [1] Conversation, 2026-11-11, Ryan's report after installing v0.1.0, with a `latexmk` log.
- [2] Conversation, 2026-11-11, Ryan's request for a quit button and working stats macros.
- [3] Conversation, 2026-11-12, Ryan's choice among the hybrid, inline everywhere, and refusing.
