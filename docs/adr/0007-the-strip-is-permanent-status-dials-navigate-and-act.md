---
status: accepted
---

# The strip is permanent status; the dials navigate and act

Each channel's two touch-strip regions (400px) permanently show that workstream's branch, ticket count, pull-request state, and outstanding attention. Nothing is hidden behind a rotate, so a glance answers "what is the state of this workstream" with no input at all. The dials are therefore free to be controls rather than selectors: dial 1 rotates through the workstream's panes and attention items and pushes to focus, then scrubs scrollback once a pane is focused (`PaneInfo.scroll`); dial 2 rotates a short verb list and pushes to commit the chosen verb.

**Amended by ADR-0011.** The frequent verbs — focus workstream, Git and pull request, actions — moved to three fixed control keys on each channel's bottom row, which is better for muscle memory than a rotate-to-discover menu. Dial 2 keeps only the rarer worktree lifecycle verbs such as create and remove, where rotate-to-discover costs little because the action is deliberate anyway.

Because ADR-0002 gives all six dials to the three channels, no dial is global. The fork's current global dials (page, attention queue, recent threads, settings) have no home on the Stream Deck + XL; per ADR-0011 the XL has no global rail either, so those surfaces exist only on a Mini.

**A workstream cannot be paused.** Herdr has no suspend; the nearest thing is sending `ctrl+c`, which is a stop. Focus and resume are real, pause is not, and it must not appear on a control.

## Considered Options

- **Strip as a facet selector**, dial 1 rotating through branch / tickets / pull request / diff stat. Rejected: richer per facet, but nothing is permanently visible, defeating the point of the surface.
- **Both dials as fixed actions**, navigation on keys only. Rejected: strongest muscle memory, but limits a workstream to two actions and wastes a dial's rotation.
- **Mixer metaphor** — scrollback scrub plus a continuous autonomy level. Partially adopted: the scrollback scrub is folded into dial 1. The autonomy dial is rejected because neither Herdr nor Claude implements anything it could drive.

## Consequences

- Dial 2's verb list is a rotate-to-discover menu, which is weaker for muscle memory than a fixed key. ADR-0011 reduces the exposure by moving the frequent verbs to fixed keys; keep what remains short and its order stable.
- The 400px budget caps the permanent summary at roughly two lines; anything more must be dropped rather than shrunk, per the 18px type floor.
- The rightmost strip region also carries the overflow count on an XL-only rig, per ADR-0011.
