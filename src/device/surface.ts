import { keyCount, layoutForDeviceType, type DeviceLayout } from "./geometry.js";
import type { State } from "./state.js";

/**
 * What a control shows, described rather than drawn. Turning a face into pixels
 * is the renderer's job, so nothing here contains an image and this whole module
 * can be tested by comparing plain values.
 */
export type KeyFace = { kind: "blank" } | { kind: "text"; label: string; detail?: string };

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
 * Deliberately almost empty: the keys stay blank until workstreams exist, and
 * the strip shows only enough for the connection to be visibly alive. What this
 * establishes is the geometry and the seam, not the product.
 */
export function surfaceOf(state: State): Surface {
  const devices: DeviceSurface[] = [];
  for (const device of state.devices) {
    const layout = layoutForDeviceType(device.type);
    if (!layout) continue;
    devices.push({
      deviceId: device.id,
      layout: layout.kind,
      keys: Array.from({ length: keyCount(layout) }, () => BLANK),
      encoders: encodersOf(state, layout)
    });
  }
  return { devices };
}

function encodersOf(state: State, layout: DeviceLayout): EncoderFace[] {
  const snapshot = state.snapshot;
  const sync = state.sync === "live" ? "LIVE" : state.sync === "syncing" ? "SYNCING" : "OFFLINE";
  const faces: EncoderFace[] = [
    { title: "HERDR", value: sync },
    { title: "WORKSPACES", value: snapshot ? String(snapshot.workspaces?.length ?? 0) : "-" },
    { title: "PANES", value: snapshot ? String(snapshot.panes.length) : "-" }
  ];
  while (faces.length < layout.encoders) faces.push({ title: "", value: "" });
  return faces.slice(0, layout.encoders);
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

function sameFace(left: object, right: object): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
