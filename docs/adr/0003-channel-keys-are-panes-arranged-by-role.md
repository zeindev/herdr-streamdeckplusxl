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

## What building it corrected (ticket `-4bb`)

The staged deviation recorded here is over: the header row is gone and all three role rows are panes. The slot-reassignment hold moved to the strip with it, which is a better home than the key it came from — the touch strip reports `hold` and `tapPos` itself, so that gesture needs no timer.

**What the header carried did not all find a new home, and this is a regression to be honest about.** The staged section this replaces named the precondition: "somewhere else has to carry a workstream's label and state". Only part of that was met.

- The **aggregate agent state** is genuinely redundant now and was deleted rather than moved. Every agent in a channel has a key of its own showing its own status, so a summary of them adds nothing a glance does not already give.
- The **branch** identifies a channel, from the strip, which is what this decision always wanted.
- A workstream with **no worktree** has no branch, so the strip shows its **label** instead. Without that it would have had no identity anywhere at all.
- The **repository name** is shown nowhere. That is the real loss: three channels on three checkouts of one monorepo are now told apart only by branch. ADR-0011's control row is its home and `-5o6` owns it; a bead records this so it is not quietly forgotten.

Three claims above were wrong about `pane.process_info`, and each was found by calling it on a running Herdr rather than reading the schema. Two of them would have broken detection on the case that matters most.

1. **`name` is not the program's name.** This decision says process info returns "`name`, `argv`, `cmdline`, and `cwd` — enough to recognise `claude`". The live agent pane reported `{ name: "2.1.233", argv0: "claude", cmdline: "claude" }`: `name` is Claude's *version*, because it rewrites its own process title. Detection matches on `argv0` and `cmdline`, and an override is keyed on the command line — keying on `name` would have tied every correction to a release.
2. **The first foreground process is the wrong one.** The same pane listed an MCP server the agent had spawned *before* the agent itself. `foreground_process_group_id` is what says which entry identifies the pane; taking the first would have called that channel's agent row an ebook indexer.
3. **It is one request per pane**, since the call takes a single `pane_id` and null means the focused pane. So only panes that need it are asked: Herdr detects agents itself and says so on the pushed snapshot, which makes the agent row both free and more reliable than any pattern could be.

A fourth finding is about naming rather than detection. `terminal_title_stripped` is the most descriptive field Herdr offers and is unusable as a key label: an agent rewrites its title as it works, so the key would be renamed and redrawn every few seconds. A pane is named by the developer's own label, then by the agent or program running in it, then by its directory.

## Consequences settled here

- A pane with no agent shows **no** state. Herdr reports `unknown` for every one of them, so drawing that would mark every service in every channel with an outline that says nothing.
- More panes of one role than its row has keys is answered by a count on the row's last key, which covers the pane it displaced as well as the extras. Nothing is ever silently absent.
- Correcting a role is a hold on the pane's key, matching the hold that reassigns a channel: a tap acts on what a control shows, a hold changes what it means.
