import assert from "node:assert/strict";
import test from "node:test";

import {
  EXIT_TOKEN_PREFIX,
  acknowledge,
  acknowledges,
  attentionByPane,
  attentionIn,
  attentionOf,
  keepAcknowledged,
  readAcknowledged,
  sameAcknowledged,
  storedAcknowledged
} from "../../.preview/device/attention.js";
import { recordedEvent, recordedWorkspace } from "../herdr/fixtures/recorded.mjs";

/** An agent pane in a workstream, at whatever state the caller names. */
const agent = (paneId, agent_status, workspace_id = "w1") => ({
  pane_id: paneId,
  workspace_id,
  agent: "claude",
  agent_status
});

/** A pane running no agent, which is what Herdr reports for every service. */
const service = (paneId, workspace_id = "w1") => ({
  pane_id: paneId,
  workspace_id,
  agent_status: "unknown"
});

/** A workspace with tokens on it, built from one Herdr really sent. */
function workspaceWith(tokens, workspace_id = "w1") {
  const { tokens: _recorded, ...recorded } = recordedWorkspace();
  return { ...recorded, workspace_id, ...(tokens ? { tokens } : {}) };
}

const reasons = (items) => items.map((item) => item.reason);

test("nothing is asking before Herdr has said anything", () => {
  assert.deepEqual(attentionOf(null), []);
  assert.deepEqual(attentionOf({ panes: [] }), []);
});

test("an agent waiting on input is asking", () => {
  const items = attentionOf({ panes: [agent("w1:p1", "blocked")] });
  assert.deepEqual(items, [{ workspaceId: "w1", reason: "waiting", paneId: "w1:p1" }]);
});

test("an agent that has finished is asking until it is acknowledged", () => {
  const panes = [agent("w1:p1", "done")];
  assert.deepEqual(reasons(attentionOf({ panes })), ["finished"]);
  assert.deepEqual(attentionOf({ panes }, ["w1:p1"]), [], "acknowledged work stops asking");
});

test("an agent that is working or idle wants nobody", () => {
  for (const status of ["working", "idle", "unknown"]) {
    assert.deepEqual(attentionOf({ panes: [agent("w1:p1", status)] }), [], `${status} must stay quiet`);
  }
});

test("a pane with no agent never reports a state, whatever Herdr says its status is", () => {
  // Herdr answers `unknown` for every pane without an agent, and reading a
  // status off a service would put attention on every shell in every channel.
  // A service saying `blocked` is Herdr's default, not a claim about the pane.
  const panes = [{ ...service("w1:p1"), agent_status: "blocked" }, { ...service("w1:p2"), agent_status: "done" }];
  assert.deepEqual(attentionOf({ panes }), []);
});

test("a declared bad exit is asking, and names the service rather than a pane", () => {
  // It cannot name a pane: probing a running Herdr showed the pane leaves the
  // session the instant its process ends, so by the time anything reads this
  // there is no pane and no key. The workstream is all that is left to point at.
  const items = attentionOf({ panes: [], workspaces: [workspaceWith({ [`${EXIT_TOKEN_PREFIX}dev`]: "1" })] });
  assert.deepEqual(items, [{ workspaceId: "w1", reason: "exited", service: "dev", status: "1" }]);
});

test("a clean exit raises nothing, and the reader is what refuses it", () => {
  // The acceptance criterion is that a clean exit does not raise attention. The
  // wrapper only declares nonzero ones, but a criterion nothing refuses to break
  // is only a hope, so a zero written by anything at all is still ignored here.
  //
  // Every spelling of zero a shell or a formatter can produce, not only the one
  // character: refusing "0" alone would let "00" ring the bell for a service
  // that exited perfectly.
  for (const status of ["0", " 0 ", "", "00", "+0", "-0", "0.0"]) {
    const workspaces = [workspaceWith({ [`${EXIT_TOKEN_PREFIX}dev`]: status })];
    assert.deepEqual(attentionOf({ panes: [], workspaces }), [], `status ${JSON.stringify(status)} must stay quiet`);
  }
});

test("every spelling of a bad exit is heard, including one nothing can parse", () => {
  // A value that is not a number is not treated as clean. Something deliberately
  // declared it, and the honest reading of a declaration nobody can parse is
  // that something is wrong — the opposite choice would let a malformed
  // declaration silence a dead service.
  for (const status of ["1", "137", "-1", "01", "crashed"]) {
    const workspaces = [workspaceWith({ [`${EXIT_TOKEN_PREFIX}dev`]: status })];
    assert.deepEqual(
      attentionOf({ panes: [], workspaces }).map((item) => item.status),
      [status.trim()],
      `status ${JSON.stringify(status)} must be heard`
    );
  }
});

test("a nameless exit token is refused, since two of them could not be told apart", () => {
  const workspaces = [workspaceWith({ [EXIT_TOKEN_PREFIX]: "1" })];
  assert.deepEqual(attentionOf({ panes: [], workspaces }), []);
});

test("tokens that are not exit declarations are left alone", () => {
  const workspaces = [workspaceWith({ sd_attention: "question", ticket: "ABC-1", exit_dev: "1" })];
  assert.deepEqual(attentionOf({ panes: [], workspaces }), []);
});

test("two dead services in one workstream stay two things to fix", () => {
  const workspaces = [workspaceWith({ [`${EXIT_TOKEN_PREFIX}api`]: "1", [`${EXIT_TOKEN_PREFIX}web`]: "137" })];
  const items = attentionOf({ panes: [], workspaces });
  assert.deepEqual(items.map((item) => item.service), ["api", "web"]);
});

test("a resolved exit leaves on its own, because the declaration is simply gone", () => {
  // Herdr reports a cleared token by omitting the field, which is exactly what
  // the recorded capture shows, so nothing has to be dismissed by hand.
  const cleared = recordedEvent("workspace_metadata_updated");
  const withToken = { ...cleared.data.workspace, workspace_id: "w1", tokens: { [`${EXIT_TOKEN_PREFIX}dev`]: "1" } };
  const { tokens: _gone, ...withoutToken } = withToken;

  assert.equal(attentionOf({ panes: [], workspaces: [withToken] }).length, 1);
  assert.deepEqual(attentionOf({ panes: [], workspaces: [withoutToken] }), []);
});

test("items belong to their own workstream and no other", () => {
  const snapshot = {
    panes: [agent("w1:p1", "blocked"), agent("w2:p1", "blocked", "w2")],
    workspaces: [workspaceWith({ [`${EXIT_TOKEN_PREFIX}dev`]: "1" }, "w2")]
  };
  const items = attentionOf(snapshot);
  assert.equal(attentionIn(items, "w1").length, 1);
  assert.equal(attentionIn(items, "w2").length, 2);
  assert.deepEqual(attentionIn(items, null), [], "a channel holding no workstream counts nothing");
});

test("the order never depends on the order Herdr happened to list things in", () => {
  const panes = [agent("w1:p9", "done"), agent("w1:p2", "blocked"), agent("w1:p1", "done")];
  const forwards = attentionOf({ panes });
  const backwards = attentionOf({ panes: [...panes].reverse() });
  assert.deepEqual(forwards, backwards);
  assert.deepEqual(reasons(forwards), ["waiting", "finished", "finished"]);
});

test("only what has a pane can reach a key", () => {
  const snapshot = {
    panes: [agent("w1:p1", "blocked")],
    workspaces: [workspaceWith({ [`${EXIT_TOKEN_PREFIX}dev`]: "1" })]
  };
  const byPane = attentionByPane(attentionOf(snapshot));
  assert.deepEqual([...byPane], [["w1:p1", "waiting"]]);
  assert.equal(byPane.size, 1, "the dead service has no key to land on and must not invent one");
});

test("a pane waiting and finished at once is one thing, not two", () => {
  // Herdr reports a single status, so this cannot happen from Herdr — but the
  // map must still be a function of the pane, or a key would flicker between
  // two faces depending on which item was read last.
  const items = [
    { workspaceId: "w1", reason: "waiting", paneId: "w1:p1" },
    { workspaceId: "w1", reason: "finished", paneId: "w1:p1" }
  ];
  assert.deepEqual([...attentionByPane(items)], [["w1:p1", "waiting"]]);
});

test("only a finished agent can be acknowledged", () => {
  assert.equal(acknowledges(agent("w1:p1", "done")), true);
  assert.equal(acknowledges(agent("w1:p1", "blocked")), false);
  assert.equal(acknowledges({ ...service("w1:p1"), agent_status: "done" }), false);
  assert.equal(acknowledges(undefined), false);
});

test("acknowledging twice is acknowledging once", () => {
  assert.deepEqual(acknowledge(["w1:p1"], "w1:p1"), ["w1:p1"]);
  assert.deepEqual(acknowledge([], "w1:p1"), ["w1:p1"]);
});

test("an agent that goes back to work un-acknowledges itself, so the next finish is heard", () => {
  const done = { panes: [agent("w1:p1", "done")] };
  const working = { panes: [agent("w1:p1", "working")] };

  assert.deepEqual(keepAcknowledged(["w1:p1"], done), ["w1:p1"], "still finished, still seen");
  assert.deepEqual(keepAcknowledged(["w1:p1"], working), [], "back at work, so the mark is spent");
  assert.deepEqual(reasons(attentionOf(done, keepAcknowledged(["w1:p1"], working))), ["finished"]);
});

test("a pane that no longer exists takes its acknowledgement with it", () => {
  assert.deepEqual(keepAcknowledged(["w1:p1"], { panes: [] }), []);
});

test("nothing is dropped before the first snapshot, since nothing is known yet", () => {
  // Settings are read before Herdr answers. Judging them against an empty
  // session would throw away every acknowledgement and write the loss back.
  assert.deepEqual(keepAcknowledged(["w1:p1", "w1:p2"], null), ["w1:p1", "w1:p2"]);
});

test("pruning returns the same value when it dropped nothing, so nothing redraws", () => {
  const acknowledged = ["w1:p1"];
  assert.equal(keepAcknowledged(acknowledged, { panes: [agent("w1:p1", "done")] }), acknowledged);
});

test("stored acknowledgements survive a round trip and reject anything else", () => {
  assert.deepEqual(readAcknowledged(storedAcknowledged(["w1:p1", "w1:p2"])), ["w1:p1", "w1:p2"]);
  assert.deepEqual(readAcknowledged(undefined), []);
  assert.deepEqual(readAcknowledged({ acknowledged: "w1:p1" }), [], "a string is not a list of panes");
  assert.deepEqual(readAcknowledged({ acknowledged: ["w1:p1", 7, "", null, "w1:p1"] }), ["w1:p1"]);
});

test("two acknowledgement lists compare by value", () => {
  assert.equal(sameAcknowledged([], []), true);
  assert.equal(sameAcknowledged(["a"], ["a"]), true);
  assert.equal(sameAcknowledged(["a"], ["b"]), false);
  assert.equal(sameAcknowledged(["a"], ["a", "b"]), false);
});
