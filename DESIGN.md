---
name: Herdr Stream Deck
description: A dense, runtime-themed instrument for running several development workstreams in parallel.
typography:
  count:
    fontSize: "72px"
    fontWeight: 700
  primary-label:
    fontSize: "24px"
    fontWeight: 700
    lineHeight: "29px"
    floor: "18px"
  branch-label:
    fontSize: "28px"
    fontWeight: 700
  field-label:
    fontSize: "20px"
    fontWeight: 700
  more-count-label:
    fontSize: "22px"
    fontWeight: 700
  footer:
    fontSize: "18px"
    fontWeight: 700
    letterSpacing: "0.1px"
  slot-number:
    fontSize: "26px"
    fontWeight: 700
rounded:
  key-outline: "18px"
spacing:
  key-inset: "4px"
  strip-content-inset: "18px"
components:
  key-canvas:
    width: "144px"
    height: "144px"
  key-outline:
    width: "136px"
    height: "136px"
    rounded: "{rounded.key-outline}"
  strip-region:
    width: "200px"
    height: "100px"
  strip-accent-bar:
    width: "5px"
    height: "100px"
---

# Design System: Herdr Stream Deck

## Overview

**Creative North Star: "The Dense Terminal Instrument"**

Herdr Stream Deck is a physical instrument for running several development workstreams in parallel, not a miniature application. Three workstreams are always visible at once, one per physical channel, each with its panes arranged by role and its own permanent status readout. The visual hierarchy favors instant recognition, stable positions, and deliberate commits over decoration.

The implementation is flat, compact, and terminal-like. Every unused pixel is true black; Herdr supplies text, state, and focus colors, while the plugin supplies geometry, type scale, and interaction marks.

**Key Characteristics:**

- The Stream Deck + XL's 36 keys and six touch-strip regions divide into three identical channels — three columns × four rows of keys, two dials each — one per workstream, always visible, with no mode for entering one.
- The Stream Deck Mini's 3×2 grid mirrors the same three channels at a glance when attached alone, or becomes the one global surface — belonging to no single workstream — when an XL is attached alongside it. Column order matches the XL's on both, so muscle memory transfers rather than competing.
- Short, bold monospaced labels; a channel's strip carries the only longer-lived text, and even that is capped readings, not prose.
- Border weight and pattern carry state; a filled corner mark carries attention, redundantly with a wording change in the same key's footer.
- Turning a dial previews; pushing commits.
- Destructive verbs arm on a push and need a second, confirming push within a few seconds; the arm reverts on its own, and any other physical action cancels it early.

**Build limitations:** the current SVGs prefer the system-installed Consolas font and depend on the host renderer honoring literal stroke-dash geometry rather than normalized path lengths. Those are shipped implementation constraints, not canonical typeface or iconography assets.

## Colors

The plugin has no independent palette. Rendering uses a generated compatibility copy of Herdr's built-in themes plus the saved theme name and custom RGB overrides from Herdr's config, until Herdr exposes its resolved runtime palette directly.

### Runtime roles

- **OLED field:** every key and strip region background is fixed `#000000`. Theme colors light only information-bearing pixels; nothing tints unused ones.
- **Text roles:** `text` and `subtext0` separate primary labels and branch names from readings, footers, and slot numbers.
- **Contrast adaptation:** every foreground color is resolved from its actual configured RGB value and lifted toward white only as far as needed to clear the black-field contrast floor; its hue is never replaced.
- **State roles, by what a pane or control is doing:** `yellow` marks an agent waiting on input; `blue` marks one working; `green` marks one finished, with the thickest outline of the set; `overlay0`/gray marks idle (solid, thin) or unknown (dashed) — a pane with no agent reports no state at all rather than a color that means nothing; `red` marks the one armed destructive state and a refused or failed acknowledgement.
- **Accent role:** `accent` marks a channel's strip identity bar and non-destructive emphasis.
- **Feedback role:** a successful control acknowledgement is a brief full-key green field with black text, distinct from every lifecycle color so it cannot be mistaken for one.

**The Herdr Owns Color Rule.** Never add plugin palette settings or hand-maintained swatches. The generated palette copy must remain mechanically derived from Herdr and disappear when a resolved-theme API exists.

**The OLED Black Rule.** Keep every background pixel `#000000`. Theme roles color information only: text, outlines, and marks.

**The OLED Contrast Rule.** Resolve every foreground from its actual configured RGB value, not the theme name or appearance. Text and small marks require 4.5:1 against black; outlines require 3:1.

**The Meaning Is Redundant Rule.** Pair every runtime state color with a short label, a non-color mark, or a stable border treatment. A pane asking for the developer carries both a filled corner mark and a footer word naming the reason (`NEEDS YOU`, `QUESTION`, `APPROVAL`, `FINISHED`, `EXITED`) — never the mark alone.

## Typography

All device text follows one compact monospaced hierarchy. The tokens above define size, weight, and rhythm; they deliberately do not name a system-installed font family as a design asset, only as a current implementation dependency.

### Hierarchy

- **Primary label** (700, 24px default, 18px floor, 29px line step): a pane or control key's own name, up to three centered lines, shrinking only once its widest line exceeds the default measure.
- **Count** (700, 72px): the dominant number on a key standing for more than it can show individually — panes a role's row had no space for, or the paired Mini's cross-workstream attention total.
- **Branch label** (700, 28px): a channel's own identity, leading its strip.
- **Field label** (700, 20px): a strip reading, a connection notice, or a dial's in-use preview — whatever currently occupies the strip's second line.
- **More-count label** (700, 22px): the short word above a count key's own number.
- **Footer** (700, 18px, uppercase, slight tracking): a pane's role, or an attention/acknowledgement word, beneath its primary label.
- **Slot number** (700, 26px): the number an unassigned channel's key shows before it holds a worktree.

**The Physical Type Floor.** Informational device text never falls below 18 pixels on its authored key or strip canvas. Shorten, truncate, or omit secondary copy before reducing type further.

**The Device SVG Rule.** Put font family, weight, size, color, alignment, and tracking directly on every SVG text element. Do not depend on embedded CSS, classes, or font shorthand in device images.

**The Operational Copy Rule.** Labels stay brief, literal, and free of implementation terminology.

**The Authored Action Feedback Rule.** Every interactive control owns its own pending, success, failure, and restore behavior. A successful acknowledgement uses the full green feedback field described above. A refusal or failure names its cause on the control itself — `NO PR YET`, `NO WORKTREE`, `NO AGENT`, or whatever Herdr's own error said — in the danger color, never the generic host warning overlay. Never call the Stream Deck SDK's own `showOk()`/`showAlert()`; a rejected action never falls through to host-owned feedback.

**The Latest Action Rule.** Whatever a channel's strip or a picker's keys show reflects the most recent physical action on that control. A newer press or turn always wins over an older pending state — an arm, a browsed preview, an open role picker — rather than a stale timer being left to resolve on its own after something newer already superseded it.

## Layout

### The XL

Three channels, each three columns × four rows of full 144×144 key canvases, plus two dials and two 200×100 strip regions. The top three rows are that channel's panes, one role per row — agent, then server, then a shared row split between tests, logs, and shell — so reading down a channel shows one workstream and reading across a row compares every instance of one role across all three. The fourth row is that channel's three fixed control keys: focus, Git and pull request, actions. This layout never changes with the rig; attaching or detaching a Mini reflows nothing on the XL.

The strip is one uninterrupted 1200×100 black composition across six 200×100 regions, two per channel, windowed rather than divided — a branch name may run past the seam between a channel's own two regions rather than being cut in half at it. Each channel's own accent bar sits 5 pixels wide at the left edge of its first region.

### The Mini

6 keys as a 3×2 grid, no dials, no strip. Column order matches the XL's exactly, so column 1 is always the same workstream on both devices.

**Mirroring alone:** row 1 is a workstream's own identity and aggregate agent state, one key per channel; row 2 is that workstream's single most urgent pane, tapped to jump straight to it.

**Paired with an XL:** the Mini stops mirroring and becomes the global surface instead. Row 1 is the cross-workstream attention queue (one key, a count and the worst reason present, pushed to jump to whatever needs the developer most) and the two most recently focused panes. Row 2 is the overflow count, moved here from the XL's strip while the Mini is attached, plus two reserved positions for worktree creation and settings.

**The Fixed Geography Rule.** A channel's column never moves, and its control row never becomes something else. Preserve stable positions across every rig so one-handed muscle memory keeps working when the developer's own hands are already there.

## Elevation & Depth

The system uses no shadows, nested fills, or background artwork. Hierarchy comes only from type, border treatment, and a filled attention mark.

**The Flat Instrument Rule.** Do not add decorative chrome, gradients, gloss, or simulated physical depth.

## Shapes

Keys use one rounded outline (18px radius) on the true-black field, inset 4 pixels from the canvas edge. The strip is rectangular and continuous; individual regions must not read as detached cards. Border width and pattern carry state: waiting-on-input and working are 5px solid; finished and the one armed destructive state are 7px solid; idle is 3px solid; unknown (no agent data at all) is 3px dashed.

## Components

### Pane key

- **Canvas:** the full 144×144 key.
- **Content:** the pane's own name as the primary label, its role as the footer — replaced by the attention word when it is asking — and a lifecycle-colored border when it runs an agent. A pane with no agent carries no status border at all, since Herdr has no state to report for one.
- **Attention mark:** a filled disc at the key's upper-right names nothing by itself; it is always paired with the footer word, so the mark and the word carry the same fact through two different channels.
- **Label behavior:** up to three centered lines, split at word separators where possible; a name past the default measure may widen before it shrinks, and shrinks no further than the 18px floor.

### More-count key

A role's row had more panes than it had keys for. Shows the word `MORE` (or the worst attention reason among the panes it is standing for) above the count of what did not fit — never silent, and marked whenever one of the hidden panes is asking.

### Empty channel key

Shows its channel number, a plus mark, and the footer `NEW WORKTREE`, inviting one — the same honest naming a reserved-but-unwired control uses, since this key has nothing behind it to press yet either (see `PRODUCT.md`'s Open decisions).

### Control row key

Three fixed positions per channel: focus, Git/pull-request (labeled with the repository name), actions. Idle, each shows its own verb name as the footer. A live acknowledgement replaces the footer with what just happened — success in the feedback field, refusal or failure in the danger color naming the cause — for a few seconds before reverting. The armed actions key alone escalates further, reading `STOP AGAIN` in the danger color until confirmed or the arm times out.

### Role picker

A hold on a pane key, wherever an XL is present, replaces that one channel's three pane rows — never the control row, never another channel — with every role at once, each sitting exactly where its own pane row already would: agent's key where an agent pane already sits, and so on down the channel. A tap on any of them commits that role for the held pane and closes the picker; any other physical action, or a few seconds of nothing, closes it without committing.

### Strip region

- **Canvas:** 200×100, one half of a channel's own 400px composition.
- **Content:** the branch label leads; readings follow in a fixed order — attention count, ticket count, pull-request state, agent count — so one is always found in the same place. A reading whose value is not yet known reads as `?` rather than blank, since the point of reserving its place is that the developer learns where to look before there is anything to see.
- **Notice:** a connection problem, or either dial being actively used, replaces the readings with one line — never the branch, which does not change because Herdr went away.
- **Overflow:** the rightmost region of an XL-only rig carries the overflow count at its far right edge, right-aligned; a paired rig moves it to the Mini instead and this region falls quiet.

### Dial-in-use notice

While dial 1 is browsing, or dial 2 is browsing, armed, or just reported an outcome, the owning channel's strip shows that instead of its permanent readings. Dial 2's own notice wins over dial 1's on the same channel, since it is the one that can be mid-arm on something destructive.

### Global surface keys (paired Mini)

- **Queue:** a count across every workstream, marked with the worst reason present among them; pushed, it focuses whichever pane that worst item names, or does nothing if the worst item names none.
- **Recent:** the two most recently focused panes, most recent first, drawn exactly like an ordinary pane key.
- **Overflow:** the same count that would otherwise sit on the XL's strip.
- **Worktree creation / settings:** reserved positions with no verb behind them yet (see `PRODUCT.md`'s Open decisions); they say what they are for rather than pretending to do something they cannot yet.

## Do's and Don'ts

### Do:

- **Do** keep every label short enough to scan at physical-device size.
- **Do** preserve the true-black field across every key and every strip region.
- **Do** pair border weight, wording, and stable position with every runtime color.
- **Do** keep turns as previews and pushes as commits.

### Don't:

- **Don't** introduce plugin theme settings, hand-maintained colors, manual appearance controls, or values sampled from preview images.
- **Don't** turn strip regions into separate cards or add decorative depth.
- **Don't** use color alone to communicate role, attention, lifecycle state, or danger.
- **Don't** infer attention, role, or pull-request state from terminal text; every one of them is declared by something that knows.
