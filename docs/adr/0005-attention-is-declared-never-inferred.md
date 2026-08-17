---
status: accepted
---

# Attention is declared, never inferred

Herdr's whole attention vocabulary is `agent_status ∈ {idle, working, blocked, done, unknown}`, which covers only two of the eight signals this product wants. Rather than infer the rest from terminal output — which `DESIGN.md` explicitly bans and which makes a triage instrument untrustworthy — attention is **declared** by whoever actually knows.

The native floor is always on: `agent_status = blocked` means needs input, an unseen `agent_status = done` means finished, and `pane_exited` means a pane's process ended.

**Correction, found while building the socket client (ticket `-3x9`):** an earlier version of this decision said `pane_exited` *with a nonzero code* means crashed. Herdr 0.8.0 sends no exit code — the payload is exactly `type`, `pane_id`, and `workspace_id`, confirmed against both the API schema and live traffic. A crashed dev server is therefore indistinguishable from a pane closed on purpose using this event alone. The floor is narrowed to "a pane ended", and telling a crash from a clean exit needs the same declaration mechanism the agents use, or a Herdr change. On top of that, agents report their own state through `pane.report_metadata`. Claude Code hooks shell out to the Herdr CLI: a `Notification` hook writes `sd_attention=question`, a `PreToolUse` hook writes `sd_attention=approval`, and a `Stop` hook writes `sd_attention=finished`. This distinguishes a question from an approval truthfully, with no scraping and no Herdr core change.

**Second correction, found while building attention itself (ticket `-d9e`), by probing a running Herdr 0.8.0 rather than reading the schema.** Three findings, and together they decided how a dead service is reported.

1. **A pane does not survive its process.** A scratch workspace was created, a token written on its pane, and the shell sent `exit 3`. `pane_exited` fired and the pane was *absent* from the very next `session.snapshot` — not flagged dead, gone. So attention arising from a pane ending can never show on that pane's key: by the time the event arrives there is no key.
2. **A pane's tokens die with the pane; a workspace's do not.** The pane token was readable immediately before the exit and gone immediately after. `workspace.report_metadata` was then used to write a token, one of a workspace's two panes was exited, and the token survived intact along with the workspace. A declaration about a dead process therefore has to be **workspace-scoped**, and `pane.report_metadata` is the wrong place for it.
3. **Herdr emits no `pane_closed` for either case.** Both probes, and the 66-event recorded capture, produced `pane_exited` and never `pane_closed`. Closing a pane on purpose and a process dying are the same event from the same code path, so no amount of correlation separates them.

**The decision that follows.** A service that ends badly declares it as a workspace token `sd_exit_<name>`, whose value is the exit status. `scripts/herdr-service` is the wrapper that writes it: it clears the token when the service starts, so restarting is what resolves the attention item, and it declares only a genuine failure — 0 is a clean exit, and 129, 130 and 143 are the developer stopping the service by hangup, Ctrl-C or `SIGTERM`. Reporting those would make the surface cry wolf every time a pane was closed, which is the exact failure this ADR exists to prevent. The reader refuses a declared zero as well, so "a clean exit does not raise attention" is enforced by the code rather than by convention. `workspace_metadata_updated` is pushed live and carries the tokens, verified against a running server and recorded in the capture, so this needs no polling.

Option 1 from `-d9e`'s notes — treating any `pane_exited` on a service pane as attention — is rejected on the evidence above, not on taste. It could not show on a key, nothing would ever resolve it, and it would fire every time a pane was closed deliberately.

**Acknowledgement is of one finished piece of work, not of a pane.** It is spent the moment the agent leaves `done`, so an agent that finishes twice asks twice. Tapping the pane key is what acknowledges, because that tap already focuses the pane in Herdr — going to look at it is the act, and a separate button would be a second gesture for something the first one performs.

This is what unblocks the capability `PRODUCT.md` called Question Mode. That feature was specified as first-release scope but is unbuildable as written: none of Herdr's 90 socket methods read or submit a structured interaction. Agent-declared tokens deliver the same signal without waiting for Herdr to grow an interaction API.

## Considered Options

- **Native floor only.** Rejected: never wrong and needs no setup, but a question is indistinguishable from an approval and failing tests stay silent.
- **User-authored output matchers** per role via `pane.wait_for_output`. Deferred, not rejected — worth adding later as opt-in for services and other non-agent panes, where no hook mechanism exists. Patterns rot as tools change their output.
- **Heuristic classification of pane output.** Rejected: contradicts `DESIGN.md`, and a surface that is sometimes wrong trains the user to ignore it.

## Consequences

- A hook installer is part of the product, not a setup note. Agents without hooks silently degrade to the native floor.
- The token vocabulary becomes a public contract that anything can write to, not only Claude. It has two halves, and the scope of each is forced by what survives: `sd_attention` on a **pane**, for an agent that is alive to report on itself, and `sd_exit_<name>` on a **workspace**, for a service that is not.
- Unseen-ness is the plugin's to track: Herdr reports `done` but has no concept of acknowledged.
- Merge conflicts and pull-request feedback remain out of reach until the external enrichment side of ADR-0004 exists.
- A crashed service is reported only when it was started under `scripts/herdr-service`. Unwrapped services degrade to silence, which is the same trade the hook installer makes for agents: the surface says less than everything, and never says something false.
- A dead service is the one attention item with no key of its own, because its pane is gone. It shows on the channel strip alone, as the `EXIT` reading beside `ATTN`, and it is the one item the developer cannot press.
