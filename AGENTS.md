# Revisions

Revisions is a rewrite of `~/repos/redraft-editor/`. Version 1 is being implemented on branch `v1`. Read `specs/overview.md` for what the product does and `specs/architecture.md` for how the code is arranged before changing anything.

## Scope

- Keep specifications in `specs/` and supporting knowledge, decisions, and interview transcripts in `notes/`.
- Treat the old repository as read-only reference. Its design and implementation are evidence of earlier choices, not requirements for this rewrite. Do not copy its code.
- The spec leads. A behaviour change updates the spec in the same commit. Record unresolved decisions as `[NEEDS CLARIFICATION: <question>]`. Do not invent requirements to fill gaps.
- Looking up library and API documentation is approved. Other external research requires user approval: name the decision it would inform, the scope, and the expected value, then wait.
- Commit on `v1` with single-line messages and no trailers. Never push or publish without asking the user. Branches named `local/*` hold history from before publication and are never pushed.
- Ask interview questions one at a time. Save questions and verbatim answers when the user says the interview is done; confirm the note was saved before asking them to exit.

## Implementation rules

- Server code is Go with the standard library only, plus `go-keyring`. UI code is strict TypeScript. See the Stack section of `specs/architecture.md` before adding any dependency.
- The server owns bytes, processes, Git, and GitHub. `web/src/core` owns every LaTeX rule and imports nothing from the DOM, React, or CodeMirror. `web/src/ui` holds no LaTeX rules.
- The HTTP contract in `specs/architecture.md` is binding. Change the contract and the code in the same commit.
- Write the failing test first. Test behaviour through public interfaces with real Git repositories and real files; avoid mocks.
- Every Scenario in `specs/overview.md` has an automated test listed in `docs/scenario-tests.md`.
- Prefer the smallest change that works: standard library first, no speculative abstraction, no configuration for values that never change. Mark a deliberate shortcut with a `ponytail:` comment naming its ceiling and upgrade path.
- Never simplify away path containment, request hardening, stale-write rejection, or byte preservation.

## Commands

- `make build` produces `bin/revisions` with the web UI embedded.
- `make test` runs Go and Vitest unit tests.
- `make e2e` runs Playwright against the built binary.
- `make lint` runs `gofmt`, `go vet`, `tsc`, and Biome.

## File conventions

- `specs/overview.md` is the root spec. Split a topic into `specs/<topic>.md` only when it outgrows the overview, leaving a one-line pointer.
- Specs have an H1 title, `## Summary` first (3–6 lines), and `## Sources` last. Use H2 for sections; use H3/H4 for requirements and scenarios.
- System specs use Motivation, Guide-level explanation, Reference-level explanation, Requirements, Alternatives considered, Prior art, and Unresolved questions between Summary and Sources. Requirements use `### Requirement: <name>`, SHALL/MAY, and at least one `#### Scenario: <name>` with WHEN/THEN lines.
- Notes follow the `structured-notes` skill: H1 title, `format: structured-notes`, creation `date`, optional `source`, `## Summary` first, and `## References` last. Keep verbatim interview material in its own section.

## Workflow feedback

Project decisions belong here. Feedback about the workflow belongs in `~/repos/workflows/notes/revisions-workflow-trial.md` and is handled through the coaching chat, separately from the spec draft.
