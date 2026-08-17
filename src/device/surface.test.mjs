import assert from "node:assert/strict";
import test from "node:test";

import { DEVICE_TYPE_XL } from "../../.preview/device/geometry.js";
import { initialState, reduce } from "../../.preview/device/state.js";
import { changedControls, surfaceOf } from "../../.preview/device/surface.js";

function run(events, from = initialState()) {
  let state = from;
  for (const event of events) state = reduce(state, event).state;
  return state;
}

const attachXl = { kind: "device-attached", device: { id: "xl-1", type: DEVICE_TYPE_XL } };

function liveState({ workspaces = [], panes = [] } = {}) {
  return run([
    attachXl,
    { kind: "herdr-connection", connected: true },
    { kind: "herdr-snapshot", snapshot: { workspaces, panes, tabs: [] } }
  ]);
}

test("no attached device means nothing to draw", () => {
  assert.deepEqual(surfaceOf(initialState()).devices, []);
});

test("an attached XL gets the full 9 by 4 grid and six encoders", () => {
  const surface = surfaceOf(run([attachXl]));
  assert.equal(surface.devices.length, 1);

  const [device] = surface.devices;
  assert.equal(device.deviceId, "xl-1");
  assert.equal(device.keys.length, 36);
  // An encoder and the strip region above it are one control on the hardware,
  // addressed together, so there are six of them and not twelve.
  assert.equal(device.encoders.length, 6);
});

test("the surface is declarative and carries no rendered image", () => {
  const device = surfaceOf(liveState({ panes: [{ pane_id: "w1:p1" }] })).devices[0];
  const serialised = JSON.stringify(device);
  assert.ok(!serialised.includes("<svg"), "the surface describes controls, it does not draw them");
  assert.ok(!serialised.includes("data:image"));
});

test("every key is blank until workstreams exist", () => {
  const device = surfaceOf(liveState({ panes: [{ pane_id: "w1:p1" }] })).devices[0];
  assert.ok(device.keys.every((key) => key.kind === "blank"));
});

test("the strip reports being offline before Herdr answers", () => {
  const device = surfaceOf(run([attachXl])).devices[0];
  assert.equal(device.encoders[0].value, "OFFLINE");
});

test("the strip reports syncing between connecting and the snapshot arriving", () => {
  const device = surfaceOf(run([attachXl, { kind: "herdr-connection", connected: true }])).devices[0];
  assert.equal(device.encoders[0].value, "SYNCING");
});

test("the strip reports what Herdr actually holds once live", () => {
  const device = surfaceOf(
    liveState({ workspaces: [{ workspace_id: "w1" }, { workspace_id: "w2" }], panes: [{ pane_id: "a" }, { pane_id: "b" }, { pane_id: "c" }] })
  ).devices[0];
  assert.equal(device.encoders[0].value, "LIVE");
  assert.match(device.encoders[1].value, /2/, "the workspace count is shown");
  assert.match(device.encoders[2].value, /3/, "the pane count is shown");
});

test("the same state projects to an identical surface every time", () => {
  const state = liveState({ panes: [{ pane_id: "w1:p1" }] });
  assert.deepEqual(surfaceOf(state), surfaceOf(state));
});

test("nothing is reported as changed between identical surfaces", () => {
  const state = liveState({ panes: [{ pane_id: "w1:p1" }] });
  assert.deepEqual(changedControls(surfaceOf(state), surfaceOf(state)), []);
});

test("only the controls that actually differ are reported as changed", () => {
  // This is what keeps the pane_updated flood from redrawing the whole device.
  const before = liveState({ workspaces: [{ workspace_id: "w1" }], panes: [{ pane_id: "a" }] });
  const after = liveState({ workspaces: [{ workspace_id: "w1" }], panes: [{ pane_id: "a" }, { pane_id: "b" }] });

  const changes = changedControls(surfaceOf(before), surfaceOf(after));
  assert.ok(changes.length > 0, "the pane count moved, so something must redraw");
  assert.ok(
    changes.every((change) => change.control === "encoder"),
    "no key changed, so no key may be redrawn"
  );
});

test("attaching a device reports every one of its controls as new", () => {
  const changes = changedControls(surfaceOf(initialState()), surfaceOf(run([attachXl])));
  assert.equal(changes.filter((change) => change.control === "key").length, 36);
  assert.equal(changes.filter((change) => change.control === "encoder").length, 6);
  assert.equal(changes.length, 42, "every control on the device, and no more");
});

test("detaching a device reports no changes for it, since there is nothing to draw on", () => {
  const attached = run([attachXl]);
  const detached = run([{ kind: "device-detached", deviceId: "xl-1" }], attached);
  assert.deepEqual(changedControls(surfaceOf(attached), surfaceOf(detached)), []);
});

test("a change names the device and index so the adapter can address it", () => {
  const [change] = changedControls(surfaceOf(initialState()), surfaceOf(run([attachXl])));
  assert.equal(change.deviceId, "xl-1");
  assert.equal(typeof change.index, "number");
  assert.ok(change.face);
});
