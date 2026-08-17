import { CHANNEL_COUNT } from "./geometry.js";
import type { Workstream } from "./workstream.js";

/** Which workstream each channel belongs to, by durable key, or null for none. */
export type SlotBindings = ReadonlyArray<string | null>;

/**
 * The device's geography, and the only state the plugin owns rather than reads.
 *
 * `bindings` is always `CHANNEL_COUNT` long, so the cap is the shape of the
 * value rather than a rule applied to it: a fourth channel cannot be expressed
 * and a fourth workstream can only become overflow (ADR-0009).
 *
 * `detached` is what makes an assignment stick. Without it, taking a workstream
 * off the device would last only until the next snapshot, which would hand it
 * straight back to the channel it was just removed from. A detached workstream
 * stays overflow until it is deliberately taken back.
 */
export type Slots = {
  readonly bindings: SlotBindings;
  readonly detached: readonly string[];
};

export function emptySlots(): Slots {
  return { bindings: Array.from({ length: CHANNEL_COUNT }, () => null), detached: [] };
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
export function channelWorkstreams(slots: Slots, workstreams: readonly Workstream[]): Array<Workstream | null> {
  const present = presentByKey(workstreams);
  return slots.bindings.map((key) => (key && present.get(key)) || null);
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
export function overflowOf(slots: Slots, workstreams: readonly Workstream[]): Workstream[] {
  const shown = new Set(channelWorkstreams(slots, workstreams).filter(Boolean));
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
 * channel hostage forever. A workstream the developer detached is passed over
 * entirely: it asked to be off the device.
 */
export function bind(slots: Slots, workstreams: readonly Workstream[]): Slots {
  const detached = new Set(slots.detached);
  const waiting = overflowOf(slots, workstreams).filter((workstream) => !detached.has(workstreamKey(workstream)));
  if (waiting.length === 0) return slots;

  const present = presentByKey(workstreams);
  const bindings = [...slots.bindings];
  // A channel bound to a workstream that is not here is only a memory, and a
  // memory yields to something real — but only after every truly free channel.
  const channels = bindings.map((key, slot) => ({
    slot,
    kind: key === null ? "free" : present.has(key) ? "held" : "remembered"
  }));
  const available = [
    ...channels.filter((channel) => channel.kind === "free"),
    ...channels.filter((channel) => channel.kind === "remembered")
  ];

  const claimed = new Set(bindings.filter((key): key is string => key !== null));
  for (const workstream of waiting) {
    const key = workstreamKey(workstream);
    // Two workstreams on one checkout would otherwise take two channels under
    // one name, which would make position ambiguous. The second stays overflow.
    if (claimed.has(key)) continue;
    const channel = available.shift();
    if (!channel) break; // Every channel is taken: the rest are overflow.
    bindings[channel.slot] = key;
    claimed.add(key);
  }
  return { bindings, detached: slots.detached };
}

/**
 * What a channel could show, in the order holding it offers them: nothing, then
 * every workstream no *other* channel is holding.
 *
 * "Nothing" is first and always available, so a channel can always be cleared,
 * and the cycle always returns to where it started rather than trapping the
 * developer in a list.
 */
export function candidatesFor(slots: Slots, slot: number, workstreams: readonly Workstream[]): Array<string | null> {
  if (!isSlot(slot)) return [null];
  const heldElsewhere = new Set(slots.bindings.filter((key, index): key is string => key !== null && index !== slot));
  const offered = workstreams
    .map(workstreamKey)
    .filter((key, index, keys) => !heldElsewhere.has(key) && keys.indexOf(key) === index);
  return [null, ...offered];
}

/**
 * Moves a channel on to the next thing it could show. This is the whole of
 * reassignment: hold a channel holding a workstream and it lets go, hold an
 * empty one and it takes in the first workstream waiting, hold again and it
 * offers the next.
 *
 * Whatever leaves a channel is detached, so the next snapshot does not
 * immediately hand it back; whatever enters one stops being detached. Without
 * that, releasing a channel would last until Herdr next spoke, which is no time
 * at all.
 */
export function cycle(slots: Slots, slot: number, workstreams: readonly Workstream[]): Slots {
  if (!isSlot(slot)) return slots;
  const candidates = candidatesFor(slots, slot, workstreams);
  const current = slots.bindings[slot];
  const position = candidates.findIndex((key) => key === current);
  const next = candidates[(position + 1) % candidates.length] ?? null;
  if (next === current) return slots;

  const bindings = [...slots.bindings];
  bindings[slot] = next;

  const detached = new Set(slots.detached);
  if (current !== null) detached.add(current);
  if (next !== null) detached.delete(next);
  return { bindings, detached: [...detached] };
}

/**
 * Forgets detached workstreams that no longer exist.
 *
 * A workstream the developer took off the device and then closed has nothing
 * left to remember, and without this the list would grow for as long as the
 * plugin runs.
 */
export function forgetAbsent(slots: Slots, workstreams: readonly Workstream[]): Slots {
  const present = presentByKey(workstreams);
  const detached = slots.detached.filter((key) => present.has(key));
  return detached.length === slots.detached.length ? slots : { bindings: slots.bindings, detached };
}

/**
 * Reads the geography back out of stored settings.
 *
 * Settings are written by an older version of this plugin, edited by hand, or
 * corrupted, so nothing here is trusted: anything unreadable yields an empty
 * device rather than a broken one, which the developer can simply use.
 */
export function readSlots(stored: unknown): Slots {
  const source = (stored ?? {}) as { slots?: unknown; detached?: unknown };
  const stored_bindings = Array.isArray(source.slots) ? source.slots : [];

  const seen = new Set<string>();
  const bindings = Array.from({ length: CHANNEL_COUNT }, (_, slot) => {
    const key = stored_bindings[slot];
    // A workstream in two channels at once would make position meaningless, so
    // the first channel claiming it wins.
    if (typeof key !== "string" || key === "" || seen.has(key)) return null;
    seen.add(key);
    return key;
  });

  const detached = (Array.isArray(source.detached) ? source.detached : []).filter(
    (key): key is string => typeof key === "string" && key !== "" && !seen.has(key)
  );
  return { bindings, detached: [...new Set(detached)] };
}

/** The shape written to settings. Kept beside `readSlots` so the two agree. */
export function storedSlots(slots: Slots): { slots: Array<string | null>; detached: string[] } {
  return { slots: [...slots.bindings], detached: [...slots.detached] };
}

export function sameSlots(left: Slots, right: Slots): boolean {
  return (
    left.bindings.length === right.bindings.length &&
    left.bindings.every((key, slot) => key === right.bindings[slot]) &&
    left.detached.length === right.detached.length &&
    left.detached.every((key) => right.detached.includes(key))
  );
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
