# Grill: Changed Words in a Diff (Session 01)
format: structured-notes
date: 2026-11-27
source: conversation (Ryan Ressmeyer with Claude Code, word-level diff follow-up, 2026-11-27)

## Summary
Follow-up to Q5 of the commit review interview [1], where word-level highlighting inside a changed line was deferred to its own change. The user chose to keep a changed paragraph as a removed line and an added line, with the changed words marked on each, over a single tracked-changes line, because telling prose from code is hard. The agent proposed the remaining details as defaults and the user approved them. The question and answers are verbatim in their own section.

## Background
- `DiffView` in `web/src/ui/Diff.tsx` draws every diff: the panel, the review window, an earlier commit's window, and the Discard confirmation [2].
- Git's diff is line by line. A manuscript with one paragraph per line shows a one-word edit as the whole paragraph removed and added again [1].
- Nothing in the code or its dependencies compares words [2].

## Decisions
- A changed paragraph stays two lines, removed and added, with the words that went marked on the first and the words that replaced them on the second (Q1).
- Defaults proposed by the agent and approved:
  - A run of removed lines followed by a run of added lines is compared as a whole, so a split, joined, or rewrapped paragraph, or an edited paragraph after a new one, still lines up.
  - Whole words are marked. Punctuation and each LaTeX command are words of their own.
  - A line keeping less than half of its words is not marked, since a new or rewritten paragraph would be marked nearly everywhere.
  - Marked words get a stronger shade of the line's colour, in both themes.
  - Very large blocks of changes get no marks, so a huge diff cannot stall the page.

## Questions and answers (verbatim)

**Q1. How should a changed paragraph look: (a) two lines, as now, with the changed words marked on each, (b) one line, like tracked changes, with removed words struck through in red and added words in green, falling back to two lines when most of the paragraph changed, or (c) something else?**
> I think for simplicity let's do (a). Detemining what lines are written prose and which are code or other things seems difficult.

**Plan approval.**
> Go ahead.

## References
- [1] `notes/grill-commit-review-01.md`, Q5 and Background.
- [2] `web/src/ui/Diff.tsx`, `web/src/core/diff/diff.ts`, and `web/package.json`, at commit `7eb3559`.
