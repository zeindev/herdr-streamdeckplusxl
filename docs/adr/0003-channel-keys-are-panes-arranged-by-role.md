---
status: accepted
---

# Channel keys are panes, arranged by role

Every key in a workstream channel's **top three rows** is a pane, and the row a pane occupies is determined by its **role**. On the Stream Deck + XL's 9×4 grid each channel is 3 columns wide, giving three role rows of three slots each — nine pane slots, enough for the one or two agents and four or five services a workstream runs. The rows are **agent**, **server**, and a combined **tests / logs / shell** row. Roles are aligned across all three channels, so reading down a channel shows one workstream and reading across a row compares the same role across all three.

The channel's fourth row is three fixed control keys — focus workstream, Git and pull request, actions — per ADR-0011. Workstream identity, tickets, and pull-request state live on the two strip regions each channel owns.

A pane's role is auto-suggested from `pane.process_info`, which returns each foreground process with `name`, `argv`, `cmdline`, and `cwd` — enough to recognise `claude`, `vitest --watch`, or `pnpm dev` without guessing from terminal text. The suggestion is stored as a pane token and can be overridden. Because tokens do not survive the pane, the durable role assignment is keyed on the process command line, which is stable for services across restarts.

## Considered Options

- **Split channel** — left column panes, right column workstream controls. Rejected: it keeps everything about a workstream on keys, but leaves only 5 pane slots for up to 7 panes and weakens role alignment across channels.
- **Herdr's own pane order.** Rejected: zero configuration, but positions shift whenever a pane is added, closed, or moved, destroying muscle memory and making horizontal comparison meaningless.
- **Manual pinning per slot**, as the current fork does with pin pages. Rejected: 30 slots is too many to place by hand, every new worktree starts empty, and it inherits the fork's fuzzy pane-rebinding problem at triple scale.

## Consequences

- Role detection must be good enough that a new worktree is usefully populated with no configuration.
- Rows are a fixed role vocabulary; adding a role changes the layout for every workstream at once.
- Three role rows means tests, logs, and shell share one row, so their relative order within that row is a convention that must be fixed rather than incidental.
- A workstream with more than three panes of one role needs an overflow rule.

## Staged deviation, in force while ticket `-3rd` is the newest work

The channel's **top row still holds a two-key workstream header** — its label and its aggregate agent state — instead of panes. This contradicts the decision above and is temporary.

The reason is ordering, not disagreement. This ADR puts identity on the strip regions, but the strip belonged to ticket `-2gn`, which had not run when the channels were first made readable in `-3rd`. Something had to carry identity for a channel to be a channel at all, so it went on keys, at a fixed row, marked as staged in the code (`HEADER_ROW` in `src/device/geometry.ts`).

**`-2gn` has since shrunk it.** The branch moved to the strip, where it is permanently visible and has room not to be cut into ambiguity, and its key was dropped — so the header is two keys wide, not three, and each channel already has one more key free than it did. What did **not** move is the label, the repository, and the aggregate state, and the reason is the pixel budget rather than reluctance: the strip's 400px holds two lines, and the branch plus attention plus the reserved ticket and pull-request fields already fill them (ADR-0007).

Two things must therefore happen together before the row can return to panes, and `-4bb` owns both:

1. Somewhere else has to carry a workstream's label and state. The channel's own control row (ADR-0011) is the obvious home.
2. `-77f` anchors the slot-reassignment hold to this row's first key (`heldLongEnough` in `src/device/state.ts`). That gesture needs a new home first. The strip is a good one and needs no timer: the SDK's `touchTap` carries `hold` and `tapPos` directly, confirmed in `node_modules/@elgato/streamdeck/dist/api/events/encoder.d.ts`.

Until then a channel has **two** role rows and one spare key, not three rows.
