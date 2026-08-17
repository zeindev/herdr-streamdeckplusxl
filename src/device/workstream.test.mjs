import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { agentStatusOfPanes } from "../../.preview/model.js";
import { channelWorkstreams, repositoriesToQuery, workstreamsOf } from "../../.preview/device/workstream.js";

const capture = JSON.parse(readFileSync(new URL("../herdr/fixtures/capture.json", import.meta.url), "utf8"));

/** A workspace exactly as Herdr sent one, so the shape is never invented. */
function recordedWorkspace(overrides = {}) {
  const event = capture.events.find((candidate) => candidate.event === "workspace_created");
  assert.ok(event?.data?.workspace, "the capture has no workspace_created to test with");
  return { ...structuredClone(event.data.workspace), ...overrides };
}

/** The worktree Herdr reported alongside that workspace, branch included. */
function recordedWorktree() {
  const event = capture.events.find((candidate) => candidate.event === "worktree_created");
  assert.ok(event?.data?.worktree, "the capture has no worktree_created to test with");
  return structuredClone(event.data.worktree);
}

const agentPane = (overrides) => ({ pane_id: "p", agent: "claude", agent_status: "idle", ...overrides });

test("a worktree-backed workspace carries its repository and checkout path", () => {
  const workspace = recordedWorkspace();
  const [workstream] = workstreamsOf({ workspaces: [workspace], panes: [] });

  assert.equal(workstream.workspaceId, workspace.workspace_id);
  assert.equal(workstream.worktree.repoName, "herdr-streamdeckplusxl");
  assert.equal(workstream.worktree.checkoutPath, workspace.worktree.checkout_path);
  assert.equal(workstream.worktree.repoKey, workspace.worktree.repo_key);
  assert.equal(workstream.worktree.isLinked, true);
});

test("the branch is unknown until worktree.list supplies it, because the snapshot has none", () => {
  const workspace = recordedWorkspace();
  assert.ok(!("branch" in workspace.worktree), "the recorded snapshot worktree carries no branch");

  const withoutBranch = workstreamsOf({ workspaces: [workspace], panes: [] })[0];
  assert.equal(withoutBranch.worktree.branch, null);

  const worktree = recordedWorktree();
  const withBranch = workstreamsOf({ workspaces: [workspace], panes: [] }, { [worktree.path]: worktree.branch })[0];
  assert.equal(withBranch.worktree.branch, "sd-fixture-probe");
});

test("a workspace with no worktree is a workstream that says so, not a missing one", () => {
  const workspace = recordedWorkspace({ worktree: null, label: "primary" });
  const [workstream] = workstreamsOf({ workspaces: [workspace], panes: [] });

  assert.equal(workstream.worktree, null);
  assert.equal(workstream.label, "primary", "it still has an identity to show");
});

test("channels take workstreams in Herdr's workspace order, which does not shuffle", () => {
  const workspaces = [
    recordedWorkspace({ workspace_id: "w9", number: 3, label: "third" }),
    recordedWorkspace({ workspace_id: "w4", number: 1, label: "first" }),
    recordedWorkspace({ workspace_id: "w6", number: 2, label: "second" })
  ];
  const order = workstreamsOf({ workspaces, panes: [] }).map((workstream) => workstream.label);
  assert.deepEqual(order, ["first", "second", "third"]);
});

test("the aggregate is recomputed from panes, because Herdr never pushes its own", () => {
  // Verified against live Herdr: 417 pane_updated events carried 8 agent-status
  // changes and no workspace_updated, so the workspace's own aggregate would be
  // whatever it was at the last snapshot read.
  const workspace = recordedWorkspace({ workspace_id: "w6", agent_status: "idle" });
  const panes = [
    agentPane({ pane_id: "w6:p1", workspace_id: "w6", agent_status: "working" }),
    agentPane({ pane_id: "w6:p2", workspace_id: "w6", agent_status: "blocked" })
  ];

  const [workstream] = workstreamsOf({ workspaces: [workspace], panes });
  assert.equal(workstream.agentStatus, "blocked", "the most urgent agent wins, not Herdr's stale aggregate");
});

test("panes are attributed to their own workspace and no other", () => {
  const workspaces = [
    recordedWorkspace({ workspace_id: "w4", number: 1 }),
    recordedWorkspace({ workspace_id: "w6", number: 2 })
  ];
  const panes = [
    agentPane({ pane_id: "w4:p1", workspace_id: "w4", agent_status: "blocked" }),
    agentPane({ pane_id: "w6:p1", workspace_id: "w6", agent_status: "idle" })
  ];

  const [first, second] = workstreamsOf({ workspaces, panes });
  assert.equal(first.agentStatus, "blocked");
  assert.equal(second.agentStatus, "idle");
});

test("panes with no agent do not stand in for one", () => {
  // Four of the five panes on the live session reported agent_status 'unknown'
  // with no agent, so counting them would drown every real reading.
  assert.equal(agentStatusOfPanes([{ pane_id: "a", agent_status: "unknown" }]), undefined);
  assert.equal(
    agentStatusOfPanes([
      { pane_id: "a", agent_status: "unknown" },
      agentPane({ pane_id: "b", agent_status: "working" })
    ]),
    "working"
  );
});

test("attention outranks progress when several agents disagree", () => {
  const status = (statuses) => agentStatusOfPanes(statuses.map((agent_status, index) => agentPane({ pane_id: `p${index}`, agent_status })));
  assert.equal(status(["working", "blocked"]), "blocked", "an agent waiting on input needs someone");
  assert.equal(status(["working", "done"]), "done", "finished work is not yet picked up");
  assert.equal(status(["blocked", "done"]), "blocked");
  assert.equal(status(["idle", "working"]), "working");
  assert.equal(status(["unknown", "idle"]), "idle");
});

test("an unrecognised status never outranks a known one", () => {
  const status = agentStatusOfPanes([
    agentPane({ pane_id: "a", agent_status: "reticulating" }),
    agentPane({ pane_id: "b", agent_status: "working" })
  ]);
  assert.equal(status, "working");
});

test("one read per repository, however many workstreams share it", () => {
  const workspaces = [
    recordedWorkspace({ workspace_id: "w4", number: 1 }),
    recordedWorkspace({ workspace_id: "w6", number: 2 }),
    recordedWorkspace({
      workspace_id: "w7",
      number: 3,
      worktree: { ...recordedWorkspace().worktree, repo_key: "/other/.git", repo_name: "other" }
    })
  ];
  const queries = repositoriesToQuery(workstreamsOf({ workspaces, panes: [] }));

  assert.equal(queries.length, 2, "two repositories, two reads");
  assert.deepEqual(new Set(queries.map((query) => query.repoKey)).size, 2);
  assert.equal(queries[0].workspaceId, "w4", "the first workspace of a repository speaks for it");
});

test("a workspace with no worktree needs no read, since it has no branch to learn", () => {
  const workspace = recordedWorkspace({ worktree: null });
  assert.deepEqual(repositoriesToQuery(workstreamsOf({ workspaces: [workspace], panes: [] })), []);
});

test("there are always exactly three channels, filled or not", () => {
  const workspaces = [recordedWorkspace({ workspace_id: "w4", number: 1 })];
  const channels = channelWorkstreams(workstreamsOf({ workspaces, panes: [] }), 3);

  assert.equal(channels.length, 3);
  assert.equal(channels[0].workspaceId, "w4");
  assert.equal(channels[1], null);
  assert.equal(channels[2], null);
});

test("a fourth workstream takes no channel", () => {
  const workspaces = [1, 2, 3, 4].map((number) =>
    recordedWorkspace({ workspace_id: `w${number}`, number, label: `stream ${number}` })
  );
  const channels = channelWorkstreams(workstreamsOf({ workspaces, panes: [] }), 3);

  assert.deepEqual(channels.map((channel) => channel?.label), ["stream 1", "stream 2", "stream 3"]);
});

test("no snapshot means no workstreams rather than a crash", () => {
  assert.deepEqual(workstreamsOf(null), []);
  assert.deepEqual(workstreamsOf({ panes: [] }), []);
});
