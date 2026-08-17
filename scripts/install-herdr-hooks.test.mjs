import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { desiredHooks, install, withHooksInstalled } from "./install-herdr-hooks.mjs";

const SCRIPT_PATH = "/fake/path/to/herdr-attention";

function scratchTarget() {
  const directory = mkdtempSync(join(tmpdir(), "herdr-hooks-install-"));
  return join(directory, "settings.json");
}

test("what this installer wants: one command per event, built from the given script path", () => {
  const hooks = desiredHooks(SCRIPT_PATH);
  assert.deepEqual(hooks, [
    { event: "Notification", command: `${SCRIPT_PATH} notification` },
    { event: "PermissionRequest", command: `${SCRIPT_PATH} approval` },
    { event: "Stop", command: `${SCRIPT_PATH} finished` },
    { event: "SessionStart", command: `${SCRIPT_PATH} clear` },
    { event: "UserPromptSubmit", command: `${SCRIPT_PATH} clear` },
    { event: "PreToolUse", command: `${SCRIPT_PATH} clear` }
  ]);
});

test("installing into nothing adds every event and touches nothing else", () => {
  const { settings, added } = withHooksInstalled({}, SCRIPT_PATH);
  assert.deepEqual(added.sort(), ["Notification", "PermissionRequest", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
  for (const { event, command } of desiredHooks(SCRIPT_PATH)) {
    assert.deepEqual(settings.hooks[event], [{ hooks: [{ type: "command", command }] }]);
  }
});

test("running twice adds nothing the second time", () => {
  const once = withHooksInstalled({}, SCRIPT_PATH);
  const twice = withHooksInstalled(once.settings, SCRIPT_PATH);
  assert.deepEqual(twice.added, []);
  assert.deepEqual(twice.settings, once.settings);
});

test("an existing hook for the same event, from something else, is kept alongside ours", () => {
  const before = {
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "/some/other/tool --lint" }] }] }
  };
  const { settings, added } = withHooksInstalled(before, SCRIPT_PATH);
  assert.deepEqual(added.sort(), ["Notification", "PermissionRequest", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
  assert.deepEqual(settings.hooks.PreToolUse, [
    { hooks: [{ type: "command", command: "/some/other/tool --lint" }] },
    { hooks: [{ type: "command", command: `${SCRIPT_PATH} clear` }] }
  ]);
});

test("everything outside `hooks`, and every other key inside it, survives untouched", () => {
  const before = {
    permissions: { defaultMode: "auto" },
    statusLine: { type: "command", command: "bash ~/.claude/statusline-command.sh" },
    hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "/some/other/tool --format" }] }] }
  };
  const { settings } = withHooksInstalled(before, SCRIPT_PATH);
  assert.deepEqual(settings.permissions, before.permissions);
  assert.deepEqual(settings.statusLine, before.statusLine);
  assert.deepEqual(settings.hooks.PostToolUse, before.hooks.PostToolUse);
});

test("installing to a target that does not exist yet creates it, with no backup", () => {
  const target = scratchTarget();
  assert.equal(existsSync(target), false);
  const result = install({ target, scriptPath: SCRIPT_PATH });
  assert.equal(result.wrote, true);
  assert.equal(result.backup, null);
  const written = JSON.parse(readFileSync(target, "utf8"));
  assert.deepEqual(Object.keys(written.hooks).sort(), ["Notification", "PermissionRequest", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
});

test("running against an already-installed target changes nothing and backs up nothing", () => {
  const target = scratchTarget();
  install({ target, scriptPath: SCRIPT_PATH });
  const before = readFileSync(target, "utf8");
  const second = install({ target, scriptPath: SCRIPT_PATH });
  assert.deepEqual(second.added, []);
  assert.equal(second.wrote, false);
  assert.equal(second.backup, null);
  assert.equal(readFileSync(target, "utf8"), before, "the file must not even be rewritten byte for byte");
});

test("a real change to an existing file is backed up first, byte for byte", () => {
  const target = scratchTarget();
  const original = JSON.stringify({ hooks: { Notification: [{ hooks: [{ type: "command", command: "/other/thing" }] }] } }, null, 2);
  writeFileSync(target, original);

  const result = install({ target, scriptPath: SCRIPT_PATH });
  assert.equal(result.wrote, true);
  assert.ok(result.backup, "a change to an existing file must be backed up");
  assert.equal(readFileSync(result.backup, "utf8"), original);
  // The pre-existing Notification hook survives alongside ours.
  const written = JSON.parse(readFileSync(target, "utf8"));
  assert.deepEqual(written.hooks.Notification, [
    { hooks: [{ type: "command", command: "/other/thing" }] },
    { hooks: [{ type: "command", command: `${SCRIPT_PATH} notification` }] }
  ]);
});

test("dry-run reports what would change and writes nothing at all", () => {
  const target = scratchTarget();
  const result = install({ target, scriptPath: SCRIPT_PATH, dryRun: true });
  assert.deepEqual(result.added.sort(), ["Notification", "PermissionRequest", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
  assert.equal(result.wrote, false);
  assert.equal(existsSync(target), false, "a dry run must not create the file");
});

test("dry-run against an already-installed target reports nothing to do", () => {
  const target = scratchTarget();
  install({ target, scriptPath: SCRIPT_PATH });
  const result = install({ target, scriptPath: SCRIPT_PATH, dryRun: true });
  assert.deepEqual(result.added, []);
  assert.equal(result.wrote, false);
});

test("a settings file that is not valid JSON is left untouched, and the error says so", () => {
  const target = scratchTarget();
  writeFileSync(target, "{ this is not json");
  assert.throws(() => install({ target, scriptPath: SCRIPT_PATH }), /not valid JSON/);
  assert.equal(readFileSync(target, "utf8"), "{ this is not json", "the broken file must be left exactly as found");
  assert.equal(existsSync(`${target}.bak`), false);
});

test("the script it points at is made executable as a side effect of installing", () => {
  const target = scratchTarget();
  const directory = mkdtempSync(join(tmpdir(), "herdr-hooks-script-"));
  const scriptPath = join(directory, "herdr-attention");
  writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n", { mode: 0o644 });

  install({ target, scriptPath });
  const mode = statSync(scriptPath).mode & 0o777;
  assert.equal(mode, 0o755);
});
