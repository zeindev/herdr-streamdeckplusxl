import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { decodeMessage } from "./decode.ts";
import { isEventKind } from "./protocol.ts";

/**
 * Real traffic recorded from a running Herdr by `scripts/capture-events.mjs`.
 * Its job is to fail when Herdr's contract drifts — something hand-written
 * sample payloads could never do.
 */
const fixture = JSON.parse(readFileSync(new URL("./fixtures/session.json", import.meta.url), "utf8"));

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

test("the capture covers the events this product depends on", () => {
  const kinds = new Set(fixture.events.map((event) => event.event));
  for (const required of ["pane_updated", "pane_created", "tab_created", "workspace_created", "worktree_created"]) {
    assert.ok(kinds.has(required), `expected ${required} in the capture`);
  }
});

test("a pane payload carries the fields the workstream model is built on", () => {
  const pane = fixture.events.find((event) => event.event === "pane_updated").data.pane;
  for (const field of ["pane_id", "terminal_id", "workspace_id", "tab_id", "focused", "agent_status", "revision"]) {
    assert.ok(field in pane, `pane_updated must carry ${field}`);
  }
  assert.ok(["idle", "working", "blocked", "done", "unknown"].includes(pane.agent_status));
});

test("pane_updated dominates the capture, which is why consumers must coalesce", () => {
  // Recorded behaviour, not a preference: pane_updated fires on every output
  // revision. A consumer that redraws per event would redraw dozens of times a
  // second, so coalescing is a requirement of anything built on this client.
  const total = fixture.events.length;
  const paneUpdates = fixture.events.filter((event) => event.event === "pane_updated").length;
  assert.ok(paneUpdates > 0);
  assert.ok(total > paneUpdates, "the capture is capped per kind so other events survive");
});
