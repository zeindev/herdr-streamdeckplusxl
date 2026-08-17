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

test("a channel names its workstream and how it is doing; the branch is on the strip", () => {
  const workspace = recordedWorkspace({ workspace_id: "w6", number: 1 });
  const device = surfaceOf(
    liveState({
      workspaces: [workspace],
      panes: [{ pane_id: "w6:p1", workspace_id: "w6", agent: "claude", agent_status: "blocked" }],
      worktrees: [recordedWorktree()]
    })
  ).devices[0];

  const [identity, state] = header(device, 0);
  assert.equal(identity.label, "fixture probe", "the label the developer chose leads");
  assert.equal(identity.detail, "herdr-streamdeckplusxl", "the repository follows it");
  assert.deepEqual(state, { kind: "status", label: "BLOCKED", status: "blocked" });

  // The branch moved to the strip, where it has room not to be cut short.
  assert.equal(device.encoders[0].block.branch, "sd-fixture-probe");
  assert.ok(header(device, 0).every((face) => face.kind !== "text" || face.label !== "sd-fixture-probe"));
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
    assert.deepEqual(header(device, 0)[1], { kind: "status", label: status.toUpperCase(), status });
  }
});

test("a workstream with no agent says so rather than reporting unknown", () => {
  const workspace = recordedWorkspace({ workspace_id: "w6", number: 1 });
  const device = surfaceOf(
    liveState({ workspaces: [workspace], panes: [{ pane_id: "w6:p1", workspace_id: "w6", agent_status: "unknown" }] })
  ).devices[0];

  assert.deepEqual(header(device, 0)[1], { kind: "text", label: "NO AGENT" });
});

test("a workspace with no worktree is shown and labelled, never dropped", () => {
  const workspace = recordedWorkspace({ workspace_id: "w6", number: 1, worktree: null, label: "primary" });
  const device = surfaceOf(liveState({ workspaces: [workspace] })).devices[0];

  assert.equal(header(device, 0)[0].label, "primary");
  assert.equal(device.encoders[0].block.branch, "NO WORKTREE");
});

test("the three ways a branch can be absent read differently on the strip", () => {
  const workspace = recordedWorkspace({ workspace_id: "w6", number: 1 });
  const branchOf = (state) => surfaceOf(state).devices[0].encoders[0].block.branch;

  // Not asked yet is not the same as asked and told there is none, and neither
  // is the same as a workspace with no checkout at all.
  assert.equal(branchOf(liveState({ workspaces: [workspace] })), "UNKNOWN");
  assert.equal(branchOf(liveState({ workspaces: [workspace], worktrees: [recordedWorktree({ branch: null })] })), "DETACHED");
  assert.equal(branchOf(liveState({ workspaces: [recordedWorkspace({ workspace_id: "w6", number: 1, worktree: null })] })), "NO WORKTREE");
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

test("the strip says why it is dark rather than showing a branch it cannot vouch for", () => {
  const offline = surfaceOf(run([attachXl])).devices[0];
  assert.equal(offline.encoders[0].notice, "HERDR OFFLINE");
  assert.ok(offline.encoders.every((face) => face.block.branch === null && face.block.fields.length === 0));

  const syncing = surfaceOf(run([attachXl, { kind: "herdr-connection", connected: true }])).devices[0];
  assert.equal(syncing.encoders[0].notice, "SYNCING");
});

test("the strip carries no notice once Herdr is live", () => {
  const device = surfaceOf(liveState({ workspaces: [workspaceOn(1, "auth")] })).devices[0];
  assert.ok(device.encoders.every((face) => face.notice === null));
});

test("both regions of a channel carry the same block, because they are one composition", () => {
  const device = surfaceOf(
    liveState({
      workspaces: [workspaceOn(1, "auth"), workspaceOn(2, "billing")],
      worktrees: [
        { path: "/w/auth", branch: "feat/auth" },
        { path: "/w/billing", branch: "feat/billing" }
      ]
    })
  ).devices[0];

  assert.deepEqual(device.encoders[0].block, device.encoders[1].block);
  assert.deepEqual(device.encoders[2].block, device.encoders[3].block);
  assert.notDeepEqual(device.encoders[0].block, device.encoders[2].block, "different channels say different things");
});

test("every strip reading is named, so no number on the strip is bare", () => {
  const device = surfaceOf(liveState({ workspaces: [workspaceOn(1, "auth")] })).devices[0];
  const fields = device.encoders[0].block.fields;

  assert.ok(fields.length > 0);
  assert.ok(fields.every((field) => field.label.length > 0 && field.value.length > 0));
});

test("space for ticket and pull-request state is reserved and reads as unknown", () => {
  const device = surfaceOf(liveState({ workspaces: [workspaceOn(1, "auth")] })).devices[0];
  const fields = device.encoders[0].block.fields;

  assert.deepEqual(fields.find((field) => field.label === "TKT"), { label: "TKT", value: "?" });
  assert.deepEqual(fields.find((field) => field.label === "PR"), { label: "PR", value: "?" });
});

test("the overflow count sits on the rightmost region and nowhere else", () => {
  const workspaces = [1, 2, 3, 4].map((number) => workspaceOn(number, `stream ${number}`));
  const device = surfaceOf(liveState({ workspaces })).devices[0];

  assert.equal(device.encoders[5].overflow, 1);
  assert.ok(device.encoders.slice(0, 5).every((face) => face.overflow === 0));
});

test("the channel sharing the overflow region gives up room rather than overlapping", () => {
  const three = [1, 2, 3].map((number) => workspaceOn(number, `stream ${number}`));
  const roomy = surfaceOf(liveState({ workspaces: three })).devices[0];
  const crowded = surfaceOf(liveState({ workspaces: [...three, workspaceOn(4, "stream 4")] })).devices[0];

  assert.ok(
    crowded.encoders[4].block.fields.length < roomy.encoders[4].block.fields.length,
    "the last channel drops a reading to make room for the count"
  );
  assert.deepEqual(
    crowded.encoders[0].block.fields.length,
    roomy.encoders[0].block.fields.length,
    "the other channels are untouched"
  );
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
  const workspaces = [workspaceOn(1, "auth"), workspaceOn(2, "billing")];
  const pane = (status) => [{ pane_id: "w2:p1", workspace_id: "w2", agent: "claude", agent_status: status }];
  const before = liveState({ workspaces, panes: pane("working") });
  const after = liveState({ workspaces, panes: pane("blocked") });

  const changes = changedControls(surfaceOf(before), surfaceOf(after));
  assert.ok(changes.length > 0, "the second channel's agent went blocked, so something must redraw");
  assert.ok(
    changes.every((change) => change.control !== "encoder" || [2, 3].includes(change.index)),
    "only the second channel's strip regions may redraw"
  );
  assert.ok(
    changes.every((change) => change.control !== "key" || change.index === 4),
    "only the second channel's state key may redraw"
  );
});

test("a rebuilt but unchanged surface redraws nothing, even though faces nest", () => {
  // Faces carry lists now, so comparing them by identity would redraw the whole
  // device ten times a second.
  const state = liveState({ workspaces: [workspaceOn(1, "auth")], panes: [] });
  assert.deepEqual(changedControls(surfaceOf(state), surfaceOf(state)), []);
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
