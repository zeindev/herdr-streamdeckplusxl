import assert from "node:assert/strict";
import test from "node:test";

import { workstreamsOf } from "../../.preview/device/workstream.js";
import {
  BRANCH_COLUMNS,
  FIELD_COLUMNS,
  OVERFLOW_COLUMNS,
  UNKNOWN,
  fieldWidth,
  stripBlockOf
} from "../../.preview/device/strip.js";
import { displayWidth } from "../../.preview/text.js";
import { recordedWorkspace } from "../herdr/fixtures/recorded.mjs";

function workstreamOn(label, { branch, worktree = true } = {}) {
  const recorded = recordedWorkspace();
  const workspace = {
    ...recorded,
    workspace_id: "w1",
    number: 1,
    label,
    worktree: worktree ? { ...recorded.worktree, checkout_path: `/w/${label}` } : null
  };
  const branches = branch === undefined ? {} : { [`/w/${label}`]: branch };
  return workstreamsOf({ workspaces: [workspace], panes: [] }, branches)[0];
}

const agentPane = (status, overrides = {}) => ({
  pane_id: `p${status}`,
  workspace_id: "w1",
  agent: "claude",
  agent_status: status,
  ...overrides
});

const valueOf = (block, label) => block.fields.find((field) => field.label === label)?.value;

/** How wide a rendered field line is, gaps included. */
function lineWidth(fields) {
  return fields.reduce((width, field, index) => width + fieldWidth(field) + (index === 0 ? 0 : 2), 0);
}

test("a channel with no workstream lights nothing at all", () => {
  assert.deepEqual(stripBlockOf(null, []), { branch: null, fields: [] });
});

test("the branch is what the strip leads with", () => {
  const block = stripBlockOf(workstreamOn("auth", { branch: "feat/auth-rewrite" }), []);
  assert.equal(block.branch, "feat/auth-rewrite");
});

test("a long branch loses its start, never the part that distinguishes it", () => {
  // Two branches under one prefix must not both read as the same thing, which is
  // exactly what cutting the end would do.
  const long = "feature/authentication/rewrite-the-token-store";
  const block = stripBlockOf(workstreamOn("auth", { branch: long }), []);

  assert.ok(displayWidth(block.branch) <= BRANCH_COLUMNS, "it fits");
  assert.ok(block.branch.startsWith("…"), "something was cut, and the strip says so");
  assert.ok(long.endsWith(block.branch.slice(1)), "what is left is the end of the branch");
});

test("two branches sharing a long prefix still read differently", () => {
  const one = stripBlockOf(workstreamOn("a", { branch: "feature/authentication/rewrite-token-store" }), []).branch;
  const two = stripBlockOf(workstreamOn("a", { branch: "feature/authentication/revert-token-store" }), []).branch;
  assert.notEqual(one, two);
});

test("a branch that fits is left exactly alone", () => {
  assert.equal(stripBlockOf(workstreamOn("a", { branch: "main" }), []).branch, "main");
});

test("the three ways a branch can be absent are three different words", () => {
  assert.equal(stripBlockOf(workstreamOn("a"), []).branch, "UNKNOWN", "nobody has asked Herdr yet");
  assert.equal(stripBlockOf(workstreamOn("a", { branch: null }), []).branch, "DETACHED", "asked, and there is none");
  assert.equal(stripBlockOf(workstreamOn("a", { worktree: false }), []).branch, "NO WORKTREE");
});

test("attention counts the agents that want the developer, and only those", () => {
  const workstream = workstreamOn("auth", { branch: "main" });
  const panes = [
    agentPane("blocked"),
    agentPane("done"),
    agentPane("working"),
    agentPane("idle"),
    { pane_id: "service", workspace_id: "w1", agent_status: "unknown" }
  ];

  // ADR-0005's native floor: blocked is waiting on input, done is finished work
  // nobody has picked up. Working and idle need nobody.
  assert.equal(valueOf(stripBlockOf(workstream, panes), "ATTN"), "2");
  assert.equal(valueOf(stripBlockOf(workstream, panes), "AGENTS"), "4", "the service pane runs no agent");
});

test("counts belong to their own workstream and no other", () => {
  const workstream = workstreamOn("auth", { branch: "main" });
  const panes = [agentPane("blocked"), agentPane("blocked", { pane_id: "elsewhere", workspace_id: "w9" })];
  assert.equal(valueOf(stripBlockOf(workstream, panes), "ATTN"), "1");
});

test("space for ticket and pull-request state is reserved and reads as unknown", () => {
  const block = stripBlockOf(workstreamOn("auth", { branch: "main" }), []);
  assert.equal(valueOf(block, "TKT"), UNKNOWN);
  assert.equal(valueOf(block, "PR"), UNKNOWN);
});

test("readings sit in a fixed order, so one is always found in the same place", () => {
  const order = (panes) => stripBlockOf(workstreamOn("auth", { branch: "main" }), panes).fields.map((field) => field.label);
  assert.deepEqual(order([]), ["ATTN", "TKT", "PR", "AGENTS"]);
  assert.deepEqual(order([agentPane("blocked")]), ["ATTN", "TKT", "PR", "AGENTS"]);
});

test("what fits, fits: the field line never exceeds its budget", () => {
  const many = Array.from({ length: 99 }, (_, index) => agentPane("blocked", { pane_id: `p${index}` }));
  const block = stripBlockOf(workstreamOn("auth", { branch: "main" }), many);
  assert.ok(lineWidth(block.fields) <= FIELD_COLUMNS);
});

test("content is dropped rather than shrunk, and the reasons the strip exists survive", () => {
  const reserved = stripBlockOf(workstreamOn("auth", { branch: "main" }), [], OVERFLOW_COLUMNS);
  const roomy = stripBlockOf(workstreamOn("auth", { branch: "main" }), []);

  assert.ok(reserved.fields.length < roomy.fields.length, "something gave way");
  assert.ok(lineWidth(reserved.fields) <= FIELD_COLUMNS - OVERFLOW_COLUMNS);
  assert.deepEqual(
    reserved.fields.map((field) => field.label),
    ["ATTN", "TKT", "PR"],
    "attention and the reserved enrichment are never the ones dropped"
  );
});

test("a workstream keeps its readings even when the branch had to be cut", () => {
  const block = stripBlockOf(
    workstreamOn("auth", { branch: "feature/authentication/rewrite-the-entire-token-store-again" }),
    [agentPane("blocked")]
  );
  assert.ok(displayWidth(block.branch) <= BRANCH_COLUMNS);
  assert.equal(valueOf(block, "ATTN"), "1");
});
