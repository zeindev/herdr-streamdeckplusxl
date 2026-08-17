import type { AgentStatus, PaneSnapshot } from "../model.js";
import { REASON_ORDER, attentionByPane, attentionIn, attentionOf, type AttentionItem, type AttentionReason } from "./attention.js";
import { ACTIONS_COLUMN, FOCUS_COLUMN, GIT_COLUMN, acknowledgementFor } from "./control.js";
import { CHANNEL_COUNT, channelKeyIndex, keyCount, layoutForDeviceType, type DeviceLayout } from "./geometry.js";
import { channelAgentStatus, mostUrgentPaneOf, paneKeyLabel, type PaneCell } from "./panes.js";
import { roleResolver } from "./role.js";
import type { PaneProcesses, Role } from "./role.js";
import { channelWorkstreams, overflowOf } from "./slots.js";
import { channelRowsOf, type State } from "./state.js";
import { OVERFLOW_CELLS, stripBlockOf, type StripBlock } from "./strip.js";
import { workstreamIdentity, workstreamsOf, type Workstream } from "./workstream.js";

/**
 * What a control shows, described rather than drawn. Turning a face into pixels
 * is the renderer's job, so nothing here contains an image and this whole module
 * can be tested by comparing plain values.
 *
 * A `status` face always carries the word as well as the status, so the reading
 * survives for anyone who cannot tell the outline colours apart.
 */
export type KeyFace =
  | { kind: "blank" }
  /**
   * One of the control row's three fixed keys (ADR-0011, ADR-0012). `danger`
   * is the armed destructive state; `feedback: "success"` is a brief green
   * acknowledgement of a command that worked. A failed or refused one is
   * carried as `danger` with the cause in `detail`, the same visual language
   * `attention`'s `exited` already uses for "something here is simply wrong".
   */
  | { kind: "text"; label: string; detail?: string; danger?: boolean; feedback?: "success" }
  /**
   * A pane, named, with the role that put it on this row and — only when it runs
   * an agent — that agent's live state.
   *
   * A pane with no agent has no state to report: Herdr says `unknown` for every
   * one of them, and drawing that as a reading would put a marked outline on
   * every service in every channel while saying nothing at all.
   *
   * `attention` is separate from `status` because the two are different facts.
   * A finished agent stays finished after the developer has looked at it; what
   * changes is that it has stopped asking. Folding the two together would mean
   * either lying about the status or never being able to stop asking.
   *
   * A pane running no agent can still carry `exited`, since the service that
   * died was running in it and the pane outlived the service.
   */
  | { kind: "pane"; label: string; role: Role; status?: AgentStatus; attention?: AttentionReason }
  /**
   * Panes a row had no key for. A count, never silence — and marked when one of
   * the panes it stands for is asking, so a rise in the channel's total always
   * has somewhere on the grid that explains it.
   */
  | { kind: "more"; count: number; attention?: AttentionReason }
  /** An unassigned channel, which invites a worktree rather than showing nothing. */
  | { kind: "empty"; slot: number }
  /**
   * A workstream's own identity plus its aggregated state — the Mini's top
   * row (ADR-0008, `-vk6`), which has no room to show individual panes the
   * way the XL's rows do. `status` is `channelAgentStatus`'s aggregate over
   * every agent pane the workstream has; `attention` is the same worst-first
   * pick `more` makes, over everything asking anywhere in the workstream
   * rather than only what one row hides.
   */
  | { kind: "workstream"; label: string; status?: AgentStatus; attention?: AttentionReason };

/**
 * An encoder and the touch-strip region above it are one control on the
 * hardware, addressed together, so they are one face here too.
 *
 * A region carries its whole channel's block rather than half of one, because
 * the two regions of a channel are one 400px composition windowed in half. The
 * renderer draws the block and shows the half this region covers, which is what
 * lets a branch or a rule cross the seam between them.
 */
export type EncoderFace = {
  block: StripBlock;
  /**
   * Workstreams over budget, drawn at the far right of the whole strip. Zero on
   * every region but the last, so a change to it redraws one control and not six.
   */
  overflow: number;
};

export type DeviceSurface = {
  deviceId: string;
  layout: DeviceLayout["kind"];
  keys: KeyFace[];
  encoders: EncoderFace[];
};

export type Surface = { devices: DeviceSurface[] };

const BLANK: KeyFace = { kind: "blank" };

const EMPTY_BLOCK: StripBlock = { branch: null, readings: [], notice: null };

/** The most urgent of several reasons, per `REASON_ORDER`, or none when nothing is asking. */
function worstOf(reasons: readonly AttentionReason[]): AttentionReason | undefined {
  return REASON_ORDER.find((reason) => reasons.includes(reason));
}

/**
 * Projects state onto every attached device.
 *
 * The three channels are the whole reading: each one names its workstream, its
 * branch, and its aggregate agent state, and the three are compared by looking
 * across. Pane keys, the control row, and the permanent strip status arrive in
 * later tickets, so everything below the header row is still blank.
 */
export function surfaceOf(state: State): Surface {
  const present = workstreamsOf(state.snapshot, state.branches);
  const workstreams = channelWorkstreams(state.slots, present);
  const overflow = overflowOf(state.slots, present).length;
  const panes = state.snapshot?.panes ?? [];
  // Worked out once for the whole device rather than per channel: the keys and
  // the strip must agree about what is asking, or a key would show something the
  // count beside it did not include.
  const attention = attentionOf(state.snapshot, state.acknowledged);
  const devices: DeviceSurface[] = [];
  for (const device of state.devices) {
    const layout = layoutForDeviceType(device.type);
    if (!layout) continue;
    devices.push({
      deviceId: device.id,
      layout: layout.kind,
      keys: keysOf(state, layout, workstreams, attention),
      encoders: encodersOf(layout, workstreams, panes, overflow, noticeFor(state), attention)
    });
  }
  return { devices };
}

function keysOf(state: State, layout: DeviceLayout, workstreams: ReadonlyArray<Workstream | null>, attention: readonly AttentionItem[]): KeyFace[] {
  if (layout.kind === "mini") return miniKeysOf(state, layout, workstreams, attention);

  const attentionByPaneId = attentionByPane(attention);
  const keys = Array.from({ length: keyCount(layout) }, () => BLANK);
  for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
    const workstream = workstreams[channel];
    if (!workstream) {
      // Nothing to show and something to offer, so the channel's first key asks
      // for a worktree rather than leaving three columns of unexplained black.
      keys[channelKeyIndex(layout, channel, 0, 0)] = { kind: "empty", slot: channel };
      continue;
    }
    channelRowsOf(state, layout, channel).forEach((row, rowIndex) =>
      row.forEach((cell, column) => {
        if (cell) keys[channelKeyIndex(layout, channel, column, rowIndex)] = paneFace(cell, state.processes, attentionByPaneId);
      })
    );
    const controlRow = layout.rows - 1;
    for (let column = 0; column < layout.columnsPerChannel; column++) {
      keys[channelKeyIndex(layout, channel, column, controlRow)] = controlFace(column, workstream, state);
    }
  }
  return keys;
}

/**
 * The Mini's two rows (ADR-0008, `-vk6`): a workstream's identity and
 * aggregate state on top, its single most urgent pane below. Nothing here
 * organises by role or draws a control row — the Mini has two keys per
 * channel and no room for either, and pretending otherwise is exactly what
 * "the device must degrade honestly" rules out.
 *
 * `attention` arrives as the raw, un-narrowed list rather than already keyed
 * by pane: the top row needs every item a workstream has, pane-scoped or
 * not (`workstreamFace`'s own doc explains why), while the bottom row needs
 * the pane-keyed form `mostUrgentPaneOf` and `paneFace` both expect — so
 * both shapes are derived here, once, from the one list passed in.
 */
function miniKeysOf(state: State, layout: DeviceLayout, workstreams: ReadonlyArray<Workstream | null>, attention: readonly AttentionItem[]): KeyFace[] {
  const attentionByPaneId = attentionByPane(attention);
  const keys = Array.from({ length: keyCount(layout) }, () => BLANK);
  const panes = state.snapshot?.panes ?? [];
  const roleFor = roleResolver(state.processes, state.roles);

  for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
    const workstream = workstreams[channel];
    if (!workstream) {
      keys[channelKeyIndex(layout, channel, 0, 0)] = { kind: "empty", slot: channel };
      continue;
    }
    keys[channelKeyIndex(layout, channel, 0, 0)] = workstreamFace(workstream, panes, attentionIn(attention, workstream.workspaceId));
    const urgent = mostUrgentPaneOf(workstream, panes, attentionByPaneId);
    if (urgent) {
      const cell: PaneCell = { kind: "pane", pane: urgent, role: roleFor(urgent) };
      keys[channelKeyIndex(layout, channel, 0, 1)] = paneFace(cell, state.processes, attentionByPaneId);
    }
  }
  return keys;
}

/**
 * A workstream's identity and aggregate state, for the Mini's top row.
 *
 * `attention` is already narrowed to this one workstream and covers every
 * item it has, pane-scoped or not — unlike a pane key's own mark, this one
 * must not miss an orphaned dead service just because it named no pane
 * (`attention.ts`'s `AttentionItem` allows `exited` to carry no `paneId`).
 */
function workstreamFace(workstream: Workstream, panes: readonly PaneSnapshot[], attention: readonly AttentionItem[]): KeyFace {
  const status = channelAgentStatus(workstream, panes);
  const worst = worstOf(attention.map((item) => item.reason));
  return {
    kind: "workstream",
    label: workstreamIdentity(workstream),
    ...(status ? { status } : {}),
    ...(worst ? { attention: worst } : {})
  };
}

/**
 * One of the control row's three fixed keys (ADR-0011, ADR-0012).
 *
 * A live acknowledgement always wins over the idle face — it is the most
 * recent thing this key did, and the developer pressed it to find out. Only
 * the actions key has an armed state to show beneath that, since focus and
 * git/pull-request have nothing to escalate to.
 */
function controlFace(column: number, workstream: Workstream, state: State): KeyFace {
  const ack = acknowledgementFor(state.controlAcknowledgements, workstream.workspaceId, column);
  if (ack) {
    return {
      kind: "text",
      label: controlLabel(column, workstream),
      detail: ack.message,
      ...(ack.ok ? { feedback: "success" as const } : { danger: true })
    };
  }
  if (column === ACTIONS_COLUMN && state.armed?.workspaceId === workstream.workspaceId) {
    return { kind: "text", label: "STOP AGAIN", danger: true };
  }
  return { kind: "text", label: controlLabel(column, workstream), ...(column === GIT_COLUMN ? { detail: "GIT" } : {}) };
}

/**
 * What each control key is called, idle. The git/pull-request key alone
 * carries the workstream's own identity rather than its own verb name — this
 * is where `-0vd.2` put the repository name once panes took row 0, since a
 * checkout with no branch still names itself by label the same way a channel
 * with no worktree does everywhere else on this device (ADR-0003).
 */
function controlLabel(column: number, workstream: Workstream): string {
  if (column === FOCUS_COLUMN) return "FOCUS";
  if (column === GIT_COLUMN) return workstream.worktree?.repoName || workstream.label;
  return "PROMPT";
}

function paneFace(
  cell: PaneCell,
  processes: PaneProcesses,
  attention: ReadonlyMap<string, AttentionReason>
): KeyFace {
  if (cell.kind === "more") {
    // The most urgent thing hiding behind the count, in the same order the
    // items themselves are ranked, so which one surfaces never depends on the
    // order Herdr listed the panes in.
    const hidden = cell.panes.map((pane) => attention.get(pane.pane_id)).filter((reason): reason is AttentionReason => Boolean(reason));
    const worst = worstOf(hidden);
    return { kind: "more", count: cell.count, ...(worst ? { attention: worst } : {}) };
  }
  const label = paneKeyLabel(cell.pane, processes[cell.pane.pane_id] ?? undefined, cell.role);
  const asking = attention.get(cell.pane.pane_id);
  return {
    kind: "pane",
    label,
    role: cell.role,
    // A pane with no agent has no state to report, so the field is absent
    // rather than carrying Herdr's `unknown` for every service on the device.
    ...(cell.pane.agent ? { status: cell.pane.agent_status } : {}),
    ...(asking ? { attention: asking } : {})
  };
}

/**
 * The strip, region by region: each channel's block repeated across the two
 * regions that show it.
 *
 * The overflow count lives on the last region, because ADR-0011 leaves the XL
 * without a global rail and the rightmost region is where that decision put it.
 * It appears only when there is something to report — a permanent zero is a
 * number the eye learns to skip, and being over budget has to stay noticeable —
 * and the channel sharing that region gives up the space rather than overlapping.
 */
function encodersOf(
  layout: DeviceLayout,
  workstreams: ReadonlyArray<Workstream | null>,
  panes: readonly PaneSnapshot[],
  overflow: number,
  notice: string | null,
  attention: readonly AttentionItem[]
): EncoderFace[] {
  // The Mini has no dials and no strip (ADR-0008): nothing to divide by, and
  // nothing to draw — an explicit early return rather than trusting the
  // arithmetic below to degrade gracefully at zero.
  if (layout.encoders === 0) return [];

  const last = layout.encoders - 1;
  const lastChannel = Math.floor(last / layout.encodersPerChannel);
  const blocks = workstreams.map((workstream, channel) =>
    stripBlockOf(workstream, panes, {
      reserved: !notice && overflow > 0 && channel === lastChannel ? OVERFLOW_CELLS : 0,
      notice,
      attention: attentionIn(attention, workstream?.workspaceId ?? null)
    })
  );

  return Array.from({ length: layout.encoders }, (_, region) => ({
    block: blocks[Math.floor(region / layout.encodersPerChannel)] ?? EMPTY_BLOCK,
    overflow: notice || region !== last ? 0 : overflow
  }));
}

/**
 * Why a channel's readings are missing, when they are.
 *
 * Herdr being unreachable makes every count whatever was last true rather than
 * what is true, so the counts go. The branch stays: a branch does not change
 * because Herdr died, and a channel with no identity at all would be worse than
 * one whose numbers are admittedly stale.
 *
 * Each channel carries the notice rather than the strip carrying one centrally,
 * because a region only ever draws its own block — a single message would be
 * visible on one region out of six.
 */
function noticeFor(state: State): string | null {
  if (state.sync === "live") return null;
  return state.sync === "syncing" ? "SYNCING" : "OFFLINE";
}

export type ControlKind = "key" | "encoder";

export type ControlChange = {
  deviceId: string;
  control: ControlKind;
  index: number;
  face: KeyFace | EncoderFace;
};

/**
 * The controls that differ between two surfaces.
 *
 * Herdr's `pane_updated` arrives dozens of times a second, so redrawing every
 * control on every change would swamp the device. Comparing faces means only
 * what actually moved is sent.
 */
export function changedControls(previous: Surface, next: Surface): ControlChange[] {
  const before = new Map(previous.devices.map((device) => [device.deviceId, device]));
  const changes: ControlChange[] = [];

  for (const device of next.devices) {
    const old = before.get(device.deviceId);
    collect(changes, device.deviceId, "key", old?.keys, device.keys);
    collect(changes, device.deviceId, "encoder", old?.encoders, device.encoders);
  }

  // Devices only in `previous` are gone; there is nothing left to draw on.
  return changes;
}

function collect(
  changes: ControlChange[],
  deviceId: string,
  control: ControlKind,
  before: ReadonlyArray<unknown> | undefined,
  after: ReadonlyArray<unknown>
): void {
  for (let index = 0; index < after.length; index++) {
    const previous = before?.[index];
    if (previous !== undefined && sameFace(previous, after[index])) continue;
    changes.push({ deviceId, control, index, face: after[index] as ControlChange["face"] });
  }
}

/**
 * Compares faces by value rather than by serialising them.
 *
 * This runs for every control on every tick, and a face is rebuilt from scratch
 * each time, so comparing by identity would redraw the whole device ten times a
 * second. Serialising would work but would make key ordering significant, which
 * would report unchanged controls as changed.
 */
function sameFace(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameFace(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && sameFace(left[key], right[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
