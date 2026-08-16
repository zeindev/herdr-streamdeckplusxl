---
status: accepted
---

# State ownership is split by clock speed

Two long-lived processes are available: the Stream Deck plugin, which lives and dies with the Stream Deck app, and a Herdr plugin, which lives with Herdr and gets startup hooks and event subscriptions. We split them by how fast their data changes. The Stream Deck plugin opens Herdr's socket directly and subscribes to the 26 push events for fast state — agent status, pane lifecycle, focus, worktrees — and sends commands back over the same socket. The Herdr plugin owns slow external enrichment — GitHub pull-request state, JIRA tickets, Git ahead/behind — and publishes it through `report_metadata` as workspace and pane tokens.

The two processes never talk directly. Herdr's own state is the interface, which means enrichment keeps running when the Stream Deck app is closed and is visible inside Herdr rather than only on the device.

This replaces the current transport in `src/herdr.ts:90`, which spawns a `herdr api snapshot` subprocess every 1000ms and diffs a stringified signature — up to a second of latency, a subprocess per second, and no knowledge of *what* changed.

## Considered Options

- **Herdr plugin as the sole brain**, Stream Deck plugin a pure renderer. Rejected: the purest separation, but fast-changing agent status would detour through a token write, adding latency and write churn to the hot path.
- **Stream Deck plugin owns everything.** Rejected: simplest to build and debug, but closing the Stream Deck app stops all enrichment, nothing surfaces in Herdr's own UI, and a second surface would duplicate the logic.
- **Keep CLI polling.** Rejected: no transport work, but it cannot support any interaction that must feel immediate.

## Consequences

- A JSON socket client must be written; `herdr api` exposes only `snapshot` and `schema`, so the CLI cannot subscribe.
- Each datum needs an explicit owner. Fast Herdr-derived state belongs to the Stream Deck plugin; anything requiring a network call outside Herdr belongs to the Herdr plugin.
- Tokens are a shared cache, not a database: 32 per entity, 16 per call, and at most 24 hours of TTL, with no TTL meaning workspace-lifetime. Anything that must survive Herdr restarting belongs in `HERDR_PLUGIN_STATE_DIR` or Stream Deck settings.
- Token writes carry a `source` id and a `seq`, so the two publishers cannot clobber each other.
