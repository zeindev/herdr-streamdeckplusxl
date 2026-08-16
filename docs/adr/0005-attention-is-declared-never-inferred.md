---
status: accepted
---

# Attention is declared, never inferred

Herdr's whole attention vocabulary is `agent_status ∈ {idle, working, blocked, done, unknown}`, which covers only two of the eight signals this product wants. Rather than infer the rest from terminal output — which `DESIGN.md` explicitly bans and which makes a triage instrument untrustworthy — attention is **declared** by whoever actually knows.

The native floor is always on: `agent_status = blocked` means needs input, an unseen `agent_status = done` means finished, and `pane_exited` means a pane's process ended.

**Correction, found while building the socket client (ticket `-3x9`):** an earlier version of this decision said `pane_exited` *with a nonzero code* means crashed. Herdr 0.8.0 sends no exit code — the payload is exactly `type`, `pane_id`, and `workspace_id`, confirmed against both the API schema and live traffic. A crashed dev server is therefore indistinguishable from a pane closed on purpose using this event alone. The floor is narrowed to "a pane ended", and telling a crash from a clean exit needs the same declaration mechanism the agents use, or a Herdr change. On top of that, agents report their own state through `pane.report_metadata`. Claude Code hooks shell out to the Herdr CLI: a `Notification` hook writes `sd_attention=question`, a `PreToolUse` hook writes `sd_attention=approval`, and a `Stop` hook writes `sd_attention=finished`. This distinguishes a question from an approval truthfully, with no scraping and no Herdr core change.

This is what unblocks the capability `PRODUCT.md` called Question Mode. That feature was specified as first-release scope but is unbuildable as written: none of Herdr's 90 socket methods read or submit a structured interaction. Agent-declared tokens deliver the same signal without waiting for Herdr to grow an interaction API.

## Considered Options

- **Native floor only.** Rejected: never wrong and needs no setup, but a question is indistinguishable from an approval and failing tests stay silent.
- **User-authored output matchers** per role via `pane.wait_for_output`. Deferred, not rejected — worth adding later as opt-in for services and other non-agent panes, where no hook mechanism exists. Patterns rot as tools change their output.
- **Heuristic classification of pane output.** Rejected: contradicts `DESIGN.md`, and a surface that is sometimes wrong trains the user to ignore it.

## Consequences

- A hook installer is part of the product, not a setup note. Agents without hooks silently degrade to the native floor.
- The token vocabulary (`sd_attention` and its values) becomes a public contract that anything can write to, not only Claude.
- Unseen-ness is the plugin's to track: Herdr reports `done` but has no concept of acknowledged.
- Merge conflicts and pull-request feedback remain out of reach until the external enrichment side of ADR-0004 exists.
- Distinguishing a crashed service from a deliberately closed pane is an open problem, since `pane_exited` carries no status. Whatever solves it must not read terminal output.
