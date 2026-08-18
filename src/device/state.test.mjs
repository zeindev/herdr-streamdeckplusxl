import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { HOLD_MS, RESYNC_DEBOUNCE_MS, dial2NoticeOf, initialState, reduce } from "../../.preview/device/state.js";
import { DIAL_PREVIEW_TIMEOUT_MS } from "../../.preview/device/dial.js";
import { REMOVE_ARM_TIMEOUT_MS } from "../../.preview/device/dial2.js";
import { ACK_DISPLAY_MS, ARM_TIMEOUT_MS, CONTINUE_PROMPT } from "../../.preview/device/control.js";
import { attentionOf } from "../../.preview/device/attention.js";
import { overflowOf, readSlots } from "../../.preview/device/slots.js";
import { roleResolver } from "../../.preview/device/role.js";
import { DEVICE_TYPE_MINI, DEVICE_TYPE_XL } from "../../.preview/device/geometry.js";
import { UNKNOWN, pullRequestReadingValue, ticketsReadingValue } from "../../.preview/device/enrichment.js";
import { workstreamsOf } from "../../.preview/device/workstream.js";
import { recordedEvents, recordedWorkspace, recordedWorktree } from "../herdr/fixtures/recorded.mjs";

const capture = JSON.parse(readFileSync(new URL("../herdr/fixtures/capture.json", import.meta.url), "utf8"));

/** Real events of one kind, so tests exercise recorded payloads rather than invented ones. */
function recorded(kind, at = 0) {
  const found = capture.events.find((event) => event.event === kind);
  assert.ok(found, `the capture has no ${kind} to test with`);
  return { kind: "herdr-event", event: { event: found.event, data: found.data }, at };
}

function workspaceClosed(workspaceId, at = 0) {
  const captured = recorded("workspace_closed", at);
  return {
    ...captured,
    event: {
      ...captured.event,
      data: { ...captured.event.data, workspace_id: workspaceId, workspace: { ...captured.event.data.workspace, workspace_id: workspaceId } }
    }
  };
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

test("an agent changing state arrives on the event stream, with no snapshot read", () => {
  // Herdr pushes pane_updated and never workspace_updated, so this is the only
  // path by which a channel's agents stay current.
  const live = run([
    { kind: "herdr-connection", connected: true },
    snapshotOf({
      workspaces: [recordedWorkspace({ workspace_id: "w6", number: 1 })],
      panes: [{ pane_id: "w6:p1", workspace_id: "w6", agent: "claude", agent_status: "working", revision: 1 }]
    })
  ]).state;

  const blocked = run(
    [paneUpdate({ pane_id: "w6:p1", workspace_id: "w6", agent: "claude", agent_status: "blocked", revision: 2 })],
    live
  );
  assert.equal(blocked.state.snapshot.panes[0].agent_status, "blocked");
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

  const { state, commands } = run([recorded("workspace_closed"), { kind: "tick", at: RESYNC_DEBOUNCE_MS + 1 }], live);
  assert.equal(state.slots.bindings[0], null, "an explicit close releases the remembered channel before the snapshot arrives");
  assert.deepEqual(commands, [{ kind: "save-slots", slots: state.slots }, { kind: "load-snapshot" }]);
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

/** A workspace on a checkout in a specific, named repository — dial 2's create candidates come from these. */
function workspaceOnRepo(number, label, repoKey) {
  const workspace = workspaceOn(number, label);
  return { ...workspace, worktree: { ...workspace.worktree, repo_key: repoKey, repo_name: repoKey, repo_root: `/repos/${repoKey}` } };
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

const mini = { kind: "device-attached", device: { id: "mini-1", type: DEVICE_TYPE_MINI } };

function liveWithMini(workspaces, panes) {
  return run([mini, { kind: "herdr-connection", connected: true }, snapshotOf({ workspaces, panes })]);
}

/** The Mini's own key at a channel's column and row, as the SDK addresses it (`-vk6`: one column per channel). */
const miniKeyAt = (channel, row) => ({ deviceId: "mini-1", column: channel, row });

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
  const stored = { kind: "settings-loaded", roles: {}, acknowledged: [], slots: readSlots({ slots: [null, "checkout:/w/billing", "checkout:/w/auth"] }) };
  const restored = run([xl, stored]);
  assert.deepEqual(restored.state.slots.bindings, [null, "checkout:/w/billing", "checkout:/w/auth"]);

  // Herdr comes back with different workspace ids; the checkout path is what
  // the channel remembers, so both land where the developer left them.
  const live = liveWith([workspaceOn(8, "auth"), workspaceOn(9, "billing")], restored.state);
  assert.deepEqual(live.state.slots.bindings, [null, "checkout:/w/billing", "checkout:/w/auth"]);
  assert.deepEqual(live.commands.filter((command) => command.kind === "save-slots"), []);
});

test("a workstream the stored settings never mentioned takes a free channel", () => {
  const restored = run([xl, { kind: "settings-loaded", roles: {}, acknowledged: [], slots: readSlots({ slots: [null, "checkout:/w/billing", null] }) }]);
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

test("adding primary-checkout metadata does not move its workspace to another channel", () => {
  const primary = { ...workspaceOn(1, "primary"), worktree: null };
  const live = liveWith([primary], run([xl]).state).state;
  assert.deepEqual(live.slots.bindings, ["workspace:w1", null, null]);

  const linkedShape = workspaceOn(1, "primary");
  const withCheckout = {
    ...linkedShape,
    worktree: { ...linkedShape.worktree, checkout_path: "/repo", is_linked_worktree: false }
  };
  const refreshed = liveWith([withCheckout], live);
  assert.deepEqual(refreshed.state.slots.bindings, ["workspace:w1", null, null]);
  assert.deepEqual(refreshed.commands.filter((command) => command.kind === "save-slots"), []);
});

test("a worktree created after an explicit close takes the channel that close freed", () => {
  const primary = { ...workspaceOn(1, "primary"), worktree: null };
  const disposable = { ...workspaceOn(2, "shell"), worktree: null };
  const live = liveWith([primary, disposable], run([xl]).state).state;
  assert.deepEqual(live.slots.bindings, ["workspace:w1", "workspace:w2", null]);

  const closed = run([workspaceClosed("w2", 100)], live).state;
  const created = liveWith([primary, workspaceOn(3, "feature")], closed).state;
  assert.deepEqual(created.slots.bindings, ["workspace:w1", "checkout:/w/feature", null]);
});

const paneOn = (workspaceId, id, overrides = {}) => ({
  pane_id: `${workspaceId}:${id}`,
  workspace_id: workspaceId,
  agent_status: "unknown",
  ...overrides
});

/** A `pane.process_info` reply, as Herdr sends one. */
const runningIn = (paneId, cmdline) => ({
  kind: "herdr-process-info",
  paneId,
  info: {
    pane_id: paneId,
    foreground_process_group_id: 7,
    foreground_processes: [{ pid: 7, name: "x", argv0: cmdline.split(" ")[0], cmdline }]
  }
});

/** The key at a channel's row and column, as the SDK addresses it. */
const keyAt = (channel, column, row) => ({ deviceId: "xl-1", column: channel * 3 + column, row });

function holdKey(state, key, at = 5000) {
  const down = run([{ kind: "key-down", key, at }], state);
  const fired = run([{ kind: "tick", at: at + HOLD_MS }], down.state);
  return { ...fired, state: run([{ kind: "key-up", key, at: at + HOLD_MS + 1 }], fired.state).state };
}

/** Rotates a channel's dial 1 (encoder `channel * 2`, the first of its pair, per ADR-0007). */
function rotateDial1(state, channel, ticks, at) {
  return run([{ kind: "encoder-rotate", deviceId: "xl-1", encoder: channel * 2, ticks, at }], state);
}

/** Pushes a channel's dial 1. */
function pressDial1(state, channel, at) {
  return run([{ kind: "encoder-down", deviceId: "xl-1", encoder: channel * 2, at }], state);
}

/** Rotates a channel's dial 2 (encoder `channel * 2 + 1`, the second of its pair, per ADR-0007). */
function rotateDial2(state, channel, ticks, at) {
  return run([{ kind: "encoder-rotate", deviceId: "xl-1", encoder: channel * 2 + 1, ticks, at }], state);
}

/** Pushes a channel's dial 2. */
function pressDial2(state, channel, at) {
  return run([{ kind: "encoder-down", deviceId: "xl-1", encoder: channel * 2 + 1, at }], state);
}

test("a snapshot asks what is running in panes it has not seen", () => {
  const { commands } = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a"), paneOn("w1", "b")]);
  assert.deepEqual(
    commands.filter((command) => command.kind === "load-process-info").map((command) => command.paneId),
    ["w1:a", "w1:b"]
  );
});

test("an agent pane is asked about too, so its role can still be corrected", () => {
  // Herdr's own detection decides the agent row, but a correction is remembered
  // against a command line — so a pane never asked about could never be fixed.
  const { commands } = liveWith2(
    [workspaceOn(1, "auth")],
    [paneOn("w1", "agent", { agent: "claude" }), paneOn("w1", "other")]
  );
  assert.deepEqual(
    commands.filter((command) => command.kind === "load-process-info").map((command) => command.paneId),
    ["w1:agent", "w1:other"]
  );
});

test("holding an agent key opens a role picker for its channel — which was impossible while agents went unasked", () => {
  const live = run(
    [runningIn("w1:a", "claude")],
    liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude" })]).state
  ).state;

  const down = run([{ kind: "key-down", key: keyAt(0, 0, 0), at: 5000 }], live).state;
  const fired = run([{ kind: "tick", at: 5000 + HOLD_MS }], down).state;

  assert.deepEqual(fired.rolePicker, { channel: 0, commandKey: "claude", at: 5000 + HOLD_MS });
  assert.deepEqual(fired.roles, {}, "nothing is corrected yet — only browsed, the same as dial 1's own preview");
});

test("a pane whose process ends is asked about again, so it does not stay on the wrong row", () => {
  const live = run(
    [runningIn("w1:t", "vitest --watch")],
    liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "t")]).state
  ).state;
  assert.ok("w1:t" in live.processes);

  const exited = run(
    [{ kind: "herdr-event", at: 0, event: { event: "pane_exited", data: { type: "pane_exited", pane_id: "w1:t" } } }],
    live
  ).state;
  assert.ok(!("w1:t" in exited.processes), "what it was running is no longer true of it");

  const asked = run([snapshotOf({ workspaces: [workspaceOn(1, "auth")], panes: [paneOn("w1", "t")] })], exited);
  assert.ok(asked.commands.some((command) => command.kind === "load-process-info" && command.paneId === "w1:t"));
});

test("a pane already asked about is not asked again", () => {
  const first = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a")]);
  const learnt = run([runningIn("w1:a", "-zsh")], first.state);
  const again = run([snapshotOf({ workspaces: [workspaceOn(1, "auth")], panes: [paneOn("w1", "a")] })], learnt.state);

  assert.deepEqual(again.commands.filter((command) => command.kind === "load-process-info"), []);
});

test("what was learned about a pane is forgotten when the pane goes", () => {
  const learnt = run(
    [runningIn("w1:a", "-zsh")],
    liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a")]).state
  );
  assert.ok("w1:a" in learnt.state.processes);

  const gone = run([snapshotOf({ workspaces: [workspaceOn(1, "auth")], panes: [] })], learnt.state);
  assert.deepEqual(gone.state.processes, {});
});

test("tapping a role in an open picker corrects it in one act, and the correction is persisted", () => {
  const live = run(
    [runningIn("w1:t", "vitest --watch")],
    liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "t")]).state
  ).state;

  // vitest is detected as a test watcher, on the shared third row; the
  // picker puts every role from `ROLE_ROWS` where its own row already would,
  // so SHELL sits two columns over on that same row.
  const opened = holdKey(live, keyAt(0, 0, 2));
  assert.deepEqual(opened.state.rolePicker, { channel: 0, commandKey: "vitest --watch", at: 5000 + HOLD_MS });

  const picked = tapKey(opened.state, keyAt(0, 2, 2), 5000 + HOLD_MS + 100);
  assert.deepEqual(picked.state.roles, { "vitest --watch": "shell" });
  assert.equal(picked.state.rolePicker, null);
  assert.deepEqual(picked.commands, [{ kind: "save-roles", roles: { "vitest --watch": "shell" } }]);
});

test("a correction is remembered by command line, so it survives the pane restarting", () => {
  const corrected = { kind: "settings-loaded", slots: readSlots(undefined), roles: { "vitest --watch": "server" }, acknowledged: [] };
  const restored = run([xl, corrected]);

  // The same command comes back in a pane with a different id after a restart.
  const live = run(
    [
      { kind: "herdr-connection", connected: true },
      snapshotOf({ workspaces: [workspaceOn(1, "auth")], panes: [paneOn("w1", "restarted")] }),
      runningIn("w1:restarted", "vitest --watch")
    ],
    restored.state
  ).state;

  assert.equal(roleResolver(live.processes, live.roles)(live.snapshot.panes[0]), "server");
});

test("holding a pane nothing is known about opens no picker, rather than forgetting a correction later", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "p")]).state;
  const held = holdKey(live, keyAt(0, 0, 2));

  assert.equal(held.state.rolePicker, null, "there is no command line to remember a correction by");
  assert.deepEqual(held.state.roles, {});
  assert.deepEqual(held.commands, []);
});

test("tapping anywhere but the picker's own five role keys cancels it without correcting anything (`-0vd.4`)", () => {
  const live = run(
    [runningIn("w1:a", "claude")],
    liveWith2([workspaceOn(1, "auth"), workspaceOn(2, "billing")], [paneOn("w1", "a", { agent: "claude" })]).state
  ).state;
  const opened = holdKey(live, keyAt(0, 0, 0));
  assert.ok(opened.state.rolePicker);

  // A tap on a completely different channel's control row — DESIGN.md's
  // Latest Action Rule, the same as any other press cancelling `armed`.
  const cancelled = tapKey(opened.state, keyAt(1, 0, 3), 6000);
  assert.equal(cancelled.state.rolePicker, null);
  assert.deepEqual(cancelled.state.roles, {});
});

test("an open role picker reverts on its own once it times out, unconfirmed", () => {
  const live = run(
    [runningIn("w1:a", "claude")],
    liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude" })]).state
  ).state;
  const opened = holdKey(live, keyAt(0, 0, 0), 1000).state;
  const at = opened.rolePicker.at;

  const tooSoon = run([{ kind: "tick", at: at + DIAL_PREVIEW_TIMEOUT_MS }], opened).state;
  assert.ok(tooSoon.rolePicker, "not past the timeout yet");

  const reverted = run([{ kind: "tick", at: at + DIAL_PREVIEW_TIMEOUT_MS + 1 }], opened).state;
  assert.equal(reverted.rolePicker, null);
});

test("holding a pane key on a Mini-only rig still cycles one step — no device present can show a picker", () => {
  const live = run(
    [runningIn("w1:a", "claude")],
    liveWithMini([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude" })]).state
  ).state;

  const held = holdKey(live, miniKeyAt(0, 1));
  assert.deepEqual(held.state.roles, { claude: "server" });
  assert.equal(held.state.rolePicker, null);
});

test("holding a pane reached via the paired Mini's global surface opens the picker on the channel actually showing its workstream", () => {
  // The queue key does not sit on any particular channel's column — it is
  // the paired Mini's own global surface (`-4w7`) — so the picker's channel
  // has to come from which channel the pane's workstream is actually bound
  // to, not from the key's position.
  const live = run(
    [runningIn("w1:a", "claude")],
    liveWithPaired([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude", agent_status: "blocked" })]).state
  ).state;

  const held = holdKey(live, miniKeyAt(0, 0));
  assert.deepEqual(held.state.rolePicker, { channel: 0, commandKey: "claude", at: 5000 + HOLD_MS });
  assert.deepEqual(held.state.roles, {}, "not corrected yet — a tap on the XL's own picker still has to commit it");
});

test("reassigning a channel's workstream closes any role picker open on it", () => {
  const live = run(
    [runningIn("w1:a", "claude")],
    liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude" })]).state
  ).state;
  const opened = holdKey(live, keyAt(0, 0, 0));
  assert.ok(opened.state.rolePicker);

  const reassigned = hold(opened.state, 0);
  assert.equal(reassigned.state.rolePicker, null);
});

test("holding one of the picker's own role keys — rather than tapping it — still picks that role instead of opening a second picker underneath it", () => {
  // The pane the picker was opened for sits on the agent row, so a long
  // press on the SERVER key is a hold on a *different* physical position —
  // exactly the case where the reducer must defer to what the picker is
  // showing rather than resolving straight through to whatever real pane
  // channelRowsOf would otherwise find sitting under it.
  const live = run(
    [runningIn("w1:a", "claude"), runningIn("w1:b", "vite")],
    liveWith2(
      [workspaceOn(1, "auth")],
      [paneOn("w1", "a", { agent: "claude" }), paneOn("w1", "b")]
    ).state
  ).state;

  const opened = holdKey(live, keyAt(0, 0, 0));
  assert.deepEqual(opened.state.rolePicker, { channel: 0, commandKey: "claude", at: 5000 + HOLD_MS });

  const heldAgain = holdKey(opened.state, keyAt(0, 0, 1), 10000); // SERVER's own position
  assert.deepEqual(heldAgain.state.roles, { claude: "server" }, "picked the role the key was showing");
  assert.equal(heldAgain.state.rolePicker, null, "the picker closed on the pick, not stayed open under a duplicate");
});

test("a press already held before the picker opened does not pick a role just because its release lands on one of the picker's keys", () => {
  const live = run(
    [runningIn("w1:a", "claude")],
    liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude" })]).state
  ).state;

  const agentKey = keyAt(0, 0, 0);
  const serverKey = keyAt(0, 0, 1); // no pane there; happens to be the picker's own SERVER position

  // A second finger touches down on the SERVER position while the AGENT key
  // is still mid-hold, before the picker exists to have a SERVER position at
  // all.
  const opened = run(
    [
      { kind: "key-down", key: agentKey, at: 5000 },
      { kind: "key-down", key: serverKey, at: 5500 },
      { kind: "tick", at: 5000 + HOLD_MS }
    ],
    live
  ).state;
  assert.deepEqual(opened.rolePicker, { channel: 0, commandKey: "claude", at: 5000 + HOLD_MS });

  const released = run([{ kind: "key-up", key: serverKey, at: 5000 + HOLD_MS + 100 }], opened).state;
  assert.deepEqual(released.roles, {}, "the stale press did not pick SERVER");
  assert.ok(released.rolePicker, "the picker is still open, waiting for a real tap");
});

test("tapping a pane key focuses that pane in Herdr", () => {
  const live = run(
    [runningIn("w1:sh", "-zsh")],
    liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "sh")]).state
  ).state;

  const key = keyAt(0, 0, 2);
  const { commands } = run([{ kind: "key-down", key, at: 100 }, { kind: "key-up", key, at: 200 }], live);
  assert.deepEqual(commands, [{ kind: "herdr-request", method: "pane.focus", params: { pane_id: "w1:sh" } }]);
});

test("a hold on a pane key does not also focus it when the key comes back up", () => {
  const live = run(
    [runningIn("w1:sh", "-zsh")],
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

/** A plain tap: down, then up, with no hold in between. */
function tapKey(state, key, at = 100) {
  return run([{ kind: "key-down", key, at }, { kind: "key-up", key, at: at + 1 }], state);
}

test("tapping the focus key asks Herdr to focus the workstream", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "sh")]).state;
  const { commands } = tapKey(live, keyAt(0, 0, 3));
  assert.deepEqual(commands, [
    { kind: "control-command", workspaceId: "w1", column: 0, method: "workspace.focus", params: { workspace_id: "w1" }, successMessage: "FOCUSED" }
  ]);
});

test("tapping the git/pull-request key before either enrichment side exists says so, with no round trip", () => {
  const live = liveWith2([workspaceOn(1, "auth")], []).state;
  const { state, commands } = tapKey(live, keyAt(0, 1, 3));
  assert.deepEqual(commands, [], "there is nothing yet for Herdr to be asked about");
  assert.deepEqual(state.controlAcknowledgements, [{ workspaceId: "w1", column: 1, ok: false, message: "NO PR YET", until: 101 + ACK_DISPLAY_MS }]);
});

test("tapping the actions key sends the fixed prompt to the workstream's own agent pane", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "agent", { agent: "claude" }), paneOn("w1", "sh")]).state;
  const { commands } = tapKey(live, keyAt(0, 2, 3));
  assert.deepEqual(commands, [
    { kind: "control-prompt", workspaceId: "w1", column: 2, paneId: "w1:agent", text: CONTINUE_PROMPT }
  ]);
});

test("the actions key targets the agent row's own pane, the lowest id when more than one agent runs", () => {
  const live = liveWith2(
    [workspaceOn(1, "auth")],
    [paneOn("w1", "z-agent", { agent: "claude" }), paneOn("w1", "a-agent", { agent: "claude" })]
  ).state;
  const { commands } = tapKey(live, keyAt(0, 2, 3));
  assert.equal(commands[0].paneId, "w1:a-agent");
});

test("tapping the actions key with no agent pane in the workstream says so, and sends nothing", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "sh")]).state;
  const { state, commands } = tapKey(live, keyAt(0, 2, 3));
  assert.deepEqual(commands, []);
  assert.equal(state.controlAcknowledgements[0].message, "NO AGENT");
  assert.equal(state.controlAcknowledgements[0].ok, false);
});

test("tapping the actions key never arms it — only a hold does", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "agent", { agent: "claude" })]).state;
  const { state } = tapKey(live, keyAt(0, 2, 3));
  assert.equal(state.armed, null);
});

test("holding the actions key arms it, and the hold itself sends nothing to Herdr", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "agent", { agent: "claude" })]).state;
  const held = holdKey(live, keyAt(0, 2, 3), 5000);
  assert.deepEqual(held.state.armed, { workspaceId: "w1", armedAt: 5000 + HOLD_MS });
  assert.deepEqual(held.commands, []);
});

test("holding the focus or git/pull-request key arms nothing, since neither has anything to escalate to", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "agent", { agent: "claude" })]).state;
  for (const column of [0, 1]) {
    const held = holdKey(live, keyAt(0, column, 3), 5000);
    assert.equal(held.state.armed, null, `column ${column} must not arm`);
  }
});

test("a confirming tap on the armed actions key sends the interrupt and disarms", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "agent", { agent: "claude" })]).state;
  const held = holdKey(live, keyAt(0, 2, 3), 5000);
  const confirmed = tapKey(held.state, keyAt(0, 2, 3), held.state.armed.armedAt + 100);

  assert.deepEqual(confirmed.commands, [
    { kind: "control-command", workspaceId: "w1", column: 2, method: "pane.send_keys", params: { pane_id: "w1:agent", keys: ["C-c"] }, successMessage: "STOPPED" }
  ]);
  assert.equal(confirmed.state.armed, null);
});

test("confirming with no agent pane left says so, and sends nothing destructive", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "agent", { agent: "claude" })]).state;
  const held = holdKey(live, keyAt(0, 2, 3), 5000);
  // The agent's pane closed while the key sat armed.
  const gone = { ...held.state, snapshot: { ...held.state.snapshot, panes: [] } };
  const confirmed = tapKey(gone, keyAt(0, 2, 3), held.state.armed.armedAt + 100);

  assert.deepEqual(confirmed.commands, []);
  assert.equal(confirmed.state.controlAcknowledgements[0].message, "NO AGENT");
  assert.equal(confirmed.state.armed, null, "an arm that could not be confirmed is still spent");
});

test("an arm past its timeout reverts on its own, on a tick alone", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "agent", { agent: "claude" })]).state;
  const held = holdKey(live, keyAt(0, 2, 3), 5000);
  const armedAt = held.state.armed.armedAt;

  const stillArmed = run([{ kind: "tick", at: armedAt + ARM_TIMEOUT_MS }], held.state);
  assert.deepEqual(stillArmed.state.armed, held.state.armed, "the window's own edge has not yet timed out");

  const expired = run([{ kind: "tick", at: armedAt + ARM_TIMEOUT_MS + 1 }], held.state);
  assert.equal(expired.state.armed, null);
});

test("a tap on anything else while armed cancels the arm without sending anything", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "agent", { agent: "claude" }), paneOn("w1", "sh")]).state;
  const held = holdKey(live, keyAt(0, 2, 3), 5000);

  // Focus in the same channel is a different control entirely.
  const elsewhere = run([{ kind: "key-down", key: keyAt(0, 0, 3), at: held.state.armed.armedAt + 50 }], held.state);
  assert.equal(elsewhere.state.armed, null, "the focus key is not the key that armed");
});

test("a press on another channel's actions key cancels this one's arm", () => {
  const live = liveWith2([workspaceOn(1, "auth"), workspaceOn(2, "billing")], [paneOn("w1", "agent", { agent: "claude" })]).state;
  const held = holdKey(live, keyAt(0, 2, 3), 5000);
  const elsewhere = run([{ kind: "key-down", key: keyAt(1, 2, 3), at: held.state.armed.armedAt + 50 }], held.state);
  assert.equal(elsewhere.state.armed, null);
});

test("holding the armed key again is not a cancellation of its own arm", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "agent", { agent: "claude" })]).state;
  const held = holdKey(live, keyAt(0, 2, 3), 5000);
  const key = keyAt(0, 2, 3);
  const pressedAgain = run([{ kind: "key-down", key, at: held.state.armed.armedAt + 50 }], held.state);
  assert.deepEqual(pressedAgain.state.armed, held.state.armed);
});

test("a control acknowledgement arrives, is shown, and reverts on its own after its window", () => {
  const live = liveWith2([workspaceOn(1, "auth")], []).state;
  const acknowledged = run(
    [{ kind: "control-acknowledged", workspaceId: "w1", column: 0, ok: true, message: "FOCUSED", at: 1000 }],
    live
  ).state;
  assert.deepEqual(acknowledged.controlAcknowledgements, [
    { workspaceId: "w1", column: 0, ok: true, message: "FOCUSED", until: 1000 + ACK_DISPLAY_MS }
  ]);

  const stillShown = run([{ kind: "tick", at: 1000 + ACK_DISPLAY_MS }], acknowledged).state;
  assert.equal(stillShown.controlAcknowledgements.length, 1, "the window's own edge is still live");

  const reverted = run([{ kind: "tick", at: 1000 + ACK_DISPLAY_MS + 1 }], acknowledged).state;
  assert.deepEqual(reverted.controlAcknowledgements, []);
});

test("a channel with no workstream has no control row to press", () => {
  const live = liveWith2([], []).state;
  const key = keyAt(0, 0, 3);
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

/**
 * Attention: the three signals arriving, resolving, and being acknowledged.
 *
 * All three go through the reducer rather than the attention module directly,
 * because what the ticket promises is that the *device* stops needing to be
 * polled — and that only holds if the events Herdr actually sends move it.
 */

/** What the device says is asking, across every workstream. */
const askingIn = (state) => attentionOf(state.snapshot, state.acknowledged);

test("an agent blocking on input raises attention from a live pane update", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude", revision: 1 })]).state;
  assert.deepEqual(askingIn(live), [], "an agent that has said nothing wants nobody");

  const blocked = run(
    [paneUpdate({ ...paneOn("w1", "a", { agent: "claude" }), agent_status: "blocked", revision: 2 })],
    live
  ).state;
  assert.deepEqual(askingIn(blocked).map((item) => item.reason), ["waiting"]);
});

test("an agent answered stops asking on its own, with nothing to clear by hand", () => {
  const live = liveWith2(
    [workspaceOn(1, "auth")],
    [paneOn("w1", "a", { agent: "claude", agent_status: "blocked", revision: 1 })]
  ).state;
  assert.equal(askingIn(live).length, 1);

  const answered = run(
    [paneUpdate({ ...paneOn("w1", "a", { agent: "claude" }), agent_status: "working", revision: 2 })],
    live
  ).state;
  assert.deepEqual(askingIn(answered), []);
});

test("tapping a finished agent acknowledges it, and the acknowledgement is persisted", () => {
  const live = run(
    [runningIn("w1:a", "claude")],
    liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude", agent_status: "done" })]).state
  ).state;
  assert.deepEqual(askingIn(live).map((item) => item.reason), ["finished"]);

  const key = keyAt(0, 0, 0);
  const tapped = run([{ kind: "key-down", key, at: 100 }, { kind: "key-up", key, at: 200 }], live);

  assert.deepEqual(askingIn(tapped.state), [], "going to look at it is what acknowledges it");
  assert.deepEqual(tapped.commands, [
    { kind: "herdr-request", method: "pane.focus", params: { pane_id: "w1:a" } },
    { kind: "save-acknowledged", acknowledged: ["w1:a"] }
  ]);
});

test("acknowledging survives a restart, since Herdr keeps reporting done forever", () => {
  const restored = run([
    xl,
    { kind: "settings-loaded", slots: readSlots(undefined), roles: {}, acknowledged: ["w1:a"] }
  ]);
  const live = run(
    [
      { kind: "herdr-connection", connected: true },
      snapshotOf({
        workspaces: [workspaceOn(1, "auth")],
        panes: [paneOn("w1", "a", { agent: "claude", agent_status: "done" })]
      })
    ],
    restored.state
  ).state;

  assert.deepEqual(askingIn(live), [], "work dealt with yesterday must not ask again today");
});

test("a stored acknowledgement is not thrown away just because the snapshot has not arrived", () => {
  // Settings load before Herdr answers. Pruning against an empty session would
  // wipe every mark and then write the loss back, so the device would ask again
  // about everything on every start.
  const restored = run([
    xl,
    { kind: "settings-loaded", slots: readSlots(undefined), roles: {}, acknowledged: ["w1:a"] }
  ]);
  assert.deepEqual(restored.state.acknowledged, ["w1:a"]);
  assert.deepEqual(restored.commands.filter((command) => command.kind === "save-acknowledged"), []);
});

test("an agent that finishes a second time asks again, from a pane update alone", () => {
  // The case a naive mark would swallow: agent status arrives on pane_updated,
  // which schedules no snapshot re-read, so if the mark were only pruned on a
  // re-read the second completion could stay silent indefinitely.
  const live = run(
    [runningIn("w1:a", "claude")],
    liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude", agent_status: "done", revision: 1 })])
      .state
  ).state;

  const key = keyAt(0, 0, 0);
  const looked = run([{ kind: "key-down", key, at: 100 }, { kind: "key-up", key, at: 200 }], live).state;
  assert.deepEqual(askingIn(looked), []);

  const working = run(
    [paneUpdate({ ...paneOn("w1", "a", { agent: "claude" }), agent_status: "working", revision: 2 }, 300)],
    looked
  );
  assert.deepEqual(working.state.acknowledged, [], "leaving done spends the mark");
  assert.deepEqual(working.commands, [{ kind: "save-acknowledged", acknowledged: [] }]);

  const again = run(
    [paneUpdate({ ...paneOn("w1", "a", { agent: "claude" }), agent_status: "done", revision: 3 }, 400)],
    working.state
  ).state;
  assert.deepEqual(askingIn(again).map((item) => item.reason), ["finished"], "the second finish is heard");
});

test("a pane that closes takes its acknowledgement with it rather than accumulating", () => {
  const live = run(
    [runningIn("w1:a", "claude")],
    liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude", agent_status: "done" })]).state
  ).state;
  const key = keyAt(0, 0, 0);
  const looked = run([{ kind: "key-down", key, at: 100 }, { kind: "key-up", key, at: 200 }], live).state;
  assert.deepEqual(looked.acknowledged, ["w1:a"]);

  const gone = run([snapshotOf({ workspaces: [workspaceOn(1, "auth")], panes: [] })], looked);
  assert.deepEqual(gone.state.acknowledged, []);
  assert.deepEqual(gone.commands.filter((command) => command.kind === "save-acknowledged"), [
    { kind: "save-acknowledged", acknowledged: [] }
  ]);
});

test("a nonzero exit declared on the workstream raises attention; a clean one does not", () => {
  // pane_exited cannot carry this. It has no exit status, and the pane it names
  // leaves the session with its process, so the declaration lives on the
  // workspace — which survives its panes and is pushed live.
  const crashed = { ...workspaceOn(1, "auth"), tokens: { sd_exit_dev: "1" } };
  const clean = { ...workspaceOn(1, "auth"), tokens: { sd_exit_dev: "0" } };

  const bad = liveWith2([crashed], [paneOn("w1", "sh")]).state;
  assert.deepEqual(askingIn(bad), [{ workspaceId: "w1", reason: "exited", service: "dev", status: "1" }]);

  const good = liveWith2([clean], [paneOn("w1", "sh")]).state;
  assert.deepEqual(askingIn(good), []);
});

test("a service coming back clears its own declaration, so nothing is dismissed by hand", () => {
  const crashed = { ...workspaceOn(1, "auth"), tokens: { sd_exit_dev: "1" } };
  const live = liveWith2([crashed], [paneOn("w1", "sh")]).state;
  assert.equal(askingIn(live).length, 1);

  // Herdr reports a cleared token by omitting the field, and the metadata event
  // is structural, so the next snapshot is what the device sees.
  const restarted = run([snapshotOf({ workspaces: [workspaceOn(1, "auth")], panes: [paneOn("w1", "sh")] })], live);
  assert.deepEqual(askingIn(restarted.state), []);
});

test("a workspace token change is structural, so the device re-reads and sees it", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "sh")]).state;
  const declared = run(
    [recorded("workspace_metadata_updated"), { kind: "tick", at: RESYNC_DEBOUNCE_MS + 1 }],
    live
  );
  assert.deepEqual(declared.commands, [{ kind: "load-snapshot" }]);
});

test("a branch changed outside Herdr — a `git switch` at the terminal — reaches the channel via sd_branch, with the workspace otherwise idle (`-0vd.1`)", () => {
  const onMain = { ...workspaceOn(1, "auth"), tokens: { sd_branch: "main" } };
  const live = liveWith([onMain], run([xl]).state).state;
  assert.equal(workstreamsOf(live.snapshot, live.branches)[0].worktree.branch, "main");

  // The Herdr plugin's own post-checkout hook republishes sd_branch, which is
  // itself a workspace_metadata_updated push — structural on its own, with
  // nothing else about the workspace changing: no pane, no focus, no agent
  // activity.
  const declared = run([recorded("workspace_metadata_updated"), { kind: "tick", at: RESYNC_DEBOUNCE_MS + 1 }], live);
  assert.deepEqual(declared.commands, [{ kind: "load-snapshot" }]);

  const onFeature = { ...workspaceOn(1, "auth"), tokens: { sd_branch: "feature/x" } };
  const refreshed = run([snapshotOf({ workspaces: [onFeature] })], declared.state).state;
  assert.equal(workstreamsOf(refreshed.snapshot, refreshed.branches)[0].worktree.branch, "feature/x");
});

/**
 * `-wl7`'s own four reducer cases: enrichment arriving, updating, expiring,
 * and never appearing at all. `workspace_metadata_updated` being structural
 * (proven just above) is what makes "arriving" and "updating" live with no
 * press — a snapshot re-read is the only path either one needs, the same
 * path `sd_exit_`/`sd_attn_` already rely on. "Expiring" is not a distinct
 * code path either: Herdr enforces `--ttl-ms` server-side, so an expired
 * token and one that was never written look identical to the next
 * snapshot — absent from `tokens` — which is why both are asserted the same
 * way here rather than through some clock the reducer does not have.
 */
function ticketsOf(state) {
  return ticketsReadingValue(workstreamsOf(state.snapshot)[0]);
}

function pullRequestOf(state) {
  return pullRequestReadingValue(workstreamsOf(state.snapshot)[0]);
}

test("enrichment never appearing reads as unknown, for both readings", () => {
  const live = liveWith2([workspaceOn(1, "auth")], []).state;
  assert.equal(ticketsOf(live), UNKNOWN);
  assert.equal(pullRequestOf(live), UNKNOWN);
});

test("enrichment arriving is visible on the very next snapshot, with no press", () => {
  const live = liveWith2([workspaceOn(1, "auth")], []).state;
  assert.equal(ticketsOf(live), UNKNOWN, "nothing published yet");

  const arrived = run(
    [snapshotOf({ workspaces: [{ ...workspaceOn(1, "auth"), tokens: { sd_tickets: "ABC-1", sd_pr: "42 open" } }] })],
    live
  ).state;
  assert.equal(ticketsOf(arrived), "ABC-1");
  assert.equal(pullRequestOf(arrived), "OPEN");
});

test("enrichment updating replaces what the strip shows, not merges with it", () => {
  const opened = liveWith2([{ ...workspaceOn(1, "auth"), tokens: { sd_tickets: "ABC-1", sd_pr: "42 open" } }], []).state;
  assert.equal(pullRequestOf(opened), "OPEN");

  const approved = run(
    [snapshotOf({ workspaces: [{ ...workspaceOn(1, "auth"), tokens: { sd_tickets: "ABC-1,ABC-2", sd_pr: "42 approved" } }] })],
    opened
  ).state;
  assert.equal(ticketsOf(approved), "ABC-1, ABC-2");
  assert.equal(pullRequestOf(approved), "APRV");
});

test("enrichment expiring reads as unknown again, the same as it never having arrived", () => {
  // What a `--ttl-ms` expiry looks like from here: the next snapshot simply
  // no longer carries the token, exactly as if it had never been written.
  const live = liveWith2([{ ...workspaceOn(1, "auth"), tokens: { sd_tickets: "ABC-1", sd_pr: "42 open" } }], []).state;
  assert.equal(ticketsOf(live), "ABC-1");

  const expired = run([snapshotOf({ workspaces: [workspaceOn(1, "auth")] })], live).state;
  assert.equal(ticketsOf(expired), UNKNOWN);
  assert.equal(pullRequestOf(expired), UNKNOWN);
});

/**
 * The Mini, at the reducer (`-vk6`). The surface-level shape of a Mini
 * device is covered in surface.test.mjs; what belongs here is what a press
 * on it actually does.
 */

test("attaching a Mini is accepted the same way an XL is", () => {
  const attached = run([mini]);
  assert.deepEqual(attached.state.devices, [{ id: "mini-1", type: DEVICE_TYPE_MINI }]);
});

test("tapping a Mini's bottom-row key focuses that channel's most urgent pane", () => {
  const live = liveWithMini(
    [workspaceOn(1, "auth")],
    [paneOn("w1", "a", { agent: "claude", agent_status: "idle" }), paneOn("w1", "b", { agent: "claude", agent_status: "blocked" })]
  ).state;

  const { commands } = tapKey(live, miniKeyAt(0, 1));
  assert.deepEqual(commands, [{ kind: "herdr-request", method: "pane.focus", params: { pane_id: "w1:b" } }]);
});

test("focusing a Mini's bottom-row key acknowledges finished work the same way a tap on the XL does", () => {
  const live = liveWithMini([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude", agent_status: "done" })]).state;
  const { state } = tapKey(live, miniKeyAt(0, 1));
  assert.deepEqual(state.acknowledged, ["w1:a"]);
});

test("tapping a Mini's bottom-row key for a workstream with no panes asks Herdr for nothing", () => {
  const live = liveWithMini([workspaceOn(1, "auth")], []).state;
  const { commands } = tapKey(live, miniKeyAt(0, 1));
  assert.deepEqual(commands, []);
});

test("tapping a Mini's top-row key does nothing — it names a workstream, not a pane, and the Mini has no control row to land on either", () => {
  const live = liveWithMini([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude", agent_status: "blocked" })]).state;
  const { commands, state } = tapKey(live, miniKeyAt(0, 0));
  assert.deepEqual(commands, []);
  assert.deepEqual(state.controlAcknowledgements, [], "there is no control row here to acknowledge a tap on");
});

test("tapping an unassigned Mini slot asks Herdr for nothing, the same as an unassigned XL channel", () => {
  const live = liveWithMini([], []).state;
  const { commands } = tapKey(live, miniKeyAt(0, 0));
  assert.deepEqual(commands, []);
});

test("a Mini's bottom-row press follows the channel's own workstream, not a fixed pane", () => {
  const workspaces = [workspaceOn(1, "auth"), workspaceOn(2, "billing")];
  const live = liveWithMini(
    workspaces,
    [paneOn("w1", "a", { agent: "claude" }), paneOn("w2", "b", { agent: "claude", agent_status: "blocked" })]
  ).state;

  const { commands } = tapKey(live, miniKeyAt(1, 1));
  assert.deepEqual(commands, [{ kind: "herdr-request", method: "pane.focus", params: { pane_id: "w2:b" } }]);
});

/**
 * The Mini, paired with an XL (ADR-0008, `-4w7`): no longer a mirror, but
 * the global surface — attention queue, recent panes, overflow, and the two
 * features still unclaimed scope. What belongs here is what a press on it
 * does; the surface-level shape is covered in surface.test.mjs.
 */

function liveWithPaired(workspaces, panes) {
  return run([xl, mini, { kind: "herdr-connection", connected: true }, snapshotOf({ workspaces, panes })]);
}

/** A paired Mini's own key, addressed row-major like every other device — unlike the mirror, row is not per-channel here. */
const globalKeyAt = (row, column) => ({ deviceId: "mini-1", column, row });

test("tapping the paired Mini's queue key jumps to the most urgent item across every workstream", () => {
  const live = liveWithPaired(
    [workspaceOn(1, "auth"), workspaceOn(2, "billing")],
    [
      paneOn("w1", "a", { agent: "claude", agent_status: "idle" }),
      paneOn("w2", "b", { agent: "claude", agent_status: "blocked" })
    ]
  ).state;

  const { commands } = tapKey(live, globalKeyAt(0, 0));
  assert.deepEqual(commands, [{ kind: "herdr-request", method: "pane.focus", params: { pane_id: "w2:b" } }]);
});

test("tapping the paired Mini's queue key acknowledges finished work the same way any other pane tap does", () => {
  const live = liveWithPaired([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude", agent_status: "done" })]).state;
  const { state } = tapKey(live, globalKeyAt(0, 0));
  assert.deepEqual(state.acknowledged, ["w1:a"]);
});

test("the paired Mini's queue key resolves to nothing when the worst item names no pane", () => {
  const withDeadService = { ...workspaceOn(1, "auth"), tokens: { sd_exit_dev: "1" } };
  const live = liveWithPaired([withDeadService], []).state;
  const { commands } = tapKey(live, globalKeyAt(0, 0));
  assert.deepEqual(commands, []);
});

test("tapping one of the paired Mini's recent-pane keys jumps to that pane", () => {
  const live = liveWithPaired([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude" })]).state;
  const focused = tapKey(live, keyAt(0, 0, 0)).state;
  assert.deepEqual(focused.recentFocus, ["w1:a"]);

  const { commands } = tapKey(focused, globalKeyAt(0, 1));
  assert.deepEqual(commands, [{ kind: "herdr-request", method: "pane.focus", params: { pane_id: "w1:a" } }]);
});

test("the paired Mini's overflow, new-worktree, and settings keys ask Herdr for nothing", () => {
  const live = liveWithPaired([workspaceOn(1, "auth")], []).state;
  for (const key of [globalKeyAt(1, 0), globalKeyAt(1, 1), globalKeyAt(1, 2)]) {
    const { commands } = tapKey(live, key);
    assert.deepEqual(commands, [], `row 1, column ${key.column} has no pane behind it`);
  }
});

test("a tap on any pane key remembers it as recently focused, most recent first", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude" }), paneOn("w1", "b")]).state;

  const afterA = tapKey(live, keyAt(0, 0, 0)).state;
  assert.deepEqual(afterA.recentFocus, ["w1:a"]);

  const afterB = tapKey(afterA, keyAt(0, 0, 2)).state;
  assert.deepEqual(afterB.recentFocus, ["w1:b", "w1:a"]);

  // Tapping a pane already remembered moves it to the front rather than
  // duplicating it, so the two keys never show the same pane twice.
  const again = tapKey(afterB, keyAt(0, 0, 0)).state;
  assert.deepEqual(again.recentFocus, ["w1:a", "w1:b"]);
});

test("recentFocus forgets a pane once it is gone", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude" })]).state;
  const focused = tapKey(live, keyAt(0, 0, 0)).state;
  assert.deepEqual(focused.recentFocus, ["w1:a"]);

  const gone = run([snapshotOf({ workspaces: [workspaceOn(1, "auth")], panes: [] })], focused).state;
  assert.deepEqual(gone.recentFocus, []);
});

test("attaching an XL to a Mini mid-session turns its bottom-row mirror key into the global surface live, with no restart", () => {
  const mirroring = liveWithMini([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude", agent_status: "blocked" })]).state;
  const beforePairing = tapKey(mirroring, miniKeyAt(0, 1));
  assert.deepEqual(beforePairing.commands, [{ kind: "herdr-request", method: "pane.focus", params: { pane_id: "w1:a" } }]);

  const paired = run([xl], mirroring).state;
  // The same physical key — column 0, row 1 — now resolves to nothing: row 1
  // is the global surface's overflow row on a paired rig, not a channel mirror.
  const afterPairing = tapKey(paired, miniKeyAt(0, 1));
  assert.deepEqual(afterPairing.commands, []);
});

test("attaching a Mini to an XL-only rig turns it into the global surface immediately, live", () => {
  const xlOnly = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude", agent_status: "blocked" })]).state;
  const paired = run([mini], xlOnly).state;

  const { commands } = tapKey(paired, globalKeyAt(0, 0));
  assert.deepEqual(commands, [{ kind: "herdr-request", method: "pane.focus", params: { pane_id: "w1:a" } }]);
});

test("detaching the XL from a paired rig returns the Mini to mirroring its channels, live", () => {
  const paired = liveWithPaired([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude", agent_status: "blocked" })]).state;
  const detached = run([{ kind: "device-detached", deviceId: "xl-1" }], paired).state;

  const { commands } = tapKey(detached, miniKeyAt(0, 1));
  assert.deepEqual(commands, [{ kind: "herdr-request", method: "pane.focus", params: { pane_id: "w1:a" } }]);
});

test("detaching the Mini from a paired rig leaves the XL an XL-only rig, with its own keys untouched", () => {
  const paired = liveWithPaired([workspaceOn(1, "auth")], [paneOn("w1", "a", { agent: "claude", agent_status: "blocked" })]).state;
  const xlOnly = run([{ kind: "device-detached", deviceId: "mini-1" }], paired).state;

  assert.deepEqual(xlOnly.devices, [{ id: "xl-1", type: DEVICE_TYPE_XL }]);
  // The XL's own key never depended on the Mini being there to begin with —
  // tapping it still focuses the same pane it always did.
  const { commands } = tapKey(xlOnly, keyAt(0, 0, 0));
  assert.deepEqual(commands, [{ kind: "herdr-request", method: "pane.focus", params: { pane_id: "w1:a" } }]);
});

/**
 * Dial 1, at the reducer (ADR-0007, `-u5d`): rotate to browse a workstream's
 * panes and attention, then push to focus.
 * The strip-level "identifiable while in use" criterion is covered in
 * surface.test.mjs, since it is about what gets drawn, not what the reducer
 * decides.
 */

test("rotating dial 1 steps through a workstream's panes and attention in a stable order, without asking Herdr for anything", () => {
  const withDeadService = { ...workspaceOn(1, "auth"), tokens: { sd_exit_dev: "1" } };
  const live = liveWith2([withDeadService], [paneOn("w1", "b"), paneOn("w1", "a")]).state;

  // Order: the paneless dead service first (nothing else can reach it), then
  // panes by id — "w1:a" before "w1:b" — regardless of the snapshot's own order.
  const first = rotateDial1(live, 0, 1, 100);
  assert.deepEqual(first.state.dial1[0], { mode: "browse", index: 0, at: 100 });
  assert.deepEqual(first.commands, [], "turning alone never mutates Herdr");

  const second = rotateDial1(first.state, 0, 1, 200);
  assert.deepEqual(second.state.dial1[0], { mode: "browse", index: 1, at: 200 });
  assert.deepEqual(second.commands, []);

  const third = rotateDial1(second.state, 0, 1, 300);
  assert.deepEqual(third.state.dial1[0], { mode: "browse", index: 2, at: 300 });

  // Three items; rotating past the last wraps to the first rather than stopping.
  const fourth = rotateDial1(third.state, 0, 1, 400);
  assert.deepEqual(fourth.state.dial1[0], { mode: "browse", index: 0, at: 400 });
});

test("a channel with no workstream has nothing for dial 1 to browse", () => {
  const live = liveWith2([], []).state;
  const { state, commands } = rotateDial1(live, 0, 1, 100);
  assert.equal(state.dial1[0], null);
  assert.deepEqual(commands, []);
});

test("pressing dial 1 while browsing a pane focuses it — the same request a pane key's own tap sends — and clears the preview", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a")]).state;
  const browsing = rotateDial1(live, 0, 1, 100).state;
  assert.deepEqual(browsing.dial1[0], { mode: "browse", index: 0, at: 100 });

  const pressed = pressDial1(browsing, 0, 200);
  assert.deepEqual(pressed.commands, [{ kind: "herdr-request", method: "pane.focus", params: { pane_id: "w1:a" } }]);
  assert.equal(pressed.state.dial1[0], null);
});

test("pressing dial 1 on a paneless attention item does nothing, since it names no pane to focus", () => {
  const withDeadService = { ...workspaceOn(1, "auth"), tokens: { sd_exit_dev: "1" } };
  const live = liveWith2([withDeadService], []).state;
  const browsing = rotateDial1(live, 0, 1, 100).state;
  assert.equal(browsing.dial1[0].mode, "browse");

  const pressed = pressDial1(browsing, 0, 200);
  assert.deepEqual(pressed.commands, []);
  assert.deepEqual(pressed.state.dial1[0], browsing.dial1[0], "still browsing; nothing was committed");
});

test("after focusing, rotating dial 1 starts a fresh browse and never invents a scroll request", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a"), paneOn("w1", "b")]).state;
  const focused = pressDial1(rotateDial1(live, 0, 1, 100).state, 0, 200).state;

  const browsingAgain = rotateDial1(focused, 0, 1, 300);
  assert.deepEqual(browsingAgain.state.dial1[0], { mode: "browse", index: 0, at: 300 });
  assert.deepEqual(browsingAgain.commands, []);
});

test("a browsed selection reverts on its own once it has stood idle past the timeout", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a")]).state;
  const browsing = rotateDial1(live, 0, 1, 1000).state;

  const tooSoon = run([{ kind: "tick", at: 1000 + DIAL_PREVIEW_TIMEOUT_MS }], browsing).state;
  assert.equal(tooSoon.dial1[0].mode, "browse", "not past the timeout yet");

  const reverted = run([{ kind: "tick", at: 1000 + DIAL_PREVIEW_TIMEOUT_MS + 1 }], browsing).state;
  assert.equal(reverted.dial1[0], null);
});

test("a fresher rotate always wins over an older timer that would otherwise overwrite it", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a"), paneOn("w1", "b")]).state;
  const browsing = rotateDial1(live, 0, 1, 1000).state;

  // A second rotate refreshes `at` well inside the first selection's timeout
  // window. A tick that arrives after the *original* `at` plus the timeout —
  // the moment a stale timer would have reverted it — must not touch a
  // selection whose own `at` is newer than that.
  const refreshed = rotateDial1(browsing, 0, 1, 1000 + DIAL_PREVIEW_TIMEOUT_MS - 500).state;
  const stillBrowsing = run([{ kind: "tick", at: 1000 + DIAL_PREVIEW_TIMEOUT_MS + 500 }], refreshed).state;
  assert.equal(stillBrowsing.dial1[0].mode, "browse", "the newer rotate's own timeout has not elapsed yet");

  const reverted = run([{ kind: "tick", at: refreshed.dial1[0].at + DIAL_PREVIEW_TIMEOUT_MS + 1 }], stillBrowsing).state;
  assert.equal(reverted.dial1[0], null);
});

test("reassigning a channel's workstream clears whatever dial 1 was browsing there", () => {
  const live = liveWith2([workspaceOn(1, "auth"), workspaceOn(2, "billing")], [paneOn("w1", "a")]).state;
  const browsing = rotateDial1(live, 0, 1, 100).state;
  assert.equal(browsing.dial1[0].mode, "browse");

  const reassigned = hold(browsing, 0);
  assert.equal(reassigned.state.dial1[0], null);
});

test("a browsed selection survives its pane disappearing — its index still resolves once the channel redraws", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a")]).state;
  const browsing = rotateDial1(live, 0, 1, 100).state;

  const gone = run([snapshotOf({ workspaces: [workspaceOn(1, "auth")], panes: [] })], browsing).state;
  assert.deepEqual(gone.dial1[0], { mode: "browse", index: 0, at: 100 });
});

test("dial 2's encoder does not touch dial 1's state", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a")]).state;
  const { state, commands } = run([{ kind: "encoder-rotate", deviceId: "xl-1", encoder: 1, ticks: 1, at: 100 }], live);
  assert.deepEqual(commands, []);
  assert.equal(state.dial1[0], null);
});

test("each channel's dial 1 is independent of the others", () => {
  const live = liveWith2(
    [workspaceOn(1, "auth"), workspaceOn(2, "billing")],
    [paneOn("w1", "a"), paneOn("w2", "b")]
  ).state;

  const channel0 = rotateDial1(live, 0, 1, 100).state;
  const channel1 = rotateDial1(channel0, 1, 1, 200).state;

  assert.deepEqual(channel1.dial1[0], { mode: "browse", index: 0, at: 100 });
  assert.deepEqual(channel1.dial1[1], { mode: "browse", index: 0, at: 200 });
});

/**
 * Dial 2, at the reducer (ADR-0007, ADR-0009, `-8e8`): rotate to browse
 * worktree-lifecycle verbs, push to commit — immediately for create, or arm
 * then confirm for the destructive remove.
 */

test("rotating dial 2 on an empty channel steps through the repositories other channels already show, without asking Herdr for anything", () => {
  const live = liveWith2([workspaceOnRepo(1, "auth", "repo-a"), workspaceOnRepo(2, "billing", "repo-b")], []).state;

  // Channel 2 is empty; its candidates are every other channel's repository,
  // sorted by the repository's own key rather than Herdr's listing order.
  const first = rotateDial2(live, 2, 1, 100);
  assert.deepEqual(first.state.dial2[2], { mode: "browse", index: 0, at: 100 });
  assert.deepEqual(first.commands, [], "turning alone never asks Herdr for anything");

  const second = rotateDial2(first.state, 2, 1, 200);
  assert.deepEqual(second.state.dial2[2], { mode: "browse", index: 1, at: 200 });

  // Two candidates; rotating past the last wraps to the first.
  const third = rotateDial2(second.state, 2, 1, 300);
  assert.deepEqual(third.state.dial2[2], { mode: "browse", index: 0, at: 300 });
});

test("an empty channel with no repository known anywhere has nothing for dial 2 to browse", () => {
  const live = liveWith2([], []).state;
  const { state, commands } = rotateDial2(live, 0, 1, 100);
  assert.equal(state.dial2[0], null);
  assert.deepEqual(commands, []);
});

test("a bound channel offers only removing its own worktree, and rotating stays on that one item", () => {
  const live = liveWith2([workspaceOn(1, "auth")], []).state;
  const first = rotateDial2(live, 0, 1, 100).state;
  assert.deepEqual(first.dial2[0], { mode: "browse", index: 0, at: 100 });

  const spun = rotateDial2(first, 0, 5, 200).state;
  assert.equal(spun.dial2[0].index, 0);
});

test("a channel holding a workspace with no worktree offers nothing on dial 2 — there is nothing here to remove", () => {
  const primary = { ...workspaceOn(1, "primary"), worktree: null };
  const live = liveWith2([primary], []).state;
  const { state, commands } = rotateDial2(live, 0, 1, 100);
  assert.equal(state.dial2[0], null);
  assert.deepEqual(commands, []);
});

test("a primary checkout with non-linked metadata still offers nothing to remove", () => {
  const linkedShape = workspaceOn(1, "primary");
  const primary = {
    ...linkedShape,
    worktree: { ...linkedShape.worktree, is_linked_worktree: false }
  };
  const live = liveWith2([primary], []).state;
  const rotated = rotateDial2(live, 0, 1, 100);
  assert.equal(rotated.state.dial2[0], null);

  const pressed = pressDial2(live, 0, 200);
  assert.deepEqual(pressed.state.dial2Acknowledgements, [{ channel: 0, ok: false, message: "NO WORKTREE", until: 200 + ACK_DISPLAY_MS }]);
});

test("pressing dial 2 on a channel with no worktree refuses locally, named, rather than doing nothing silently", () => {
  const primary = { ...workspaceOn(1, "primary"), worktree: null };
  const live = liveWith2([primary], []).state;

  const { state, commands } = pressDial2(live, 0, 100);
  assert.deepEqual(commands, [], "there is nothing to remove, so no round trip to Herdr either");
  assert.deepEqual(state.dial2Acknowledgements, [{ channel: 0, ok: false, message: "NO WORKTREE", until: 100 + ACK_DISPLAY_MS }]);
});

test("pressing dial 2's create commits immediately, with no arming, and asks Herdr to create a worktree in that repository", () => {
  const live = liveWith2([workspaceOnRepo(1, "auth", "repo-a")], []).state;
  const browsing = rotateDial2(live, 1, 1, 100).state;
  assert.equal(browsing.dial2[1].mode, "browse");

  const pressed = pressDial2(browsing, 1, 200);
  assert.deepEqual(pressed.commands, [
    { kind: "dial2-command", channel: 1, method: "worktree.create", params: { cwd: "/repos/repo-a" }, successMessage: "CREATED" }
  ]);
  assert.equal(pressed.state.dial2[1], null, "nothing left to browse; the reservation is what remembers the intent now");
  assert.deepEqual(pressed.state.reservedChannel, { channel: 1, repoKey: "repo-a", at: 200 });
});

test("a worktree created from a channel binds to that channel once it appears, not just the lowest free one", () => {
  const started = liveWith2([workspaceOnRepo(1, "auth", "repo-a")], []).state;
  // Channels 1 and 2 are both free; create is pressed from channel 2 specifically.
  const reserved = pressDial2(rotateDial2(started, 2, 1, 100).state, 2, 200).state;
  assert.deepEqual(reserved.reservedChannel, { channel: 2, repoKey: "repo-a", at: 200 });

  // The new worktree appears on the next snapshot. Plain `bind` alone would
  // hand an unbound workstream to channel 1, the lowest free channel — the
  // reservation has to win instead.
  const after = liveWith([workspaceOnRepo(1, "auth", "repo-a"), workspaceOnRepo(9, "created", "repo-a")], reserved).state;

  assert.equal(after.slots.bindings[2], "checkout:/w/created", "the reservation put it in channel 2, not channel 1");
  assert.equal(after.slots.bindings[1], null, "channel 1 is still free — nothing claimed it");
  assert.equal(after.reservedChannel, null, "consumed");
});

test("pressing dial 2 on a linked worktree arms its only verb directly, without requiring a rotate", () => {
  const live = liveWith2([workspaceOn(1, "auth")], []).state;

  const pressed = pressDial2(live, 0, 200);
  assert.deepEqual(pressed.commands, []);
  assert.deepEqual(pressed.state.dial2[0], { mode: "armed", at: 200 });
});

test("confirming an armed removal within the timeout sends worktree.remove for that workstream", () => {
  const live = liveWith2([workspaceOn(1, "auth")], []).state;
  const armed = pressDial2(live, 0, 200).state;

  const confirmed = pressDial2(armed, 0, 500);
  assert.deepEqual(confirmed.commands, [
    { kind: "dial2-command", channel: 0, method: "worktree.remove", params: { workspace_id: "w1", force: false }, successMessage: "REMOVED" }
  ]);
  assert.equal(confirmed.state.dial2[0], null);
});

test("an armed removal reverts on its own once it times out, unconfirmed", () => {
  const live = liveWith2([workspaceOn(1, "auth")], []).state;
  const armed = pressDial2(live, 0, 200).state;

  const tooSoon = run([{ kind: "tick", at: 200 + REMOVE_ARM_TIMEOUT_MS }], armed).state;
  assert.equal(tooSoon.dial2[0].mode, "armed", "not past the timeout yet");

  const reverted = run([{ kind: "tick", at: 200 + REMOVE_ARM_TIMEOUT_MS + 1 }], armed).state;
  assert.equal(reverted.dial2[0], null);
});

test("rotating dial 2 while a removal is armed cancels it visibly, then returns to the normal strip", () => {
  const live = liveWith2([workspaceOn(1, "auth")], []).state;
  const armed = pressDial2(live, 0, 200).state;

  const { state, commands } = rotateDial2(armed, 0, 1, 300);
  assert.equal(state.dial2[0], null, "the cancelling turn is consumed instead of selecting REMOVE again");
  assert.deepEqual(state.dial2Acknowledgements, [{ channel: 0, ok: true, message: "CANCELLED", until: 300 + ACK_DISPLAY_MS }]);
  assert.equal(dial2NoticeOf(state, 0), "CANCELLED");
  assert.deepEqual(commands, []);

  const trailing = rotateDial2(state, 0, 1, 350).state;
  assert.equal(trailing.dial2[0], null, "later events from the same physical turn cannot select REMOVE behind the acknowledgement");

  const reverted = run([{ kind: "tick", at: 300 + ACK_DISPLAY_MS + 1 }], trailing).state;
  assert.equal(dial2NoticeOf(reverted, 0), null, "the normal workstream strip returns after the acknowledgement");

  const freshTurn = rotateDial2(reverted, 0, 1, 300 + ACK_DISPLAY_MS + 2).state;
  assert.equal(freshTurn.dial2[0].mode, "browse", "a genuinely new turn may browse REMOVE again");
});

test("dial 2's success and failure are acknowledged on the channel, naming the cause on failure", () => {
  const live = liveWith2([workspaceOn(1, "auth")], []).state;

  const succeeded = run([{ kind: "dial2-acknowledged", channel: 0, ok: true, message: "CREATED", at: 100 }], live).state;
  assert.deepEqual(succeeded.dial2Acknowledgements, [{ channel: 0, ok: true, message: "CREATED", until: 100 + ACK_DISPLAY_MS }]);

  const failed = run(
    [{ kind: "dial2-acknowledged", channel: 0, ok: false, message: "worktree has uncommitted changes", at: 200 }],
    live
  ).state;
  assert.deepEqual(failed.dial2Acknowledgements, [
    { channel: 0, ok: false, message: "worktree has uncommitted changes", until: 200 + ACK_DISPLAY_MS }
  ]);
});

test("reassigning a channel's workstream clears whatever dial 2 was doing there", () => {
  const live = liveWith2([workspaceOn(1, "auth"), workspaceOn(2, "billing")], []).state;
  const armed = pressDial2(rotateDial2(live, 0, 1, 100).state, 0, 200).state;
  assert.equal(armed.dial2[0].mode, "armed");

  const reassigned = hold(armed, 0);
  assert.equal(reassigned.state.dial2[0], null);
});

test("dial 1's encoder does not touch dial 2's state, and vice versa", () => {
  const live = liveWith2([workspaceOn(1, "auth")], [paneOn("w1", "a")]).state;

  const dial1Only = rotateDial1(live, 0, 1, 100).state;
  assert.equal(dial1Only.dial2[0], null);

  const dial2Only = rotateDial2(live, 0, 1, 100).state;
  assert.equal(dial2Only.dial1[0], null);
});

test("every pane behind a row's overflow count can still be focused from the device, via dial 1 (`-0vd.3`)", () => {
  // Four plain shell panes share one three-key row; the row's own `fitRow`
  // shows the first two and counts the rest, leaving "w1:c" and "w1:d" with
  // no key at all. Dial 1 rotates the workstream's panes directly rather
  // than the row, so it reaches every one of them regardless of whether the
  // row had room to show it.
  const panes = ["a", "b", "c", "d"].map((id) => paneOn("w1", id));
  const live = liveWith2([workspaceOn(1, "auth")], panes).state;

  const focused = ["w1:a", "w1:b", "w1:c", "w1:d"].map((_, index) => {
    const browsed = rotateDial1(live, 0, index + 1, 100).state;
    return pressDial1(browsed, 0, 200).commands[0]?.params.pane_id;
  });

  assert.deepEqual(focused, ["w1:a", "w1:b", "w1:c", "w1:d"]);
});
