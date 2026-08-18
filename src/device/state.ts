import type { HerdrEvent } from "../herdr/protocol.js";
import type { HerdrSnapshot, PaneProcess, PaneSnapshot, ResolvedThemeSnapshot, WorktreeEntry } from "../model.js";
import {
  acknowledge,
  acknowledges,
  attentionByPane,
  attentionOf,
  keepAcknowledged,
  sameAcknowledged,
  worstAttentionItem,
  type Acknowledged
} from "./attention.js";
import {
  ACTIONS_COLUMN,
  CONTINUE_PROMPT,
  FOCUS_COLUMN,
  GIT_COLUMN,
  acknowledge as acknowledgeControl,
  arm,
  armedElsewhere,
  dueArmTimeout,
  isArmedFor,
  liveAcknowledgements,
  type ArmedAction,
  type ControlOutcome
} from "./control.js";
import {
  dial1Notice,
  dialItemsOf,
  pressBrowse,
  pressScrub,
  revertIdleDial1,
  rotateBrowse,
  rotateScrub,
  type DialSelection
} from "./dial.js";
import { sameKey, type Command, type DeviceEvent, type DeviceInfo, type KeyAddress } from "./events.js";
import { CHANNEL_COUNT, channelOfColumn, channelOfEncoder, columnInChannel, isDial1, layoutForDeviceType, type DeviceLayout, type Rig } from "./geometry.js";
import { agentPaneOf, channelRows, mostUrgentPaneOf, type PaneCell } from "./panes.js";
import {
  commandKeyOf,
  commandLineOf,
  identifyingProcess,
  nextRole,
  roleResolver,
  type PaneProcesses,
  type RoleOverrides
} from "./role.js";
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
 * How many panes `recentFocus` remembers, well past the two the Mini's paired
 * surface shows. The headroom is so a pane closing does not immediately
 * empty a key that had something to show a moment ago.
 */
const RECENT_FOCUS_LIMIT = 6;

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
  /**
   * Panes whose finished agent the developer has already looked at. Durable,
   * because Herdr keeps reporting `done` and would otherwise ask again every
   * time the plugin started.
   */
  acknowledged: Acknowledged;
  /** Keys currently held, with when the hold began. */
  pressed: PressedKey[];
  /**
   * Panes the developer has jumped to lately, most recent first, deduped.
   * Feeds the Mini's paired global surface (`-4w7`), which has room to show
   * two. Ephemeral rather than durable — like `pressed` and `armed`, it is a
   * live convenience rather than geography, so it starts empty on every
   * restart instead of surviving one the way `slots` and `roles` do.
   */
  recentFocus: readonly string[];
  /**
   * Each channel's own dial 1 (`-u5d`), by channel index — browsing its
   * workstream's panes and attention, or scrubbing a pane it was pushed into.
   * Ephemeral like `pressed`, `armed`, and `recentFocus`: a browsed selection
   * is a preview, not geography, and even a committed scrub is only ever
   * about a pane that exists right now.
   */
  dial1: ReadonlyArray<DialSelection | null>;
  /** When a structural change was first seen, or null when nothing is pending. */
  resyncRequestedAt: number | null;
  /** The one actions key currently armed for a destructive interrupt, if any. */
  armed: ArmedAction | null;
  /** What each control key most recently showed about its own last press. */
  controlAcknowledgements: readonly ControlOutcome[];
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
    acknowledged: [],
    pressed: [],
    recentFocus: [],
    dial1: Array.from({ length: CHANNEL_COUNT }, () => null),
    resyncRequestedAt: null,
    armed: null,
    controlAcknowledgements: []
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
      const acknowledged = keepAcknowledged(state.acknowledged, snapshot);
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
          acknowledged,
          // A pane that is gone can never be jumped back to.
          recentFocus: keepKnownRecent(state.recentFocus, snapshot),
          // A scrub scrubbing a pane that is gone has nothing left to scrub;
          // a browsed selection is left alone, since its index still resolves
          // against whatever the channel's items are once redrawn.
          dial1: state.dial1.map((selection) => keepKnownDial1(selection, snapshot)),
          resyncRequestedAt: null
        },
        commands: [
          ...savedIfAcknowledgedChanged(state.acknowledged, acknowledged),
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
      // Stored acknowledgements can name panes that are already gone or already
      // back at work, and they must not survive that — pruning here rather than
      // waiting for the next snapshot means a stale mark can never swallow the
      // first thing that finishes after a restart.
      const acknowledged = keepAcknowledged(event.acknowledged, state.snapshot);
      return {
        state: { ...state, slots, roles: event.roles, acknowledged },
        // Only a binding this load actually added is worth writing back.
        commands: [
          ...savedIfChanged(event.slots, slots),
          ...savedIfAcknowledgedChanged(event.acknowledged, acknowledged)
        ]
      };
    }

    case "herdr-process-info": {
      const process = identifyingProcess(event.info ?? undefined) ?? null;
      const known = state.processes[event.paneId];
      if (known !== undefined && commandLineOf(known ?? undefined) === commandLineOf(process ?? undefined)) {
        return { state, commands: [] };
      }
      return { state: { ...state, processes: { ...state.processes, [event.paneId]: process } }, commands: [] };
    }

    case "herdr-worktrees": {
      const branches = withBranches(state.branches, event.worktrees, state.snapshot);
      return branches === state.branches ? { state, commands: [] } : { state: { ...state, branches }, commands: [] };
    }

    case "herdr-event":
      return applyHerdrEvent(state, event.event, event.at);

    case "tick": {
      // A hold, a due resync, an expired arm, an expired acknowledgement and an
      // idle dial-1 preview are all independent, so one firing must never delay
      // another by a whole beat.
      const held = heldLongEnough(state, event.at);
      const hold = held ? applyHold(state, held, event.at) : { state, commands: [] };
      const resync = dueResync(hold.state, event.at);
      const armed = dueArmTimeout(resync.state.armed, event.at) ? null : resync.state.armed;
      const controlAcknowledgements = liveAcknowledgements(resync.state.controlAcknowledgements, event.at);
      // Comparing against each selection's own `at` — never a timer captured
      // when the preview started — is what lets a fresher rotate on the same
      // dial always win over a stale revert, however late this tick arrives.
      const dial1 = resync.state.dial1.map((selection) => revertIdleDial1(selection, event.at));
      return {
        state: { ...resync.state, armed, controlAcknowledgements, dial1 },
        commands: [...hold.commands, ...resync.commands]
      };
    }

    case "theme-changed":
      return { state: { ...state, theme: event.theme }, commands: [] };

    case "control-acknowledged": {
      const controlAcknowledgements = acknowledgeControl(
        state.controlAcknowledgements,
        { workspaceId: event.workspaceId, column: event.column, ok: event.ok, message: event.message },
        event.at
      );
      return { state: { ...state, controlAcknowledgements }, commands: [] };
    }

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
      // DESIGN.md's Latest Action Rule: the most recent physical press wins, so
      // pressing anything other than the armed actions key itself cancels a
      // pending arm rather than leaving it live for a confirmation the
      // developer was not reaching for.
      const armed = armedElsewhere(state.armed, controlCellAt(state, event.key)) ? null : state.armed;
      if (state.pressed.some((held) => sameKey(held.key, event.key))) {
        return armed === state.armed ? { state, commands: [] } : { state: { ...state, armed }, commands: [] };
      }
      return { state: { ...state, armed, pressed: [...state.pressed, { key: event.key, at: event.at }] }, commands: [] };
    }

    case "key-up": {
      if (!state.pressed.some((held) => sameKey(held.key, event.key))) return { state, commands: [] };
      const pressed = state.pressed.filter((held) => !sameKey(held.key, event.key));
      // A hold has already fired and taken its press with it, so anything still
      // held here was a tap.
      const cell = cellAt(state, event.key);
      if (cell?.kind === "pane") {
        // Going to look at finished work is what acknowledges it, so the same
        // tap does both. Anything else would be a second gesture for something
        // the first one already accomplishes.
        const acknowledged = acknowledges(cell.pane, state.snapshot)
          ? acknowledge(state.acknowledged, cell.pane.pane_id)
          : state.acknowledged;
        const recentFocus = withRecentFocus(state.recentFocus, cell.pane.pane_id);
        return {
          state: { ...state, pressed, acknowledged, recentFocus },
          commands: [
            { kind: "herdr-request", method: "pane.focus", params: { pane_id: cell.pane.pane_id } },
            ...savedIfAcknowledgedChanged(state.acknowledged, acknowledged)
          ]
        };
      }

      const control = controlCellAt(state, event.key);
      if (control) return applyControlTap({ ...state, pressed }, control, event.at);
      return { state: { ...state, pressed }, commands: [] };
    }

    case "encoder-touch": {
      // Holding a channel's strip is what reassigns it. It moved here from the
      // channel's first key when the panes took that row, and the strip suits it
      // better: the SDK reports the hold itself, so no timer is needed.
      if (!event.hold) return { state, commands: [] };
      const layout = layoutOf(state, event.deviceId);
      if (!layout) return { state, commands: [] };
      const channel = channelOfEncoder(layout, event.encoder);
      const slots = cycle(state.slots, channel, presentWorkstreams(state));
      // The channel now shows a different workstream, or none at all, so
      // whatever dial 1 was browsing or scrubbing there no longer applies.
      const dial1 = sameSlots(state.slots, slots) ? state.dial1 : withDial1(state.dial1, channel, null);
      return { state: { ...state, slots, dial1 }, commands: savedIfChanged(state.slots, slots) };
    }

    case "encoder-rotate": {
      const layout = layoutOf(state, event.deviceId);
      // Dial 1 only exists on the XL, and only its first encoder of each pair —
      // the second is dial 2's, `-8e8`'s to wire up.
      if (!layout || layout.kind !== "xl" || !isDial1(layout, event.encoder)) return { state, commands: [] };
      return applyDial1Rotate(state, channelOfEncoder(layout, event.encoder), event.ticks, event.at);
    }

    case "encoder-down": {
      const layout = layoutOf(state, event.deviceId);
      if (!layout || layout.kind !== "xl" || !isDial1(layout, event.encoder)) return { state, commands: [] };
      return applyDial1Press(state, channelOfEncoder(layout, event.encoder), event.at);
    }

    case "encoder-up":
      // The push already fired on `encoder-down` — a dial has no hold gesture
      // to distinguish from a tap the way a key does, so there is nothing left
      // for the release to do.
      return { state, commands: [] };
  }
}

/** Replaces one channel's dial-1 slot, leaving the array's identity alone when nothing changed. */
function withDial1(dial1: ReadonlyArray<DialSelection | null>, channel: number, selection: DialSelection | null): ReadonlyArray<DialSelection | null> {
  if (dial1[channel] === selection) return dial1;
  const next = [...dial1];
  next[channel] = selection;
  return next;
}

/**
 * A channel's dial-1 items, from state — the reducer and the projection must
 * agree on these, the same way `channelRowsOf` already has to for the panes
 * on a channel's keys.
 */
function dial1ItemsOf(state: State, channel: number) {
  const workstream = channelWorkstreams(state.slots, presentWorkstreams(state))[channel];
  if (!workstream) return { workstream: null, items: [] as ReturnType<typeof dialItemsOf> };
  const items = dialItemsOf(workstream, state.snapshot?.panes ?? [], attentionOf(state.snapshot, state.acknowledged));
  return { workstream, items };
}

/**
 * What a channel's strip says about dial 1, if anything (`-u5d`). Shared with
 * the projection so the strip and the dial's own press/rotate handling can
 * never disagree about which item is selected.
 */
export function dial1NoticeOf(state: State, channel: number): string | null {
  const { items } = dial1ItemsOf(state, channel);
  return dial1Notice(state.dial1[channel] ?? null, items);
}

/**
 * Turning dial 1: moves the browsed selection, or — once a push has committed
 * to a pane — moves its scrollback offset instead. Browsing never asks Herdr
 * for anything; scrubbing does, because scrubbing *is* asking Herdr for a
 * different window of a pane's history to show.
 */
function applyDial1Rotate(state: State, channel: number, ticks: number, at: number): Step {
  const { workstream, items } = dial1ItemsOf(state, channel);
  if (!workstream) return { state, commands: [] };

  const current = state.dial1[channel];
  if (current?.mode === "scrub") {
    const next = rotateScrub(current, ticks, at);
    const dial1 = withDial1(state.dial1, channel, next);
    return { state: { ...state, dial1 }, commands: [scrollCommand(next.paneId, next.offset)] };
  }

  const next = rotateBrowse(current, items, ticks, at);
  return { state: { ...state, dial1: withDial1(state.dial1, channel, next) }, commands: [] };
}

/**
 * Pushing dial 1: commits a browsed item to `scrub` and focuses its pane, or,
 * already scrubbing, returns that pane to live output. Focusing here is
 * `pane.focus`, the same request a pane key's own tap already sends, so the
 * two paths can never disagree about what "focus" means.
 */
function applyDial1Press(state: State, channel: number, at: number): Step {
  const { workstream, items } = dial1ItemsOf(state, channel);
  if (!workstream) return { state, commands: [] };

  const current = state.dial1[channel];
  if (current?.mode === "scrub") {
    if (current.offset === 0) return { state, commands: [] }; // already live; nothing to commit
    const next = pressScrub(current, at);
    return { state: { ...state, dial1: withDial1(state.dial1, channel, next) }, commands: [scrollCommand(next.paneId, next.offset)] };
  }
  if (current?.mode !== "browse") return { state, commands: [] };

  const next = pressBrowse(current, items, at);
  if (!next) return { state, commands: [] }; // the browsed item named no pane to focus
  const dial1 = withDial1(state.dial1, channel, next);
  const recentFocus = withRecentFocus(state.recentFocus, next.paneId);
  return { state: { ...state, dial1, recentFocus }, commands: [{ kind: "herdr-request", method: "pane.focus", params: { pane_id: next.paneId } }] };
}

/**
 * Asks Herdr to show a different window of a pane's scrollback.
 *
 * `pane.scroll` is not in `protocol.ts`'s verified vocabulary — nothing in
 * this repo has confirmed the request side of `PaneInfo.scroll` (ADR-0007)
 * against a live Herdr the way `pane.focus` and `pane.send_keys` already
 * have. `offset` is lines back from live, 0 meaning live itself. Validate
 * both the method name and this shape on hardware before shipping.
 */
function scrollCommand(paneId: string, offset: number): Command {
  return { kind: "herdr-request", method: "pane.scroll", params: { pane_id: paneId, offset } };
}

function applyHerdrEvent(state: State, event: HerdrEvent, at: number): Step {
  // Anything before the snapshot is replayed history describing a session that
  // may no longer exist.
  if (state.sync !== "live" || !state.snapshot) return { state, commands: [] };

  if (event.event === "pane_updated") {
    const snapshot = withUpdatedPane(state.snapshot, event.data.pane);
    if (snapshot === state.snapshot) return { state, commands: [] };
    // An agent leaving `done` un-acknowledges it, and this is the only path that
    // sees it happen: agent status arrives on `pane_updated`, which is a delta
    // and schedules no snapshot re-read. Pruning only on a re-read would leave a
    // mark from the last completion sitting over the next one, possibly for a
    // long time, and the second time an agent finished the device would say
    // nothing.
    const acknowledged = keepAcknowledged(state.acknowledged, snapshot);
    return {
      state: { ...state, snapshot, acknowledged },
      commands: savedIfAcknowledgedChanged(state.acknowledged, acknowledged)
    };
  }

  if (event.event === "pane_exited") {
    // What was running in that pane has stopped, so what the plugin knows about
    // it is now a guess about a process that no longer exists. Forgetting it
    // makes the next snapshot ask again, which is how a pane that was running a
    // test watcher and is now running a dev server stops being on the wrong row.
    const forgotten = withoutPane(state, event.data.pane_id);
    if (state.resyncRequestedAt !== null) return { state: forgotten, commands: [] };
    return { state: { ...forgotten, resyncRequestedAt: at }, commands: [] };
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

function savedIfAcknowledgedChanged(before: Acknowledged, after: Acknowledged): Command[] {
  return sameAcknowledged(before, after) ? [] : [{ kind: "save-acknowledged", acknowledged: after }];
}

/** The first key held past the friction threshold, if any. */
function heldLongEnough(state: State, at: number): PressedKey | null {
  return state.pressed.find((held) => at - held.at >= HOLD_MS) ?? null;
}

/**
 * What holding a key does: correct a pane's role one step at a time, or arm
 * the channel's actions key for its destructive interrupt. Whichever it is,
 * the hold is spent whether or not it changed anything, so it fires once
 * rather than on every tick while the key stays down.
 */
function applyHold(state: State, held: PressedKey, at: number): Step {
  const spent = { ...state, pressed: state.pressed.filter((candidate) => candidate !== held) };
  const cell = cellAt(state, held.key);
  if (cell?.kind === "pane") {
    const key = commandKeyOf(state.processes[cell.pane.pane_id] ?? undefined);
    if (!key) return { state: spent, commands: [] };
    const roles = { ...state.roles, [key]: nextRole(cell.role) };
    return { state: { ...spent, roles }, commands: [{ kind: "save-roles", roles }] };
  }

  const control = controlCellAt(state, held.key);
  // Only the actions key has anything a hold can do. Holding focus or the
  // git/pull-request key is a no-op, the same as holding a key nothing else
  // is placed on — those verbs have nothing to escalate to.
  if (!control || control.column !== ACTIONS_COLUMN) return { state: spent, commands: [] };
  return { state: { ...spent, armed: arm(control.workspaceId, at) }, commands: [] };
}

/**
 * The control row is the last row of every channel on the XL; this resolves
 * a press to which channel's workstream and which of the three fixed verbs
 * it landed on.
 *
 * Derived the same way `surfaceOf` derives it, from the same inputs, so a
 * press can never act on a different workstream than the one the developer is
 * looking at (ADR-0011, ADR-0012). The Mini has no control row at all
 * (ADR-0008) — its own last row is the most-urgent-pane row `cellAt` already
 * resolves, so this returns null there rather than misreading a pane tap as
 * a verb because the two devices happen to share a row index.
 */
function controlCellAt(state: State, key: KeyAddress): { workspaceId: string; column: number } | null {
  const layout = layoutOf(state, key.deviceId);
  if (!layout || layout.kind !== "xl" || key.row !== layout.rows - 1) return null;
  const channel = channelOfColumn(layout, key.column);
  const workstream = channelWorkstreams(state.slots, presentWorkstreams(state))[channel];
  return workstream ? { workspaceId: workstream.workspaceId, column: columnInChannel(layout, key.column) } : null;
}

/**
 * What tapping one of the control row's three keys does.
 *
 * `pressed` has already had this press removed by the caller; every branch
 * here only decides what else changes and what, if anything, Herdr is asked.
 */
function applyControlTap(state: State, control: { workspaceId: string; column: number }, at: number): Step {
  if (control.column === FOCUS_COLUMN) {
    return {
      state,
      commands: [
        {
          kind: "control-command",
          workspaceId: control.workspaceId,
          column: FOCUS_COLUMN,
          method: "workspace.focus",
          params: { workspace_id: control.workspaceId },
          successMessage: "FOCUSED"
        }
      ]
    };
  }

  if (control.column === GIT_COLUMN) {
    // `-wl7` put pull-request state on the strip (`sd_pr`, read by
    // `pullRequestReadingValue`), but taught nothing about opening a browser
    // to it — that scope is still unclaimed, so this key has nowhere to send
    // a tap and says so rather than pretending to be a shortcut it is not.
    return { state: locallyAcknowledged(state, control, false, "NO PR YET", at), commands: [] };
  }

  // ACTIONS_COLUMN. An armed key confirms the interrupt; an unarmed one sends
  // the fixed prompt. Both need the same pane, so they share the lookup.
  const pane = agentPaneOf(control.workspaceId, state.snapshot?.panes ?? []);
  if (isArmedFor(state.armed, control.workspaceId, control.column, at)) {
    const disarmed = { ...state, armed: null };
    if (!pane) return { state: locallyAcknowledged(disarmed, control, false, "NO AGENT", at), commands: [] };
    return {
      state: disarmed,
      commands: [
        {
          kind: "control-command",
          workspaceId: control.workspaceId,
          column: control.column,
          method: "pane.send_keys",
          params: { pane_id: pane.pane_id, keys: ["C-c"] },
          successMessage: "STOPPED"
        }
      ]
    };
  }

  if (!pane) return { state: locallyAcknowledged(state, control, false, "NO AGENT", at), commands: [] };
  return {
    state,
    commands: [{ kind: "control-prompt", workspaceId: control.workspaceId, column: control.column, paneId: pane.pane_id, text: CONTINUE_PROMPT }]
  };
}

/** Records an outcome the reducer already knows, with no round trip to Herdr. */
function locallyAcknowledged(state: State, control: { workspaceId: string; column: number }, ok: boolean, message: string, at: number): State {
  return {
    ...state,
    controlAcknowledgements: acknowledgeControl(
      state.controlAcknowledgements,
      { workspaceId: control.workspaceId, column: control.column, ok, message },
      at
    )
  };
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
 * One channel's rows, from state.
 *
 * The reducer and the projection both need this, and they must agree: if a press
 * acted on a different layout than the one drawn, the device would do something
 * other than what the developer was looking at.
 */
export function channelRowsOf(state: State, layout: DeviceLayout, channel: number): Array<Array<PaneCell | null>> {
  return channelRows(
    channelWorkstreams(state.slots, presentWorkstreams(state))[channel] ?? null,
    state.snapshot?.panes ?? [],
    roleResolver(state.processes, state.roles),
    layout.columnsPerChannel
  );
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
  if (layout.kind === "mini") return miniCellAt(state, layout, key);
  const rows = channelRowsOf(state, layout, channelOfColumn(layout, key.column));
  return rows[key.row]?.[columnInChannel(layout, key.column)] ?? null;
}

/**
 * What sits on a Mini key. Standalone, it mirrors a channel (`-vk6`); paired
 * with an XL, it is the global surface instead (`-4w7`) — the rig decides
 * which, and only the rig, so the same physical key resolves differently
 * the instant a second device attaches or leaves, with nothing to restart.
 */
function miniCellAt(state: State, layout: DeviceLayout, key: KeyAddress): PaneCell | null {
  if (rigOf(state) === "paired") return globalCellAt(state, key);

  // The Mini's bottom-row key: its channel's most urgent pane, resolved the
  // same way `surfaceOf` resolves it (`mostUrgentPaneOf`), so a tap can never
  // focus a different pane than the one the key is actually showing. The top
  // row names the workstream, not a pane, so nothing resolves there — `-vk6`
  // only asks that a bottom-row tap focus a pane, and the top row has none to
  // offer.
  if (key.row !== 1) return null;
  const channel = channelOfColumn(layout, key.column);
  const workstream = channelWorkstreams(state.slots, presentWorkstreams(state))[channel];
  if (!workstream) return null;
  const panes = state.snapshot?.panes ?? [];
  const attention = attentionByPane(attentionOf(state.snapshot, state.acknowledged));
  const pane = mostUrgentPaneOf(workstream, panes, attention);
  return paneCellOf(state, pane?.pane_id);
}

/**
 * The rig currently connected (CONTEXT.md), derived from the devices the
 * plugin has seen `device-attached`/`device-detached` events for. Nothing
 * else may decide this — the Mini's surface and the XL strip's overflow
 * digit both have to agree about which rig they are in, or attaching a
 * second device could make one of them lie.
 */
export function rigOf(state: State): Rig {
  const hasXL = state.devices.some((device) => layoutForDeviceType(device.type)?.kind === "xl");
  const hasMini = state.devices.some((device) => layoutForDeviceType(device.type)?.kind === "mini");
  if (hasXL && hasMini) return "paired";
  return hasMini ? "mini-only" : "xl-only";
}

/**
 * Where the paired Mini's six keys resolve to a pane, row-major like every
 * other key address on this device: row 0 is the attention queue's single
 * most urgent item, then the two most recently focused panes. Row 1 —
 * overflow, worktree creation, settings — has no pane behind it, so a tap
 * there resolves to nothing, the same way an XL control key does.
 */
function globalCellAt(state: State, key: KeyAddress): PaneCell | null {
  if (key.row !== 0) return null;
  if (key.column === 0) return queuePaneOf(state);
  if (key.column === 1) return recentPaneOf(state, 0);
  if (key.column === 2) return recentPaneOf(state, 1);
  return null;
}

/**
 * The pane behind the paired Mini's queue key: the single most urgent
 * attention item across every workstream (`worstAttentionItem`), resolved to
 * its pane. Shared between the reducer and the projection, the same way
 * `channelRowsOf` is, so a tap can never jump to a different pane than the
 * key showed. An item with no pane — a dead service whose pane went with it
 * — leaves the key with nothing to jump to, same as the `more` key already
 * does for a hidden pane-less exit.
 */
export function queuePaneOf(state: State): PaneCell | null {
  const worst = worstAttentionItem(attentionOf(state.snapshot, state.acknowledged));
  return worst?.paneId ? paneCellOf(state, worst.paneId) : null;
}

/** One of the paired Mini's two recently focused panes (`recentFocus`), most recent at slot 0. */
export function recentPaneOf(state: State, slot: number): PaneCell | null {
  return paneCellOf(state, state.recentFocus[slot]);
}

function paneCellOf(state: State, paneId: string | undefined): PaneCell | null {
  if (!paneId) return null;
  const pane = state.snapshot?.panes.find((candidate) => candidate.pane_id === paneId);
  return pane ? { kind: "pane", pane, role: roleResolver(state.processes, state.roles)(pane) } : null;
}

/** Remembers a newly focused pane at the front, deduped and capped. */
function withRecentFocus(recentFocus: readonly string[], paneId: string): readonly string[] {
  return [paneId, ...recentFocus.filter((candidate) => candidate !== paneId)].slice(0, RECENT_FOCUS_LIMIT);
}

/** Drops panes from `recentFocus` that no longer exist. */
function keepKnownRecent(recentFocus: readonly string[], snapshot: HerdrSnapshot): readonly string[] {
  const live = new Set(snapshot.panes.map((pane) => pane.pane_id));
  const kept = recentFocus.filter((paneId) => live.has(paneId));
  return kept.length === recentFocus.length ? recentFocus : kept;
}

/** Drops a dial-1 scrub whose pane is gone. A browsed selection has no pane to lose. */
function keepKnownDial1(selection: DialSelection | null, snapshot: HerdrSnapshot): DialSelection | null {
  if (selection?.mode !== "scrub") return selection;
  return snapshot.panes.some((pane) => pane.pane_id === selection.paneId) ? selection : null;
}

/**
 * Panes Herdr has not been asked about yet.
 *
 * Every pane is asked about, agents included. Herdr's own `agent` field still
 * decides the agent row — it is more reliable than any pattern — but a role can
 * only be *corrected* against a command line, so a pane whose command line was
 * never fetched could never be corrected at all. Skipping agents saved one
 * request each and made the agent row the one row nobody could fix.
 */
function unknownPanes(processes: PaneProcesses, snapshot: HerdrSnapshot): string[] {
  return snapshot.panes.filter((pane) => !(pane.pane_id in processes)).map((pane) => pane.pane_id);
}

/** Forgets what was learned about one pane, so it is asked about again. */
function withoutPane(state: State, paneId: unknown): State {
  if (typeof paneId !== "string" || !(paneId in state.processes)) return state;
  const { [paneId]: _gone, ...rest } = state.processes;
  return { ...state, processes: rest };
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
