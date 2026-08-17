import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_PROJECT_KEY_PATTERN,
  buildReportArgs,
  deriveTicketKeys,
  ensureCommitHookInstalled,
  extractTicketKeys,
  loadConfig,
  resolveBaseRef,
  run
} from "./herdr-tickets.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A throwaway repo with a base branch, an optional feature branch checked out, and commits on each. */
function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), "herdr-tickets-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "seed"]);
  return dir;
}

function checkoutFeatureBranch(dir, branch) {
  git(dir, ["checkout", "-q", "-b", branch]);
}

function commit(dir, filename, message) {
  writeFileSync(join(dir, filename), "x\n");
  git(dir, ["add", filename]);
  git(dir, ["commit", "-q", "-m", message]);
}

test("extractTicketKeys pulls every match, deduplicated, in first-seen order", () => {
  const text = "ABC-12 fixes bug\nrelated to ABC-12 and DEF-7\nalso XYZ99 is not a key";
  assert.deepEqual(extractTicketKeys(text), ["ABC-12", "DEF-7"]);
});

test("extractTicketKeys respects a configured pattern instead of the default", () => {
  const text = "PROJ-1 and proj-2 and PROJ-3";
  assert.deepEqual(extractTicketKeys(text, "PROJ-\\d+"), ["PROJ-1", "PROJ-3"]);
});

test("extractTicketKeys finds nothing in text with no keys, cleanly", () => {
  assert.deepEqual(extractTicketKeys("just a plain message"), []);
});

test("deriveTicketKeys seeds from the branch name when there are no commits yet", () => {
  const keys = deriveTicketKeys({ branch: "feature/ABC-42-do-the-thing", commitSubjects: [], hasCommits: false });
  assert.deepEqual(keys, ["ABC-42"]);
});

test("deriveTicketKeys uses the commit range once commits exist, not the branch", () => {
  const keys = deriveTicketKeys({
    branch: "feature/ABC-1-old-name",
    commitSubjects: ["DEF-2: did a thing", "also touches DEF-3"],
    hasCommits: true
  });
  assert.deepEqual(keys, ["DEF-2", "DEF-3"]);
});

test("deriveTicketKeys yields an empty list, not the branch's, when commits exist but name no tickets", () => {
  const keys = deriveTicketKeys({
    branch: "feature/ABC-1-old-name",
    commitSubjects: ["fix typo", "tidy up"],
    hasCommits: true
  });
  assert.deepEqual(keys, []);
});

test("deriveTicketKeys handles a branch with no ticket key at all as an empty list", () => {
  assert.deepEqual(deriveTicketKeys({ branch: "chore/cleanup", commitSubjects: [], hasCommits: false }), []);
});

test("loadConfig defaults when no config directory is given", () => {
  assert.deepEqual(loadConfig(undefined), { projectKeyPattern: DEFAULT_PROJECT_KEY_PATTERN, baseRefs: {} });
});

test("loadConfig defaults when tickets.json does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-tickets-config-"));
  assert.deepEqual(loadConfig(dir), { projectKeyPattern: DEFAULT_PROJECT_KEY_PATTERN, baseRefs: {} });
});

test("loadConfig reads a configured pattern and base refs", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-tickets-config-"));
  writeFileSync(
    join(dir, "tickets.json"),
    JSON.stringify({ projectKeyPattern: "PROJ-\\d+", baseRefs: { myrepo: "origin/develop" } })
  );
  assert.deepEqual(loadConfig(dir), { projectKeyPattern: "PROJ-\\d+", baseRefs: { myrepo: "origin/develop" } });
});

test("loadConfig falls back to defaults rather than throwing on invalid JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-tickets-config-"));
  writeFileSync(join(dir, "tickets.json"), "{ not json");
  assert.deepEqual(loadConfig(dir), { projectKeyPattern: DEFAULT_PROJECT_KEY_PATTERN, baseRefs: {} });
});

test("resolveBaseRef prefers an explicit configured base ref over inference", () => {
  const dir = scratchRepo();
  const base = resolveBaseRef({ cwd: dir, repoKey: "myrepo", config: { baseRefs: { myrepo: "does-not-need-to-exist" } } });
  assert.equal(base, "does-not-need-to-exist");
});

test("resolveBaseRef takes a worktree-creation base ref over inference", () => {
  const dir = scratchRepo();
  const base = resolveBaseRef({ cwd: dir, repoKey: "myrepo", config: { baseRefs: {} }, worktreeBaseRef: "does-not-need-to-exist" });
  assert.equal(base, "does-not-need-to-exist");
});

test("resolveBaseRef still prefers an explicit config entry over a worktree-creation base ref", () => {
  const dir = scratchRepo();
  const base = resolveBaseRef({
    cwd: dir,
    repoKey: "myrepo",
    config: { baseRefs: { myrepo: "configured-wins" } },
    worktreeBaseRef: "from-worktree-creation"
  });
  assert.equal(base, "configured-wins");
});

test("resolveBaseRef infers a common branch name when nothing is configured", () => {
  const dir = scratchRepo();
  const base = resolveBaseRef({ cwd: dir, repoKey: "myrepo", config: { baseRefs: {} } });
  assert.equal(base, "main");
});

test("resolveBaseRef gives up cleanly when nothing configured or inferable exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-tickets-empty-"));
  git(dir, ["init", "-q"]);
  const base = resolveBaseRef({ cwd: dir, repoKey: undefined, config: { baseRefs: {} } });
  assert.equal(base, undefined);
});

test("buildReportArgs publishes a comma-joined token for a non-empty list, with a ttl", () => {
  const args = buildReportArgs({ workspaceId: "w1", ticketKeys: ["ABC-1", "ABC-2"], seq: 42 });
  assert.deepEqual(args, [
    "workspace",
    "report-metadata",
    "w1",
    "--source",
    "herdr-plugin-tickets",
    "--seq",
    "42",
    "--ttl-ms",
    "86400000",
    "--token",
    "sd_tickets=ABC-1,ABC-2"
  ]);
});

test("buildReportArgs publishes an empty value for an empty list, never clearing", () => {
  // -wl7 needs "asked, and there are none" distinguishable from "never asked
  // at all" (or expired past the ttl above) — both of which read as the
  // token being entirely absent, not as an empty string.
  const args = buildReportArgs({ workspaceId: "w1", ticketKeys: [], seq: 42 });
  assert.deepEqual(args, [
    "workspace",
    "report-metadata",
    "w1",
    "--source",
    "herdr-plugin-tickets",
    "--seq",
    "42",
    "--ttl-ms",
    "86400000",
    "--token",
    "sd_tickets="
  ]);
});

test("ensureCommitHookInstalled writes a fresh post-commit hook that calls back into this script", () => {
  const dir = scratchRepo();
  const scriptPath = "/fake/path/to/herdr-tickets.mjs";
  const result = ensureCommitHookInstalled(dir, scriptPath);
  assert.equal(result.installed, true);
  const content = readFileSync(result.hookPath, "utf8");
  assert.match(content, /node .*herdr-tickets\.mjs.* commit/);
});

test("ensureCommitHookInstalled is idempotent: a second call changes nothing", () => {
  const dir = scratchRepo();
  const scriptPath = "/fake/path/to/herdr-tickets.mjs";
  const first = ensureCommitHookInstalled(dir, scriptPath);
  const before = readFileSync(first.hookPath, "utf8");
  const second = ensureCommitHookInstalled(dir, scriptPath);
  assert.equal(second.installed, false);
  assert.equal(readFileSync(first.hookPath, "utf8"), before);
});

test("ensureCommitHookInstalled keeps an existing hook from something else and appends alongside it", () => {
  const dir = scratchRepo();
  const hooksDir = git(dir, ["rev-parse", "--git-path", "hooks"]);
  const absoluteHooksDir = hooksDir.startsWith("/") ? hooksDir : join(dir, hooksDir);
  mkdirSync(absoluteHooksDir, { recursive: true });
  const hookPath = join(absoluteHooksDir, "post-commit");
  writeFileSync(hookPath, "#!/bin/sh\necho already here\n");

  ensureCommitHookInstalled(dir, "/fake/path/to/herdr-tickets.mjs");
  const content = readFileSync(hookPath, "utf8");
  assert.match(content, /echo already here/);
  assert.match(content, /herdr-tickets\.mjs.* commit/);
});

test("run publishes the branch-seeded list for a fresh workstream with no commits ahead of base", () => {
  const dir = scratchRepo();
  checkoutFeatureBranch(dir, "feature/ABC-9-do-thing");
  const calls = [];
  const result = run({
    env: { HERDR_WORKSPACE_ID: "w1" },
    cwd: dir,
    installHook: false,
    herdrBin: "herdr",
    report: (...args) => calls.push(args)
  });
  assert.equal(result.ran, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(result.ticketKeys, ["ABC-9"]);
  const [command, args] = calls[0];
  assert.equal(command, "herdr");
  const seqIndex = args.indexOf("--seq") + 1;
  assert.ok(Number(args[seqIndex]) > 0, "seq must be a positive number");
  assert.deepEqual(
    [...args.slice(0, seqIndex - 1), ...args.slice(seqIndex + 1)],
    ["workspace", "report-metadata", "w1", "--source", "herdr-plugin-tickets", "--ttl-ms", "86400000", "--token", "sd_tickets=ABC-9"]
  );
});

test("run publishes commit-derived keys once commits land, superseding the branch guess", () => {
  const dir = scratchRepo();
  checkoutFeatureBranch(dir, "feature/ABC-9-do-thing");
  commit(dir, "a.txt", "DEF-1: implements the thing");
  const calls = [];
  const result = run({
    env: { HERDR_WORKSPACE_ID: "w1" },
    cwd: dir,
    installHook: false,
    report: (...args) => calls.push(args)
  });
  assert.deepEqual(result.ticketKeys, ["DEF-1"]);
});

test("run does nothing outside a Herdr workspace", () => {
  const dir = scratchRepo();
  const calls = [];
  const result = run({ env: {}, cwd: dir, installHook: false, report: (...args) => calls.push(args) });
  assert.equal(result.ran, false);
  assert.deepEqual(calls, []);
});

test("run installs the commit hook only when asked to", () => {
  const dir = scratchRepo();
  const calls = [];
  run({ env: { HERDR_WORKSPACE_ID: "w1" }, cwd: dir, installHook: true, report: (...args) => calls.push(args) });
  const hooksDir = git(dir, ["rev-parse", "--git-path", "hooks"]);
  const absoluteHooksDir = hooksDir.startsWith("/") ? hooksDir : join(dir, hooksDir);
  assert.equal(existsSync(join(absoluteHooksDir, "post-commit")), true);
});

test("run reads the project key pattern and base ref from a config directory", () => {
  const dir = scratchRepo();
  checkoutFeatureBranch(dir, "feature/branch");
  commit(dir, "a.txt", "touches PROJ-5 only");
  const configDir = mkdtempSync(join(tmpdir(), "herdr-tickets-config-"));
  writeFileSync(join(configDir, "tickets.json"), JSON.stringify({ projectKeyPattern: "PROJ-\\d+" }));
  const calls = [];
  const result = run({
    env: { HERDR_WORKSPACE_ID: "w1", HERDR_PLUGIN_CONFIG_DIR: configDir },
    cwd: dir,
    installHook: false,
    report: (...args) => calls.push(args)
  });
  assert.deepEqual(result.ticketKeys, ["PROJ-5"]);
});
