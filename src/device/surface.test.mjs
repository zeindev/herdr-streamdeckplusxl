import assert from "node:assert/strict";
import test from "node:test";

import { CHANNEL_COUNT, DEVICE_TYPE_MINI, DEVICE_TYPE_XL, XL_LAYOUT, channelKeyIndex } from "../../.preview/device/geometry.js";
import { readSlots } from "../../.preview/device/slots.js";
import { HOLD_MS, initialState, reduce } from "../../.preview/device/state.js";
import { changedControls, surfaceOf } from "../../.preview/device/surface.js";
import { recordedWorkspace, recordedWorktree } from "../herdr/fixtures/recorded.mjs";

function run(events, from = initialState()) {
  let state = from;
  for (const event of events) state = reduce(state, event).state;
  return state;
}

const attachXl = { kind: "device-attached", device: { id: "xl-1", type: DEVICE_TYPE_XL } };
const attachMini = { kind: "device-attached", device: { id: "mini-1", type: DEVICE_TYPE_MINI } };

const BLANK = { kind: "blank" };

/**
 * A `pane.process_info` reply, in the envelope the reducer reads.
 *
 * The whole envelope under `info`, not a bare process under `process`. The
 * wrong shape type-checks in a .mjs file and delivers nothing, so every pane
 * silently became a shell — which is what these tests asserted against until
 * a preview scene made the gap visible.
 */
function runningIn(paneId, cmdline) {
  return {
    kind: "herdr-process-info",
    paneId,
    info: {
      pane_id: paneId,
      foreground_process_group_id: 1,
      foreground_processes: [{ pid: 1, name: "x", argv0: cmdline.split(" ")[0], cmdline }]
    }
  };
}

function liveState({ workspaces = [], panes = [], worktrees = [], processes = {}, attach = attachXl } = {}) {
  return run([
    attach,
    { kind: "herdr-connection", connected: true },
    { kind: "herdr-snapshot", snapshot: { workspaces, panes, tabs: [] } },
    { kind: "herdr-worktrees", worktrees },
    ...Object.entries(processes).map(([paneId, cmdline]) => runningIn(paneId, cmdline))
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
      processes: { "w1:shell": "-zsh" }
    })
  ).devices[0];

  assert.equal(rowOf(device, 0, 0)[0].role, "agent");
  assert.deepEqual(rowOf(device, 0, 1), [BLANK, BLANK, BLANK], "no server is running");
  assert.equal(rowOf(device, 0, 2)[0].role, "shell");
  assert.deepEqual(
    rowOf(device, 0, 3).map((face) => face.kind),
    ["text", "text", "text"],
    "the control row is the channel's three fixed verbs (ADR-0011, ADR-0012)"
  );
});

/**
 * The role-correction picker (`-0vd.4`): a hold on a pane key opens it, and
 * it shows every role at once rather than making the developer cycle one
 * step per hold. The reducer's own open/pick/cancel/timeout decisions are
 * covered in state.test.mjs; this is only what gets drawn.
 */
test("an open role picker shows every role at once, each where its own row already puts it", () => {
  const live = liveState({
    workspaces: [workspaceOn(1, "auth")],
    panes: [paneOn("w1", "agent", { agent: "claude" })],
    processes: { "w1:agent": "claude" }
  });
  const opened = run([{ kind: "key-down", key: { deviceId: "xl-1", column: 0, row: 0 }, at: 1000 }, { kind: "tick", at: 1000 + HOLD_MS }], live);

  const device = surfaceOf(opened).devices[0];
  assert.deepEqual(rowOf(device, 0, 0), [{ kind: "text", label: "AGENT" }, BLANK, BLANK]);
  assert.deepEqual(rowOf(device, 0, 1), [{ kind: "text", label: "SERVER" }, BLANK, BLANK]);
  assert.deepEqual(rowOf(device, 0, 2), [
    { kind: "text", label: "TESTS" },
    { kind: "text", label: "LOGS" },
    { kind: "text", label: "SHELL" }
  ]);
});

test("an open role picker leaves the control row and every other channel untouched", () => {
  const live = liveState({
    workspaces: [workspaceOn(1, "auth"), workspaceOn(2, "billing")],
    panes: [paneOn("w1", "agent", { agent: "claude" }), paneOn("w2", "b", { label: "billing shell" })],
    processes: { "w1:agent": "claude" }
  });
  const opened = run([{ kind: "key-down", key: { deviceId: "xl-1", column: 0, row: 0 }, at: 1000 }, { kind: "tick", at: 1000 + HOLD_MS }], live);

  const device = surfaceOf(opened).devices[0];
  assert.deepEqual(
    rowOf(device, 0, 3).map((face) => face.kind),
    ["text", "text", "text"],
    "the picker replaces the pane rows, not the control row"
  );
  assert.equal(rowOf(device, 1, 2)[0].label, "billing shell", "billing's own channel was never touched");
});

test("a pane with no agent reports no state, since Herdr has none to give", () => {
  // Every service pane reports `unknown`, so drawing that would mark every one
  // of them with an outline that says nothing.
  const device = surfaceOf(
    liveState({
      workspaces: [workspaceOn(1, "auth")],
      panes: [paneOn("w1", "sh")],
      processes: { "w1:sh": "-zsh" }
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
  const workspace = { ...workspaceOn(1, "primary"), worktree: null, label: "primary" };
  const device = surfaceOf(
    liveState({ workspaces: [workspace], panes: [paneOn("w1", "p1", { agent: "claude" })] })
  ).devices[0];

  assert.equal(rowOf(device, 0, 0)[0].role, "agent");
  assert.equal(device.encoders[0].block.branch, "primary", "its label names it, since it has no branch");
});

test("the three ways a branch can be absent read differently on the strip", () => {
  const workspace = recordedWorkspace({ workspace_id: "w6", number: 1 });
  const branchOf = (state) => surfaceOf(state).devices[0].encoders[0].block.branch;

  // Not asked yet is not the same as asked and told there is none, and neither
  // is the same as a workspace with no checkout at all.
  assert.equal(branchOf(liveState({ workspaces: [workspace] })), "UNKNOWN");
  assert.equal(branchOf(liveState({ workspaces: [workspace], worktrees: [recordedWorktree({ branch: null })] })), "DETACHED");
  assert.equal(
    branchOf(liveState({ workspaces: [recordedWorkspace({ workspace_id: "w6", number: 1, worktree: null, label: "primary" })] })),
    "primary",
    "a workstream with no worktree is named by its label"
  );
});

test("the control row carries focus, git and pull request, and actions, in that fixed order", () => {
  const device = surfaceOf(
    liveState({
      workspaces: [workspaceOn(1, "auth")],
      panes: [paneOn("w1", "p1", { agent: "claude" })]
    })
  ).devices[0];

  const [focus, git, actions] = rowOf(device, 0, 3);
  assert.equal(focus.label, "FOCUS");
  assert.equal(git.label, "herdr-streamdeckplusxl", "the repository names the channel here, since row 0 no longer can (-0vd.2)");
  assert.equal(git.detail, "GIT");
  assert.equal(actions.label, "PROMPT");
});

test("a channel with no worktree names its git key by its own label, the same as the strip does", () => {
  const workspace = { ...workspaceOn(1, "primary"), worktree: null, label: "primary" };
  const device = surfaceOf(liveState({ workspaces: [workspace], panes: [] })).devices[0];

  assert.equal(rowOf(device, 0, 3)[1].label, "primary");
});

/** The key at a channel's row and column, as the SDK addresses it. */
const controlKeyAt = (channel, column) => ({ deviceId: "xl-1", column: channel * 3 + column, row: XL_LAYOUT.rows - 1 });

test("an armed actions key reads STOP AGAIN in the danger colour, across a redraw", () => {
  const live = liveState({ workspaces: [workspaceOn(1, "auth")], panes: [paneOn("w1", "agent", { agent: "claude" })] });
  const key = controlKeyAt(0, 2);
  const armed = run(
    [{ kind: "key-down", key, at: 1000 }, { kind: "tick", at: 1000 + HOLD_MS }],
    live
  );

  const actions = rowOf(surfaceOf(armed).devices[0], 0, 3)[2];
  assert.equal(actions.label, "STOP AGAIN");
  assert.equal(actions.danger, true);
});

test("a successful control command flashes green on the key that fired it, then reverts", () => {
  const live = liveState({ workspaces: [workspaceOn(1, "auth")], panes: [] });
  const acknowledged = run([{ kind: "control-acknowledged", workspaceId: "w1", column: 0, ok: true, message: "FOCUSED", at: 1000 }], live);

  const focus = rowOf(surfaceOf(acknowledged).devices[0], 0, 3)[0];
  assert.equal(focus.label, "FOCUS");
  assert.equal(focus.detail, "FOCUSED");
  assert.equal(focus.feedback, "success");
  assert.ok(!("danger" in focus));
});

test("a refused git/pull-request tap says so on the key without losing the repository's name", () => {
  const live = liveState({ workspaces: [workspaceOn(1, "auth")], panes: [] });
  const key = controlKeyAt(0, 1);
  const tapped = run([{ kind: "key-down", key, at: 100 }, { kind: "key-up", key, at: 101 }], live);

  const git = rowOf(surfaceOf(tapped).devices[0], 0, 3)[1];
  assert.equal(git.label, "herdr-streamdeckplusxl", "identity survives the refusal, it is not replaced by it");
  assert.equal(git.detail, "NO PR YET");
  assert.equal(git.danger, true);
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

/**
 * Attention on the surface: what a key shows, and what the strip counts.
 *
 * The device's whole promise is that a glance across it says which workstream
 * is asking. These assert the described faces, never the pixels.
 */

/** A live state whose stored acknowledgements are already in place. */
function liveStateAcknowledged({ workspaces = [], panes = [], acknowledged = [] } = {}) {
  return run([
    attachXl,
    { kind: "settings-loaded", slots: readSlots(undefined), roles: {}, acknowledged },
    { kind: "herdr-connection", connected: true },
    { kind: "herdr-snapshot", snapshot: { workspaces, panes, tabs: [] } }
  ]);
}

const readingOf = (face, label) => face.block.readings.find((reading) => reading.label === label)?.value;

test("an agent waiting on input is marked on its own key", () => {
  const [device] = surfaceOf(
    liveState({
      workspaces: [workspaceOn(1, "auth")],
      panes: [paneOn("w1", "a", { agent: "claude", agent_status: "blocked" })]
    })
  ).devices;

  const [face] = rowOf(device, 0, 0);
  assert.equal(face.kind, "pane");
  assert.equal(face.attention, "waiting");
  assert.equal(face.status, "blocked", "the status is still reported; asking is a separate fact");
});

test("a finished agent asks on its key until it is acknowledged, and stays finished after", () => {
  const asking = surfaceOf(
    liveStateAcknowledged({
      workspaces: [workspaceOn(1, "auth")],
      panes: [paneOn("w1", "a", { agent: "claude", agent_status: "done" })]
    })
  ).devices[0];
  assert.equal(rowOf(asking, 0, 0)[0].attention, "finished");

  const seen = surfaceOf(
    liveStateAcknowledged({
      workspaces: [workspaceOn(1, "auth")],
      panes: [paneOn("w1", "a", { agent: "claude", agent_status: "done" })],
      acknowledged: ["w1:a"]
    })
  ).devices[0];
  const face = rowOf(seen, 0, 0)[0];
  assert.equal(face.attention, undefined, "it has stopped asking");
  assert.equal(face.status, "done", "but it has not stopped being finished");
});

test("a service key is never marked, since Herdr reports no state for one", () => {
  const [device] = surfaceOf(
    liveState({
      workspaces: [workspaceOn(1, "auth")],
      panes: [paneOn("w1", "sh", { agent_status: "blocked" })]
    })
  ).devices;
  assert.equal(rowOf(device, 0, 2)[0].attention, undefined);
});

test("a workstream's outstanding attention is on its strip with no press at all", () => {
  const [device] = surfaceOf(
    liveState({
      workspaces: [workspaceOn(1, "auth"), workspaceOn(2, "billing")],
      panes: [
        paneOn("w1", "a", { agent: "claude", agent_status: "blocked" }),
        paneOn("w1", "b", { agent: "claude", agent_status: "done" }),
        paneOn("w2", "a", { agent: "claude", agent_status: "working" })
      ]
    })
  ).devices;

  assert.equal(readingOf(device.encoders[0], "ATTN"), "2");
  assert.equal(readingOf(device.encoders[2], "ATTN"), "0", "the quiet stream says so rather than saying nothing");
});

test("acknowledging takes the count down as well as the mark", () => {
  const panes = [paneOn("w1", "a", { agent: "claude", agent_status: "done" })];
  const asking = surfaceOf(liveStateAcknowledged({ workspaces: [workspaceOn(1, "auth")], panes })).devices[0];
  const seen = surfaceOf(
    liveStateAcknowledged({ workspaces: [workspaceOn(1, "auth")], panes, acknowledged: ["w1:a"] })
  ).devices[0];

  assert.equal(readingOf(asking.encoders[0], "ATTN"), "1");
  assert.equal(readingOf(seen.encoders[0], "ATTN"), "0");
});

test("a dead service is counted and named on the strip, because it has no key to land on", () => {
  // The one attention item with nowhere else to go: its pane left the session
  // with its process. Without EXIT the count would rise and nothing anywhere
  // would say what to look at.
  const crashed = { ...workspaceOn(1, "auth"), tokens: { sd_exit_dev: "1", sd_exit_api: "137" } };
  const [device] = surfaceOf(liveState({ workspaces: [crashed], panes: [paneOn("w1", "sh")] })).devices;

  assert.equal(readingOf(device.encoders[0], "ATTN"), "2");
  assert.equal(readingOf(device.encoders[0], "EXIT"), "2");
});

test("EXIT appears only when a service has died, and spends the droppable reading", () => {
  const quiet = surfaceOf(liveState({ workspaces: [workspaceOn(1, "auth")], panes: [] })).devices[0];
  assert.deepEqual(
    quiet.encoders[0].block.readings.map((reading) => reading.label),
    ["ATTN", "TKT", "PR", "AGENTS"]
  );

  const crashed = { ...workspaceOn(1, "auth"), tokens: { sd_exit_dev: "1" } };
  const loud = surfaceOf(liveState({ workspaces: [crashed], panes: [] })).devices[0];
  assert.deepEqual(
    loud.encoders[0].block.readings.map((reading) => reading.label),
    ["ATTN", "TKT", "PR", "EXIT"],
    "the reserved fields keep their place; AGENTS is what gives way"
  );
});

test("attention changing redraws only the controls that moved", () => {
  const workspaces = [workspaceOn(1, "auth"), workspaceOn(2, "billing")];
  const quiet = liveState({
    workspaces,
    panes: [paneOn("w1", "a", { agent: "claude", agent_status: "working", revision: 1 })]
  });
  const asking = run(
    [
      {
        kind: "herdr-event",
        at: 0,
        event: {
          event: "pane_updated",
          data: {
            type: "pane_updated",
            pane: paneOn("w1", "a", { agent: "claude", agent_status: "blocked", revision: 2 })
          }
        }
      }
    ],
    quiet
  );

  const changes = changedControls(surfaceOf(quiet), surfaceOf(asking));
  assert.deepEqual(
    changes.map((change) => `${change.control}:${change.index}`),
    ["key:0", "encoder:0", "encoder:1"],
    "the pane's key and its own channel's two regions, and nothing belonging to another stream"
  );
});

/**
 * `-2gn` closed with a gap in its own criterion 8: nothing proved a branch
 * change redraws the strip specifically, only that agent-status changes do.
 * The branch is what `worktree.list` supplies asynchronously after the
 * snapshot (ADR-0001), so it can and does arrive as its own later update —
 * this is that path, exercised directly.
 */
test("a branch arriving redraws only that channel's strip regions", () => {
  const workspaces = [workspaceOn(1, "auth"), workspaceOn(2, "billing")];
  const unnamed = liveState({ workspaces, panes: [] });
  const named = run([{ kind: "herdr-worktrees", worktrees: [{ path: "/w/auth", branch: "feat/login" }] }], unnamed);

  const changes = changedControls(surfaceOf(unnamed), surfaceOf(named));
  assert.deepEqual(
    changes.map((change) => `${change.control}:${change.index}`),
    ["encoder:0", "encoder:1"],
    "only auth's own two strip regions redraw; billing's channel and every key are untouched"
  );
});

test("enrichment arriving on the strip redraws only that channel's regions, the same as a branch does", () => {
  const workspaces = [workspaceOn(1, "auth"), workspaceOn(2, "billing")];
  const unenriched = liveState({ workspaces, panes: [] });
  const enriched = run(
    [
      {
        kind: "herdr-snapshot",
        snapshot: { workspaces: [{ ...workspaceOn(1, "auth"), tokens: { sd_tickets: "ABC-1", sd_pr: "42 open" } }, workspaceOn(2, "billing")], panes: [], tabs: [] }
      }
    ],
    unenriched
  );

  const changes = changedControls(surfaceOf(unenriched), surfaceOf(enriched));
  assert.deepEqual(
    changes.map((change) => `${change.control}:${change.index}`),
    ["encoder:0", "encoder:1"],
    "only auth's own two strip regions redraw"
  );
});

test("an asking pane hidden behind the overflow count still marks the grid", () => {
  // The channel's total counts panes the row had no key for, so without this a
  // developer could watch ATTN rise with nothing anywhere on the grid to look at.
  // Agents, because only an agent can be waiting — and four of them overflow a
  // three-column row, so the fourth has no key of its own.
  const panes = [1, 2, 3, 4].map((n) =>
    paneOn("w1", `a${n}`, { agent: "claude", agent_status: n === 4 ? "blocked" : "working" })
  );
  const [device] = surfaceOf(
    liveState({
      workspaces: [workspaceOn(1, "auth")],
      panes,
      processes: Object.fromEntries(panes.map((pane) => [pane.pane_id, "claude"]))
    })
  ).devices;

  const more = rowOf(device, 0, 0)[2];
  assert.equal(more.kind, "more");
  assert.ok(more.count > 0, "some panes had no key");
  assert.equal(more.attention, "waiting", "the count says what is hiding behind it");
  assert.equal(readingOf(device.encoders[0], "ATTN"), "1", "and the strip counts the same pane");
});

test("an overflow count hiding nothing urgent stays quiet", () => {
  const panes = [1, 2, 3, 4].map((n) => paneOn("w1", `a${n}`, { agent: "claude", agent_status: "working" }));
  const [device] = surfaceOf(
    liveState({
      workspaces: [workspaceOn(1, "auth")],
      panes,
      processes: Object.fromEntries(panes.map((pane) => [pane.pane_id, "claude"]))
    })
  ).devices;

  const more = rowOf(device, 0, 0)[2];
  assert.equal(more.kind, "more");
  assert.equal(more.attention, undefined);
});

test("a dead service is marked on the pane it ran in, while that pane is there", () => {
  // Probed live: a service crashing under the wrapper leaves its pane standing,
  // so the item has a key after all. An earlier version put it on the strip only.
  const crashed = { ...workspaceOn(1, "auth"), tokens: { sd_exit_dev: "1 w1:dev" } };
  const [device] = surfaceOf(
    liveState({
      workspaces: [crashed],
      panes: [paneOn("w1", "dev")],
      processes: { "w1:dev": "npm run dev" }
    })
  ).devices;

  const face = rowOf(device, 0, 1)[0];
  assert.equal(face.kind, "pane", "the server row still holds the pane it died in");
  assert.equal(face.attention, "exited");
  assert.equal(readingOf(device.encoders[0], "EXIT"), "1", "and it is still counted on the strip");
});

test("a dead service whose pane really did go falls back to the strip alone", () => {
  const crashed = { ...workspaceOn(1, "auth"), tokens: { sd_exit_dev: "1 w1:gone" } };
  const [device] = surfaceOf(liveState({ workspaces: [crashed], panes: [] })).devices;

  assert.equal(readingOf(device.encoders[0], "EXIT"), "1");
  assert.ok(
    device.keys.every((key) => key.attention === undefined),
    "no key may be marked for a pane the device is not showing"
  );
});

/**
 * The Mini, standalone (ADR-0008, `-vk6`). Same slot binding, same three
 * channels, same column order as the XL — only what a Mini surface looks
 * like changes, not which workstream is where.
 */

function miniLiveState(options) {
  return liveState({ ...options, attach: attachMini });
}

test("a Mini alone gets the full 3 by 2 grid and no encoders at all", () => {
  const [device] = surfaceOf(run([attachMini])).devices;
  assert.equal(device.layout, "mini");
  assert.equal(device.keys.length, 6);
  assert.deepEqual(device.encoders, []);
});

test("the Mini's column order matches the XL's, so column 1 is the same workstream on both", () => {
  const workspaces = [workspaceOn(1, "auth"), workspaceOn(2, "billing"), workspaceOn(3, "search")];
  const [xl] = surfaceOf(liveState({ workspaces })).devices;
  const [mini] = surfaceOf(miniLiveState({ workspaces })).devices;

  // Both devices derive a workstream's identity through `workstreamIdentity`
  // — the XL's own strip carries it as `branch`, the Mini's top-row key as
  // `label` — so comparing the two, channel by channel, is exactly asking
  // whether the same workstream sits in the same place on both.
  for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
    assert.equal(mini.keys[channel].label, xl.encoders[channel * XL_LAYOUT.encodersPerChannel].block.branch);
  }
});

test("an unassigned Mini slot invites a worktree, matching the XL's own behaviour", () => {
  const [xl] = surfaceOf(liveState({ workspaces: [] })).devices;
  const [mini] = surfaceOf(miniLiveState({ workspaces: [] })).devices;

  assert.deepEqual(mini.keys[0], { kind: "empty", slot: 0 });
  assert.deepEqual(xl.keys[0], { kind: "empty", slot: 0 });
  assert.deepEqual(mini.keys[3], BLANK, "the bottom row of an empty channel stays blank, there being no pane to show");
});

test("the Mini's top row names the workstream and carries its aggregate agent state", () => {
  const [device] = surfaceOf(
    miniLiveState({
      workspaces: [workspaceOn(1, "auth")],
      worktrees: [{ path: "/w/auth", branch: "auth" }],
      panes: [paneOn("w1", "a", { agent: "claude", agent_status: "blocked" })]
    })
  ).devices;

  assert.deepEqual(device.keys[0], { kind: "workstream", label: "auth", status: "blocked", attention: "waiting" });
});

test("the Mini's top row carries no state at all for a workstream with no agents", () => {
  const [device] = surfaceOf(
    miniLiveState({
      workspaces: [workspaceOn(1, "auth")],
      worktrees: [{ path: "/w/auth", branch: "auth" }],
      panes: [paneOn("w1", "svc")]
    })
  ).devices;
  assert.deepEqual(device.keys[0], { kind: "workstream", label: "auth" });
});

test("the Mini's top row marks an orphaned dead service even though it names no pane", () => {
  const withDeadService = { ...workspaceOn(1, "auth"), tokens: { sd_exit_dev: "1" } };
  const [device] = surfaceOf(miniLiveState({ workspaces: [withDeadService], panes: [] })).devices;
  assert.equal(device.keys[0].kind, "workstream");
  assert.equal(device.keys[0].attention, "exited", "a pane-scoped attention map alone would have missed this");
});

test("the Mini's bottom row shows the channel's most urgent pane", () => {
  const [device] = surfaceOf(
    miniLiveState({
      workspaces: [workspaceOn(1, "auth")],
      panes: [
        paneOn("w1", "a", { agent: "claude", agent_status: "idle", label: "idle one" }),
        paneOn("w1", "b", { agent: "claude", agent_status: "blocked", label: "blocked one" })
      ]
    })
  ).devices;

  assert.equal(device.keys[3].kind, "pane");
  assert.equal(device.keys[3].label, "blocked one", "the pane asking for the developer wins the key, not the idle one");
  assert.equal(device.keys[3].attention, "waiting");
});

test("the Mini's bottom row stays blank for a workstream with no panes at all", () => {
  const [device] = surfaceOf(miniLiveState({ workspaces: [workspaceOn(1, "auth")], panes: [] })).devices;
  assert.deepEqual(device.keys[3], BLANK);
});

test("the Mini's top-row key names an identity, never a role — that concept is the XL rows' own", () => {
  const [device] = surfaceOf(
    miniLiveState({ workspaces: [workspaceOn(1, "auth")], panes: [paneOn("w1", "a", { agent: "claude", agent_status: "working" })] })
  ).devices;
  assert.equal(device.keys[0].kind, "workstream");
  assert.ok(!("role" in device.keys[0]));
});

test("the Mini's redraw is scoped to the channel that changed, the same as the XL's", () => {
  const workspaces = [workspaceOn(1, "auth"), workspaceOn(2, "billing")];
  const quiet = miniLiveState({ workspaces, panes: [paneOn("w1", "a", { agent: "claude", agent_status: "working" })] });
  const asking = run(
    [
      {
        kind: "herdr-event",
        at: 0,
        event: { event: "pane_updated", data: { type: "pane_updated", pane: paneOn("w1", "a", { agent: "claude", agent_status: "blocked" }) } }
      }
    ],
    quiet
  );

  const changes = changedControls(surfaceOf(quiet), surfaceOf(asking));
  assert.deepEqual(
    changes.map((change) => `${change.control}:${change.index}`),
    ["key:0", "key:3"],
    "only auth's own two keys redraw; billing's channel is untouched, and there are no encoders to redraw at all"
  );
});

/**
 * The Mini, paired with an XL (ADR-0008, `-4w7`): the global surface rather
 * than a mirror of any one channel. Row 0 is the attention queue and the two
 * most recently focused panes; row 1 is the overflow count and the two
 * features still unclaimed scope.
 */

const attachBoth = [attachXl, attachMini];

function pairedLiveState({ workspaces = [], panes = [] } = {}) {
  return run([
    ...attachBoth,
    { kind: "herdr-connection", connected: true },
    { kind: "herdr-snapshot", snapshot: { workspaces, panes, tabs: [] } }
  ]);
}

test("the paired Mini renders the global surface rather than mirroring a channel", () => {
  const [, mini] = surfaceOf(pairedLiveState({ workspaces: [workspaceOn(1, "auth")] })).devices;
  assert.equal(mini.layout, "mini");
  assert.equal(mini.keys[0].kind, "queue", "row 0 is the attention queue, not a workstream's identity");
  assert.equal(mini.keys[3].kind, "overflow", "row 1 is the overflow count, not a channel's most urgent pane");
});

test("the paired Mini's queue key counts and marks everything asking, across every workstream", () => {
  const [, mini] = surfaceOf(
    pairedLiveState({
      workspaces: [workspaceOn(1, "auth"), workspaceOn(2, "billing")],
      panes: [
        paneOn("w1", "a", { agent: "claude", agent_status: "done" }),
        paneOn("w2", "b", { agent: "claude", agent_status: "blocked" })
      ]
    })
  ).devices;

  assert.deepEqual(mini.keys[0], { kind: "queue", count: 2, attention: "waiting" });
});

test("the paired Mini's queue key stays quiet when nothing anywhere is asking", () => {
  const [, mini] = surfaceOf(pairedLiveState({ workspaces: [workspaceOn(1, "auth")] })).devices;
  assert.deepEqual(mini.keys[0], { kind: "queue", count: 0 });
});

test("the paired Mini's recent-pane keys show the two most recently focused panes", () => {
  const live = pairedLiveState({
    workspaces: [workspaceOn(1, "auth")],
    panes: [paneOn("w1", "a", { agent: "claude", label: "one" }), paneOn("w1", "b", { agent: "claude", label: "two" })]
  });
  const agentKey = { deviceId: "xl-1", column: 0, row: 0 };
  const focusedA = run([{ kind: "key-down", key: agentKey, at: 100 }, { kind: "key-up", key: agentKey, at: 101 }], live);

  const [, mini] = surfaceOf(focusedA).devices;
  assert.equal(mini.keys[1].kind, "pane");
  assert.equal(mini.keys[1].label, "one");
  assert.deepEqual(mini.keys[2], BLANK, "nothing has been focused for the second recent key yet");
});

test("worktree creation and settings are honest placeholders on the paired Mini, unclaimed scope like the git key was", () => {
  const [, mini] = surfaceOf(pairedLiveState({ workspaces: [workspaceOn(1, "auth")] })).devices;
  assert.deepEqual(mini.keys[4], { kind: "text", label: "NEW WORKTREE" });
  assert.deepEqual(mini.keys[5], { kind: "text", label: "SETTINGS" });
});

test("the overflow count moves from the XL's strip to the paired Mini's overflow key", () => {
  const workspaces = [workspaceOn(1, "a"), workspaceOn(2, "b"), workspaceOn(3, "c"), workspaceOn(4, "d")];
  const [xl, mini] = surfaceOf(pairedLiveState({ workspaces })).devices;

  assert.equal(xl.encoders[xl.encoders.length - 1].overflow, 0, "the XL strip goes quiet once the Mini carries the count");
  assert.deepEqual(mini.keys[3], { kind: "overflow", count: 1 });
});

test("detaching the Mini returns the overflow count to the XL's rightmost strip region", () => {
  const workspaces = [workspaceOn(1, "a"), workspaceOn(2, "b"), workspaceOn(3, "c"), workspaceOn(4, "d")];
  const paired = pairedLiveState({ workspaces });
  const xlOnly = run([{ kind: "device-detached", deviceId: "mini-1" }], paired);

  const [xl] = surfaceOf(xlOnly).devices;
  assert.equal(xl.encoders[xl.encoders.length - 1].overflow, 1);
});

test("the XL's key layout is unaffected by whether a Mini is attached", () => {
  const workspaces = [workspaceOn(1, "auth")];
  const panes = [paneOn("w1", "a", { agent: "claude", agent_status: "blocked" })];
  const [xlAlone] = surfaceOf(liveState({ workspaces, panes })).devices;
  const [xlPaired] = surfaceOf(pairedLiveState({ workspaces, panes })).devices;

  assert.deepEqual(xlPaired.keys, xlAlone.keys);
  assert.deepEqual(xlPaired.encoders, xlAlone.encoders, "no overflow is in play here, so the two strips agree too");
});

test("the XL's key grid stays byte-for-byte identical even with overflow in play — only the strip's overflow digit moves", () => {
  // "Byte-for-byte identical" (the acceptance criterion) is about the XL's
  // geometry and its keys, which never read anything about the rig at all —
  // `keysOf`'s XL branch takes no rig-dependent input. The strip is not held
  // to the same claim: ADR-0009 already had the last region give up reading
  // space to reserve room for a nonzero overflow count, before this ticket
  // existed, and now that reservation depends on which rail is showing the
  // count — so the strip's *content* legitimately differs, while the keys,
  // and the fact that there are still six encoder regions, do not.
  const workspaces = [workspaceOn(1, "a"), workspaceOn(2, "b"), workspaceOn(3, "c"), workspaceOn(4, "d")];
  const [xlAlone] = surfaceOf(liveState({ workspaces })).devices;
  const [xlPaired] = surfaceOf(pairedLiveState({ workspaces })).devices;

  assert.deepEqual(xlPaired.keys, xlAlone.keys);
  assert.equal(xlAlone.encoders.length, xlPaired.encoders.length);
  assert.equal(xlAlone.encoders[xlAlone.encoders.length - 1].overflow, 1, "unpaired, the XL strip carries the real count");
  assert.equal(xlPaired.encoders[xlPaired.encoders.length - 1].overflow, 0, "paired, the Mini carries it instead");
});

/**
 * Dial 1's own strip presence (ADR-0007, `-u5d`): the acceptance criterion
 * that a browsed or scrubbed selection is identifiable on the strip while
 * the dial is in use. The reducer's own decisions about rotating and
 * pushing are covered in state.test.mjs; this is only what gets drawn.
 */

test("browsing dial 1 replaces the channel's readings with the selected item, leaving the branch and the other channels alone", () => {
  const live = liveState({
    workspaces: [workspaceOn(1, "auth"), workspaceOn(2, "billing")],
    worktrees: [{ path: "/w/auth", branch: "auth" }],
    panes: [paneOn("w1", "a", { label: "shell one" })]
  });
  const browsing = run([{ kind: "encoder-rotate", deviceId: "xl-1", encoder: 0, ticks: 1, at: 100 }], live);

  const [device] = surfaceOf(browsing).devices;
  assert.equal(device.encoders[0].block.branch, "auth", "the branch survives a dial preview the same way it survives OFFLINE");
  assert.equal(device.encoders[0].block.notice, "> shell one");
  assert.deepEqual(device.encoders[0].block.readings, []);
  assert.equal(device.encoders[2].block.notice, null, "billing's channel was not touched");
});

test("scrubbing dial 1 shows the scrollback depth on the channel's strip", () => {
  const live = liveState({ workspaces: [workspaceOn(1, "auth")], panes: [paneOn("w1", "a")] });
  const focused = run(
    [
      { kind: "encoder-rotate", deviceId: "xl-1", encoder: 0, ticks: 1, at: 100 },
      { kind: "encoder-down", deviceId: "xl-1", encoder: 0, at: 200 },
      { kind: "encoder-rotate", deviceId: "xl-1", encoder: 0, ticks: 5, at: 300 }
    ],
    live
  );

  const [device] = surfaceOf(focused).devices;
  assert.equal(device.encoders[0].block.notice, "SCRUB -5");
});

test("a live scrub (offset zero) reads as LIVE rather than a bare zero", () => {
  const live = liveState({ workspaces: [workspaceOn(1, "auth")], panes: [paneOn("w1", "a")] });
  const focused = run(
    [
      { kind: "encoder-rotate", deviceId: "xl-1", encoder: 0, ticks: 1, at: 100 },
      { kind: "encoder-down", deviceId: "xl-1", encoder: 0, at: 200 }
    ],
    live
  );

  const [device] = surfaceOf(focused).devices;
  assert.equal(device.encoders[0].block.notice, "LIVE");
});

test("a connection notice wins over a dial 1 preview, since a preview is not trustworthy once Herdr is unreachable either", () => {
  const live = liveState({ workspaces: [workspaceOn(1, "auth")], panes: [paneOn("w1", "a")] });
  const browsing = run([{ kind: "encoder-rotate", deviceId: "xl-1", encoder: 0, ticks: 1, at: 100 }], live);
  const offline = run([{ kind: "herdr-connection", connected: false }], browsing);

  const [device] = surfaceOf(offline).devices;
  assert.equal(device.encoders[0].block.notice, "OFFLINE");
});

/**
 * Dial 2's own strip presence (ADR-0007, ADR-0009, `-8e8`): an armed removal
 * must be visible before it can be trusted to time out visibly, and a
 * success or failure must show on the channel that caused it. The reducer's
 * own rotate/press/arm decisions are covered in state.test.mjs.
 */

test("an armed removal reads visibly on the channel's strip", () => {
  const live = liveState({ workspaces: [workspaceOn(1, "auth")] });
  const armed = run(
    [
      { kind: "encoder-rotate", deviceId: "xl-1", encoder: 1, ticks: 1, at: 100 },
      { kind: "encoder-down", deviceId: "xl-1", encoder: 1, at: 200 }
    ],
    live
  );

  const [device] = surfaceOf(armed).devices;
  assert.equal(device.encoders[0].block.notice, "REMOVE AGAIN?");
});

test("dial 2 winning over dial 1 on the same channel's strip, since it can be mid-arm on something destructive", () => {
  const live = liveState({ workspaces: [workspaceOn(1, "auth")], panes: [paneOn("w1", "a")] });
  const both = run(
    [
      { kind: "encoder-rotate", deviceId: "xl-1", encoder: 0, ticks: 1, at: 50 }, // dial 1 browsing
      { kind: "encoder-rotate", deviceId: "xl-1", encoder: 1, ticks: 1, at: 100 }, // dial 2 browsing
      { kind: "encoder-down", deviceId: "xl-1", encoder: 1, at: 200 } // dial 2 armed
    ],
    live
  );

  const [device] = surfaceOf(both).devices;
  assert.equal(device.encoders[0].block.notice, "REMOVE AGAIN?");
});

test("dial 2's success is acknowledged on the channel's strip", () => {
  const live = liveState({ workspaces: [workspaceOn(1, "auth")] });
  const acknowledged = run([{ kind: "dial2-acknowledged", channel: 0, ok: true, message: "CREATED", at: 100 }], live);

  const [device] = surfaceOf(acknowledged).devices;
  assert.equal(device.encoders[0].block.notice, "CREATED");
});

test("dial 2's failure is acknowledged on the channel's strip, naming the cause", () => {
  const live = liveState({ workspaces: [workspaceOn(1, "auth")] });
  const acknowledged = run(
    [{ kind: "dial2-acknowledged", channel: 0, ok: false, message: "worktree has uncommitted changes", at: 100 }],
    live
  );

  const [device] = surfaceOf(acknowledged).devices;
  assert.equal(device.encoders[0].block.notice, "worktree has uncommitted changes");
});

/**
 * `-0vd.3`: panes a row's own overflow count hides used to be reachable by
 * nothing on the device at all. Dial 1 (`-u5d`) rotates a workstream's panes
 * directly rather than the row, so it already reaches every one of them —
 * this pins that down against the exact scenario the bug described, rather
 * than trusting it as an unverified side effect of a later ticket.
 */
test("panes a row's overflow count hides are reachable by nothing on the key grid, but dial 1 can still reach them", () => {
  const panes = ["a", "b", "c", "d"].map((id) => paneOn("w1", id));
  const live = liveState({ workspaces: [workspaceOn(1, "auth")], panes });

  const [device] = surfaceOf(live).devices;
  const sharedRow = rowOf(device, 0, 2); // the tests/logs/shell row every plain shell pane lands on
  assert.equal(sharedRow[0].kind, "pane");
  assert.equal(sharedRow[1].kind, "pane");
  assert.equal(sharedRow[2].kind, "more");
  assert.equal(sharedRow[2].count, 2, "two panes have no key of their own");

  // "w1:c" and "w1:d" — the two the row's count hides, by pane-id order —
  // are still there for dial 1 to name and select.
  const atThird = run([{ kind: "encoder-rotate", deviceId: "xl-1", encoder: 0, ticks: 3, at: 100 }], live);
  assert.equal(surfaceOf(atThird).devices[0].encoders[0].block.notice, "> w1:c");

  const atFourth = run([{ kind: "encoder-rotate", deviceId: "xl-1", encoder: 0, ticks: 1, at: 200 }], atThird);
  assert.equal(surfaceOf(atFourth).devices[0].encoders[0].block.notice, "> w1:d");
});
