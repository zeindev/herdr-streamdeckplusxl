import assert from "node:assert/strict";
import test from "node:test";

import { paneRowsOf } from "../../.preview/device/panes.js";

const pane = (id, role) => ({ pane_id: id, workspace_id: "w1", agent_status: "unknown", role });
const roleFor = (candidate) => candidate.role;
const rows = (panes, columns = 3) => paneRowsOf(panes, roleFor, columns);
const idsOf = (row) => row.map((cell) => (cell === null ? null : cell.kind === "more" ? `+${cell.count}` : cell.pane.pane_id));

test("a channel has one row per role row, each as wide as the channel", () => {
  const laid = rows([]);
  assert.equal(laid.length, 3);
  assert.ok(laid.every((row) => row.length === 3));
  assert.ok(laid.every((row) => row.every((cell) => cell === null)), "an empty channel stays quiet");
});

test("the row a pane sits on is its role", () => {
  const laid = rows([pane("a", "agent"), pane("s", "server"), pane("t", "tests")]);
  assert.deepEqual(idsOf(laid[0]), ["a", null, null]);
  assert.deepEqual(idsOf(laid[1]), ["s", null, null]);
  assert.deepEqual(idsOf(laid[2]), ["t", null, null]);
});

test("tests, logs and shells share the third row in that fixed order", () => {
  // Declared order, not arrival order: a shell opened first must not push the
  // test watcher along.
  const laid = rows([pane("z-shell", "shell"), pane("y-logs", "logs"), pane("x-tests", "tests")]);
  assert.deepEqual(idsOf(laid[2]), ["x-tests", "y-logs", "z-shell"]);
});

test("panes of one role are ordered so that opening another moves nothing", () => {
  const laid = rows([pane("p3", "tests"), pane("p1", "tests"), pane("p2", "tests")]);
  assert.deepEqual(idsOf(laid[2]), ["p1", "p2", "p3"]);
});

test("a role row filling up uses every key it has", () => {
  const laid = rows([pane("a1", "agent"), pane("a2", "agent"), pane("a3", "agent")]);
  assert.deepEqual(idsOf(laid[0]), ["a1", "a2", "a3"]);
});

test("more panes than keys are counted, so none disappears quietly", () => {
  const laid = rows([1, 2, 3, 4, 5].map((n) => pane(`a${n}`, "agent")));
  assert.deepEqual(idsOf(laid[0]), ["a1", "a2", "+3"], "the last key says how many it is not showing");
});

test("the count covers the pane whose key it took, not only the extras", () => {
  const laid = rows([1, 2, 3, 4].map((n) => pane(`a${n}`, "agent")));
  assert.deepEqual(idsOf(laid[0]), ["a1", "a2", "+2"]);

  const shown = laid[0].filter((cell) => cell?.kind === "pane").length;
  const counted = laid[0].find((cell) => cell?.kind === "more").count;
  assert.equal(shown + counted, 4, "every pane is either shown or counted");
});

test("overflow in one role leaves the other rows alone", () => {
  const laid = rows([...[1, 2, 3, 4].map((n) => pane(`a${n}`, "agent")), pane("s1", "server")]);
  assert.deepEqual(idsOf(laid[0]), ["a1", "a2", "+2"]);
  assert.deepEqual(idsOf(laid[1]), ["s1", null, null]);
});

test("the shared row counts across all three of its roles together", () => {
  const laid = rows([pane("t1", "tests"), pane("t2", "tests"), pane("l1", "logs"), pane("sh1", "shell")]);
  assert.deepEqual(idsOf(laid[2]), ["t1", "t2", "+2"]);
});

test("a role emptying leaves its row quiet rather than pulling others up", () => {
  const before = rows([pane("a1", "agent"), pane("s1", "server")]);
  const after = rows([pane("s1", "server")]);

  assert.deepEqual(idsOf(before[0]), ["a1", null, null]);
  assert.deepEqual(idsOf(after[0]), [null, null, null], "the agent row empties");
  assert.deepEqual(idsOf(after[1]), ["s1", null, null], "the server does not move up into it");
});

test("a pane carries the role it was placed by, so the face can say what it is", () => {
  const [agents] = rows([pane("a1", "agent")]);
  assert.equal(agents[0].role, "agent");
});
