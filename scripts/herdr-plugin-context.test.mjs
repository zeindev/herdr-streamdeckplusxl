import assert from "node:assert/strict";
import test from "node:test";

import { parseContext, worktreeFrom } from "./herdr-plugin-context.mjs";

test("parseContext parses well-formed JSON", () => {
  assert.deepEqual(parseContext('{"worktree":{"branch":"main"}}'), { worktree: { branch: "main" } });
});

test("parseContext returns {} for missing or malformed input, never throws", () => {
  assert.deepEqual(parseContext(undefined), {});
  assert.deepEqual(parseContext(""), {});
  assert.deepEqual(parseContext("not json"), {});
});

test("worktreeFrom returns the worktree block, or {} when there is none", () => {
  assert.deepEqual(worktreeFrom({ worktree: { branch: "main" } }), { branch: "main" });
  assert.deepEqual(worktreeFrom({}), {});
});
