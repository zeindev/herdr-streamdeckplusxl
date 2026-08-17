import assert from "node:assert/strict";
import test from "node:test";

import { channelAgentStatus, mostUrgentPaneOf, paneRowsOf } from "../../.preview/device/panes.js";

const pane = (id, role) => ({ pane_id: id, workspace_id: "w1", agent_status: "unknown", role });
const roleFor = (candidate) => candidate.role;
const rows = (panes, columns = 3) => paneRowsOf(panes, roleFor, columns);
const idsOf = (row) => row.map((cell) => (cell === null ? null : cell.kind === "more" ? `+${cell.count}` : cell.pane.pane_id));

const workstream = (id) => ({ workspaceId: id, label: id, worktree: null });
const paneOn = (workspaceId, id, overrides = {}) => ({ pane_id: id, workspace_id: workspaceId, agent_status: "unknown", ...overrides });
const attentionOn = (entries) => new Map(entries);

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

test("mostUrgentPaneOf picks the pane asking in REASON_ORDER's own priority", () => {
  const panes = [paneOn("w1", "p1"), paneOn("w1", "p2")];
  const attention = attentionOn([
    ["p1", "finished"],
    ["p2", "waiting"]
  ]);
  assert.equal(mostUrgentPaneOf(workstream("w1"), panes, attention).pane_id, "p2");
});

test("mostUrgentPaneOf breaks a tie in urgency by pane_id, deterministically", () => {
  const panes = [paneOn("w1", "p9"), paneOn("w1", "p2")];
  const attention = attentionOn([
    ["p9", "waiting"],
    ["p2", "waiting"]
  ]);
  assert.equal(mostUrgentPaneOf(workstream("w1"), panes, attention).pane_id, "p2");
});

test("mostUrgentPaneOf prefers a working agent when nothing is asking", () => {
  const panes = [paneOn("w1", "idle1", { agent: "claude", agent_status: "idle" }), paneOn("w1", "work1", { agent: "claude", agent_status: "working" })];
  assert.equal(mostUrgentPaneOf(workstream("w1"), panes, attentionOn([])).pane_id, "work1");
});

test("mostUrgentPaneOf falls back to any agent pane when none is working and nothing is asking", () => {
  const panes = [paneOn("w1", "svc"), paneOn("w1", "agent1", { agent: "claude", agent_status: "idle" })];
  assert.equal(mostUrgentPaneOf(workstream("w1"), panes, attentionOn([])).pane_id, "agent1");
});

test("mostUrgentPaneOf falls back to any pane at all when the workstream runs no agent", () => {
  const panes = [paneOn("w1", "z-svc"), paneOn("w1", "a-svc")];
  assert.equal(mostUrgentPaneOf(workstream("w1"), panes, attentionOn([])).pane_id, "a-svc");
});

test("mostUrgentPaneOf returns undefined for a workstream with no panes at all", () => {
  assert.equal(mostUrgentPaneOf(workstream("w1"), [], attentionOn([])), undefined);
});

test("mostUrgentPaneOf never picks a pane belonging to another workstream", () => {
  const panes = [paneOn("w9", "elsewhere"), paneOn("w1", "mine")];
  const attention = attentionOn([["elsewhere", "waiting"]]);
  assert.equal(mostUrgentPaneOf(workstream("w1"), panes, attention).pane_id, "mine");
});

test("channelAgentStatus reports blocked over an idle agent elsewhere in the channel", () => {
  const panes = [
    paneOn("w1", "p1", { agent: "claude", agent_status: "idle" }),
    paneOn("w1", "p2", { agent: "claude", agent_status: "blocked" })
  ];
  assert.equal(channelAgentStatus(workstream("w1"), panes), "blocked");
});

test("channelAgentStatus follows the full priority: blocked, working, done, idle", () => {
  const statusesPresent = (...statuses) =>
    channelAgentStatus(
      workstream("w1"),
      statuses.map((status, index) => paneOn("w1", `p${index}`, { agent: "claude", agent_status: status }))
    );
  assert.equal(statusesPresent("idle", "working", "done"), "working");
  assert.equal(statusesPresent("idle", "done"), "done");
  assert.equal(statusesPresent("idle"), "idle");
});

test("channelAgentStatus ignores panes with no agent, since Herdr reports unknown for every one of them", () => {
  const panes = [paneOn("w1", "svc1"), paneOn("w1", "svc2")];
  assert.equal(channelAgentStatus(workstream("w1"), panes), undefined);
});

test("channelAgentStatus is undefined for a workstream with no panes at all", () => {
  assert.equal(channelAgentStatus(workstream("w1"), []), undefined);
});

test("channelAgentStatus only counts panes belonging to this workstream", () => {
  const panes = [paneOn("w9", "elsewhere", { agent: "claude", agent_status: "blocked" }), paneOn("w1", "mine", { agent: "claude", agent_status: "idle" })];
  assert.equal(channelAgentStatus(workstream("w1"), panes), "idle");
});
