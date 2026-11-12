# Feedback: First Hands-On Demo
format: structured-notes
date: 2026-11-11
source: conversation (Ryan Ressmeyer with Claude Code, v1 build session on branch v1)

## Summary
Ryan tried the first demo build, which had the rich editor, comments, tracked changes, builds, and SyncTeX but no Git panel. He was happy with it overall and asked for seven changes before further core work. He confirmed that `changes` markup stays hidden in Rich text, and that single line breaks should flow with a faint mark. His messages are quoted verbatim in their own section.

## Requested changes
- **Slow text in a large manuscript.** In the VisionCore manuscript, lines popped in while scrolling [1].
- **File tree.** A sidebar navigation panel for the repository file tree [1].
- **Hiding a pane.** Either the editor or the PDF can be hidden [1, 2].
- **Hiding markup.** A toggle that hides comments and change markup in the rich view [1, 2].
- **Highlight without a comment.** An action that marks text without attaching a comment [1, 2].
- **Colour scheme.** Light, dark, or the system default [1].
- **Log of the shown build.** The log of the last successful build, whose PDF is on screen [1].

## Decisions
- **Hidden change markup.** `changes` syntax stays hidden in Rich text even with the cursor inside it, because a change can only be resolved, accepted, or rejected, not edited by hand. Source mode shows it [1].
- **Single line breaks.** A single line break inside a paragraph flows as text. A faint down-right arrow marks the join, and deleting the mark removes the break [1].

## Diagnosis of the slow text
Scrolling was profiled on a local copy of the VisionCore manuscript (155 KB, 491 inline formulas, PDF figures). No single step was slow. Three suspects remained to be confirmed in the fix: the 2 s disk check rebuilding the index and replacing every rendered widget, PDF figures re-rasterised each time they scroll into view, and CodeMirror drawing only about one screen beyond the visible area.

## Verbatim
Ryan's feedback on the demo:

> This is awesome. Quite good. One thing I noticed was that the text loading for the VisionCore project was pretty slow such that I could scroll and have the next lines of text pop in. Another thing we don't have currently is a side bar navigation panel for the repository file tree or the ability to hide the pdf to the left or not show comments or add highlights. We also need a way to make it light / dark / system default color scheme. It would also be nice to be able to see the log of the last successful (shown) build. That all being said overall I'm super happy with it. I think the Rich text syntax being hidden makes sense since it can only be resolved instead of edited manually. Single line breaks flowing as a transparent down right arrow to indicate it and be able to remove the extra space seems like a good option for this. Overall I'm quite happy though and once these minor tweaks are in we can progress with more of the core functionality.

Ryan's reply when asked whether "hide the pdf to the left" meant collapsing a pane, and whether "not show comments or add highlights" meant a show/hide toggle plus a highlight-without-comment action:

> Both readings are right, go ahead

## References
- [1] This conversation, 2026-11-11, Ryan's feedback on the demo build.
- [2] This conversation, 2026-11-11, Ryan's confirmation of the two readings.
