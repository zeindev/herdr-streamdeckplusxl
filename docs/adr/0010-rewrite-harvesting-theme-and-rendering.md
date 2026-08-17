---
status: accepted
---

# Rewrite around the workstream model, harvesting theme and rendering

The transport (ADR-0004), the state model (ADR-0001, ADR-0003), the device targets (ADR-0008), and the layout (ADR-0002) all changed at once. That is a rewrite whether or not it is called one, so the pin-and-page model is deleted outright rather than adapted.

What carries over: `src/herdr-themes.ts` (1,492 lines) and `src/theme.ts` (93 lines) survive untouched — verified against a live `session.snapshot`, which has no `theme` key, so the generated compatibility copy of Herdr's palette is still the only colour source. `src/render.ts` (457 lines) largely survives: keys are authored at 144×144 and dial regions at 200×100 on both target devices, unchanged from today, because Stream Deck scales down as needed. What changes is what gets drawn, not the canvas geometry, so the type scale, the 18px floor, and the drawing primitives all carry over. The Mini needs no dial-region rendering. The snapshot types in `src/model.ts` survive and grow; its pin model does not. `src/plugin.ts` (1,249 lines), `src/herdr.ts` (158 lines), and the `DeviceType 7` profile are dropped.

Back-compatibility carries no weight here: the retired model only ran on the Stream Deck+, which is no longer a target, so there are no users on supported hardware. Test coverage is not a constraint either — `src/model.test.mjs` is 368 lines containing two tests, one an omnibus case.

The known risk is a long stretch with nothing running end to end. The mitigation already exists in the repo: `npm run preview` renders real-resolution images through `scripts/render-preview.mjs`, giving visual feedback with no device attached. Keeping it green is the feedback loop for the rewrite.

## Considered Options

- **Incremental refactor on main.** Rejected: runnable at every commit, but the old and new models are structurally incompatible — panes on pages versus panes in roles in channels — so a pins-to-channels adapter would be maintained for weeks purely to be deleted.
- **Parallel implementation with a single cutover.** Rejected: the old plugin keeps working throughout, but two trees must keep compiling and the cutover arrives as one unreviewable commit.
- **Keep the pin model as a legacy mode.** Rejected: maintenance cost with no user, since no supported device can run it.

## Consequences

- `npm run preview` becomes a required gate, not a convenience.
- `PRODUCT.md` and `DESIGN.md` are rewritten rather than amended; both are titled and dimensioned for the Stream Deck+.
- Real test coverage has to be built from scratch; there is nothing meaningful to preserve.
