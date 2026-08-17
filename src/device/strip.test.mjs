import assert from "node:assert/strict";
import test from "node:test";

import { workstreamsOf } from "../../.preview/device/workstream.js";
import {
  BRANCH_CELLS,
  OVERFLOW_CELLS,
  READING_CELLS,
  UNKNOWN,
  readingWidth,
  stripBlockOf
} from "../../.preview/device/strip.js";
import { READING_GAP, displayWidth } from "../../.preview/text.js";
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

const valueOf = (block, label) => block.readings.find((reading) => reading.label === label)?.value;
const labelsOf = (block) => block.readings.map((reading) => reading.label);

/** How wide a rendered readings line is, gaps included. */
function lineWidth(readings) {
  return readings.reduce((width, reading, index) => width + readingWidth(reading) + (index === 0 ? 0 : READING_GAP), 0);
}

test("a channel with no workstream lights nothing at all", () => {
  assert.deepEqual(stripBlockOf(null, []), { branch: null, readings: [], notice: null });
});

test("the branch is what the strip leads with", () => {
  const block = stripBlockOf(workstreamOn("auth", { branch: "feat/auth-rewrite" }), []);
  assert.equal(block.branch, "feat/auth-rewrite");
});

test("a long branch loses its middle, so both ends still identify it", () => {
  const long = "feature/authentication/rewrite-the-token-store";
  const block = stripBlockOf(workstreamOn("auth", { branch: long }), []);

  assert.ok(displayWidth(block.branch) <= BRANCH_CELLS, "it fits");
  const [head, tail] = block.branch.split("…");
  assert.ok(head.length > 0 && tail.length > 0, "something was cut, and both ends survived");
  assert.ok(long.startsWith(head) && long.endsWith(tail));
});

test("branches that differ only at the end still read differently", () => {
  const one = stripBlockOf(workstreamOn("a", { branch: "feature/authentication/rewrite-token-store" }), []).branch;
  const two = stripBlockOf(workstreamOn("a", { branch: "feature/authentication/revert-token-store" }), []).branch;
  assert.notEqual(one, two);
});

test("branches that differ only at the start still read differently", () => {
  // Cutting the head instead of the middle would have merged these two, which is
  // the same ambiguity in a mirror.
  const long = (owner) => `${owner}/a-really-quite-long-branch-name-here`;
  const one = stripBlockOf(workstreamOn("a", { branch: long("alice") }), []).branch;
  const two = stripBlockOf(workstreamOn("a", { branch: long("bob") }), []).branch;
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
  const order = (panes) => labelsOf(stripBlockOf(workstreamOn("auth", { branch: "main" }), panes));
  assert.deepEqual(order([]), ["ATTN", "TKT", "PR", "AGENTS"]);
  assert.deepEqual(order([agentPane("blocked")]), ["ATTN", "TKT", "PR", "AGENTS"]);
});

test("enrichment arriving changes what a reading says, not where anything sits", () => {
  // The reserved widths are the whole point: -wl7 filling TKT and PR in must not
  // shove AGENTS off the strip, or the layout would move under the developer.
  const block = stripBlockOf(workstreamOn("auth", { branch: "main" }), []);
  const widest = block.readings.map((reading) =>
    reading.label === "PR" ? { ...reading, value: "OPEN" } : reading
  );
  assert.deepEqual(labelsOf(block), ["ATTN", "TKT", "PR", "AGENTS"]);
  assert.ok(lineWidth(widest) <= READING_CELLS, "the widest values the reservation covers still fit");
});

test("a notice replaces the readings but never the branch", () => {
  // A branch does not change because Herdr died; the counts do, so they go.
  const block = stripBlockOf(workstreamOn("auth", { branch: "main" }), [agentPane("blocked")], { notice: "OFFLINE" });
  assert.equal(block.branch, "main");
  assert.deepEqual(block.readings, []);
  assert.equal(block.notice, "OFFLINE");
});

test("what fits, fits: the field line never exceeds its budget", () => {
  const many = Array.from({ length: 99 }, (_, index) => agentPane("blocked", { pane_id: `p${index}` }));
  const block = stripBlockOf(workstreamOn("auth", { branch: "main" }), many);
  assert.ok(lineWidth(block.readings) <= READING_CELLS);
});

test("content is dropped rather than shrunk, and the reasons the strip exists survive", () => {
  const reserved = stripBlockOf(workstreamOn("auth", { branch: "main" }), [], { reserved: OVERFLOW_CELLS });
  const roomy = stripBlockOf(workstreamOn("auth", { branch: "main" }), []);

  assert.ok(reserved.readings.length < roomy.readings.length, "something gave way");
  assert.ok(lineWidth(reserved.readings) <= READING_CELLS - OVERFLOW_CELLS);
  assert.deepEqual(
    reserved.readings.map((field) => field.label),
    ["ATTN", "TKT", "PR"],
    "attention and the reserved enrichment are never the ones dropped"
  );
});

test("the readings the strip exists for are kept whatever the budget", () => {
  // The reserved enrichment is only reserved if it cannot be squeezed out, and
  // a strip that silently stopped reporting attention would be worse than one
  // that runs long. Budgets far tighter than anything the device produces.
  const workstream = workstreamOn("auth", { branch: "main" });
  for (const attention of [0, 9, 999]) {
    const panes = Array.from({ length: attention }, (_, index) => agentPane("blocked", { pane_id: `p${index}` }));
    for (const reserved of [0, OVERFLOW_CELLS, 15, 25, READING_CELLS - 1]) {
      const labels = stripBlockOf(workstream, panes, { reserved }).readings.map((reading) => reading.label);
      assert.deepEqual(
        labels.filter((label) => ["ATTN", "TKT", "PR"].includes(label)),
        ["ATTN", "TKT", "PR"],
        `attention ${attention} with ${reserved} cells reserved dropped a reading it may not drop`
      );
    }
  }
});

test("a workstream keeps its readings even when the branch had to be cut", () => {
  const block = stripBlockOf(
    workstreamOn("auth", { branch: "feature/authentication/rewrite-the-entire-token-store-again" }),
    [agentPane("blocked")]
  );
  assert.ok(displayWidth(block.branch) <= BRANCH_CELLS);
  assert.equal(valueOf(block, "ATTN"), "1");
});
