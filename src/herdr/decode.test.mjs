import assert from "node:assert/strict";
import test from "node:test";

import { NdjsonDecoder, decodeMessage } from "../../.preview/herdr/decode.js";
import {
  EVENT_KINDS,
  GLOBAL_SUBSCRIPTIONS,
  SUBSCRIPTION_EVENT_KINDS,
  isEventKind
} from "../../.preview/herdr/protocol.js";

test("the decoder reassembles lines split across arbitrary chunk boundaries", () => {
  const decoder = new NdjsonDecoder();
  assert.deepEqual(decoder.push('{"a":1}\n{"b'), ['{"a":1}']);
  assert.deepEqual(decoder.push('":2}\n'), ['{"b":2}']);
  assert.deepEqual(decoder.push(""), []);
});

test("the decoder emits several lines arriving in one chunk, and holds a partial line", () => {
  const decoder = new NdjsonDecoder();
  assert.deepEqual(decoder.push('{"a":1}\n{"b":2}\n{"c'), ['{"a":1}', '{"b":2}']);
  assert.equal(decoder.pending, '{"c');
  assert.deepEqual(decoder.push('":3}\n'), ['{"c":3}']);
  assert.equal(decoder.pending, "");
});

test("the decoder skips blank lines and survives a reset mid-line", () => {
  const decoder = new NdjsonDecoder();
  assert.deepEqual(decoder.push('\n\n{"a":1}\n\n'), ['{"a":1}']);
  decoder.push('{"partial"');
  decoder.reset();
  assert.equal(decoder.pending, "");
  assert.deepEqual(decoder.push('{"a":2}\n'), ['{"a":2}']);
});

test("a pushed event decodes as an event, with its kind preserved", () => {
  const message = decodeMessage(
    JSON.stringify({ event: "pane_updated", data: { type: "pane_updated", pane: { pane_id: "w1:p1" } } })
  );
  assert.equal(message.kind, "event");
  assert.equal(message.event, "pane_updated");
  assert.equal(message.data.type, "pane_updated");
});

test("a successful reply decodes as an ok reply carrying its id", () => {
  const message = decodeMessage(JSON.stringify({ id: "sub", result: { type: "subscription_started" } }));
  assert.equal(message.kind, "reply");
  assert.equal(message.ok, true);
  assert.equal(message.id, "sub");
  assert.deepEqual(message.result, { type: "subscription_started" });
});

test("an error reply decodes as a failed reply and keeps code and message", () => {
  const message = decodeMessage(
    JSON.stringify({ id: "", error: { code: "invalid_request", message: "missing field `pane_id`" } })
  );
  assert.equal(message.kind, "reply");
  assert.equal(message.ok, false);
  assert.equal(message.id, "");
  assert.equal(message.error.code, "invalid_request");
});

test("malformed and unrecognised lines decode as unknown rather than throwing", () => {
  assert.equal(decodeMessage("not json at all").kind, "unknown");
  assert.equal(decodeMessage("[1,2,3]").kind, "unknown");
  assert.equal(decodeMessage(JSON.stringify({ event: "no_such_event", data: {} })).kind, "unknown");
  assert.equal(decodeMessage(JSON.stringify({ nothing: true })).kind, "unknown");
});

test("per-pane subscription events use a different envelope and are reported as unknown", () => {
  // Their `event` is dot-named and their `data` carries no `type`, so they are
  // not the 26-kind event stream. Nothing subscribes per-pane today; this locks
  // in what would happen if something did, so the shape difference cannot bite
  // silently later.
  for (const kind of SUBSCRIPTION_EVENT_KINDS) {
    const message = decodeMessage(JSON.stringify({ event: kind, data: { pane_id: "w1:p1" } }));
    assert.equal(message.kind, "unknown", `${kind} is not an ordinary event`);
    assert.ok(!isEventKind(kind));
  }
});

test("the event vocabulary is complete and distinct from the subscription vocabulary", () => {
  assert.equal(EVENT_KINDS.length, 26);
  assert.equal(new Set(EVENT_KINDS).size, 26);
  assert.ok(EVENT_KINDS.every((kind) => !kind.includes(".")));
  assert.equal(GLOBAL_SUBSCRIPTIONS.length, 24);
  assert.ok(GLOBAL_SUBSCRIPTIONS.every((name) => name.includes(".")));
  // Every argument-free subscription must be requestable without a pane_id.
  assert.ok(!GLOBAL_SUBSCRIPTIONS.includes("pane.agent_status_changed"));
  assert.ok(!GLOBAL_SUBSCRIPTIONS.includes("pane.scroll_changed"));
  assert.ok(!GLOBAL_SUBSCRIPTIONS.includes("pane.output_matched"));
  assert.ok(isEventKind("pane_agent_status_changed"));
  assert.ok(!isEventKind("pane.agent_status_changed"));
});
