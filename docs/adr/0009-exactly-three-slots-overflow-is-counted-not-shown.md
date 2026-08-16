---
status: accepted
---

# Exactly three slots; overflow is counted, not shown

There are always exactly three channels. A workspace is assigned to a slot and keeps that slot for the life of the workstream, which is what makes a channel's meaning stable — the premise ADR-0002 and ADR-0008 both rest on. Worktree workspaces that are not assigned do not get a channel; they raise a visible overflow count — on the Mini when one is attached, otherwise on the rightmost strip region, since ADR-0011 leaves the XL without a global rail. An empty slot renders as "create worktree here" and calls `worktree.create`. A workspace with no worktree at all — the primary checkout — may occupy a slot like any other.

This makes the three-worktree limit enforced by the instrument rather than by willpower: a fourth stream shows up as pressure on the rail, which is the honest representation of being over budget.

## Considered Options

- **Auto-fill by recency.** Rejected: zero configuration, but a workstream can silently change columns while the user is looking away, breaking the spatial memory the layout depends on.
- **Adaptive reflow** sized to the number of workstreams. Rejected: uses the whole device at any count, but every key moves whenever a workstream starts or ends.
- **Overflow paging.** Rejected: no workstream is second-class, but it reintroduces the mode switch this design removed and adds "which page am I on".

## Consequences

- Slot assignment is a manual act and needs a low-friction path — from the device, from Herdr's context menu, and implicitly when a worktree is created from an empty slot.
- A forgotten fourth workstream is deliberately second-class. The overflow count is the only pressure to clean it up, so it must be visible rather than subtle. On an XL-only rig the rightmost strip region is a weaker home for it than a dedicated key would be; validate on hardware.
- Slot assignment must survive Herdr and Stream Deck restarts, so it is durable plugin state rather than a workspace token (which dies with the workspace).
- Reassigning a slot is disruptive by design and should carry friction.
