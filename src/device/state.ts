import type { HerdrEvent } from "../herdr/protocol.js";
import type { HerdrSnapshot, PaneProcess, PaneSnapshot, ResolvedThemeSnapshot, WorktreeEntry } from "../model.js";
import { sameKey, type Command, type DeviceEvent, type DeviceInfo, type KeyAddress } from "./events.js";
import { channelOfColumn, columnInChannel, layoutForDeviceType, type DeviceLayout } from "./geometry.js";
import { channelRows, type PaneCell } from "./panes.js";
import { commandKeyOf, nextRole, roleResolver, type PaneProcesses, type RoleOverrides } from "./role.js";
import { bind, channelWorkstreams, cycle, emptySlots, forgetAbsent, sameSlots, type Slots } from "./slots.js";
import { oneWorkspacePerRepository, workstreamsOf, type Branches } from "./workstream.js";

/**
 * How long a burst of structural changes is allowed to settle before the truth
 * is re-read. Herdr can emit many events for one user action, and each read is
 * a whole snapshot, so they are collapsed into one.
 */
export const RESYNC_DEBOUNCE_MS = 120;

/**
 * How long a key must be held for the hold to mean something rather than the tap.
 *
 * One threshold for the whole device: a tap acts on what a control shows, a hold
 * changes what it means. ADR-0009 asks that reassigning a slot carry friction,
 * and the same reasoning covers correcting a pane's role — both change what a
 * position means, and neither may happen by brushing a key.
 */
export const HOLD_MS = 1200;

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
  /** Which channel belongs to which workstream. Durable. */
  slots: Slots;
  /** What Herdr says is running in each pane, so a role can be worked out. */
  processes: PaneProcesses;
  /** Roles the developer corrected, keyed by command line. Durable. */
  roles: RoleOverrides;
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
    processes: {},
    roles: {},
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
      const slots = bind(forgetAbsent(state.slots, workstreams), workstreams);
      return {
        state: {
          ...state,
          sync: "live",
          snapshot,
          // Branches of checkouts that are gone would otherwise accumulate for
          // as long as the plugin runs.
          branches: keepKnownCheckouts(state.branches, snapshot),
          // A pane that is gone can never be asked about again.
          processes: keepKnownPanes(state.processes, snapshot),
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
          ...unknownPanes(state.processes, snapshot).map((paneId) => ({
            kind: "load-process-info" as const,
            paneId
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
        state: { ...state, slots, roles: event.roles },
        // Only a binding this load actually added is worth writing back.
        commands: savedIfChanged(event.slots, slots)
      };
    }

    case "herdr-process-info": {
      if (state.processes[event.paneId] === event.process) return { state, commands: [] };
      return { state: { ...state, processes: { ...state.processes, [event.paneId]: event.process } }, commands: [] };
    }

    case "herdr-worktrees": {
      const branches = withBranches(state.branches, event.worktrees, state.snapshot);
      return branches === state.branches ? { state, commands: [] } : { state: { ...state, branches }, commands: [] };
    }

    case "herdr-event":
      return applyHerdrEvent(state, event.event, event.at);

    case "tick": {
      // A hold and a due resync are independent, so one firing must never delay
      // the other by a whole beat.
      const held = heldLongEnough(state, event.at);
      const hold = held ? applyHold(state, held) : { state, commands: [] };
      const resync = dueResync(hold.state, event.at);
      return { state: resync.state, commands: [...hold.commands, ...resync.commands] };
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
      const pressed = state.pressed.filter((held) => !sameKey(held.key, event.key));
      // A hold has already fired and taken its press with it, so anything still
      // held here was a tap. A tap on a pane focuses it in Herdr.
      const cell = cellAt(state, event.key);
      const commands: Command[] =
        cell?.kind === "pane"
          ? [{ kind: "herdr-request", method: "pane.focus", params: { pane_id: cell.pane.pane_id } }]
          : [];
      return { state: { ...state, pressed }, commands };
    }

    case "encoder-touch": {
      // Holding a channel's strip is what reassigns it. It moved here from the
      // channel's first key when the panes took that row, and the strip suits it
      // better: the SDK reports the hold itself, so no timer is needed.
      if (!event.hold) return { state, commands: [] };
      const layout = layoutOf(state, event.deviceId);
      if (!layout) return { state, commands: [] };
      const slots = cycle(state.slots, Math.floor(event.encoder / layout.encodersPerChannel), presentWorkstreams(state));
      return { state: { ...state, slots }, commands: savedIfChanged(state.slots, slots) };
    }

    case "encoder-rotate":
    case "encoder-down":
    case "encoder-up":
      // Accepted so the input path is proven end to end; nothing is bound to an
      // encoder until the dials get their verbs.
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

function dueResync(state: State, at: number): Step {
  if (state.resyncRequestedAt === null) return { state, commands: [] };
  if (at - state.resyncRequestedAt < RESYNC_DEBOUNCE_MS) return { state, commands: [] };
  return { state: { ...state, resyncRequestedAt: null }, commands: [{ kind: "load-snapshot" }] };
}

function savedIfChanged(before: Slots, after: Slots): Command[] {
  return sameSlots(before, after) ? [] : [{ kind: "save-slots", slots: after }];
}

/** The first key held past the friction threshold, if any. */
function heldLongEnough(state: State, at: number): PressedKey | null {
  return state.pressed.find((held) => at - held.at >= HOLD_MS) ?? null;
}

/**
 * What holding a pane key does: correct what the device thinks that pane is for,
 * one role at a time, wrapping.
 *
 * The correction is remembered against the pane's command line rather than the
 * pane, so it outlives the pane being restarted — a dev server that crashed and
 * came back is the same job in a new pane. A pane whose command line is not
 * known yet cannot be corrected, because there would be nothing to remember it
 * by, and a correction that quietly forgot itself would be worse than none.
 *
 * The hold is spent whether or not it changed anything, so it fires once rather
 * than on every tick while the key stays down.
 */
function applyHold(state: State, held: PressedKey): Step {
  const spent = { ...state, pressed: state.pressed.filter((candidate) => candidate !== held) };
  const cell = cellAt(state, held.key);
  if (cell?.kind !== "pane") return { state: spent, commands: [] };

  const key = commandKeyOf(state.processes[cell.pane.pane_id] ?? undefined);
  if (!key) return { state: spent, commands: [] };

  const roles = { ...state.roles, [key]: nextRole(cell.role) };
  return { state: { ...spent, roles }, commands: [{ kind: "save-roles", roles }] };
}

/** The layout of an attached device, or null when it is not one we drive. */
function layoutOf(state: State, deviceId: string): DeviceLayout | null {
  const device = state.devices.find((candidate) => candidate.id === deviceId);
  return device ? layoutForDeviceType(device.type) : null;
}

/** Workstreams Herdr currently holds, in the order channels take them. */
function presentWorkstreams(state: State) {
  return workstreamsOf(state.snapshot, state.branches);
}

/**
 * What sits on one key, which is what a press acts on.
 *
 * Derived the same way the projection derives it, from the same inputs, so a
 * press can never act on something other than what the developer is looking at.
 */
function cellAt(state: State, key: KeyAddress): PaneCell | null {
  const layout = layoutOf(state, key.deviceId);
  if (!layout) return null;
  const rows = channelRows(
    channelWorkstreams(state.slots, presentWorkstreams(state))[channelOfColumn(layout, key.column)] ?? null,
    state.snapshot?.panes ?? [],
    roleResolver(state.processes, state.roles),
    layout.columnsPerChannel
  );
  return rows[key.row]?.[columnInChannel(layout, key.column)] ?? null;
}

/** Panes Herdr has not been asked about yet, and which need asking about. */
function unknownPanes(processes: PaneProcesses, snapshot: HerdrSnapshot): string[] {
  // An agent pane needs no lookup: Herdr detects agents itself and says so on
  // the snapshot, which is both cheaper and more reliable than any pattern.
  return snapshot.panes
    .filter((pane) => !pane.agent && !(pane.pane_id in processes))
    .map((pane) => pane.pane_id);
}

/** Drops what was learned about panes that no longer exist. */
function keepKnownPanes(processes: PaneProcesses, snapshot: HerdrSnapshot): PaneProcesses {
  const live = new Set(snapshot.panes.map((pane) => pane.pane_id));
  const kept = Object.entries(processes).filter(([paneId]) => live.has(paneId));
  return kept.length === Object.keys(processes).length ? processes : Object.fromEntries(kept);
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
