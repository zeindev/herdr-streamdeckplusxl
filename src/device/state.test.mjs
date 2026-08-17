import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { RESYNC_DEBOUNCE_MS, initialState, reduce } from "../../.preview/device/state.js";
import { DEVICE_TYPE_XL } from "../../.preview/device/geometry.js";

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

test("a key press is tracked while held and released cleanly", () => {
  const key = { deviceId: "xl-1", column: 4, row: 2 };
  const down = run([xl, { kind: "key-down", key }]);
  assert.equal(down.state.pressed.length, 1);

  const up = run([{ kind: "key-up", key }], down.state);
  assert.deepEqual(up.state.pressed, []);
});

test("a key release with no matching press is harmless", () => {
  const { state } = run([xl, { kind: "key-up", key: { deviceId: "xl-1", column: 0, row: 0 } }]);
  assert.deepEqual(state.pressed, []);
});

test("unplugging a device forgets keys still held on it", () => {
  const held = run([xl, { kind: "key-down", key: { deviceId: "xl-1", column: 1, row: 1 } }]);
  const { state } = run([{ kind: "device-detached", deviceId: "xl-1" }], held.state);
  assert.deepEqual(state.pressed, [], "a detached device cannot report the release");
});

test("dial input is accepted without commands until something is bound to it", () => {
  const { state, commands } = run([
    xl,
    { kind: "dial-rotate", deviceId: "xl-1", dial: 0, ticks: 3 },
    { kind: "dial-down", deviceId: "xl-1", dial: 0 },
    { kind: "dial-up", deviceId: "xl-1", dial: 0 }
  ]);
  assert.deepEqual(commands, []);
  assert.equal(state.devices.length, 1);
});

test("the theme is carried on state so rendering never reaches for it", () => {
  const theme = { name: "catppuccin", appearance: "dark", palette: {} };
  const { state } = run([{ kind: "theme-changed", theme }]);
  assert.equal(state.theme.name, "catppuccin");
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
