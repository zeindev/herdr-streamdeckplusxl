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

## Amendment: assignment is automatic and sticky, not manual (ticket `-77f`)

The consequence above says "slot assignment is a manual act". Building it showed that to be the wrong half of the idea. **Assignment** is automatic: a workstream with no channel takes the lowest free one the moment it appears. **Reassignment** is the manual act, and the one that carries friction.

The concern this decision actually rests on is that a workstream must never *move* — that is why auto-fill by recency was rejected, because it lets a channel change meaning while the developer is looking away. Automatic assignment that is sticky does not do that: a channel is filled once and then never reflows, so closing the leftmost workstream leaves a gap rather than sliding the others along. Requiring a manual act on top of that would buy no stability and would leave the device showing three empty channels until it was configured, which makes a fresh install useless rather than cautious.

Three things follow, all verified rather than assumed:

- **A slot remembers a workstream by its checkout path**, because that is what a workstream *is* and it survives everything, including Herdr losing its session file. A workspace with no worktree has no such path and falls back to its workspace id, which Herdr persists verbatim in `session.json` and so survives a restart, though not a session reset. The two are prefixed so the namespaces cannot collide.
- **The assignment lives in the Stream Deck app's global settings**, not a workspace token, as this decision requires — a token dies with its workspace.
- **Reassignment is a hold, not a tap**, on the channel's identity key: holding a filled channel releases it, holding an empty one takes in the workstream that has been waiting longest. Two holds move a workstream to a chosen channel. A hold cannot happen by brushing a key, which is the friction this decision asks for.

A channel bound to a workstream that is not present renders empty and keeps its binding, so a Herdr restart puts everything back. Such a binding yields to a new workstream only once every genuinely free channel is taken, so a workstream that never returns cannot hold a channel hostage.
