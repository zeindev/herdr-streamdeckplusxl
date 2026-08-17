import assert from "node:assert/strict";
import test from "node:test";

import { CHANNEL_COUNT, DEVICE_TYPE_XL, HEADER_ROW, XL_LAYOUT, channelKeyIndex } from "../../.preview/device/geometry.js";
import { initialState, reduce } from "../../.preview/device/state.js";
import { changedControls, surfaceOf } from "../../.preview/device/surface.js";
import { recordedWorkspace, recordedWorktree } from "../herdr/fixtures/recorded.mjs";

function run(events, from = initialState()) {
  let state = from;
  for (const event of events) state = reduce(state, event).state;
  return state;
}

const attachXl = { kind: "device-attached", device: { id: "xl-1", type: DEVICE_TYPE_XL } };

function liveState({ workspaces = [], panes = [], worktrees = [] } = {}) {
  return run([
    attachXl,
    { kind: "herdr-connection", connected: true },
    { kind: "herdr-snapshot", snapshot: { workspaces, panes, tabs: [] } },
    { kind: "herdr-worktrees", worktrees }
  ]);
}

/** A workspace on a checkout of its own, which is what a workstream is keyed on. */
function workspaceOn(number, label) {
  const recorded = recordedWorkspace();
  return {
    ...recorded,
    workspace_id: `w${number}`,
    number,
    label,
    worktree: { ...recorded.worktree, checkout_path: `/w/${label}` }
  };
}

/** The three keys of one channel's header row, left to right. */
function header(device, channel) {
  return [0, 1, 2].map((column) => device.keys[channelKeyIndex(XL_LAYOUT, channel, column, HEADER_ROW)]);
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

test("an unassigned channel invites a worktree rather than showing nothing", () => {
  const device = surfaceOf(liveState({ panes: [{ pane_id: "w1:p1" }] })).devices[0];

  for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
    assert.deepEqual(header(device, channel)[0], { kind: "empty", slot: channel });
  }
});

test("three channels sit side by side in Herdr's workspace order", () => {
  const workspaces = [1, 2, 3].map((number) => workspaceOn(number, `stream ${number}`));
  const device = surfaceOf(liveState({ workspaces })).devices[0];

  // The channel is the position, so a workstream is found by where it sits.
  assert.deepEqual(
    [0, 1, 2].map((channel) => header(device, channel)[0].label),
    ["stream 1", "stream 2", "stream 3"]
  );
});

test("each channel owns three columns and nothing outside them", () => {
  const workspaces = [recordedWorkspace({ workspace_id: "w1", number: 1 })];
  const device = surfaceOf(liveState({ workspaces })).devices[0];

  // Only the first channel is bound, so columns 3 to 8 must hold no identity.
  for (let column = 3; column < XL_LAYOUT.columns; column++) {
    const face = device.keys[HEADER_ROW * XL_LAYOUT.columns + column];
    assert.notEqual(face.kind, "status", `column ${column} belongs to another channel`);
  }
});

test("a channel names its repository, its branch, and how it is doing", () => {
  const workspace = recordedWorkspace({ workspace_id: "w6", number: 1 });
  const device = surfaceOf(
    liveState({
      workspaces: [workspace],
      panes: [{ pane_id: "w6:p1", workspace_id: "w6", agent: "claude", agent_status: "blocked" }],
      worktrees: [recordedWorktree()]
    })
  ).devices[0];

  const [identity, branch, state] = header(device, 0);
  assert.equal(identity.label, "fixture probe", "the label the developer chose leads");
  assert.equal(identity.detail, "herdr-streamdeckplusxl", "the repository follows it");
  assert.equal(branch.label, "sd-fixture-probe");
  assert.deepEqual(state, { kind: "status", label: "BLOCKED", status: "blocked" });
});

test("every state carries its word, so colour is never the only reading", () => {
  const workspace = recordedWorkspace({ workspace_id: "w6", number: 1 });
  for (const status of ["idle", "working", "blocked", "done", "unknown"]) {
    const device = surfaceOf(
      liveState({
        workspaces: [workspace],
        panes: [{ pane_id: "w6:p1", workspace_id: "w6", agent: "claude", agent_status: status }]
      })
    ).devices[0];
    assert.deepEqual(header(device, 0)[2], { kind: "status", label: status.toUpperCase(), status });
  }
});

test("a workstream with no agent says so rather than reporting unknown", () => {
  const workspace = recordedWorkspace({ workspace_id: "w6", number: 1 });
  const device = surfaceOf(
    liveState({ workspaces: [workspace], panes: [{ pane_id: "w6:p1", workspace_id: "w6", agent_status: "unknown" }] })
  ).devices[0];

  assert.deepEqual(header(device, 0)[2], { kind: "text", label: "NO AGENT" });
});

test("a workspace with no worktree is shown and labelled, never dropped", () => {
  const workspace = recordedWorkspace({ workspace_id: "w6", number: 1, worktree: null, label: "primary" });
  const device = surfaceOf(liveState({ workspaces: [workspace] })).devices[0];

  const [identity, branch] = header(device, 0);
  assert.equal(identity.label, "primary");
  assert.equal(branch.label, "NO WORKTREE");
});

test("the three ways a branch can be absent read differently", () => {
  const workspace = recordedWorkspace({ workspace_id: "w6", number: 1 });
  const branchOf = (state) => surfaceOf(state).devices[0];

  // Not asked yet is not the same as asked and told there is none, and neither
  // is the same as a workspace with no checkout at all.
  assert.equal(header(branchOf(liveState({ workspaces: [workspace] })), 0)[1].label, "UNKNOWN");
  assert.equal(
    header(branchOf(liveState({ workspaces: [workspace], worktrees: [recordedWorktree({ branch: null })] })), 0)[1].label,
    "DETACHED"
  );
  assert.equal(
    header(branchOf(liveState({ workspaces: [recordedWorkspace({ workspace_id: "w6", number: 1, worktree: null })] })), 0)[1].label,
    "NO WORKTREE"
  );
});

test("everything below the header row is still blank, awaiting panes and controls", () => {
  const workspaces = [recordedWorkspace({ workspace_id: "w1", number: 1 })];
  const device = surfaceOf(liveState({ workspaces })).devices[0];

  for (let row = HEADER_ROW + 1; row < XL_LAYOUT.rows; row++) {
    for (let column = 0; column < XL_LAYOUT.columns; column++) {
      assert.equal(device.keys[row * XL_LAYOUT.columns + column].kind, "blank");
    }
  }
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
