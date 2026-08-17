import type { AgentStatus, PaneSnapshot } from "../model.js";
import {
  CHANNEL_COUNT,
  HEADER_ROW,
  IDENTITY_COLUMN,
  channelKeyIndex,
  keyCount,
  layoutForDeviceType,
  type DeviceLayout
} from "./geometry.js";
import { channelWorkstreams, overflowOf } from "./slots.js";
import type { State } from "./state.js";
import { OVERFLOW_COLUMNS, stripBlockOf, type StripBlock } from "./strip.js";
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
  | { kind: "status"; label: string; status: AgentStatus }
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
  /**
   * A message that replaces the whole strip, or null when there is none.
   *
   * Used when Herdr cannot be trusted: every branch and every count would be
   * whatever was last true rather than what is true, so the strip says why it is
   * dark instead of showing a confident lie.
   */
  notice: string | null;
};

export type DeviceSurface = {
  deviceId: string;
  layout: DeviceLayout["kind"];
  keys: KeyFace[];
  encoders: EncoderFace[];
};

export type Surface = { devices: DeviceSurface[] };

const BLANK: KeyFace = { kind: "blank" };
const EMPTY_BLOCK: StripBlock = { branch: null, fields: [] };

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
  const devices: DeviceSurface[] = [];
  for (const device of state.devices) {
    const layout = layoutForDeviceType(device.type);
    if (!layout) continue;
    devices.push({
      deviceId: device.id,
      layout: layout.kind,
      keys: keysOf(layout, workstreams),
      encoders: encodersOf(layout, workstreams, state.snapshot?.panes ?? [], overflow, noticeFor(state))
    });
  }
  return { devices };
}

function keysOf(layout: DeviceLayout, workstreams: ReadonlyArray<Workstream | null>): KeyFace[] {
  const keys = Array.from({ length: keyCount(layout) }, () => BLANK);
  for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
    const header = headerOf(channel, workstreams[channel] ?? null);
    for (let column = 0; column < header.length; column++) {
      keys[channelKeyIndex(layout, channel, column, HEADER_ROW)] = header[column];
    }
  }
  return keys;
}

/**
 * A channel's header: who it is, and how it is doing.
 *
 * The branch used to sit between them and now lives on the strip, where it is
 * permanently visible and has room not to be truncated into ambiguity. What
 * stays on keys is what the strip has no room for — the 400px budget holds the
 * branch and the readings, not a label and a repository as well (ADR-0007).
 */
function headerOf(channel: number, workstream: Workstream | null): KeyFace[] {
  if (!workstream) return atIdentity({ kind: "empty", slot: channel });
  // The label leads and the repository follows: a monorepo hosts several
  // workstreams at once, so the repository name alone can name all three
  // channels identically while the label is what the developer chose.
  const repository = workstream.worktree?.repoName;
  return atIdentity(
    detail(workstream.label, repository === workstream.label ? undefined : repository),
    stateFace(workstream.agentStatus)
  );
}

/** Lays faces out from the identity column rightwards, blanking the rest. */
function atIdentity(...faces: KeyFace[]): KeyFace[] {
  const header = Array.from({ length: faces.length + IDENTITY_COLUMN }, () => BLANK);
  faces.forEach((face, offset) => (header[IDENTITY_COLUMN + offset] = face));
  return header;
}

function detail(label: string, context: string | undefined): KeyFace {
  return context ? { kind: "text", label, detail: context } : { kind: "text", label };
}

/** No agent is a reading of its own, not an unknown one. */
function stateFace(status: AgentStatus | undefined): KeyFace {
  return status ? { kind: "status", label: status.toUpperCase(), status } : { kind: "text", label: "NO AGENT" };
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
  notice: string | null
): EncoderFace[] {
  const last = layout.encoders - 1;
  const lastChannel = Math.floor(last / layout.encodersPerChannel);
  const blocks = notice
    ? workstreams.map(() => EMPTY_BLOCK)
    : workstreams.map((workstream, channel) =>
        stripBlockOf(workstream, panes, overflow > 0 && channel === lastChannel ? OVERFLOW_COLUMNS : 0)
      );

  return Array.from({ length: layout.encoders }, (_, region) => ({
    block: blocks[Math.floor(region / layout.encodersPerChannel)] ?? EMPTY_BLOCK,
    overflow: notice || region !== last ? 0 : overflow,
    notice
  }));
}

/**
 * Why the strip is dark, when it is.
 *
 * Herdr being unreachable is not a state any single channel can express, and
 * leaving the last known branches lit would be a confident lie about a session
 * that may no longer exist at all.
 */
function noticeFor(state: State): string | null {
  if (state.sync === "live") return null;
  return state.sync === "syncing" ? "SYNCING" : "HERDR OFFLINE";
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
