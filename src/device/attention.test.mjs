import assert from "node:assert/strict";
import test from "node:test";

import {
  DECLARED_ATTENTION_PREFIX,
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
import {
  recordedEvent,
  recordedSnapshotWorkspaceWithTokens,
  recordedWorkspace
} from "../herdr/fixtures/recorded.mjs";

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

/** The number Herdr gives a pane within its workspace: "w1:p2" is "p2". */
const localNumber = (paneId) => paneId.slice(paneId.lastIndexOf(":") + 1);

/** A declared-attention token, in the shape `scripts/herdr-attention` writes. */
const declared = (kind, paneId) => `${kind} ${paneId}`;

/** A workspace whose pane declared something about itself. */
function workspaceWithDeclared(paneId, kind, workspace_id = "w1") {
  return workspaceWith({ [`${DECLARED_ATTENTION_PREFIX}${localNumber(paneId)}`]: declared(kind, paneId) }, workspace_id);
}

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

test("each declared kind is distinguishable on the device", () => {
  for (const kind of ["question", "approval", "finished"]) {
    const panes = [agent("w1:p1", "working")];
    const workspaces = [workspaceWithDeclared("w1:p1", kind)];
    assert.deepEqual(attentionOf({ panes, workspaces }), [{ workspaceId: "w1", reason: kind, paneId: "w1:p1" }]);
  }
});

test("a declared question or approval resolves the moment the token is gone, with no acknowledgement needed", () => {
  // Mirrors how native `waiting` resolves: nothing is tapped, the fact just
  // stops being true. Only `finished` needs a tap, whichever side declared it.
  for (const kind of ["question", "approval"]) {
    const panes = [agent("w1:p1", "working")];
    const asking = { panes, workspaces: [workspaceWithDeclared("w1:p1", kind)] };
    const resolved = { panes, workspaces: [workspaceWith(undefined)] };
    assert.deepEqual(reasons(attentionOf(asking)), [kind]);
    assert.deepEqual(attentionOf(resolved), [], `${kind} must not linger once cleared`);
  }
});

test("a declared finish is asking until acknowledged, exactly like a native one", () => {
  const panes = [agent("w1:p1", "working")];
  const workspaces = [workspaceWithDeclared("w1:p1", "finished")];
  assert.deepEqual(reasons(attentionOf({ panes, workspaces })), ["finished"]);
  assert.deepEqual(attentionOf({ panes, workspaces }, ["w1:p1"]), [], "acknowledged work stops asking, declared or not");
});

test("a declared reason wins over Herdr's native status for the same pane, whatever the native status says", () => {
  // ADR-0005: declared is more specific, so it wins unconditionally rather than
  // the two being merged or the native one taking precedence.
  for (const status of ["blocked", "done", "working", "idle", "unknown"]) {
    const panes = [agent("w1:p1", status)];
    const workspaces = [workspaceWithDeclared("w1:p1", "question")];
    assert.deepEqual(reasons(attentionOf({ panes, workspaces })), ["question"], `native ${status} must not win`);
  }
});

test("native waiting still applies once nothing valid is declared for that pane", () => {
  const panes = [agent("w1:p1", "blocked")];
  const workspaces = [workspaceWith({ sd_attn_p1: "garbage" }, "w1")];
  assert.deepEqual(reasons(attentionOf({ panes, workspaces })), ["waiting"]);
});

test("an unrecognised declared kind is not believed, and the native floor applies instead", () => {
  const panes = [agent("w1:p1", "blocked")];
  const workspaces = [workspaceWith({ sd_attn_p1: "urgent w1:p1" }, "w1")];
  assert.deepEqual(reasons(attentionOf({ panes, workspaces })), ["waiting"], "not one of the three declared kinds");
});

test("a declaration naming a different pane than the one it sits under is not believed", () => {
  // The same defence EXIT_TOKEN_PREFIX needed after a leaked HERDR_PANE_ID
  // stamped one agent's key with another's declaration (ADR-0005).
  const panes = [agent("w1:p1", "working"), agent("w1:p2", "blocked")];
  const workspaces = [workspaceWith({ sd_attn_p1: "question w1:p2" }, "w1")];
  const items = attentionOf({ panes, workspaces });
  assert.deepEqual(reasons(items.filter((item) => item.paneId === "w1:p1")), []);
  assert.deepEqual(reasons(items.filter((item) => item.paneId === "w1:p2")), ["waiting"], "native status is untouched");
});

test("a pane running no agent is never given a declared reason either", () => {
  const panes = [service("w1:p1")];
  const workspaces = [workspaceWithDeclared("w1:p1", "question")];
  assert.deepEqual(attentionOf({ panes, workspaces }), []);
});

test("two agents in one workstream keep two independent declarations", () => {
  const panes = [agent("w1:p1", "working"), agent("w1:p2", "working")];
  const workspaces = [
    workspaceWith(
      { sd_attn_p1: declared("question", "w1:p1"), sd_attn_p2: declared("approval", "w1:p2") },
      "w1"
    )
  ];
  const items = attentionOf({ panes, workspaces });
  assert.deepEqual(
    items.map((item) => [item.paneId, item.reason]).sort(),
    [
      ["w1:p1", "question"],
      ["w1:p2", "approval"]
    ]
  );
});

test("a mixed declared-plus-native workstream reports both correctly", () => {
  // One pane declares, one relies on the native floor, one is finished and
  // already looked at — all in the same snapshot.
  const panes = [agent("w1:p1", "working"), agent("w1:p2", "blocked"), agent("w1:p3", "done")];
  const workspaces = [workspaceWithDeclared("w1:p1", "approval")];
  const items = attentionOf({ panes, workspaces }, ["w1:p3"]);
  assert.deepEqual(
    items.map((item) => [item.paneId, item.reason]).sort(),
    [
      ["w1:p1", "approval"],
      ["w1:p2", "waiting"]
    ]
  );
});

test("a declared bad exit is asking, and names the service", () => {
  const items = attentionOf({ panes: [], workspaces: [workspaceWith({ [`${EXIT_TOKEN_PREFIX}dev`]: "1" })] });
  assert.deepEqual(items, [{ workspaceId: "w1", reason: "exited", service: "dev", status: "1" }]);
});

test("the declaration Herdr really returned is read the way the wrapper wrote it", () => {
  // End to end on recorded traffic rather than a hand-built token: the wrapper
  // wrote this, Herdr stored it, session.snapshot returned it, and the reader
  // takes the status and the pane back out of it.
  const workspace = recordedSnapshotWorkspaceWithTokens();
  const paneId = `${workspace.workspace_id}:p1`;
  const panes = [service(paneId, workspace.workspace_id)];

  assert.deepEqual(attentionOf({ panes, workspaces: [workspace] }), [
    { workspaceId: workspace.workspace_id, reason: "exited", service: "dev", status: "1", paneId }
  ]);
});

test("a dead service keeps the key of the pane it ran in, while that pane is there", () => {
  // Probed on a running Herdr: a service crashing under the wrapper does NOT end
  // the pane's shell, so the pane is still on the device and pane_exited never
  // fires. An earlier version of this claimed the pane was always gone — true of
  // the pane_exited case that was rejected, not of the one that was built.
  const panes = [service("w1:p2")];
  const workspaces = [workspaceWith({ [`${EXIT_TOKEN_PREFIX}dev`]: "1 w1:p2" })];
  assert.deepEqual(attentionOf({ panes, workspaces }), [
    { workspaceId: "w1", reason: "exited", service: "dev", status: "1", paneId: "w1:p2" }
  ]);
  assert.deepEqual([...attentionByPane(attentionOf({ panes, workspaces }))], [["w1:p2", "exited"]]);
});

test("a declaration cannot point at a pane in someone else's workstream", () => {
  // Found by running the real wrapper against a live Herdr: it inherited a
  // HERDR_PANE_ID from the surrounding shell, so the token named a pane in a
  // different workstream — and the reader believed it, stamping "your service
  // died" onto an unrelated agent's key. A pane id proves nothing on its own.
  const panes = [agent("w2:p1", "working", "w2")];
  const workspaces = [workspaceWith({ [`${EXIT_TOKEN_PREFIX}dev`]: "1 w2:p1" }, "w1")];
  const items = attentionOf({ panes, workspaces });

  assert.deepEqual(items, [{ workspaceId: "w1", reason: "exited", service: "dev", status: "1" }]);
  assert.equal(attentionByPane(items).size, 0, "no key in another workstream may be marked");
});

test("a named pane that is gone is dropped, never pointed at anyway", () => {
  // The pane id comes out of a token that outlives whatever wrote it. Keeping a
  // dead one would put the mark on whatever now sits in that position, or on
  // nothing at all, so the item falls back to the strip instead.
  const workspaces = [workspaceWith({ [`${EXIT_TOKEN_PREFIX}dev`]: "1 w1:p2" })];
  const items = attentionOf({ panes: [], workspaces });
  assert.deepEqual(items, [{ workspaceId: "w1", reason: "exited", service: "dev", status: "1" }]);
  assert.equal(attentionByPane(items).size, 0);
});

test("every pane an item names is a pane the device is showing", () => {
  // The invariant the keys rest on, checked across every shape at once.
  const panes = [agent("w1:p1", "blocked"), service("w1:p2")];
  const workspaces = [
    workspaceWith({
      [`${EXIT_TOKEN_PREFIX}dev`]: "1 w1:p2",
      [`${EXIT_TOKEN_PREFIX}api`]: "1 w1:gone",
      [`${EXIT_TOKEN_PREFIX}web`]: "1"
    })
  ];
  const owners = new Map(panes.map((pane) => [pane.pane_id, pane.workspace_id]));
  for (const item of attentionOf({ panes, workspaces })) {
    if (item.paneId) {
      assert.equal(owners.get(item.paneId), item.workspaceId, `${item.paneId} is not this workstream's pane`);
    }
  }
  assert.equal(attentionOf({ panes, workspaces }).length, 4, "the two keyless exits are still counted");
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
  assert.equal(byPane.size, 1, "an exit that named no pane must not invent one");
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
  assert.equal(acknowledges(agent("w1:p1", "done"), null), true);
  assert.equal(acknowledges(agent("w1:p1", "blocked"), null), false);
  assert.equal(acknowledges({ ...service("w1:p1"), agent_status: "done" }, null), false);
  assert.equal(acknowledges(undefined, null), false);
});

test("a declared finish can be acknowledged even when Herdr's own status disagrees", () => {
  // The Stop hook is what makes `finished` show up promptly; Herdr's own
  // detection may not have caught up yet, or may never (that gap is the whole
  // reason -97u exists). Acknowledging must not depend on which side said it.
  const pane = agent("w1:p1", "working");
  const snapshot = { panes: [pane], workspaces: [workspaceWithDeclared("w1:p1", "finished")] };
  assert.equal(acknowledges(pane, snapshot), true);
});

test("a declared question or approval is never itself acknowledgeable", () => {
  for (const kind of ["question", "approval"]) {
    const pane = agent("w1:p1", "working");
    const snapshot = { panes: [pane], workspaces: [workspaceWithDeclared("w1:p1", kind)] };
    assert.equal(acknowledges(pane, snapshot), false, `${kind} must not be acknowledgeable`);
  }
});

test("acknowledging twice is acknowledging once", () => {
  assert.deepEqual(acknowledge(["w1:p1"], "w1:p1"), ["w1:p1"]);
  assert.deepEqual(acknowledge([], "w1:p1"), ["w1:p1"]);
});

test("an agent that goes back to work un-acknowledges itself, so the next finish is heard", () => {
  const done = { panes: [agent("w1:p1", "done")] };
  const working = { panes: [agent("w1:p1", "working")] };

  assert.deepEqual(keepAcknowledged(["w1:p1"], done), ["w1:p1"], "still finished, still acknowledged");
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
