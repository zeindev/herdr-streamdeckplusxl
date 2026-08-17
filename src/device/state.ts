import type { HerdrEvent } from "../herdr/protocol.js";
import type { HerdrSnapshot, PaneSnapshot, ResolvedThemeSnapshot, WorktreeEntry } from "../model.js";
import { sameKey, type Command, type DeviceEvent, type DeviceInfo, type KeyAddress } from "./events.js";
import { HEADER_ROW, channelOfColumn, columnInChannel, layoutForDeviceType } from "./geometry.js";
import {
  adoptIntoSlot,
  bind,
  emptySlots,
  overflowOf,
  release,
  sameSlots,
  workstreamKey,
  type SlotBindings
} from "./slots.js";
import { oneWorkspacePerRepository, workstreamsOf, type Branches } from "./workstream.js";

/**
 * How long a burst of structural changes is allowed to settle before the truth
 * is re-read. Herdr can emit many events for one user action, and each read is
 * a whole snapshot, so they are collapsed into one.
 */
export const RESYNC_DEBOUNCE_MS = 120;

/**
 * How long a channel's identity key must be held to change what that channel
 * means.
 *
 * ADR-0009 asks that reassigning a slot be disruptive by design and carry
 * friction, because a channel that changes meaning costs the developer the
 * spatial memory the whole layout is built on. A hold cannot happen by brushing
 * a key, which a tap can.
 */
export const SLOT_HOLD_MS = 1200;

/**
 * `offline` — no connection. `syncing` — connected, but the snapshot has not
 * arrived, so nothing on the wire can be trusted yet. `live` — the snapshot is
 * in hand and events are deltas on top of it.
 */
export type Sync = "offline" | "syncing" | "live";

export type State = {
  sync: Sync;
  snapshot: HerdrSnapshot | null;
  theme: ResolvedThemeSnapshot | null;
  devices: DeviceInfo[];
  /**
   * Branch per checkout path, from `worktree.list`. Held beside the snapshot
   * rather than merged into it because Herdr answers for the two separately, and
   * a snapshot re-read must not drop a branch that has not changed.
   */
  branches: Branches;
  /** Which channel belongs to which workstream, and the only durable state. */
  slots: SlotBindings;
  /** Keys currently held, with when the hold began. */
  pressed: PressedKey[];
  /** When a structural change was first seen, or null when nothing is pending. */
  resyncRequestedAt: number | null;
};

/** A key being held, and since when, so a hold can be told from a tap. */
export type PressedKey = { key: KeyAddress; at: number };

export type Step = { state: State; commands: Command[] };

export function initialState(): State {
  return {
    sync: "offline",
    snapshot: null,
    theme: null,
    devices: [],
    branches: {},
    slots: emptySlots(),
    pressed: [],
    resyncRequestedAt: null
  };
}

/**
 * Events that change the shape of the session rather than the contents of one
 * pane. Herdr's payloads for these are partial, so rather than patching state
 * from them the reducer re-reads the snapshot — which also makes a replayed
 * backlog harmless, since the worst it can cause is one redundant read.
 */
const STRUCTURAL_EVENTS: ReadonlySet<string> = new Set([
  "workspace_created",
  "workspace_updated",
  "workspace_metadata_updated",
  "workspace_closed",
  "workspace_renamed",
  "workspace_moved",
  "workspace_reordered",
  "workspace_focused",
  "worktree_created",
  "worktree_opened",
  "worktree_removed",
  "tab_created",
  "tab_closed",
  "tab_renamed",
  "tab_moved",
  "tab_focused",
  "pane_created",
  "pane_closed",
  "pane_focused",
  "pane_moved",
  "pane_exited",
  "pane_agent_detected",
  "layout_updated"
]);

/**
 * The whole product in one function: state plus one event in, new state and
 * anything to ask Herdr out. It is pure — no clocks, no sockets, no rendering —
 * so every behaviour above can be tested by handing it a list of events.
 */
export function reduce(state: State, event: DeviceEvent): Step {
  switch (event.kind) {
    case "herdr-connection":
      return event.connected
        // A fresh connection replays history, so the stream cannot be trusted
        // until the snapshot says what is actually true.
        ? { state: { ...state, sync: "syncing", resyncRequestedAt: null }, commands: [{ kind: "load-snapshot" }] }
        : { state: { ...state, sync: "offline", resyncRequestedAt: null }, commands: [] };

    case "herdr-snapshot": {
      const snapshot = event.snapshot;
      const workstreams = workstreamsOf(snapshot);
      const slots = bind(state.slots, workstreams);
      return {
        state: {
          ...state,
          sync: "live",
          snapshot,
          // Branches of checkouts that are gone would otherwise accumulate for
          // as long as the plugin runs.
          branches: keepKnownCheckouts(state.branches, snapshot),
          slots,
          resyncRequestedAt: null
        },
        commands: [
          // One read per repository, not per workstream: `worktree.list` answers
          // for a whole repository at once.
          ...oneWorkspacePerRepository(workstreams).map((workspaceId) => ({
            kind: "load-worktrees" as const,
            workspaceId
          })),
          ...savedIfChanged(state.slots, slots)
        ]
      };
    }

    case "settings-loaded": {
      // Whatever was stored is the truth about geography; any workstream it does
      // not mention takes a free channel on the next snapshot.
      const slots = bind(event.slots, workstreamsOf(state.snapshot, state.branches));
      return {
        state: { ...state, slots },
        // Only a binding this load actually added is worth writing back.
        commands: savedIfChanged(event.slots, slots)
      };
    }

    case "herdr-worktrees": {
      const branches = withBranches(state.branches, event.worktrees, state.snapshot);
      return branches === state.branches ? { state, commands: [] } : { state: { ...state, branches }, commands: [] };
    }

    case "herdr-event":
      return applyHerdrEvent(state, event.event, event.at);

    case "tick": {
      const held = heldLongEnough(state, event.at);
      if (held) return applySlotHold(state, held);
      if (state.resyncRequestedAt === null) return { state, commands: [] };
      if (event.at - state.resyncRequestedAt < RESYNC_DEBOUNCE_MS) return { state, commands: [] };
      return { state: { ...state, resyncRequestedAt: null }, commands: [{ kind: "load-snapshot" }] };
    }

    case "theme-changed":
      return { state: { ...state, theme: event.theme }, commands: [] };

    case "device-attached": {
      if (!layoutForDeviceType(event.device.type)) return { state, commands: [] };
      if (state.devices.some((device) => device.id === event.device.id)) return { state, commands: [] };
      return { state: { ...state, devices: [...state.devices, event.device] }, commands: [] };
    }

    case "device-detached":
      return {
        state: {
          ...state,
          devices: state.devices.filter((device) => device.id !== event.deviceId),
          // A device that is gone can never report the release of a held key.
          pressed: state.pressed.filter((held) => held.key.deviceId !== event.deviceId)
        },
        commands: []
      };

    case "key-down": {
      if (state.pressed.some((held) => sameKey(held.key, event.key))) return { state, commands: [] };
      return { state: { ...state, pressed: [...state.pressed, { key: event.key, at: event.at }] }, commands: [] };
    }

    case "key-up": {
      if (!state.pressed.some((held) => sameKey(held.key, event.key))) return { state, commands: [] };
      return {
        state: { ...state, pressed: state.pressed.filter((held) => !sameKey(held.key, event.key)) },
        commands: []
      };
    }

    case "encoder-rotate":
    case "encoder-down":
    case "encoder-up":
      // Accepted so the input path is proven end to end; nothing is bound to an
      // encoder until the channels exist.
      return { state, commands: [] };
  }
}

function applyHerdrEvent(state: State, event: HerdrEvent, at: number): Step {
  // Anything before the snapshot is replayed history describing a session that
  // may no longer exist.
  if (state.sync !== "live" || !state.snapshot) return { state, commands: [] };

  if (event.event === "pane_updated") {
    const snapshot = withUpdatedPane(state.snapshot, event.data.pane);
    return snapshot === state.snapshot ? { state, commands: [] } : { state: { ...state, snapshot }, commands: [] };
  }

  if (STRUCTURAL_EVENTS.has(event.event)) {
    // Already pending: the burst collapses into the read already scheduled.
    if (state.resyncRequestedAt !== null) return { state, commands: [] };
    return { state: { ...state, resyncRequestedAt: at }, commands: [] };
  }

  return { state, commands: [] };
}

function savedIfChanged(before: SlotBindings, after: SlotBindings): Command[] {
  return sameSlots(before, after) ? [] : [{ kind: "save-slots", slots: after }];
}

/**
 * A channel's identity key held past the friction threshold, if any.
 *
 * Only that one key per channel changes what the channel means. Every other key
 * is a pane or a control and belongs to another ticket, so a long press
 * elsewhere does nothing rather than doing something surprising.
 */
function heldLongEnough(state: State, at: number): { held: PressedKey; slot: number } | null {
  for (const held of state.pressed) {
    if (at - held.at < SLOT_HOLD_MS) continue;
    const device = state.devices.find((candidate) => candidate.id === held.key.deviceId);
    const layout = device && layoutForDeviceType(device.type);
    if (!layout) continue;
    if (held.key.row !== HEADER_ROW || columnInChannel(layout, held.key.column) !== 0) continue;
    return { held, slot: channelOfColumn(layout, held.key.column) };
  }
  return null;
}

/**
 * What holding a channel's identity key does: a bound channel lets its
 * workstream go, and a free channel takes the workstream that has been waiting
 * longest. Two holds therefore move a workstream to a chosen channel, which is
 * the deliberate act ADR-0009 asks for.
 *
 * The hold is spent whether or not it changed anything, so it fires once rather
 * than on every tick while the key stays down.
 */
function applySlotHold(state: State, { held, slot }: { held: PressedKey; slot: number }): Step {
  const spent = { ...state, pressed: state.pressed.filter((candidate) => candidate !== held) };
  const workstreams = workstreamsOf(state.snapshot, state.branches);

  if (state.slots[slot] !== null) {
    const slots = release(state.slots, slot);
    return { state: { ...spent, slots }, commands: savedIfChanged(state.slots, slots) };
  }

  const [waiting] = overflowOf(state.slots, workstreams);
  if (!waiting) return { state: spent, commands: [] };

  const slots = adoptIntoSlot(state.slots, slot, workstreamKey(waiting));
  return { state: { ...spent, slots }, commands: savedIfChanged(state.slots, slots) };
}

/** Every checkout path the snapshot's workspaces currently occupy. */
function checkoutPathsOf(snapshot: HerdrSnapshot | null): Set<string> {
  const paths = new Set<string>();
  for (const workspace of snapshot?.workspaces ?? []) {
    if (workspace.worktree) paths.add(workspace.worktree.checkout_path);
  }
  return paths;
}

/**
 * Drops branches for checkouts no longer held by any workspace, and returns the
 * same object when nothing was dropped so an unchanged snapshot causes no redraw.
 */
function keepKnownCheckouts(branches: Branches, snapshot: HerdrSnapshot): Branches {
  const live = checkoutPathsOf(snapshot);
  const kept = Object.entries(branches).filter(([path]) => live.has(path));
  return kept.length === Object.keys(branches).length ? branches : Object.fromEntries(kept);
}

/**
 * Folds a `worktree.list` reply into the known branches.
 *
 * A repository usually has worktrees no workspace is open on, so only the ones a
 * workspace occupies are kept — otherwise the map would grow with checkouts the
 * device can never show.
 */
function withBranches(branches: Branches, worktrees: readonly WorktreeEntry[], snapshot: HerdrSnapshot | null): Branches {
  const wanted = checkoutPathsOf(snapshot);
  let next: Record<string, string | null> | null = null;
  for (const worktree of worktrees) {
    if (!wanted.has(worktree.path)) continue;
    // A worktree on no branch is an answer, not a missing one, so it is recorded
    // as null rather than skipped: the device shows the two differently.
    const branch = worktree.branch ?? null;
    if (worktree.path in branches && branches[worktree.path] === branch) continue;
    next ??= { ...branches };
    next[worktree.path] = branch;
  }
  return next ?? branches;
}

/**
 * Replaces one pane in the snapshot, ignoring an update that is older than what
 * is already known. Revisions only move forward, so a lower one is a replay.
 */
function withUpdatedPane(snapshot: HerdrSnapshot, incoming: unknown): HerdrSnapshot {
  if (!incoming || typeof incoming !== "object") return snapshot;
  const pane = incoming as PaneSnapshot & { revision?: number };
  if (typeof pane.pane_id !== "string") return snapshot;

  const index = snapshot.panes.findIndex((candidate) => candidate.pane_id === pane.pane_id);
  if (index < 0) return snapshot; // A pane the snapshot does not know: the resync will bring it.

  const known = snapshot.panes[index] as PaneSnapshot & { revision?: number };
  if (typeof known.revision === "number" && typeof pane.revision === "number" && pane.revision <= known.revision) {
    return snapshot;
  }

  const panes = [...snapshot.panes];
  panes[index] = pane;
  return { ...snapshot, panes };
}
