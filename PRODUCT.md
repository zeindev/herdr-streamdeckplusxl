# Herdr Stream Deck

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Stack

- Stream Deck plugin: TypeScript with Elgato's official Node SDK, driving the socket connection directly (no CLI subprocess in the hot path).
- A separate Herdr plugin process, started and supervised by Herdr itself, owns slow external enrichment — ticket keys and pull-request state derived from Git and GitHub — and publishes it back as workspace tokens the Stream Deck plugin reads. The two never talk directly; Herdr's own state is the interface.
- Herdr capabilities: stock Herdr socket API, CLI, and Herdr-plugin hooks only; Herdr core remains out of scope, except where a decision is explicitly recorded as needing a Herdr core change (see Open decisions).
- The official Stream Deck app supports macOS and Windows; Linux runs through the third-party OpenDeck app and is experimental. Which platform to validate and ship first is not decided here (see Open decisions). The Herdr-plugin half (enrichment scripts) is plain Node and platform-independent regardless.

## Users

Technically fluent developers who run several coding-agent workstreams in Herdr at once and work elsewhere on their computer the rest of the time. The primary usage is fast, one-handed triage across every workstream without switching into a second software interface.

## Product Purpose

Herdr Stream Deck is a physical instrument for running several development workstreams in parallel. It keeps every active workstream permanently visible with its own identity and state, shows what is asking for the developer without inference or guessing, brings any pane forward on demand, and lets the developer send a workstream's frequent verbs — and the rarer worktree lifecycle ones — without opening Herdr's own window.

Success means the developer can tell at a glance which of their workstreams needs them, jump to any pane in any of them, and act on the common cases (focus, continue an agent, stop one, create or remove a worktree) from the device — while anything the device cannot express safely stays in Herdr itself, on purpose.

## Positioning

This is not a miniature Herdr UI or a generic macro pad. Its distinct mechanism is three workstreams shown simultaneously as three physical channels, one per workstream, each organizing its panes by role rather than by open order, with attention declared by whoever actually knows (an agent, a hook, a supervised service) rather than inferred from terminal text.

## Operating Context

- The product targets two devices: the **Stream Deck + XL** (36 keys in a 9×4 grid, a continuous 1200×100 touch strip of six 200px regions, and 6 rotary encoders) and the **Stream Deck Mini** (6 keys in a 3×2 grid, no dials, no strip). The **rig** — which of the two, or both, are attached — decides the layout, and can change while the plugin is running. The Stream Deck+ (the four-dial, eight-key device the product previously targeted) is not supported.
- The XL always shows the same three-channel layout, with or without a Mini attached — attaching or detaching one never reflows it. A Mini attached alone mirrors those same three channels at a glance. A Mini attached alongside an XL instead becomes the **global surface**: the cross-workstream attention queue, recently focused panes, the overflow count, and (not yet wired to a verb — see Open decisions) worktree creation and settings. A Mini-only rig reaches those same things through each channel's own controls instead, since it has nowhere else to put them.
- The user normally operates the device one-handed while Herdr runs in the background, foreground, or is closed. Device actions may focus an existing Herdr client but never launch one implicitly.
- Two bundled Stream Deck profiles, one per device, install themselves automatically; there is no manual profile setup.
- Runtime distribution remains undecided. GitHub/manual installation, Herdr distribution, and Elgato Marketplace submission are separate decisions.

## Capabilities and Constraints

### Interaction vocabulary

The full vocabulary — workstream, repository, worktree, ticket, pull request, workspace, pane, agent, service, token, slot, channel, control row, rig, role, global surface, overflow, attention item, acknowledged — is defined once, in `CONTEXT.md`, and this document uses it exactly as defined there rather than redefining it. Two more describe *interaction* rather than structure, and are defined here because CONTEXT.md does not carry them:

- **Browsing / committed:** turning a dial previews without touching Herdr. Pushing it commits — focuses a pane, sends a verb, or arms one that needs a second push to actually happen. Nothing on this device mutates Herdr on a turn alone.
- **Armed:** a destructive verb (interrupting an agent, removing a worktree) needs a push to arm it and a second, confirming push within a few seconds to commit it. An arm reverts on its own if left alone, and any other physical action cancels it early.

### Three workstream channels, always visible

- Each of the XL's three channels is three columns × four rows: the top three rows are that workstream's panes, arranged by role (agent, then server, then a shared row split between tests, logs, and shell) so the same role sits at the same height in every channel; the fourth row is that channel's three fixed control keys.
- A role with more panes than its row has keys shows the row's last key as a count of what did not fit, rather than hiding a pane silently. Every pane a workstream is running can still be reached — and focused — by rotating that channel's first dial, which browses every pane (and any dead service with no pane at all) in the workstream directly rather than through the row.
- A workstream keeps its channel for its whole life once assigned; a Herdr restart returns it to the same one. Reassigning a channel is a deliberate hold-the-strip gesture, never automatic, so spatial memory stays trustworthy.
- A fourth workstream (and beyond) is overflow: counted on the XL's rightmost strip region, or on the Mini once one is attached, never silently dropped and never auto-placed into a channel.
- An unassigned channel invites a worktree rather than showing nothing.

### The permanent strip, and what each dial does

- Each channel's two touch-strip regions permanently show its branch, its attention count, its ticket count, its pull-request state, and its number of running agents — nothing here is hidden behind a turn. A region with reserved but not-yet-known enrichment shows a real placeholder (`?`), never a blank, so the developer learns where to look before there is anything to see.
- **Dial 1** rotates through a channel's panes and any paneless dead-service attention, in a stable order, and pushes to focus the selected pane — never mutating Herdr while only turning. Focusing clears the temporary strip preview, so the next turn starts browsing again.
- **Dial 2** rotates a channel's worktree-lifecycle verbs. An empty channel offers creating a worktree in one of the repositories already visible elsewhere on the device; pushing commits immediately, and the new worktree lands in the very channel that asked for it, not just whichever channel happens to be free. A bound channel with a worktree offers removing it; pushing arms the removal, and a second push within the arm window confirms it. Success and failure both acknowledge on the dial that fired them, naming the cause on failure.
- While either dial is in use, the channel's strip briefly shows what it is doing instead of the permanent readings, and reverts to them once the developer is done or a connection notice needs the space instead.

### The control row

Every channel's fourth row is the same three verbs, in the same order, whether or not a Mini is attached:

1. **Focus** — brings the workstream forward in Herdr.
2. **Git and pull request** — its label is the repository's name; a tap has no verb behind it yet (see Open decisions), and says so honestly rather than pretending to be a shortcut.
3. **Actions** — a tap sends a fixed, deliberately unambitious prompt ("Continue with your best judgment.") to the workstream's own agent pane. A hold arms the same key for its one destructive act, interrupting that agent; a second, confirming tap within the arm window sends it, and the arm reverts on its own if nothing follows.

### Correcting a wrongly detected role

A pane's role is worked out from what is actually running in it — never from terminal output — with a developer's own correction always winning. Correcting one wrong detection is one deliberate act: holding the pane's key, wherever an XL is present, opens a picker showing every role at once in the exact position its own row would occupy, and a single tap on any of them commits the correction. That correction is remembered by the pane's command line, so it survives the pane restarting. A Mini-only rig, with nowhere to show five roles at once, keeps the older one-step-per-hold cycling instead — a real, accepted reduction in capability for that rig, not an oversight.

### Attention, declared

Attention is declared by whoever actually knows, never inferred from terminal text: an agent's own hooks report a question, an approval-request, or that it finished; Herdr's native `blocked`/`done` are the floor beneath that; a supervised service that exits badly declares it on its workstream. Finished work is acknowledged the moment the developer taps the pane's own key to go look at it — the same tap that focuses it — and asks again the next time that same pane finishes, since acknowledgement is of one piece of finished work, not of the pane forever. A service that stays down and unrestarted keeps asking for as long as it stays down; nothing on the device can silence a problem that is still true.

### The paired Mini's global surface

When a Mini is attached alongside an XL, it stops mirroring channels and becomes the one place that belongs to no single workstream: its top row is the cross-workstream attention queue (a push jumps straight to whatever needs the developer most, across every workstream at once) and the two most recently focused panes; its bottom row is the overflow count, moved off the XL's strip while the Mini is there to carry it, plus two positions reserved for worktree creation and settings that have no verb wired to them yet (see Open decisions). Detaching the Mini returns the overflow count to the XL's strip immediately, with nothing to restart.

### Rejected

- **Question Mode**, a coordinated four-dial surface for reading and answering a structured agent question, was specified for the retired Stream Deck+ product and is not built. None of Herdr's socket methods read or submit a structured interaction, so it was unbuildable as specified. What survives in its place is narrower and honest about what Herdr can actually say: an agent's own hooks can declare that it has a question or needs an approval, which raises attention and is reachable by focusing the pane — not a browsable, submittable answer surface.
- **Pausing a workstream** is not offered anywhere on the device. Herdr has no suspend; the nearest real action is sending an interrupt, which is a stop, not a pause, and presenting it as one would misrepresent what actually happens.
- **A continuous autonomy dial** is not built. Neither Herdr nor any agent implements anything such a control could actually drive.
- **Scrollback scrubbing from dial 1** is not built. Herdr 0.8 protocol 19 exposes scroll state but no request that changes it, so the plugin does not send an invented method.

### Open decisions

- Opening a pull request in a browser from the Git/pull-request key. Ticket and pull-request state are already shown on the strip; nothing yet turns a known pull-request URL into an opened browser tab, and the key refuses honestly rather than guessing in the meantime.
- Worktree creation and settings on the paired Mini's global surface are reserved positions with no verb behind them yet. An unassigned channel's own key invites a worktree the same way, and is equally unwired — dial 2 is where worktree creation actually landed, not a tap on the empty key itself.
- The overflow count's placement — the XL's rightmost strip region on an XL-only rig, the Mini once one is attached — is provisional and needs validating on physical hardware.
- Windows and Linux validation, and the long-term distribution and update channel; the current physical-device run is on macOS.
- Further physical-device brightness, hold-duration, and acknowledgement-timing calibration.

## Brand Commitments

- Product name: Herdr Stream Deck.
- Preserve the existing Herdr name and sheep/terminal mark.
- Keep user-facing copy brief, operational, and free of implementation terminology.

## Evidence on Hand

- `herdr_logo.svg`: primary square Herdr mark and OLED baseline source.
- `herdr_logo_wide.png`: wide mark for light surfaces.
- `herdr_logo_wide_dark.png`: wide mark for dark surfaces.
- A working Stream Deck plugin and `npm run preview`'s actual-resolution rendered images cover every channel, the Mini in both its mirror and global-surface roles, dial 1 and dial 2 in every state, the control row, and armed/acknowledged states.
- A first macOS physical-device run verified installation and profile import, and exposed the stale shipped runtime fixed by ADR-0013. Timing, legibility, and control feel still need broader calibration.

## Product Principles

1. Physical control for parallel work, not a second UI.
2. Every routine interaction stays one-handed.
3. Turning previews; pushing commits.
4. Attention is declared by whoever knows, never inferred — and nothing that is still true can be silenced.
5. A channel is a workstream's stable position for as long as that workstream lives; reassigning one is deliberate, never automatic.

## Accessibility & Inclusion

- Never rely on color alone; pair every state with a short label, a mark, or a border treatment.
- Preserve one-handed operation; no control requires holding two things at once.
- Keep touch-strip text readable at its physical size; content is dropped before it is shrunk below the type floor.
- Keep all authored informational device text at 18 pixels or larger; shorten copy before reducing type.
- Destructive actions require an explicit armed state and a second, confirming action.
