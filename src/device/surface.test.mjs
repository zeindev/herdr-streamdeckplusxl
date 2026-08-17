import assert from "node:assert/strict";
import test from "node:test";

import { CHANNEL_COUNT, DEVICE_TYPE_XL, XL_LAYOUT, channelKeyIndex } from "../../.preview/device/geometry.js";
import { initialState, reduce } from "../../.preview/device/state.js";
import { changedControls, surfaceOf } from "../../.preview/device/surface.js";
import { recordedWorkspace, recordedWorktree } from "../herdr/fixtures/recorded.mjs";

function run(events, from = initialState()) {
  let state = from;
  for (const event of events) state = reduce(state, event).state;
  return state;
}

const attachXl = { kind: "device-attached", device: { id: "xl-1", type: DEVICE_TYPE_XL } };

const BLANK = { kind: "blank" };

function liveState({ workspaces = [], panes = [], worktrees = [], processes = {} } = {}) {
  return run([
    attachXl,
    { kind: "herdr-connection", connected: true },
    { kind: "herdr-snapshot", snapshot: { workspaces, panes, tabs: [] } },
    { kind: "herdr-worktrees", worktrees },
    ...Object.entries(processes).map(([paneId, process]) => ({ kind: "herdr-process-info", paneId, process }))
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

/** One row of one channel, left to right. */
function rowOf(device, channel, row) {
  return [0, 1, 2].map((column) => device.keys[channelKeyIndex(XL_LAYOUT, channel, column, row)]);
}

/** A pane belonging to a workstream, running whatever the caller says. */
const paneOn = (workspaceId, id, overrides = {}) => ({
  pane_id: `${workspaceId}:${id}`,
  workspace_id: workspaceId,
  agent_status: "unknown",
  ...overrides
});

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
    assert.deepEqual(rowOf(device, channel, 0)[0], { kind: "empty", slot: channel });
  }
});

test("three channels sit side by side, each showing only its own panes", () => {
  const workspaces = [1, 2, 3].map((number) => workspaceOn(number, `stream ${number}`));
  const panes = [1, 2, 3].map((number) => paneOn(`w${number}`, "p1", { agent: "claude", agent_status: "idle" }));
  const device = surfaceOf(liveState({ workspaces, panes })).devices[0];

  // The channel is the position, so a workstream's panes are found by where they sit.
  assert.deepEqual(
    [0, 1, 2].map((channel) => rowOf(device, channel, 0)[0].label),
    ["claude", "claude", "claude"],
    "an agent key is named for the agent, not for a terminal title that keeps changing"
  );
  assert.ok([0, 1, 2].every((channel) => rowOf(device, channel, 0)[0].role === "agent"));
});

test("each channel owns three columns and nothing outside them", () => {
  const device = surfaceOf(
    liveState({
      workspaces: [workspaceOn(1, "auth")],
      panes: [paneOn("w1", "p1", { agent: "claude" })]
    })
  ).devices[0];

  // Only the first channel is bound, so columns 3 to 8 must hold no pane.
  for (let column = 3; column < XL_LAYOUT.columns; column++) {
    assert.notEqual(device.keys[column].kind, "pane", `column ${column} belongs to another channel`);
  }
});

test("a channel's rows are its roles, top to bottom", () => {
  const workspace = workspaceOn(1, "auth");
  const device = surfaceOf(
    liveState({
      workspaces: [workspace],
      panes: [
        paneOn("w1", "agent", { agent: "claude", agent_status: "blocked" }),
        paneOn("w1", "shell")
      ],
      processes: { "w1:shell": { pid: 1, name: "zsh", argv0: "zsh", cmdline: "-zsh" } }
    })
  ).devices[0];

  assert.equal(rowOf(device, 0, 0)[0].role, "agent");
  assert.deepEqual(rowOf(device, 0, 1), [BLANK, BLANK, BLANK], "no server is running");
  assert.equal(rowOf(device, 0, 2)[0].role, "shell");
  assert.deepEqual(rowOf(device, 0, 3), [BLANK, BLANK, BLANK], "the control row is another ticket's");
});

test("a pane with no agent reports no state, since Herdr has none to give", () => {
  // Every service pane reports `unknown`, so drawing that would mark every one
  // of them with an outline that says nothing.
  const device = surfaceOf(
    liveState({
      workspaces: [workspaceOn(1, "auth")],
      panes: [paneOn("w1", "sh")],
      processes: { "w1:sh": { pid: 1, name: "zsh", argv0: "zsh", cmdline: "-zsh" } }
    })
  ).devices[0];

  const face = rowOf(device, 0, 2)[0];
  assert.equal(face.role, "shell");
  assert.ok(!("status" in face), "no agent, no state reading");
});

test("a pane key carries its live state, named as well as coloured", () => {
  for (const status of ["idle", "working", "blocked", "done", "unknown"]) {
    const device = surfaceOf(
      liveState({
        workspaces: [workspaceOn(1, "auth")],
        panes: [paneOn("w1", "p1", { agent: "claude", agent_status: status })]
      })
    ).devices[0];
    const face = rowOf(device, 0, 0)[0];
    assert.equal(face.status, status, "the state is on the face, not only in a colour");
    assert.equal(face.role, "agent");
    assert.ok(face.label.length > 0, "and the pane is named");
  }
});

test("a workspace with no worktree still shows its panes", () => {
  const workspace = { ...workspaceOn(1, "primary"), worktree: null };
  const device = surfaceOf(
    liveState({ workspaces: [workspace], panes: [paneOn("w1", "p1", { agent: "claude" })] })
  ).devices[0];

  assert.equal(rowOf(device, 0, 0)[0].role, "agent");
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

test("the control row stays blank, since it belongs to another ticket", () => {
  const device = surfaceOf(
    liveState({
      workspaces: [workspaceOn(1, "auth")],
      panes: [paneOn("w1", "p1", { agent: "claude" })]
    })
  ).devices[0];

  const last = XL_LAYOUT.rows - 1;
  for (let column = 0; column < XL_LAYOUT.columns; column++) {
    assert.equal(device.keys[last * XL_LAYOUT.columns + column].kind, "blank");
  }
});

test("a channel keeps its branch when Herdr goes away, and drops the counts", () => {
  // The branch does not change because Herdr died, but every count would be
  // whatever was last true rather than what is true.
  const live = liveState({
    workspaces: [workspaceOn(1, "auth")],
    worktrees: [{ path: "/w/auth", branch: "feat/auth" }]
  });
  const lost = run([{ kind: "herdr-connection", connected: false }], live);
  const device = surfaceOf(lost).devices[0];

  assert.equal(device.encoders[0].block.branch, "feat/auth", "identity survives");
  assert.deepEqual(device.encoders[0].block.readings, [], "the counts do not");
  assert.equal(device.encoders[0].block.notice, "OFFLINE");
});

test("every channel says why its counts are missing, since a region only draws its own", () => {
  const offline = surfaceOf(run([attachXl])).devices[0];
  assert.ok(offline.encoders.every((face) => face.block.notice === "OFFLINE"));

  const syncing = surfaceOf(run([attachXl, { kind: "herdr-connection", connected: true }])).devices[0];
  assert.ok(syncing.encoders.every((face) => face.block.notice === "SYNCING"));
});

test("a channel with no workstream still says why the strip is dark", () => {
  // Cold start: nothing is assigned and Herdr has not answered. A blank strip
  // would leave the developer with no reason for it.
  const device = surfaceOf(run([attachXl])).devices[0];
  const face = device.encoders[0];

  assert.equal(face.block.branch, null);
  assert.equal(face.block.notice, "OFFLINE");
});

test("the strip carries no notice once Herdr is live", () => {
  const device = surfaceOf(liveState({ workspaces: [workspaceOn(1, "auth")] })).devices[0];
  assert.ok(device.encoders.every((face) => face.block.notice === null));
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
  const fields = device.encoders[0].block.readings;

  assert.ok(fields.length > 0);
  assert.ok(fields.every((field) => field.label.length > 0 && field.value.length > 0));
});

test("space for ticket and pull-request state is reserved and reads as unknown", () => {
  const device = surfaceOf(liveState({ workspaces: [workspaceOn(1, "auth")] })).devices[0];
  const fields = device.encoders[0].block.readings;

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
    crowded.encoders[4].block.readings.length < roomy.encoders[4].block.readings.length,
    "the last channel drops a reading to make room for the count"
  );
  assert.deepEqual(
    crowded.encoders[0].block.readings.length,
    roomy.encoders[0].block.readings.length,
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
  const panes = (status) => [paneOn("w2", "p1", { agent: "claude", agent_status: status })];
  const before = liveState({ workspaces, panes: panes("working") });
  const after = liveState({ workspaces, panes: panes("blocked") });

  const changes = changedControls(surfaceOf(before), surfaceOf(after));
  assert.ok(changes.length > 0, "the second channel's agent went blocked, so something must redraw");
  assert.ok(
    changes.every((change) => change.control !== "encoder" || [2, 3].includes(change.index)),
    "only the second channel's strip regions may redraw"
  );
  assert.ok(
    changes.every((change) => change.control !== "key" || change.index === 3),
    "only that agent's own key may redraw"
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
