---
status: accepted
---

# The Stream Deck + XL shows three workstream channels simultaneously

The Stream Deck + XL (DeviceType 13) has 36 keys in a **9-column × 4-row** grid, a 1200×100 touch strip of six 200px regions below the grid, and 6 dials below the strip — each count divisible by three, matching the self-imposed cap of three active workstreams. We lay it out as three vertical channels, one per workstream: **three columns** of keys, two dials, and two strip regions each. All three workstreams are therefore visible at once and there is no mode for entering one.

Column order is the product's primary spatial convention: channel 1 is the leftmost workstream, and that ordering is shared by every device (see ADR-0008).

## Considered Options

- **Symmetric modal design across devices.** Rejected: one layout engine is cheaper, but it wastes the exact 3× hardware fit and keeps a mode switch on a device that does not need one.
- **Horizontal bands** — portfolio always visible on top, selected workstream detailed below. Rejected: inspecting a second workstream still costs a context switch, which is the cost this product exists to remove, and detail keys change meaning constantly.
- **Attention-first ranked grid.** Rejected: nothing holds a stable position, so muscle memory is impossible by construction.

## Consequences

- Spatial memory is the primary navigation aid — a workstream *is* its column group — so reassigning a workstream to a different channel is disruptive and must be deliberate.
- The bottom row is the physical reach; the least urgent controls belong there.
- The XL carries no shared global rail; each channel's bottom row is its own three control keys. See ADR-0011.

## Superseded content

An earlier version of this decision made the Stream Deck+ (DeviceType 7) the second target, as a modal portfolio-and-triage surface. The Stream Deck+ is no longer a target at all. See ADR-0008 for the current device set.
