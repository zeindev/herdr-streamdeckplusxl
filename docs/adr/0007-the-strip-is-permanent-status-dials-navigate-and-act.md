---
status: accepted
---

# The strip is permanent status; the dials navigate and act

**Correction, found while building the adapter (ticket `-2kw`):** an encoder and the touch-strip region above it are **one control**, not two. The Stream Deck SDK addresses them through a single action, whose `setImage` draws the dial face and whose `setFeedback` draws the strip region. The XL's 1200px strip is six 200px regions, one per encoder. So a channel owns **two encoders**, each with its own region — not "two dials and two strip regions" as if there were four things. The wording below is kept for the record; read every pairing as one control.

Each channel's two touch-strip regions (400px) permanently show that workstream's branch, ticket count, pull-request state, and outstanding attention. Nothing is hidden behind a rotate, so a glance answers "what is the state of this workstream" with no input at all. The dials are therefore free to be controls rather than selectors: dial 1 rotates through the workstream's panes and attention items and pushes to focus, then scrubs scrollback once a pane is focused (`PaneInfo.scroll`); dial 2 rotates a short verb list and pushes to commit the chosen verb.

**Amended by ADR-0011.** The frequent verbs — focus workstream, Git and pull request, actions — moved to three fixed control keys on each channel's bottom row, which is better for muscle memory than a rotate-to-discover menu. Dial 2 keeps only the rarer worktree lifecycle verbs such as create and remove, where rotate-to-discover costs little because the action is deliberate anyway.

Because ADR-0002 gives all six dials to the three channels, no dial is global. The fork's current global dials (page, attention queue, recent threads, settings) have no home on the Stream Deck + XL; per ADR-0011 the XL has no global rail either, so those surfaces exist only on a Mini.

**A workstream cannot be paused.** Herdr has no suspend; the nearest thing is sending `ctrl+c`, which is a stop. Focus and resume are real, pause is not, and it must not appear on a control.

## What was built, and what the 400px actually holds (ticket `-2gn`)

The permanent summary exists. Each channel's block leads with its **branch** on one line and its **readings** on the next — attention, then reserved space for the ticket count and the pull request, then the number of agents. Ticket and pull-request state render an explicit `?` rather than nothing, because a blank field reads as a field that does not exist and the point of reserving the space is that the developer learns where to look before there is anything to see. `-wl7` fills them in once `-5ot` publishes the tokens.

Three findings worth keeping:

- **The two regions are one composition, and had to be built as one.** The renderer draws the whole 400px block and each region is a window onto it, which is what lets a branch run past the seam instead of being cut in half at it. Both regions therefore carry the same described block.
- **The budget is real and forced choices.** About 359px of usable width means roughly 23 cells on the branch line at 28px and 32 on the field line at 20px. Content is dropped rather than shrunk, so the field furthest right gives way first; attention and the reserved enrichment never do. A branch that will not fit loses its **start**, not its end — cutting the end would make `feature/auth/rewrite` and `feature/auth/revert` read identically, which is the ambiguity the decision above exists to prevent.
- **The strip also had to answer for Herdr being gone.** When the connection is not live, every branch and count would be whatever was last true rather than what is true, so the strip goes dark and says so instead of showing a confident lie. That reading had no other home once the connection placeholder was replaced.

## Considered Options

- **Strip as a facet selector**, dial 1 rotating through branch / tickets / pull request / diff stat. Rejected: richer per facet, but nothing is permanently visible, defeating the point of the surface.
- **Both dials as fixed actions**, navigation on keys only. Rejected: strongest muscle memory, but limits a workstream to two actions and wastes a dial's rotation.
- **Mixer metaphor** — scrollback scrub plus a continuous autonomy level. Partially adopted: the scrollback scrub is folded into dial 1. The autonomy dial is rejected because neither Herdr nor Claude implements anything it could drive.

## Consequences

- Dial 2's verb list is a rotate-to-discover menu, which is weaker for muscle memory than a fixed key. ADR-0011 reduces the exposure by moving the frequent verbs to fixed keys; keep what remains short and its order stable.
- The 400px budget caps the permanent summary at roughly two lines; anything more must be dropped rather than shrunk, per the 18px type floor.
- The rightmost strip region also carries the overflow count on an XL-only rig, per ADR-0011.
