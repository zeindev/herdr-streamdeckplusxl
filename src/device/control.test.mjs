import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIONS_COLUMN,
  ARM_TIMEOUT_MS,
  FOCUS_COLUMN,
  GIT_COLUMN,
  acknowledge,
  acknowledgementFor,
  arm,
  armedElsewhere,
  dueArmTimeout,
  isArmedFor,
  liveAcknowledgements
} from "../../.preview/device/control.js";

test("arming names the workstream and the moment", () => {
  assert.deepEqual(arm("w1", 1000), { workspaceId: "w1", armedAt: 1000 });
});

test("an armed actions key is live for its own workstream within the window", () => {
  const armed = arm("w1", 1000);
  assert.equal(isArmedFor(armed, "w1", ACTIONS_COLUMN, 1000), true);
  assert.equal(isArmedFor(armed, "w1", ACTIONS_COLUMN, 1000 + ARM_TIMEOUT_MS), true, "the window's own edge still counts");
});

test("nothing is armed before anything has armed it", () => {
  assert.equal(isArmedFor(null, "w1", ACTIONS_COLUMN, 1000), false);
});

test("an arm is only live for the exact key that armed it", () => {
  const armed = arm("w1", 1000);
  assert.equal(isArmedFor(armed, "w2", ACTIONS_COLUMN, 1000), false, "a different workstream");
  assert.equal(isArmedFor(armed, "w1", FOCUS_COLUMN, 1000), false, "a different column on the same workstream");
  assert.equal(isArmedFor(armed, "w1", GIT_COLUMN, 1000), false);
});

test("an arm past its window is no longer live, even for its own key", () => {
  const armed = arm("w1", 1000);
  assert.equal(isArmedFor(armed, "w1", ACTIONS_COLUMN, 1000 + ARM_TIMEOUT_MS + 1), false);
});

test("a timeout is due once the window has passed, and not before", () => {
  const armed = arm("w1", 1000);
  assert.equal(dueArmTimeout(armed, 1000 + ARM_TIMEOUT_MS), false, "the edge itself is still within the window");
  assert.equal(dueArmTimeout(armed, 1000 + ARM_TIMEOUT_MS + 1), true);
  assert.equal(dueArmTimeout(null, 5000), false, "nothing armed has no timeout to be due");
});

test("pressing the armed key itself is never a cancellation", () => {
  const armed = arm("w1", 1000);
  assert.equal(armedElsewhere(armed, { workspaceId: "w1", column: ACTIONS_COLUMN }), false);
});

test("pressing anything else while armed cancels it", () => {
  const armed = arm("w1", 1000);
  assert.equal(armedElsewhere(armed, { workspaceId: "w1", column: FOCUS_COLUMN }), true, "another control on the same channel");
  assert.equal(armedElsewhere(armed, { workspaceId: "w2", column: ACTIONS_COLUMN }), true, "another channel's actions key");
  assert.equal(armedElsewhere(armed, null), true, "a press this module cannot even place, such as a pane");
});

test("nothing armed has nothing to cancel", () => {
  assert.equal(armedElsewhere(null, { workspaceId: "w1", column: ACTIONS_COLUMN }), false);
});

test("an outcome is recorded with an absolute expiry, not a duration", () => {
  const acks = acknowledge([], { workspaceId: "w1", column: FOCUS_COLUMN, ok: true }, 1000);
  assert.equal(acks.length, 1);
  assert.equal(acks[0].until > 1000, true);
});

test("a second outcome on the same key replaces the first rather than stacking", () => {
  const first = acknowledge([], { workspaceId: "w1", column: ACTIONS_COLUMN, ok: true, message: "SENT" }, 1000);
  const second = acknowledge(first, { workspaceId: "w1", column: ACTIONS_COLUMN, ok: false, message: "FAILED" }, 1200);
  assert.equal(second.length, 1);
  assert.equal(second[0].message, "FAILED");
});

test("outcomes on different keys coexist", () => {
  const acks = acknowledge(
    acknowledge([], { workspaceId: "w1", column: FOCUS_COLUMN, ok: true }, 1000),
    { workspaceId: "w1", column: ACTIONS_COLUMN, ok: true },
    1000
  );
  assert.equal(acks.length, 2);
});

test("an expired outcome is dropped, a live one is kept", () => {
  const acks = acknowledge([], { workspaceId: "w1", column: FOCUS_COLUMN, ok: true }, 1000);
  const onItsEdge = liveAcknowledgements(acks, acks[0].until);
  assert.deepEqual(onItsEdge, acks, "the window's own edge still counts, the same as isArmedFor's");
  const gone = liveAcknowledgements(acks, acks[0].until + 1);
  assert.deepEqual(gone, []);
});

test("pruning returns the same array when nothing expired, so nothing redraws", () => {
  const acks = acknowledge([], { workspaceId: "w1", column: FOCUS_COLUMN, ok: true }, 1000);
  assert.equal(liveAcknowledgements(acks, 1000), acks);
});

test("a key with no outcome recorded has nothing to show", () => {
  assert.equal(acknowledgementFor([], "w1", FOCUS_COLUMN), undefined);
});

test("acknowledgementFor finds the one matching key among several", () => {
  const acks = acknowledge(
    acknowledge([], { workspaceId: "w1", column: FOCUS_COLUMN, ok: true, message: "FOCUSED" }, 1000),
    { workspaceId: "w2", column: ACTIONS_COLUMN, ok: false, message: "NO AGENT" },
    1000
  );
  assert.equal(acknowledgementFor(acks, "w1", FOCUS_COLUMN).message, "FOCUSED");
  assert.equal(acknowledgementFor(acks, "w2", ACTIONS_COLUMN).message, "NO AGENT");
  assert.equal(acknowledgementFor(acks, "w1", GIT_COLUMN), undefined);
});
