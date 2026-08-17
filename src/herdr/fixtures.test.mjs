import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { decodeMessage } from "../../.preview/herdr/decode.js";
import { EVENT_KINDS, isEventKind } from "../../.preview/herdr/protocol.js";

/**
 * Real traffic recorded from a running Herdr by `scripts/capture-events.mjs`.
 * Its job is to fail when Herdr's contract drifts — something hand-written
 * sample payloads could never do.
 */
const fixture = JSON.parse(readFileSync(new URL("./fixtures/capture.json", import.meta.url), "utf8"));
const capturedKinds = new Set(fixture.events.map((event) => event.event));

/**
 * Event kinds the capture does not contain, each with the reason. Anything
 * building on this fixture must know which payload shapes are still unproven
 * rather than assuming full coverage.
 */
const UNCAPTURED = {
  // Unreachable on this subscription set. See GLOBAL_SUBSCRIPTIONS.
  pane_output_changed: "no subscription of any kind exists",
  pane_agent_status_changed: "only offered as a per-pane subscription",
  // Simply not provoked by the capture run yet.
  workspace_updated: "not provoked",
  workspace_moved: "needs a reorder gesture",
  workspace_reordered: "needs a reorder gesture",
  worktree_opened: "not provoked",
  tab_moved: "needs a move gesture",
  pane_closed: "not provoked",
  pane_moved: "needs a move gesture",
  pane_agent_detected: "needs an agent to start inside a captured pane"
};

test("every captured event decodes as a recognised event", () => {
  assert.ok(fixture.events.length > 0, "the fixture must not be empty");
  for (const { at, ...event } of fixture.events) {
    assert.ok(typeof at === "number", "each capture records when it arrived");
    const message = decodeMessage(JSON.stringify(event));
    assert.equal(message.kind, "event", `${event.event} should decode as an event`);
    assert.ok(isEventKind(message.event));
    assert.equal(message.data.type, message.event, "the envelope kind and payload type must agree");
  }
});

test("the capture covers the events the workstream model is built on", () => {
  for (const required of [
    "workspace_created",
    "workspace_renamed",
    "workspace_closed",
    "worktree_created",
    "worktree_removed",
    "pane_created",
    "pane_updated",
    "pane_focused",
    "pane_exited",
    "tab_created",
    "tab_closed",
    "layout_updated",
    "workspace_metadata_updated"
  ]) {
    assert.ok(capturedKinds.has(required), `expected ${required} in the capture`);
  }
});

test("a workspace token is pushed live, which is what a dead service can be declared on", () => {
  // Recorded against a running Herdr, because the whole crashed-service signal
  // rests on it. -3rd found workspace_updated is never emitted, so if setting a
  // token were silent too the plugin could never learn a service had died. It is
  // not silent: workspace_metadata_updated carries the whole workspace, tokens
  // included, and clearing a token pushes again with the field simply absent.
  const updates = fixture.events
    .filter((event) => event.event === "workspace_metadata_updated")
    .map((event) => event.data.workspace);

  const set = updates.find((workspace) => workspace.tokens);
  assert.ok(set, "one push must carry tokens");
  assert.equal(set.tokens.sd_exit_dev, "1", "the value is the exit status, as a string");

  const cleared = updates.find((workspace) => !workspace.tokens);
  assert.ok(cleared, "clearing a token pushes too, or a resolved exit would never leave");
  assert.equal("tokens" in cleared, false, "a cleared token is an absent field, not an empty object");
});

test("uncaptured event kinds are accounted for, so coverage gaps stay visible", () => {
  const unexplained = EVENT_KINDS.filter((kind) => !capturedKinds.has(kind) && !(kind in UNCAPTURED));
  assert.deepEqual(unexplained, [], "a newly missing event kind needs a reason recorded here");

  const nowCaptured = Object.keys(UNCAPTURED).filter((kind) => capturedKinds.has(kind));
  assert.deepEqual(nowCaptured, [], "a kind that is now captured should be dropped from UNCAPTURED");
});

test("a pane payload carries the fields the workstream model is built on", () => {
  const pane = fixture.events.find((event) => event.event === "pane_updated").data.pane;
  for (const field of ["pane_id", "terminal_id", "workspace_id", "tab_id", "focused", "agent_status", "revision"]) {
    assert.ok(field in pane, `pane_updated must carry ${field}`);
  }
  assert.ok(["idle", "working", "blocked", "done", "unknown"].includes(pane.agent_status));
});

test("pane_exited identifies its pane but carries no exit status", () => {
  // Recorded so the attention design cannot assume otherwise: Herdr 0.8.0 sends
  // only pane_id, workspace_id, and type. There is no exit code, so a crashed
  // service is indistinguishable from a pane closed on purpose using this event
  // alone. ADR-0005's native floor is narrowed accordingly.
  const exited = fixture.events.find((event) => event.event === "pane_exited").data;
  assert.deepEqual(Object.keys(exited).sort(), ["pane_id", "type", "workspace_id"]);
});

test("pane_updated dominates the capture, which is why consumers must coalesce", () => {
  // Recorded behaviour, not a preference: pane_updated fires on every output
  // revision, arriving hundreds of times over a short run. A consumer that
  // redrew per event would redraw dozens of times a second, so coalescing is a
  // requirement of anything built on this client. The capture is capped per
  // kind, so the live ratio is far more extreme than what is stored here.
  const paneUpdates = fixture.events.filter((event) => event.event === "pane_updated").length;
  assert.ok(paneUpdates > 0);
  assert.ok(fixture.events.length > paneUpdates, "the per-kind cap lets other events survive");
});

test("a workspace token survives the leg the reducer actually reads", () => {
  // The test above proves the pushed event carries tokens, and the reducer never
  // looks at it: a metadata change is structural, so it re-reads the snapshot and
  // discards the payload. Recorded from a real `session.snapshot` so the leg the
  // code depends on is the leg the fixture pins.
  const workspace = fixture.snapshotWorkspaceWithTokens;
  assert.ok(workspace, "the fixture must carry a snapshot workspace with tokens");
  assert.equal(typeof workspace.workspace_id, "string");
  assert.equal(workspace.tokens.sd_exit_dev, `1 ${workspace.workspace_id}:p1`);

  // The value's shape is the contract between the wrapper and the reader: the
  // exit status, then the pane it ran in.
  const [status, paneId] = workspace.tokens.sd_exit_dev.split(/\s+/);
  assert.equal(status, "1");
  assert.ok(paneId.startsWith(workspace.workspace_id), "the pane belongs to the workspace that declared it");
});

test("the fixture says where its later additions came from", () => {
  // The capture script writes `capturedAt` and `events` and nothing else, so two
  // events and a snapshot workspace appearing without a word would look
  // hand-written. They were recorded live; this is the note saying so.
  assert.ok(fixture.appended, "anything added after the capture run must say so");
  assert.match(fixture.appended.by, /recorded live/);
  assert.ok(Array.isArray(fixture.appended.what) && fixture.appended.what.length > 0);
});
