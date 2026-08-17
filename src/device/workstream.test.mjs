import assert from "node:assert/strict";
import test from "node:test";

import { oneWorkspacePerRepository, workstreamsOf } from "../../.preview/device/workstream.js";
import { recordedWorkspace, recordedWorktree } from "../herdr/fixtures/recorded.mjs";

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
  assert.equal(withoutBranch.worktree.branch, undefined, "not asked is not the same as no branch");

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

test("channels take workstreams in Herdr's workspace order, deterministically", () => {
  const workspaces = [
    recordedWorkspace({ workspace_id: "w9", number: 3, label: "third" }),
    recordedWorkspace({ workspace_id: "w4", number: 1, label: "first" }),
    recordedWorkspace({ workspace_id: "w6", number: 2, label: "second" })
  ];
  const order = workstreamsOf({ workspaces, panes: [] }).map((workstream) => workstream.label);
  assert.deepEqual(order, ["first", "second", "third"]);

  // Deterministic, and deliberately not the device's geography: closing the
  // first workstream slides this order along, which is exactly why `slots.ts`
  // and not this order decides which channel a workstream holds.
  const afterClosing = workstreamsOf({ workspaces: workspaces.filter((w) => w.number !== 1), panes: [] });
  assert.deepEqual(afterClosing.map((workstream) => workstream.label), ["second", "third"]);
});

test("a checkout Herdr says is on no branch is an answer, not a gap", () => {
  const workspace = recordedWorkspace();
  const detached = workstreamsOf({ workspaces: [workspace], panes: [] }, { [workspace.worktree.checkout_path]: null })[0];
  assert.equal(detached.worktree.branch, null);
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
  const queries = oneWorkspacePerRepository(workstreamsOf({ workspaces, panes: [] }));

  assert.equal(queries.length, 2, "two repositories, two reads");
  assert.equal(queries[0], "w4", "the first workspace of a repository speaks for it");
  assert.ok(!queries.includes("w6"), "a second workspace on the same repository costs nothing");
});

test("a workspace with no worktree needs no read, since it has no branch to learn", () => {
  const workspace = recordedWorkspace({ worktree: null });
  assert.deepEqual(oneWorkspacePerRepository(workstreamsOf({ workspaces: [workspace], panes: [] })), []);
});

test("no snapshot means no workstreams rather than a crash", () => {
  assert.deepEqual(workstreamsOf(null), []);
  assert.deepEqual(workstreamsOf({ panes: [] }), []);
});
