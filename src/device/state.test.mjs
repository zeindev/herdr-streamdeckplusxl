import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { HOLD_MS, RESYNC_DEBOUNCE_MS, initialState, reduce } from "../../.preview/device/state.js";
import { overflowOf, readSlots } from "../../.preview/device/slots.js";
import { roleResolver } from "../../.preview/device/role.js";
import { DEVICE_TYPE_XL } from "../../.preview/device/geometry.js";
import { workstreamsOf } from "../../.preview/device/workstream.js";
import { recordedEvents, recordedWorkspace, recordedWorktree } from "../herdr/fixtures/recorded.mjs";

const capture = JSON.parse(readFileSync(new URL("../herdr/fixtures/capture.json", import.meta.url), "utf8"));

/** Real events of one kind, so tests exercise recorded payloads rather than invented ones. */
function recorded(kind, at = 0) {
  const found = capture.events.find((event) => event.event === kind);
  assert.ok(found, `the capture has no ${kind} to test with`);
  return { kind: "herdr-event", event: { event: found.event, data: found.data }, at };
}

function snapshotOf({ workspaces = [], panes = [], tabs = [] } = {}) {
  return { kind: "herdr-snapshot", snapshot: { workspaces, panes, tabs } };
}

/** Applies events in order, returning the final state and every command emitted. */
function run(events, from = initialState()) {
  let state = from;
  const commands = [];
  for (const event of events) {
    const step = reduce(state, event);
    state = step.state;
    commands.push(...step.commands);
  }
  return { state, commands };
}

const xl = { kind: "device-attached", device: { id: "xl-1", type: DEVICE_TYPE_XL } };

test("a fresh state is offline and knows nothing", () => {
  const state = initialState();
  assert.equal(state.sync, "offline");
  assert.equal(state.snapshot, null);
  assert.deepEqual(state.devices, []);
});

test("the reducer never mutates the state it was given", () => {
  const before = initialState();
  const frozen = JSON.stringify(before);
  reduce(before, { kind: "herdr-connection", connected: true });
  reduce(before, xl);
  assert.equal(JSON.stringify(before), frozen);
});

test("connecting asks for the snapshot rather than trusting the event stream", () => {
  const { state, commands } = run([{ kind: "herdr-connection", connected: true }]);
  assert.equal(state.sync, "syncing");
  assert.deepEqual(commands, [{ kind: "load-snapshot" }]);
});

test("the snapshot is what makes the device live", () => {
  const { state } = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({ workspaces: [{ workspace_id: "w1", label: "auth" }], panes: [{ pane_id: "w1:p1" }] })
  ]);
  assert.equal(state.sync, "live");
  assert.equal(state.snapshot.workspaces.length, 1);
  assert.equal(state.snapshot.panes.length, 1);
});

test("events arriving before the snapshot are discarded as replayed history", () => {
  // Herdr replays a backlog on every subscribe, describing things that may no
  // longer exist. Applying it would resurrect deleted workspaces.
  const { state } = run([
    { kind: "herdr-connection", connected: true },
    recorded("workspace_created"),
    recorded("worktree_created"),
    recorded("pane_created")
  ]);
  assert.equal(state.sync, "syncing");
  assert.equal(state.snapshot, null, "nothing may be built from the backlog");
});

test("a reconnection re-reads the truth and ignores the replay that follows", () => {
  const live = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({ panes: [{ pane_id: "w1:p1", revision: 1 }] })
  ]).state;

  const { state, commands } = run(
    [
      { kind: "herdr-connection", connected: false },
      { kind: "herdr-connection", connected: true },
      recorded("workspace_closed")
    ],
    live
  );

  assert.equal(state.sync, "syncing");
  assert.deepEqual(commands, [{ kind: "load-snapshot" }]);
});

test("losing Herdr marks the device offline without inventing state", () => {
  const live = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({ panes: [{ pane_id: "w1:p1" }] })
  ]).state;

  const { state } = run([{ kind: "herdr-connection", connected: false }], live);
  assert.equal(state.sync, "offline");
});

test("a pane update is applied in place once live", () => {
  const live = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({ panes: [{ pane_id: "w4:p1", agent_status: "idle", revision: 1 }] })
  ]).state;

  const update = {
    kind: "herdr-event",
    at: 0,
    event: {
      event: "pane_updated",
      data: { type: "pane_updated", pane: { pane_id: "w4:p1", agent_status: "working", revision: 2 } }
    }
  };
  const { state } = run([update], live);
  assert.equal(state.snapshot.panes[0].agent_status, "working");
});

test("a stale pane update is ignored, since replays arrive out of order", () => {
  const live = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({ panes: [{ pane_id: "w4:p1", agent_status: "working", revision: 9 }] })
  ]).state;

  const stale = {
    kind: "herdr-event",
    at: 0,
    event: {
      event: "pane_updated",
      data: { type: "pane_updated", pane: { pane_id: "w4:p1", agent_status: "idle", revision: 4 } }
    }
  };
  const { state } = run([stale], live);
  assert.equal(state.snapshot.panes[0].agent_status, "working", "an older revision must not win");
});

test("pane updates alone never ask for a resync, because they flood", () => {
  const live = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({ panes: [{ pane_id: "w4:p1", revision: 1 }] })
  ]).state;

  const updates = Array.from({ length: 50 }, (_, index) => ({
    kind: "herdr-event",
    at: index,
    event: {
      event: "pane_updated",
      data: { type: "pane_updated", pane: { pane_id: "w4:p1", revision: index + 2 } }
    }
  }));
  const { commands } = run([...updates, { kind: "tick", at: 10_000 }], live);
  assert.deepEqual(commands, [], "50 output revisions must not cause 50 snapshot reads");
});

test("a structural change schedules one resync however many events arrive", () => {
  const live = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({ workspaces: [{ workspace_id: "w1" }] })
  ]).state;

  const { commands } = run(
    [
      recorded("tab_created"),
      recorded("pane_created"),
      recorded("workspace_renamed"),
      { kind: "tick", at: RESYNC_DEBOUNCE_MS + 1 }
    ],
    live
  );
  assert.deepEqual(commands, [{ kind: "load-snapshot" }], "one read for the whole burst");
});

test("a scheduled resync waits for the debounce to pass", () => {
  const live = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({ workspaces: [{ workspace_id: "w1" }] })
  ]).state;

  const early = run([recorded("tab_created"), { kind: "tick", at: RESYNC_DEBOUNCE_MS - 1 }], live);
  assert.deepEqual(early.commands, [], "too soon to re-read");

  const later = run([{ kind: "tick", at: RESYNC_DEBOUNCE_MS + 1 }], early.state);
  assert.deepEqual(later.commands, [{ kind: "load-snapshot" }]);
});

test("an idle tick asks for nothing", () => {
  const live = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({ panes: [] })
  ]).state;
  assert.deepEqual(run([{ kind: "tick", at: 50_000 }], live).commands, []);
});

test("devices come and go without disturbing Herdr state", () => {
  const live = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({ panes: [{ pane_id: "w1:p1" }] })
  ]).state;

  const attached = run([xl], live);
  assert.deepEqual(attached.state.devices, [{ id: "xl-1", type: DEVICE_TYPE_XL }]);
  assert.equal(attached.state.sync, "live");
  assert.deepEqual(attached.commands, []);

  const detached = run([{ kind: "device-detached", deviceId: "xl-1" }], attached.state);
  assert.deepEqual(detached.state.devices, []);
  assert.equal(detached.state.sync, "live", "unplugging a device says nothing about Herdr");
});

test("an unsupported device is not adopted", () => {
  const { state } = run([{ kind: "device-attached", device: { id: "plus-1", type: 7 } }]);
  assert.deepEqual(state.devices, [], "the Stream Deck+ is not a target");
});

test("attaching the same device twice does not duplicate it", () => {
  const { state } = run([xl, xl]);
  assert.equal(state.devices.length, 1);
});

test("a key press is tracked while held, with when it began, and released cleanly", () => {
  const key = { deviceId: "xl-1", column: 4, row: 2 };
  const down = run([xl, { kind: "key-down", key, at: 500 }]);
  assert.deepEqual(down.state.pressed, [{ key, at: 500 }], "a hold cannot be told from a tap without the time");

  const up = run([{ kind: "key-up", key, at: 600 }], down.state);
  assert.deepEqual(up.state.pressed, []);
});

test("a key release with no matching press is harmless", () => {
  const { state } = run([xl, { kind: "key-up", key: { deviceId: "xl-1", column: 0, row: 0 }, at: 0 }]);
  assert.deepEqual(state.pressed, []);
});

test("unplugging a device forgets keys still held on it", () => {
  const held = run([xl, { kind: "key-down", key: { deviceId: "xl-1", column: 1, row: 1 }, at: 0 }]);
  const { state } = run([{ kind: "device-detached", deviceId: "xl-1" }], held.state);
  assert.deepEqual(state.pressed, [], "a detached device cannot report the release");
});

test("encoder input is accepted without commands until something is bound to it", () => {
  const { state, commands } = run([
    xl,
    { kind: "encoder-rotate", deviceId: "xl-1", encoder: 0, ticks: 3 },
    { kind: "encoder-down", deviceId: "xl-1", encoder: 0 },
    { kind: "encoder-up", deviceId: "xl-1", encoder: 0 }
  ]);
  assert.deepEqual(commands, []);
  assert.equal(state.devices.length, 1);
});

test("the theme is carried on state so rendering never reaches for it", () => {
  const theme = { name: "catppuccin", appearance: "dark", palette: {} };
  const { state } = run([{ kind: "theme-changed", theme }]);
  assert.equal(state.theme.name, "catppuccin");
});

function paneUpdate(pane, at = 0) {
  return { kind: "herdr-event", at, event: { event: "pane_updated", data: { type: "pane_updated", pane } } };
}

test("a snapshot asks for the branches the snapshot itself does not carry", () => {
  const workspace = recordedWorkspace({ workspace_id: "w6" });
  assert.ok(!("branch" in workspace.worktree), "Herdr's snapshot worktree has no branch to read");

  const { commands } = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({ workspaces: [workspace] })
  ]);
  assert.deepEqual(
    commands.filter((command) => command.kind === "load-worktrees"),
    [{ kind: "load-worktrees", workspaceId: "w6" }]
  );
});

test("workspaces sharing a repository cost one read between them", () => {
  const { commands } = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({
      workspaces: [
        recordedWorkspace({ workspace_id: "w4", number: 1 }),
        recordedWorkspace({ workspace_id: "w6", number: 2 })
      ]
    })
  ]);
  assert.equal(commands.filter((command) => command.kind === "load-worktrees").length, 1);
});

test("a branch is kept beside the snapshot, so a re-read does not lose it", () => {
  const workspace = recordedWorkspace({ workspace_id: "w6" });
  const worktree = recordedWorktree();

  const learnt = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({ workspaces: [workspace] }),
    { kind: "herdr-worktrees", worktrees: [worktree] }
  ]);
  assert.equal(learnt.state.branches[worktree.path], "sd-fixture-probe");

  const reread = run([snapshotOf({ workspaces: [workspace] })], learnt.state);
  assert.equal(reread.state.branches[worktree.path], "sd-fixture-probe", "the branch survives a new snapshot");
});

test("branches of checkouts no workspace holds are not kept", () => {
  const workspace = recordedWorkspace({ workspace_id: "w6" });
  const worktree = recordedWorktree();

  const learnt = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({ workspaces: [workspace] }),
    // A repository normally has worktrees nothing is open on; those cannot reach
    // a channel, so remembering them would only grow the map.
    { kind: "herdr-worktrees", worktrees: [worktree, { path: "/elsewhere", branch: "stray" }] }
  ]);
  assert.equal(learnt.state.branches["/elsewhere"], undefined);

  const closed = run([snapshotOf({ workspaces: [] })], learnt.state);
  assert.deepEqual(closed.state.branches, {}, "a closed workstream takes its branch with it");
});

test("a worktree reply that changes nothing leaves the state alone, so nothing redraws", () => {
  const workspace = recordedWorkspace({ workspace_id: "w6" });
  const worktree = recordedWorktree();
  const learnt = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({ workspaces: [workspace] }),
    { kind: "herdr-worktrees", worktrees: [worktree] }
  ]).state;

  const again = reduce(learnt, { kind: "herdr-worktrees", worktrees: [worktree] });
  assert.equal(again.state, learnt, "an identical answer must not look like a change");
});

test("a workstream appearing shows up on the next snapshot", () => {
  const first = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({ workspaces: [recordedWorkspace({ workspace_id: "w4", number: 1 })] })
  ]);
  assert.equal(workstreamsOf(first.state.snapshot).length, 1);

  const second = run(
    [
      snapshotOf({
        workspaces: [
          recordedWorkspace({ workspace_id: "w4", number: 1 }),
          recordedWorkspace({ workspace_id: "w6", number: 2 })
        ]
      })
    ],
    first.state
  );
  assert.deepEqual(
    workstreamsOf(second.state.snapshot).map((workstream) => workstream.workspaceId),
    ["w4", "w6"]
  );
});

test("a workstream changing state redraws from the event stream, with no snapshot read", () => {
  // This is the whole point of recomputing the aggregate: Herdr pushes
  // pane_updated and never workspace_updated, so nothing else would move.
  const live = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({
      workspaces: [recordedWorkspace({ workspace_id: "w6", number: 1 })],
      panes: [{ pane_id: "w6:p1", workspace_id: "w6", agent: "claude", agent_status: "working", revision: 1 }]
    })
  ]).state;
  assert.equal(workstreamsOf(live.snapshot)[0].agentStatus, "working");

  const blocked = run(
    [paneUpdate({ pane_id: "w6:p1", workspace_id: "w6", agent: "claude", agent_status: "blocked", revision: 2 })],
    live
  );
  assert.equal(workstreamsOf(blocked.state.snapshot)[0].agentStatus, "blocked");
  assert.deepEqual(blocked.commands, [], "no read was needed, so none was asked for");
});

test("a workstream disappearing leaves its channel empty rather than stale", () => {
  const live = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({
      workspaces: [recordedWorkspace({ workspace_id: "w6", number: 1 })],
      panes: [{ pane_id: "w6:p1", workspace_id: "w6", agent: "claude", agent_status: "working" }]
    })
  ]).state;

  const closed = run([snapshotOf({ workspaces: [], panes: [] })], live);
  assert.deepEqual(workstreamsOf(closed.state.snapshot), []);
});

test("closing a workspace schedules the re-read that empties its channel", () => {
  const live = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({ workspaces: [recordedWorkspace({ workspace_id: "w6", number: 1 })] })
  ]).state;

  const { commands } = run([recorded("workspace_closed"), { kind: "tick", at: RESYNC_DEBOUNCE_MS + 1 }], live);
  assert.deepEqual(commands, [{ kind: "load-snapshot" }]);
});

/** A workspace on a checkout of its own, which is what a slot remembers it by. */
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

/** Holding a channel's strip is what reassigns it, since the panes took the keys. */
function hold(state, channel) {
  return run([{ kind: "encoder-touch", deviceId: "xl-1", encoder: channel * 2, hold: true }], state);
}

function liveWith(workspaces, from) {
  return run([{ kind: "herdr-connection", connected: true }, snapshotOf({ workspaces })], from);
}

function liveWith2(workspaces, panes) {
  return run([xl, { kind: "herdr-connection", connected: true }, snapshotOf({ workspaces, panes })]);
}

test("a workstream is given a channel and the assignment is persisted", () => {
  const { state, commands } = liveWith([workspaceOn(1, "auth")], run([xl]).state);

  assert.deepEqual(state.slots.bindings, ["checkout:/w/auth", null, null]);
  const saves = commands.filter((command) => command.kind === "save-slots");
  assert.equal(saves.length, 1, "geography that is not written down does not survive the night");
  assert.deepEqual(saves[0].slots.bindings, ["checkout:/w/auth", null, null]);
});

test("a workstream keeps its channel when an earlier one closes", () => {
  const both = liveWith([workspaceOn(1, "auth"), workspaceOn(2, "billing")], run([xl]).state);
  assert.deepEqual(both.state.slots.bindings, ["checkout:/w/auth", "checkout:/w/billing", null]);

  const after = liveWith([workspaceOn(2, "billing")], both.state);
  assert.equal(after.state.slots.bindings[1], "checkout:/w/billing", "billing does not slide left into the free channel");
  assert.deepEqual(after.commands.filter((command) => command.kind === "save-slots"), [], "nothing moved, nothing to write");
});

test("assignments read back from settings put the channels where they were", () => {
  const stored = { kind: "settings-loaded", roles: {}, slots: readSlots({ slots: [null, "checkout:/w/billing", "checkout:/w/auth"] }) };
  const restored = run([xl, stored]);
  assert.deepEqual(restored.state.slots.bindings, [null, "checkout:/w/billing", "checkout:/w/auth"]);

  // Herdr comes back with different workspace ids; the checkout path is what
  // the channel remembers, so both land where the developer left them.
  const live = liveWith([workspaceOn(8, "auth"), workspaceOn(9, "billing")], restored.state);
  assert.deepEqual(live.state.slots.bindings, [null, "checkout:/w/billing", "checkout:/w/auth"]);
  assert.deepEqual(live.commands.filter((command) => command.kind === "save-slots"), []);
});

test("a workstream the stored settings never mentioned takes a free channel", () => {
  const restored = run([xl, { kind: "settings-loaded", roles: {}, slots: readSlots({ slots: [null, "checkout:/w/billing", null] }) }]);
  const live = liveWith([workspaceOn(1, "auth"), workspaceOn(2, "billing")], restored.state);

  assert.deepEqual(live.state.slots.bindings, ["checkout:/w/auth", "checkout:/w/billing", null]);
});

test("a fourth workstream is counted rather than given a channel", () => {
  const { state } = liveWith(
    [workspaceOn(1, "a"), workspaceOn(2, "b"), workspaceOn(3, "c"), workspaceOn(4, "d")],
    run([xl]).state
  );

  assert.deepEqual(state.slots.bindings, ["checkout:/w/a", "checkout:/w/b", "checkout:/w/c"]);
  assert.equal(overflowOf(state.slots, workstreamsOf(state.snapshot)).length, 1);
});

test("overflow clears live as a workstream closes", () => {
  const crowded = liveWith(
    [workspaceOn(1, "a"), workspaceOn(2, "b"), workspaceOn(3, "c"), workspaceOn(4, "d")],
    run([xl]).state
  );
  const roomy = liveWith([workspaceOn(2, "b"), workspaceOn(3, "c"), workspaceOn(4, "d")], crowded.state);

  assert.equal(overflowOf(roomy.state.slots, workstreamsOf(roomy.state.snapshot)).length, 0);
  assert.equal(roomy.state.slots.bindings[0], "checkout:/w/d", "the freed channel absorbs the workstream that was waiting");
});

test("a tap on a channel's strip changes nothing, because reassigning must be deliberate", () => {
  const live = liveWith([workspaceOn(1, "auth")], run([xl]).state);
  const tapped = run([{ kind: "encoder-touch", deviceId: "xl-1", encoder: 0, hold: false }], live.state);

  assert.deepEqual(tapped.state.slots.bindings, live.state.slots.bindings);
  assert.deepEqual(tapped.commands, []);
});

test("holding a bound channel's strip lets its workstream go, and says so in storage", () => {
  const live = liveWith([workspaceOn(1, "auth"), workspaceOn(2, "billing")], run([xl]).state);
  const released = hold(live.state, 0);

  assert.deepEqual(released.state.slots.bindings, [null, "checkout:/w/billing", null]);
  assert.equal(released.commands.filter((command) => command.kind === "save-slots").length, 1);
  assert.equal(overflowOf(released.state.slots, workstreamsOf(released.state.snapshot)).length, 1, "it is over budget now");
});

test("a released workstream is not handed straight back by the next snapshot", () => {
  // The gesture is only real if it outlives Herdr speaking again, which it does
  // dozens of times a second.
  const live = liveWith([workspaceOn(1, "auth"), workspaceOn(2, "billing")], run([xl]).state);
  const released = hold(live.state, 0);
  const after = liveWith([workspaceOn(1, "auth"), workspaceOn(2, "billing")], released.state);

  assert.deepEqual(after.state.slots.bindings, [null, "checkout:/w/billing", null]);
  assert.equal(overflowOf(after.state.slots, workstreamsOf(after.state.snapshot)).length, 1);
});

test("holding an empty channel takes in the workstream that was waiting", () => {
  const live = liveWith([workspaceOn(1, "auth"), workspaceOn(2, "billing")], run([xl]).state);
  const released = hold(live.state, 0);
  const adopted = hold(released.state, 2);

  assert.deepEqual(adopted.state.slots.bindings, [null, "checkout:/w/billing", "checkout:/w/auth"]);
  assert.equal(overflowOf(adopted.state.slots, workstreamsOf(adopted.state.snapshot)).length, 0);
});

test("a worktree created while one channel is free lands in that channel", () => {
  const live = liveWith([workspaceOn(1, "auth"), workspaceOn(2, "billing")], run([xl]).state);
  assert.equal(live.state.slots.bindings[2], null, "one channel is offering a worktree");

  const created = liveWith(
    [workspaceOn(1, "auth"), workspaceOn(2, "billing"), workspaceOn(3, "search")],
    live.state
  );
  assert.equal(created.state.slots.bindings[2], "checkout:/w/search");
});

test("holding an empty channel with nothing waiting does nothing", () => {
  const live = liveWith([workspaceOn(1, "auth")], run([xl]).state);
  const held = hold(live.state, 2);

  assert.deepEqual(held.state.slots.bindings, live.state.slots.bindings);
  assert.deepEqual(held.commands, []);
});

test("holding a key never reassigns a channel, since that gesture lives on the strip", () => {
  const live = liveWith([workspaceOn(1, "auth"), workspaceOn(2, "billing")], run([xl]).state);
  for (const key of [{ deviceId: "xl-1", column: 0, row: 0 }, { deviceId: "xl-1", column: 0, row: 3 }]) {
    const held = run([{ kind: "key-down", key, at: 1000 }, { kind: "tick", at: 1000 + HOLD_MS }], live.state);
    assert.deepEqual(held.state.slots.bindings, live.state.slots.bindings);
    assert.deepEqual(held.commands.filter((command) => command.kind === "save-slots"), []);
  }
});

test("a workspace with no worktree occupies a channel like any other", () => {
  const primary = { ...workspaceOn(1, "primary"), worktree: null };
  const { state } = liveWith([primary, workspaceOn(2, "auth")], run([xl]).state);

  assert.deepEqual(state.slots.bindings, ["workspace:w1", "checkout:/w/auth", null]);
});

const paneOn = (workspaceId, id, overrides = {}) => ({
  pane_id: `${workspaceId}:${id}`,
  workspace_id: workspaceId,
  agent_status: "unknown",
  ...overrides
});

const shellProcess = { pid: 1, name: "zsh", argv0: "zsh", cmdline: "-zsh" };
const testProcess = { pid: 2, name: "node", argv0: "vitest", cmdline: "vitest --watch" };

/** The key at a channel's row and column, as the SDK addresses it. */
const keyAt = (channel, column, row) => ({ deviceId: "xl-1", column: channel * 3 + column, row });

function holdKey(state, key, at = 5000) {
  const down = run([{ kind: "key-down", key, at }], state);
  const fired = run([{ kind: "tick", at: at + HOLD_MS }], down.state);
  return { ...fired, state: run([{ kind: "key-up", key, at: at + HOLD_MS + 1 }], fired.state).state };
}

test("a snapshot asks what is running in panes it has not seen", () => {
  const { commands } = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a"), paneOn("w1", "b")]);
  assert.deepEqual(
    commands.filter((command) => command.kind === "load-process-info").map((command) => command.paneId),
    ["w1:a", "w1:b"]
  );
});

test("an agent pane is never asked about, because Herdr already said", () => {
  // Herdr detects agents itself and pushes the answer, so a lookup would be a
  // request per pane for something already known.
  const { commands } = liveWith2(
    [workspaceOn(1, "auth")],
    [paneOn("w1", "agent", { agent: "claude" }), paneOn("w1", "other")]
  );
  assert.deepEqual(
    commands.filter((command) => command.kind === "load-process-info").map((command) => command.paneId),
    ["w1:other"]
  );
});

test("a pane already asked about is not asked again", () => {
  const first = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a")]);
  const learnt = run([{ kind: "herdr-process-info", paneId: "w1:a", process: shellProcess }], first.state);
  const again = run([snapshotOf({ workspaces: [workspaceOn(1, "auth")], panes: [paneOn("w1", "a")] })], learnt.state);

  assert.deepEqual(again.commands.filter((command) => command.kind === "load-process-info"), []);
});

test("what was learned about a pane is forgotten when the pane goes", () => {
  const learnt = run(
    [{ kind: "herdr-process-info", paneId: "w1:a", process: shellProcess }],
    liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a")]).state
  );
  assert.ok("w1:a" in learnt.state.processes);

  const gone = run([snapshotOf({ workspaces: [workspaceOn(1, "auth")], panes: [] })], learnt.state);
  assert.deepEqual(gone.state.processes, {});
});

test("holding a pane key corrects its role, and the correction is persisted", () => {
  const live = run(
    [{ kind: "herdr-process-info", paneId: "w1:t", process: testProcess }],
    liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "t")]).state
  ).state;

  // vitest is detected as a test watcher, which puts it on the third row.
  const held = holdKey(live, keyAt(0, 0, 2));
  assert.deepEqual(held.state.roles, { "vitest --watch": "logs" }, "the next role after tests");
  assert.deepEqual(held.commands, [{ kind: "save-roles", roles: { "vitest --watch": "logs" } }]);
});

test("a correction is remembered by command line, so it survives the pane restarting", () => {
  const corrected = { kind: "settings-loaded", slots: readSlots(undefined), roles: { "vitest --watch": "server" } };
  const restored = run([xl, corrected]);

  // The same command comes back in a pane with a different id after a restart.
  const live = run(
    [
      { kind: "herdr-connection", connected: true },
      snapshotOf({ workspaces: [workspaceOn(1, "auth")], panes: [paneOn("w1", "restarted")] }),
      { kind: "herdr-process-info", paneId: "w1:restarted", process: testProcess }
    ],
    restored.state
  ).state;

  assert.equal(roleResolver(live.processes, live.roles)(live.snapshot.panes[0]), "server");
});

test("holding a pane nothing is known about corrects nothing, rather than forgetting it later", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "p")]).state;
  const held = holdKey(live, keyAt(0, 0, 2));

  assert.deepEqual(held.state.roles, {}, "there is no command line to remember it by");
  assert.deepEqual(held.commands, []);
});

test("tapping a pane key focuses that pane in Herdr", () => {
  const live = run(
    [{ kind: "herdr-process-info", paneId: "w1:sh", process: shellProcess }],
    liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "sh")]).state
  ).state;

  const key = keyAt(0, 0, 2);
  const { commands } = run([{ kind: "key-down", key, at: 100 }, { kind: "key-up", key, at: 200 }], live);
  assert.deepEqual(commands, [{ kind: "herdr-request", method: "pane.focus", params: { pane_id: "w1:sh" } }]);
});

test("a hold on a pane key does not also focus it when the key comes back up", () => {
  const live = run(
    [{ kind: "herdr-process-info", paneId: "w1:sh", process: shellProcess }],
    liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "sh")]).state
  ).state;

  const held = holdKey(live, keyAt(0, 0, 2));
  assert.deepEqual(held.commands.filter((command) => command.kind === "herdr-request"), []);
});

test("tapping an empty key asks Herdr for nothing", () => {
  const live = liveWith2([workspaceOn(1, "auth")], []).state;
  const key = keyAt(0, 2, 1);
  const { commands } = run([{ kind: "key-down", key, at: 100 }, { kind: "key-up", key, at: 200 }], live);
  assert.deepEqual(commands, []);
});

test("every recorded event kind can be applied to a live state without throwing", () => {
  const live = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({ panes: [{ pane_id: "w4:p1", revision: 1 }], workspaces: [{ workspace_id: "w4" }] })
  ]).state;

  for (const event of capture.events) {
    const step = reduce(live, { kind: "herdr-event", event: { event: event.event, data: event.data }, at: 0 });
    assert.ok(step.state, `${event.event} produced no state`);
    assert.ok(Array.isArray(step.commands));
  }
});
