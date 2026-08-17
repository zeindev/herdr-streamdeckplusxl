---
status: accepted
---

# Each channel owns a control row; the XL has no global rail

The Stream Deck + XL's grid is **9 columns × 4 rows**, not the 6 × 4 arrangement earlier ADRs assumed. Each channel is therefore three columns wide and four rows tall. The top three rows are panes (ADR-0003); the **fourth row is three fixed control keys belonging to that workstream** — focus workstream, Git and pull request, actions.

There is no shared global rail on the XL. Two findings make one unnecessary:

1. ADR-0007 already puts every workstream's attention count permanently on its own strip regions. With all three counts always visible, a global inbox key would restate what the strip already shows.
2. A shared rail row would cost nine keys and cut each channel from three role rows to two, which is too few for one or two agents plus four or five services.

Three fixed keys per channel also repair the weakest part of ADR-0007: dial 2's verb list was a rotate-to-discover menu, which is poor for muscle memory. The frequent verbs move to fixed keys with stable positions. Dial 2 keeps only the rarer worktree lifecycle verbs, where rotate-to-discover costs little because the action is deliberate anyway.

## Considered Options

- **A shared global rail row** of nine keys, moving to the Mini when one is attached. Rejected: costs a role row, and duplicates attention information the strip already carries permanently.
- **All four rows as panes**, twelve slots and four clean role rows. Rejected: more pane capacity than a workstream needs, and it leaves every control on the two dials.
- **A global attention row** of the nine highest-ranked items across all workstreams. Rejected: a real spatial answer to "where is my attention most valuable", but those nine keys change meaning constantly.

## Consequences

- **The XL's layout no longer depends on the rig.** Attaching or detaching a Mini does not reflow the XL, which removes a whole class of runtime layout complexity from ADR-0008 and makes the geometry easier to trust.
- Truly global surfaces — the cross-workstream attention queue, worktree creation, settings, recent — exist only on the Mini. On an XL-only rig they are reachable through per-channel controls instead.
- The overflow count from ADR-0009 loses its rail. On an XL-only rig it renders on the rightmost strip region; when a Mini is attached it moves to the Mini. This placement is provisional and should be validated on hardware.
- Nine keys per channel for panes, against a typical six or seven, leaves useful headroom without waste.
- A channel owns two **encoders**, each being a dial and its strip region as one addressable control, so the device has 36 keys and 6 encoders — 42 controls, not 48. See the correction in ADR-0007.
