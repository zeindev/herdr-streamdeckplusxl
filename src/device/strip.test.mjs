import assert from "node:assert/strict";
import test from "node:test";

import { attentionIn, attentionOf } from "../../.preview/device/attention.js";
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

/**
 * A channel's block the way the surface builds one.
 *
 * Attention comes from the real reader rather than being handed in, so these
 * assertions break if what counts as needing the developer ever changes — the
 * strip's job is to report that number, not to decide it.
 */
function blockOf(workstream, panes = [], { workspaces = [], acknowledged = [], ...options } = {}) {
  const attention = attentionOf({ panes, workspaces }, acknowledged);
  return stripBlockOf(workstream, panes, {
    ...options,
    attention: attentionIn(attention, workstream?.workspaceId ?? null)
  });
}

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
  const block = blockOf(workstreamOn("auth", { branch: "feat/auth-rewrite" }), []);
  assert.equal(block.branch, "feat/auth-rewrite");
});

test("a long branch loses its middle, so both ends still identify it", () => {
  const long = "feature/authentication/rewrite-the-token-store";
  const block = blockOf(workstreamOn("auth", { branch: long }), []);

  assert.ok(displayWidth(block.branch) <= BRANCH_CELLS, "it fits");
  const [head, tail] = block.branch.split("…");
  assert.ok(head.length > 0 && tail.length > 0, "something was cut, and both ends survived");
  assert.ok(long.startsWith(head) && long.endsWith(tail));
});

test("branches that differ only at the end still read differently", () => {
  const one = blockOf(workstreamOn("a", { branch: "feature/authentication/rewrite-token-store" }), []).branch;
  const two = blockOf(workstreamOn("a", { branch: "feature/authentication/revert-token-store" }), []).branch;
  assert.notEqual(one, two);
});

test("branches that differ only at the start still read differently", () => {
  // Cutting the head instead of the middle would have merged these two, which is
  // the same ambiguity in a mirror.
  const long = (owner) => `${owner}/a-really-quite-long-branch-name-here`;
  const one = blockOf(workstreamOn("a", { branch: long("alice") }), []).branch;
  const two = blockOf(workstreamOn("a", { branch: long("bob") }), []).branch;
  assert.notEqual(one, two);
});

test("a branch that fits is left exactly alone", () => {
  assert.equal(blockOf(workstreamOn("a", { branch: "main" }), []).branch, "main");
});

test("the ways a branch can be absent stay distinguishable", () => {
  assert.equal(blockOf(workstreamOn("a"), []).branch, "UNKNOWN", "nobody has asked Herdr yet");
  assert.equal(blockOf(workstreamOn("a", { branch: null }), []).branch, "DETACHED", "asked, and there is none");
});

test("a workstream with no worktree is named by its label, since it has no branch", () => {
  // Without this it would have no identity anywhere: the keys are all panes now.
  assert.equal(blockOf(workstreamOn("primary", { worktree: false }), []).branch, "primary");
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
  assert.equal(valueOf(blockOf(workstream, panes), "ATTN"), "2");
  assert.equal(valueOf(blockOf(workstream, panes), "AGENTS"), "4", "the service pane runs no agent");
});

test("counts belong to their own workstream and no other", () => {
  const workstream = workstreamOn("auth", { branch: "main" });
  const panes = [agentPane("blocked"), agentPane("blocked", { pane_id: "elsewhere", workspace_id: "w9" })];
  assert.equal(valueOf(blockOf(workstream, panes), "ATTN"), "1");
});

test("space for ticket and pull-request state is reserved and reads as unknown", () => {
  const block = blockOf(workstreamOn("auth", { branch: "main" }), []);
  assert.equal(valueOf(block, "TKT"), UNKNOWN);
  assert.equal(valueOf(block, "PR"), UNKNOWN);
});

test("readings sit in a fixed order, so one is always found in the same place", () => {
  const order = (panes) => labelsOf(blockOf(workstreamOn("auth", { branch: "main" }), panes));
  assert.deepEqual(order([]), ["ATTN", "TKT", "PR", "AGENTS"]);
  assert.deepEqual(order([agentPane("blocked")]), ["ATTN", "TKT", "PR", "AGENTS"]);
});

test("enrichment arriving changes what a reading says, not where anything sits", () => {
  // The reserved widths are the whole point: -wl7 filling TKT and PR in must not
  // shove AGENTS off the strip, or the layout would move under the developer.
  const block = blockOf(workstreamOn("auth", { branch: "main" }), []);
  const widest = block.readings.map((reading) =>
    reading.label === "PR" ? { ...reading, value: "OPEN" } : reading
  );
  assert.deepEqual(labelsOf(block), ["ATTN", "TKT", "PR", "AGENTS"]);
  assert.ok(lineWidth(widest) <= READING_CELLS, "the widest values the reservation covers still fit");
});

test("a notice replaces the readings but never the branch", () => {
  // A branch does not change because Herdr died; the counts do, so they go.
  const block = blockOf(workstreamOn("auth", { branch: "main" }), [agentPane("blocked")], { notice: "OFFLINE" });
  assert.equal(block.branch, "main");
  assert.deepEqual(block.readings, []);
  assert.equal(block.notice, "OFFLINE");
});

test("what fits, fits: the field line never exceeds its budget", () => {
  const many = Array.from({ length: 99 }, (_, index) => agentPane("blocked", { pane_id: `p${index}` }));
  const block = blockOf(workstreamOn("auth", { branch: "main" }), many);
  assert.ok(lineWidth(block.readings) <= READING_CELLS);
});

test("content is dropped rather than shrunk, and the reasons the strip exists survive", () => {
  const reserved = blockOf(workstreamOn("auth", { branch: "main" }), [], { reserved: OVERFLOW_CELLS });
  const roomy = blockOf(workstreamOn("auth", { branch: "main" }), []);

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
      const labels = blockOf(workstream, panes, { reserved }).readings.map((reading) => reading.label);
      assert.deepEqual(
        labels.filter((label) => ["ATTN", "TKT", "PR"].includes(label)),
        ["ATTN", "TKT", "PR"],
        `attention ${attention} with ${reserved} cells reserved dropped a reading it may not drop`
      );
    }
  }
});

test("a workstream keeps its readings even when the branch had to be cut", () => {
  const block = blockOf(
    workstreamOn("auth", { branch: "feature/authentication/rewrite-the-entire-token-store-again" }),
    [agentPane("blocked")]
  );
  assert.ok(displayWidth(block.branch) <= BRANCH_CELLS);
  assert.equal(valueOf(block, "ATTN"), "1");
});

test("a dead service is named on the strip, and spends the droppable reading to say so", () => {
  const workstream = workstreamOn("auth", { branch: "main" });
  const workspaces = [{ workspace_id: "w1", tokens: { sd_exit_dev: "1", sd_exit_api: "137" } }];
  const block = blockOf(workstream, [], { workspaces });

  assert.deepEqual(labelsOf(block), ["ATTN", "TKT", "PR", "EXIT"], "AGENTS is what gives way");
  assert.equal(valueOf(block, "ATTN"), "2");
  assert.equal(valueOf(block, "EXIT"), "2");
});

test("EXIT is absent when nothing has died, so the reading means something when it appears", () => {
  const block = blockOf(workstreamOn("auth", { branch: "main" }), []);
  assert.deepEqual(labelsOf(block), ["ATTN", "TKT", "PR", "AGENTS"]);
});

test("EXIT gives way rather than overrunning the overflow count", () => {
  // The arithmetic that decided this: the three required readings plus EXIT come
  // to 30 cells, and the last channel keeps only READING_CELLS - OVERFLOW_CELLS
  // once the overflow count takes its share. Marking EXIT required would not buy
  // the space, only overrun into the count, and two readings drawn over each
  // other are both unreadable. ATTN still carries the fact.
  const workspaces = [{ workspace_id: "w1", tokens: { sd_exit_dev: "1" } }];
  const block = blockOf(workstreamOn("auth", { branch: "main" }), [], { workspaces, reserved: OVERFLOW_CELLS });

  assert.deepEqual(labelsOf(block), ["ATTN", "TKT", "PR"]);
  assert.equal(valueOf(block, "ATTN"), "1", "the count never stops telling the truth");
  assert.ok(lineWidth(block.readings) <= READING_CELLS - OVERFLOW_CELLS);
});

test("no combination of attention, dead services and reserved space overruns the line", () => {
  // Stressing the budget rather than trusting it. The EXIT reading was required
  // when it was first written, and this is the check that showed it could not
  // be: 30 cells of required readings into 23 cells of last-channel budget.
  const workstream = workstreamOn("auth", { branch: "main" });
  for (const waiting of [0, 1, 9, 40]) {
    for (const dead of [0, 1, 7]) {
      for (const reserved of [0, OVERFLOW_CELLS, 15, 25, READING_CELLS - 1]) {
        const panes = Array.from({ length: waiting }, (_, index) => agentPane("blocked", { pane_id: `p${index}` }));
        const tokens = Object.fromEntries(Array.from({ length: dead }, (_, index) => [`sd_exit_s${index}`, "1"]));
        const block = blockOf(workstream, panes, { workspaces: [{ workspace_id: "w1", tokens }], reserved });
        const budget = READING_CELLS - reserved;
        const labels = labelsOf(block);

        assert.ok(
          lineWidth(block.readings) <= Math.max(budget, requiredWidth(block.readings)),
          `${waiting} waiting, ${dead} dead, ${reserved} reserved overran its ${budget} cells`
        );
        assert.deepEqual(
          labels.filter((label) => ["ATTN", "TKT", "PR"].includes(label)),
          ["ATTN", "TKT", "PR"],
          `${waiting} waiting, ${dead} dead, ${reserved} reserved dropped a reading it may not drop`
        );
        assert.equal(valueOf(block, "ATTN"), String(waiting + dead), "the count includes what has no key");
      }
    }
  }
});

/** What the readings that may never be dropped take up, gaps included. */
function requiredWidth(readings) {
  return lineWidth(readings.filter((reading) => ["ATTN", "TKT", "PR"].includes(reading.label)));
}
