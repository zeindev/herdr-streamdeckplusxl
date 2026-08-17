import type { AgentStatus, PaneSnapshot } from "../model.js";
import { attentionByPane, attentionIn, attentionOf, type AttentionItem, type PaneAttention } from "./attention.js";
import { CHANNEL_COUNT, channelKeyIndex, keyCount, layoutForDeviceType, type DeviceLayout } from "./geometry.js";
import type { PaneCell } from "./panes.js";
import { paneKeyLabel } from "./panes.js";
import type { PaneProcesses, Role } from "./role.js";
import { channelWorkstreams, overflowOf } from "./slots.js";
import { channelRowsOf, type State } from "./state.js";
import { OVERFLOW_CELLS, stripBlockOf, type StripBlock } from "./strip.js";
import { workstreamsOf, type Workstream } from "./workstream.js";

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
  | { kind: "text"; label: string; detail?: string }
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
   */
  | { kind: "pane"; label: string; role: Role; status?: AgentStatus; attention?: PaneAttention }
  /** Panes a row had no key for. A count, never silence. */
  | { kind: "more"; count: number }
  /** An unassigned channel, which invites a worktree rather than showing nothing. */
  | { kind: "empty"; slot: number };

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
      keys: keysOf(state, layout, workstreams, attentionByPane(attention)),
      encoders: encodersOf(layout, workstreams, panes, overflow, noticeFor(state), attention)
    });
  }
  return { devices };
}

function keysOf(
  state: State,
  layout: DeviceLayout,
  workstreams: ReadonlyArray<Workstream | null>,
  attention: ReadonlyMap<string, PaneAttention>
): KeyFace[] {
  const keys = Array.from({ length: keyCount(layout) }, () => BLANK);
  for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
    if (!workstreams[channel]) {
      // Nothing to show and something to offer, so the channel's first key asks
      // for a worktree rather than leaving three columns of unexplained black.
      keys[channelKeyIndex(layout, channel, 0, 0)] = { kind: "empty", slot: channel };
      continue;
    }
    channelRowsOf(state, layout, channel).forEach((row, rowIndex) =>
      row.forEach((cell, column) => {
        if (cell) keys[channelKeyIndex(layout, channel, column, rowIndex)] = paneFace(cell, state.processes, attention);
      })
    );
  }
  return keys;
}

function paneFace(
  cell: PaneCell,
  processes: PaneProcesses,
  attention: ReadonlyMap<string, PaneAttention>
): KeyFace {
  if (cell.kind === "more") return { kind: "more", count: cell.count };
  const label = paneKeyLabel(cell.pane, processes[cell.pane.pane_id] ?? undefined, cell.role);
  const asking = attention.get(cell.pane.pane_id);
  const raised = asking ? { attention: asking } : {};
  if (!cell.pane.agent) return { kind: "pane", label, role: cell.role, ...raised };
  return { kind: "pane", label, role: cell.role, status: cell.pane.agent_status, ...raised };
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
