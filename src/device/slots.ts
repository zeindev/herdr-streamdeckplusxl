import { CHANNEL_COUNT } from "./geometry.js";
import type { Workstream } from "./workstream.js";

/**
 * Which workstream each channel belongs to, by durable key, or null for a
 * channel offering to start one.
 *
 * Always `CHANNEL_COUNT` long. The cap is the shape of this value rather than a
 * rule applied to it, so there is no way to express a fourth channel and a
 * fourth workstream can only become overflow (ADR-0009).
 */
export type SlotBindings = ReadonlyArray<string | null>;

export function emptySlots(): SlotBindings {
  return Array.from({ length: CHANNEL_COUNT }, () => null);
}

/**
 * What a slot remembers a workstream by, across both Herdr and the Stream Deck
 * app restarting.
 *
 * The checkout path is the honest key: it is what the workstream *is*, it is
 * stable, and it survives even Herdr losing its session file. A workspace with
 * no worktree has no such path, so it falls back to the workspace id — Herdr
 * persists that verbatim in `session.json`, so it survives a restart, though not
 * a session reset. The two are prefixed because a checkout path and a workspace
 * id are different kinds of name and must never be able to collide.
 */
export function workstreamKey(workstream: Workstream): string {
  return workstream.worktree
    ? `checkout:${workstream.worktree.checkoutPath}`
    : `workspace:${workstream.workspaceId}`;
}

/**
 * The workstream each channel currently shows, one entry per channel.
 *
 * A binding whose workstream is not present right now renders as an empty
 * channel rather than a stale one — Herdr may simply be restarting, and the
 * binding is kept so the workstream returns to the same place.
 */
export function channelWorkstreams(
  bindings: SlotBindings,
  workstreams: readonly Workstream[]
): Array<Workstream | null> {
  const present = presentByKey(workstreams);
  return Array.from({ length: CHANNEL_COUNT }, (_, slot) => {
    const key = bindings[slot];
    return (key && present.get(key)) || null;
  });
}

/**
 * Workstreams that exist but hold no channel. They are counted rather than
 * shown, which is the only pressure to close one (ADR-0009).
 *
 * Derived from what the channels actually show rather than from the bindings
 * alone, so a workstream can never be both unshown and uncounted. That matters
 * for the one case where two workstreams claim the same key: only one of them
 * can hold the channel, and the other has to surface as overflow rather than
 * disappear.
 */
export function overflowOf(bindings: SlotBindings, workstreams: readonly Workstream[]): Workstream[] {
  const shown = new Set(channelWorkstreams(bindings, workstreams).filter(Boolean));
  return workstreams.filter((workstream) => !shown.has(workstream));
}

/**
 * Gives a channel to every workstream that can have one, without moving any
 * workstream that already has a channel.
 *
 * Not moving is the whole point: ADR-0009 rejects auto-fill because a workstream
 * that slides sideways destroys the spatial memory the layout is built on. So
 * this only ever fills channels, and a workstream keeps its channel for as long
 * as it lives.
 *
 * Free channels are taken before remembered ones, so a Herdr restart puts every
 * workstream back where it was. A remembered channel is only taken when nothing
 * is free, which stops a workstream that will never return from holding a
 * channel hostage forever.
 */
export function bind(bindings: SlotBindings, workstreams: readonly Workstream[]): SlotBindings {
  const waiting = overflowOf(bindings, workstreams);
  if (waiting.length === 0) return bindings;

  const present = presentByKey(workstreams);
  const next = [...bindings];
  // A channel bound to a workstream that is not here is only a memory, and a
  // memory yields to something real — but only after every truly free channel.
  const free = next.map((key, slot) => ({ slot, kind: key === null ? "free" : present.has(key) ? "held" : "remembered" }));
  const available = [
    ...free.filter((channel) => channel.kind === "free"),
    ...free.filter((channel) => channel.kind === "remembered")
  ];

  const claimed = new Set(next.filter((key): key is string => key !== null));
  for (const workstream of waiting) {
    const key = workstreamKey(workstream);
    // Two workstreams on one checkout would otherwise take two channels under
    // one name, which would make position ambiguous. The second stays overflow.
    if (claimed.has(key)) continue;
    const channel = available.shift();
    if (!channel) break; // Every channel is taken: the rest are overflow.
    next[channel.slot] = key;
    claimed.add(key);
  }
  return next;
}

/** Empties a channel. Its workstream becomes overflow rather than disappearing. */
export function release(bindings: SlotBindings, slot: number): SlotBindings {
  if (!isSlot(slot) || bindings[slot] === null) return bindings;
  const next = [...bindings];
  next[slot] = null;
  return next;
}

/**
 * Moves a workstream into a chosen channel, leaving whatever channel it held.
 * A workstream is in one channel or none, never two.
 */
export function adoptIntoSlot(bindings: SlotBindings, slot: number, key: string): SlotBindings {
  if (!isSlot(slot) || bindings[slot] === key) return bindings;
  const next = bindings.map((held) => (held === key ? null : held));
  next[slot] = key;
  return next;
}

/**
 * Reads the bindings back out of stored settings.
 *
 * Settings are written by an older version of this plugin, edited by hand, or
 * corrupted, so nothing here is trusted: anything unreadable yields an empty
 * device rather than a broken one, which the developer can simply use.
 */
export function readSlots(stored: unknown): SlotBindings {
  const slots = (stored as { slots?: unknown } | null | undefined)?.slots;
  if (!Array.isArray(slots)) return emptySlots();

  const seen = new Set<string>();
  return Array.from({ length: CHANNEL_COUNT }, (_, slot) => {
    const key = slots[slot];
    // A workstream in two channels at once would make position meaningless, so
    // the first channel claiming it wins.
    if (typeof key !== "string" || key === "" || seen.has(key)) return null;
    seen.add(key);
    return key;
  });
}

export function sameSlots(left: SlotBindings, right: SlotBindings): boolean {
  return left.length === right.length && left.every((key, slot) => key === right[slot]);
}

/** First wins, so which workstream a channel resolves to never depends on order. */
function presentByKey(workstreams: readonly Workstream[]): Map<string, Workstream> {
  const byKey = new Map<string, Workstream>();
  for (const workstream of workstreams) {
    const key = workstreamKey(workstream);
    if (!byKey.has(key)) byKey.set(key, workstream);
  }
  return byKey;
}

function isSlot(slot: number): boolean {
  return Number.isInteger(slot) && slot >= 0 && slot < CHANNEL_COUNT;
}
