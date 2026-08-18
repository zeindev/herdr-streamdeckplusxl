---
status: accepted
---

# The control row extends tap-and-hold rather than inventing arm-and-confirm from scratch

ADR-0011 named the control row's three verbs — focus workstream, Git and pull request, actions — and gave each a fixed key. This decision is about what pressing each of them actually does, and it leans on the gesture vocabulary ADR-0009 and ticket `-4bb` already built rather than adding a second one: a **tap** acts on what a key shows, a 1200ms **hold** (`HOLD_MS`, `src/device/state.ts`) changes what it means or escalates it. Nothing here introduces a third physical gesture.

## The three keys

**Focus** (column 0). A tap sends `workspace.focus`. Whether Herdr raises its own window without stealing operating-system focus was, for a time, only asserted from the API shape — `workspace.focus` takes only a `workspace_id`, giving the plugin nothing to ask for OS focus with. **Observed directly (ticket `-0vd.5`):** with the developer's own window focus deliberately moved elsewhere, both `workspace.focus` and `pane.focus` were called against a live Herdr over the socket, and neither brought its window forward. The API shape's implication holds in practice, not only on paper.

**Git and pull request** (column 1). Its label is the repository name, not its own verb — this is where ticket `-0vd.2`'s regression is repaired, since row 0 no longer carries channel identity (`-4bb`). Its footer says `GIT`. Herdr's socket API has no method to open a URL at all — `openUrl` lives on the Stream Deck SDK, not Herdr — and more fundamentally there is no pull-request state to open yet: `-5ot` and `-7bl`, which would publish it, are both still open. A tap therefore refuses honestly rather than pretending to be a shortcut to somewhere it cannot reach: it acknowledges `NO PR YET` on the key, in the failure colour, without spending a round trip to Herdr to say so. The identity label survives the refusal — only the footer changes — because the repository name is not itself in question. When `-wl7`'s enrichment lands, this is the seam it extends: a known pull-request URL becomes a `streamDeck.system.openUrl` call in the adapter, and an unknown one keeps refusing exactly as it does today.

**Actions** (column 2). A tap sends one fixed prompt — "Continue with your best judgment." (`CONTINUE_PROMPT`) — to the workstream's own agent pane, the same one its channel's agent row shows. A hold arms the key for its one destructive action, an interrupt (`pane.send_keys` with `["C-c"]`), which needs a **second, confirming tap on the same key within `ARM_TIMEOUT_MS` (3000ms)** to actually send. Both numbers, and the two-step shape itself, are lifted from the retired Stream Deck+ product's Actions Mode (`PRODUCT.md`, `DESIGN.md`), which armed its own Stop key the same way for the same reason: destructive actions need friction, but the friction has to resolve on its own if the developer walks away, rather than staying dangerous forever.

Sending a prompt is two Herdr calls, not one — `pane.send_text` types it, `pane.send_keys ["Return"]` submits it. Probed directly: `herdr pane run` is a CLI convenience that composes exactly these two socket calls; there is no single `pane.run` method on the wire. `pane.send_keys ["C-c"]` was also probed directly, against a real `sleep 30` in a scratch pane, and interrupted it cleanly.

## Why hold arms rather than tap-cycling through the retired product's four verbs

The retired design's Actions Mode had six keys — `CONTINUE`, `STATUS`, `VERIFY`, `ZOOM`, blank, `STOP` — because it had six keys to spend. This control row has one. Two shapes were available for reaching more than one prompt from a single key: cycle on tap and commit on a separate gesture, or collapse to the one prompt that is useful without knowing anything else about the session. The second was chosen. `STATUS` and `VERIFY` are both, in effect, "tell me what's going on" — a question a `Notification`-hook `question` declaration (ticket `-97u`) now answers more usefully than a fixed prompt ever could, and `ZOOM` is a Herdr pane operation with no attention-worthy urgency of its own. What is left that a single reflexive tap earns its place for is exactly `CONTINUE`: the one action useful in the most sessions with the least context.

This also decided the gesture split directly. A tap is supposed to be the light, reflexive action on every key on this device — pane keys focus on a tap, the strip's hold reassigns a channel because reassigning is the deliberate one. Routing the *routine* prompt through a hold and the *destructive* one through a tap would have inverted that: the rare, weighty action reachable by the fast gesture, the frequent, safe one gated behind friction. Hold arms, because arming is the one moment on this key that has to be deliberate; everything else stays a tap.

## Acknowledging every control key's own last press

`DESIGN.md`'s Authored Action Feedback Rule already commits this whole plugin to owning every key's pending, success and failure behaviour, and to never calling `showOk()` or `showAlert()`. This ticket is the first to actually need it on a key that isn't a pane, so `src/device/control.ts` introduces the general shape everything else reuses: a `ControlOutcome` (`workspaceId`, `column`, `ok`, an optional `message`, and an absolute `until`) replaces whatever a key was last showing, and a live one always wins over the key's idle face. `ACK_DISPLAY_MS` (1500ms) is how long it stays before the key reverts on its own, on the next `tick` — the same tick-driven pruning pattern `attention.ts`'s acknowledgement tracking and `state.ts`'s resync debounce already use, so nothing new was invented to expire it either.

A refusal the reducer already knows the reason for — no pull-request state yet, no agent pane to target — is acknowledged **locally**, with no Herdr request at all. Only `workspace.focus` and the two pane commands actually round-trip, and `plugin.ts` is where a request's outcome, success or failure, turns into the same `control-acknowledged` event either way; the reducer does not know or care which path an acknowledgement came from.

This is a second, unrelated use of the word "acknowledge" in this codebase — `attention.ts`'s `Acknowledged` is about finished work staying quiet until looked at again, and has nothing to do with `control.ts`'s `ControlOutcome`. Both are called acknowledgement because `DESIGN.md` already uses the word generically for "a key owns telling you what it just did"; the two are unrelated types in unrelated modules and neither reads the other's state.

## Considered Options

- **Cycle-and-commit on the actions key**, mirroring the pane-role-correction pattern (`nextRole`): each hold advances to the next of several prompts and sends it immediately. Rejected: it makes the routine action a hold and gives no way to see what is about to fire before firing it, since a physical key's face only updates after a press completes.
- **A single generic `herdr-request` per control key, fire-and-forget**, matching the pattern `pane.focus` already used before this ticket. Rejected outright by this ticket's own acceptance criteria: every control key has to name its own outcome, which needs the request's result routed back through the reducer, not merely fired.
- **Opening a placeholder search or generic URL from the Git key today.** Rejected: it would be exactly the blind shortcut the acceptance criteria rule out, and Herdr has no method to open anything regardless.

## Consequences

- The actions key can only ever target the workstream's own agent pane — the first, by pane id, among panes with `pane.agent` set in that workstream. A workstream running two agents sends its prompt to only one of them; this is accepted rather than solved, since choosing among several would need a selection gesture this row does not have room for.
- `StopFailure` (an API-error turn ending, from ticket `-97u`'s hook work) is not a fourth prompt outcome here and is not read by the actions key. It is out of scope for this ticket's three-verb row, same as it was out of scope for `-97u`'s three declared attention kinds.
- The git/pull-request key's tap is inert today in every case — there is nothing yet it could open. `-wl7` is expected to give it a real destination without changing this ADR's shape, only what happens when a URL is actually known.
- `ticket -0vd.2` closes as a consequence of this one: the repository name is visible on every channel without a press, and a monorepo's three checkouts are told apart by name as well as branch.
