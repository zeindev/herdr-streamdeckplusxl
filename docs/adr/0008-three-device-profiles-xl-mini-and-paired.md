---
status: accepted
---

# Three device profiles: XL, Mini, and the paired rig

The product targets the **Stream Deck + XL** (DeviceType 13) and the **Stream Deck Mini** (DeviceType 1), plus the setup where both are connected — three profiles in total. The Stream Deck+ (DeviceType 7) is **not** a target, which retires the bundled `DeviceType 7` profile and the 800×100 / four-dial geometry that `DESIGN.md` is written against.

Both target devices divide by three, matching the three-workstream cap: the XL is 36 keys in a 9-column × 4-row grid, with six 200px strip regions below the grid and 6 dials below the strip; the Mini is 6 keys in a 3×2 grid with no dials and no touch strip. Each XL channel is therefore 3 columns wide, and the Mini's 3 columns map onto the same three channels — column 1 is the same workstream on both devices, left to right, always — so muscle memory transfers between them rather than competing.

**XL:** three channels of 3 columns × 4 rows. Top three rows are panes; the fourth is that channel's three control keys (ADR-0011). This layout is **the same whether or not a Mini is attached**.

**Mini alone:** row 1 is the workstream and its aggregated state; row 2 is that workstream's most urgent pane, tapped to jump straight to it.

**Paired:** the Mini becomes the global surface — the cross-workstream attention queue, overflow count, worktree creation, recent, and settings — none of which the XL carries, since ADR-0011 gives it no global rail.

## Considered Options

- **Mini as a pure ranked attention queue.** Rejected: the clearest possible answer to "what needs me", but nothing holds a stable position, so it offers no muscle memory and no portfolio glance.
- **Mini as portfolio plus globals** — workstreams on row 1, Inbox and Actions on row 2. Rejected: conventional and useful, but the bottom row stops meaning workstream, breaking the shared column convention.
- **Mini as a workstream switcher and launcher.** Rejected: strong for starting and finishing streams, but it shows almost no live state, so it earns no glance.

## Consequences

- A Mini-only setup has no dials and no strip, so everything ADR-0007 places there — branch, ticket list, pull-request state, pane browsing, the verb list — does not exist. A Mini alone can show state and jump; it cannot show detail or run a verb list.
- **The XL's layout is rig-independent.** Attaching or detaching a Mini adds or removes the global surface but never reflows the XL, which removes a whole class of runtime layout complexity. The plugin still tracks `onDeviceDidConnect` and `onDeviceDidDisconnect`, but only to decide whether the Mini is being driven.
- On an XL-only rig the global surfaces have no home; the cross-workstream queue is reached through per-channel controls, and the overflow count renders on the rightmost strip region.
- Keys are authored at 144×144 on both devices and Stream Deck scales down as needed, so the existing key canvas, type scale, and 18px physical type floor carry over unchanged. Dial regions stay 200×100 on the XL. The XL's dial and strip placement relative to the key grid remains undocumented; the six 200px region count is inferred from the confirmed 1200px width and six dials.
- `PRODUCT.md` and `DESIGN.md` are both named and written for the Stream Deck+ and need rewriting, not amending.
