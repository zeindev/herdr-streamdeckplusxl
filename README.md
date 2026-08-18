# Herdr Stream Deck

A physical instrument for running several development workstreams in parallel through [Herdr](https://herdr.dev). Three workstreams stay visible at once, each as its own channel of keys and dials, with attention declared rather than guessed and every routine action reachable one-handed.

## Install

Requires Herdr 0.8.0 or newer and a Stream Deck + XL, a Stream Deck Mini, or both.

```text
herdr plugin install zeindev/herdr-streamdeckplusxl
```

Accept the Stream Deck install prompt on Windows or macOS. Linux uses [OpenDeck](https://github.com/nekename/OpenDeck) and requires a restart after installation. macOS and Linux support is experimental and unproven.

## Use

Each of the XL's three channels holds one workstream: its panes fill the top three rows, arranged by role, and the fourth row is that workstream's own focus, Git/pull-request, and actions keys. Every channel's strip permanently shows its branch, attention count, ticket count, pull-request state, and agent count.

| Control | What it does |
| --- | --- |
| A pane key | Tap to focus that pane in Herdr; hold to correct its detected role |
| Dial 1 | Rotate to browse a channel's panes and attention, then push to focus the selected pane |
| Dial 2 | Rotate an empty channel's candidate repositories, push to create a worktree there; on a bound channel, push to arm removing its worktree, push again to confirm |
| Focus key | Bring the workstream forward in Herdr |
| Git/pull-request key | Names the repository; no verb behind it yet |
| Actions key | Tap to send a fixed continue prompt; hold to arm an interrupt, tap again to confirm |
| A channel's strip (held) | Reassign that channel to a different workstream |

A Stream Deck Mini attached alone mirrors the same three workstreams at a glance. Attached alongside an XL, it becomes the global surface instead: the cross-workstream attention queue, the two most recently focused panes, and the overflow count for any workstream beyond the first three.

See [`PRODUCT.md`](PRODUCT.md) for the full interaction model and [`DESIGN.md`](DESIGN.md) for the visual system.

## License

Plugin code is [MIT licensed](LICENSE). Herdr-derived themes and brand assets remain under Herdr's terms; see [third-party notices](THIRD_PARTY_NOTICES.md).
