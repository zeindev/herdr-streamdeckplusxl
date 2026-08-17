import assert from "node:assert/strict";
import test from "node:test";

import { workstreamsOf } from "../../.preview/device/workstream.js";
import {
  bind,
  candidatesFor,
  channelWorkstreams,
  cycle,
  emptySlots,
  forgetAbsent,
  overflowOf,
  readSlots,
  storedSlots,
  workstreamKey
} from "../../.preview/device/slots.js";
import { recordedWorkspace } from "../herdr/fixtures/recorded.mjs";

/** A worktree-backed workspace on its own checkout, as Herdr sends them. */
function workspace(number, label, checkoutPath = `/w/${label}`) {
  const recorded = recordedWorkspace();
  return {
    ...recorded,
    workspace_id: `w${number}`,
    number,
    label,
    worktree: { ...recorded.worktree, checkout_path: checkoutPath }
  };
}

const streams = (...workspaces) => workstreamsOf({ workspaces, panes: [] });
const labels = (bindings, workstreams) => channelWorkstreams(bindings, workstreams).map((held) => held?.label ?? null);

test("a workstream is keyed on its checkout path, which outlives everything", () => {
  const [workstream] = streams(workspace(1, "auth", "/w/auth"));
  assert.equal(workstreamKey(workstream), "checkout:/w/auth");
});

test("a workspace with no worktree keys on its id, the only durable thing it has", () => {
  // Verified in ~/.config/herdr/session.json: Herdr persists the workspace id
  // verbatim, so it survives a restart. `identity_cwd` would be a better key but
  // is not exposed on the socket.
  const [workstream] = streams({ ...workspace(1, "primary"), worktree: null });
  assert.equal(workstreamKey(workstream), "workspace:w1");

  // The two namespaces must never be able to collide.
  const [worktreeBacked] = streams(workspace(2, "other", "workspace:w1"));
  assert.notEqual(workstreamKey(worktreeBacked), "workspace:w1");
});

test("there are always exactly three slots, however few workstreams exist", () => {
  assert.equal(emptySlots().bindings.length, 3);
  assert.deepEqual(labels(emptySlots(), []), [null, null, null]);
});

test("a new workstream takes the lowest free slot", () => {
  const workstreams = streams(workspace(1, "auth"), workspace(2, "billing"));
  const bound = bind(emptySlots(), workstreams);
  assert.deepEqual(labels(bound, workstreams), ["auth", "billing", null]);
});

test("a workstream keeps its slot when an earlier one closes", () => {
  // This is the whole point of the ticket: ADR-0009 rejects auto-fill precisely
  // because a workstream must never slide sideways while the developer is away.
  const all = streams(workspace(1, "auth"), workspace(2, "billing"), workspace(3, "search"));
  const bound = bind(emptySlots(), all);
  assert.deepEqual(labels(bound, all), ["auth", "billing", "search"]);

  const afterClosing = streams(workspace(2, "billing"), workspace(3, "search"));
  assert.deepEqual(labels(bound, afterClosing), [null, "billing", "search"], "nobody moved");
});

test("a workstream reclaims its own slot after Herdr restarts", () => {
  const before = streams(workspace(1, "auth"), workspace(2, "billing"));
  const bound = bind(emptySlots(), before);

  // A restart renumbers nothing the plugin depends on: the checkout path is the
  // key, so the same checkouts land back where they were.
  const after = streams(workspace(7, "billing"), workspace(9, "auth"));
  assert.deepEqual(labels(bind(bound, after), after), ["auth", "billing", null]);
});

test("a slot remembered for an absent workstream is preferred over an empty one", () => {
  const bound = bind(emptySlots(), streams(workspace(1, "auth")));
  const different = streams(workspace(2, "billing"));

  // Slot 0 is still spoken for, so the newcomer takes slot 1 rather than
  // evicting a workstream that may simply be waiting for Herdr to come back.
  assert.deepEqual(labels(bind(bound, different), different), [null, "billing", null]);
});

test("a remembered slot is only evicted when nothing else is free", () => {
  const bound = bind(emptySlots(), streams(workspace(1, "a"), workspace(2, "b"), workspace(3, "c")));
  const newcomers = streams(workspace(4, "d"), workspace(5, "e"), workspace(6, "f"), workspace(7, "g"));

  const filled = bind(bound, newcomers);
  assert.deepEqual(labels(filled, newcomers), ["d", "e", "f"], "the ghosts give way rather than locking the device");
  assert.equal(overflowOf(filled, newcomers).length, 1, "the fourth is over budget, not hidden");
});

test("a fourth workstream is counted, never given a channel", () => {
  const workstreams = streams(workspace(1, "a"), workspace(2, "b"), workspace(3, "c"), workspace(4, "d"));
  const bound = bind(emptySlots(), workstreams);

  assert.deepEqual(labels(bound, workstreams), ["a", "b", "c"]);
  assert.deepEqual(overflowOf(bound, workstreams).map((held) => held.label), ["d"]);
});

test("overflow clears as soon as a channel frees up", () => {
  const crowded = streams(workspace(1, "a"), workspace(2, "b"), workspace(3, "c"), workspace(4, "d"));
  const bound = bind(emptySlots(), crowded);
  assert.equal(overflowOf(bound, crowded).length, 1);

  const roomy = streams(workspace(2, "b"), workspace(3, "c"), workspace(4, "d"));
  assert.equal(overflowOf(bind(bound, roomy), roomy).length, 0, "the freed slot absorbs the overflow");
});

test("holding a channel that holds a workstream lets it go", () => {
  const workstreams = streams(workspace(1, "auth"), workspace(2, "billing"));
  const bound = bind(emptySlots(), workstreams);

  const released = cycle(bound, 0, workstreams);
  assert.deepEqual(labels(released, workstreams), [null, "billing", null]);
  assert.deepEqual(overflowOf(released, workstreams).map((held) => held.label), ["auth"]);
});

test("a released workstream stays released when Herdr next speaks", () => {
  // Without this the whole gesture is theatre: the next snapshot would hand the
  // workstream straight back to the channel it was just taken out of.
  const workstreams = streams(workspace(1, "auth"), workspace(2, "billing"));
  const released = cycle(bind(emptySlots(), workstreams), 0, workstreams);

  assert.deepEqual(labels(bind(released, workstreams), workstreams), [null, "billing", null]);
});

test("holding an empty channel takes in the workstream that was waiting", () => {
  const workstreams = streams(workspace(1, "auth"), workspace(2, "billing"), workspace(3, "search"));
  const bound = bind(emptySlots(), [workstreams[0], workstreams[1]]);

  const adopted = cycle(bound, 2, workstreams);
  assert.deepEqual(labels(adopted, workstreams), ["auth", "billing", "search"]);
});

test("holding again offers the next workstream, so the developer can choose", () => {
  const workstreams = streams(workspace(1, "auth"), workspace(2, "billing"), workspace(3, "search"));
  const only = bind(emptySlots(), [workstreams[0]]);

  const first = cycle(only, 1, workstreams);
  assert.deepEqual(labels(first, workstreams), ["auth", "billing", null]);

  const second = cycle(first, 1, workstreams);
  assert.deepEqual(labels(second, workstreams), ["auth", "search", null], "a second hold offers the other one");
});

test("the cycle comes back round rather than trapping the developer in a list", () => {
  const workstreams = streams(workspace(1, "auth"));
  let slots = bind(emptySlots(), workstreams);
  const seen = [labels(slots, workstreams)[0]];
  for (let hold = 0; hold < 2; hold++) {
    slots = cycle(slots, 0, workstreams);
    seen.push(labels(slots, workstreams)[0]);
  }
  assert.deepEqual(seen, ["auth", null, "auth"]);
});

test("a channel is never offered a workstream another channel is holding", () => {
  const workstreams = streams(workspace(1, "auth"), workspace(2, "billing"));
  const bound = bind(emptySlots(), workstreams);

  assert.deepEqual(candidatesFor(bound, 2, workstreams), [null], "both are spoken for");
  assert.deepEqual(candidatesFor(bound, 0, workstreams), [null, workstreamKey(workstreams[0])]);
});

test("a workstream detached and then closed is forgotten rather than remembered forever", () => {
  const workstreams = streams(workspace(1, "auth"), workspace(2, "billing"));
  const released = cycle(bind(emptySlots(), workstreams), 0, workstreams);
  assert.deepEqual(released.detached, [workstreamKey(workstreams[0])]);

  const survivors = streams(workspace(2, "billing"));
  assert.deepEqual(forgetAbsent(released, survivors).detached, []);
});

test("geography survives a round trip through settings", () => {
  const workstreams = streams(workspace(1, "auth"), workspace(2, "billing"), workspace(3, "search"));
  const released = cycle(bind(emptySlots(), workstreams), 0, workstreams);

  const restored = readSlots(JSON.parse(JSON.stringify(storedSlots(released))));
  assert.deepEqual(restored, released);
  assert.deepEqual(labels(restored, workstreams), [null, "billing", "search"]);
  assert.deepEqual(labels(bind(restored, workstreams), workstreams), [null, "billing", "search"], "still released");
});

test("settings that are missing, damaged, or the wrong shape leave the device usable", () => {
  const damaged = [undefined, null, {}, { slots: "nonsense" }, { slots: [1, 2, 3] }, { slots: [] }, { detached: 7 }];
  for (const stored of damaged) {
    const restored = readSlots(stored);
    assert.equal(restored.bindings.length, 3, `${JSON.stringify(stored)} must still yield three slots`);
    assert.ok(restored.bindings.every((held) => held === null || typeof held === "string"));
    assert.ok(Array.isArray(restored.detached));
  }
});

test("stored settings naming the same workstream twice keep only the first", () => {
  assert.deepEqual(readSlots({ slots: ["checkout:/w/auth", "checkout:/w/auth", null] }).bindings, [
    "checkout:/w/auth",
    null,
    null
  ]);
});

test("stored settings longer than the device are cut to its three slots", () => {
  assert.deepEqual(readSlots({ slots: ["a", "b", "c", "d", "e"] }).bindings, ["a", "b", "c"]);
});

test("a workstream cannot be both held and detached, however the settings were written", () => {
  const restored = readSlots({ slots: ["checkout:/w/auth", null, null], detached: ["checkout:/w/auth"] });
  assert.deepEqual(restored.bindings, ["checkout:/w/auth", null, null]);
  assert.deepEqual(restored.detached, [], "holding a channel wins over being detached");
});
