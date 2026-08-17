import type { AgentStatus } from "../model.js";
import { CHANNEL_COUNT, HEADER_ROW, channelKeyIndex, keyCount, layoutForDeviceType, type DeviceLayout } from "./geometry.js";
import { channelWorkstreams, overflowOf } from "./slots.js";
import type { State } from "./state.js";
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
 */
export type EncoderFace = { title: string; value: string };

export type DeviceSurface = {
  deviceId: string;
  layout: DeviceLayout["kind"];
  keys: KeyFace[];
  encoders: EncoderFace[];
};

export type Surface = { devices: DeviceSurface[] };

const BLANK: KeyFace = { kind: "blank" };

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
      encoders: encodersOf(state, layout, overflow)
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
 * A channel's header, left to right: who it is, which branch, and how it is
 * doing. Three keys, so each reading has a fixed position and the same reading
 * sits at the same place in all three channels.
 */
function headerOf(channel: number, workstream: Workstream | null): KeyFace[] {
  if (!workstream) return [{ kind: "empty", slot: channel }, BLANK, BLANK];
  const worktree = workstream.worktree;
  // The label leads and the repository follows: a monorepo hosts several
  // workstreams at once, so the repository name alone can name all three
  // channels identically while the label is what the developer chose.
  const repository = worktree?.repoName;
  return [
    detail(workstream.label, repository === workstream.label ? undefined : repository),
    { kind: "text", label: branchLabel(worktree) },
    stateFace(workstream.agentStatus)
  ];
}

/**
 * Three different facts that would otherwise all read as "no branch": a
 * workspace Herdr tracks no checkout for, a checkout sitting on no branch, and
 * a checkout Herdr has not been asked about yet.
 */
function branchLabel(worktree: Workstream["worktree"]): string {
  if (!worktree) return "NO WORKTREE";
  if (worktree.branch === undefined) return "UNKNOWN";
  return worktree.branch ?? "DETACHED";
}

function detail(label: string, context: string | undefined): KeyFace {
  return context ? { kind: "text", label, detail: context } : { kind: "text", label };
}

/** No agent is a reading of its own, not an unknown one. */
function stateFace(status: AgentStatus | undefined): KeyFace {
  return status ? { kind: "status", label: status.toUpperCase(), status } : { kind: "text", label: "NO AGENT" };
}

function encodersOf(state: State, layout: DeviceLayout, overflow: number): EncoderFace[] {
  const snapshot = state.snapshot;
  const sync = state.sync === "live" ? "LIVE" : state.sync === "syncing" ? "SYNCING" : "OFFLINE";
  const faces: EncoderFace[] = [
    { title: "HERDR", value: sync },
    { title: "WORKSPACES", value: snapshot ? String(snapshot.workspaces?.length ?? 0) : "-" },
    { title: "PANES", value: snapshot ? String(snapshot.panes.length) : "-" }
  ];
  while (faces.length < layout.encoders) faces.push({ title: "", value: "" });
  const regions = faces.slice(0, layout.encoders);
  // The rightmost region carries the overflow count on an XL-only rig, since
  // ADR-0011 leaves the XL without a global rail. It appears only when there is
  // something to report: a permanent zero is a number the eye learns to skip,
  // and being over budget has to stay noticeable.
  if (overflow > 0) regions[regions.length - 1] = { title: "OVERFLOW", value: `+${overflow}` };
  return regions;
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
  before: ReadonlyArray<object> | undefined,
  after: ReadonlyArray<object>
): void {
  for (let index = 0; index < after.length; index++) {
    const previous = before?.[index];
    if (previous && sameFace(previous, after[index])) continue;
    changes.push({ deviceId, control, index, face: after[index] as ControlChange["face"] });
  }
}

/**
 * Compares faces field by field rather than by serialising them: faces are flat
 * and this runs for every control on every tick, so key ordering must not be
 * able to report an unchanged control as changed.
 */
function sameFace(left: object, right: object): boolean {
  const leftKeys = Object.keys(left) as Array<keyof typeof left>;
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === (right as typeof left)[key]);
}
