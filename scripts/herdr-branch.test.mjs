import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildReportArgs, currentBranch, ensureCheckoutHookInstalled, run } from "./herdr-branch.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A throwaway repo on its default branch, with one commit so `HEAD` resolves. */
function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), "herdr-branch-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "seed"]);
  return dir;
}

test("currentBranch reports the branch actually checked out", () => {
  const dir = scratchRepo();
  assert.equal(currentBranch(dir), "main");

  git(dir, ["checkout", "-q", "-b", "feature/x"]);
  assert.equal(currentBranch(dir), "feature/x");
});

test("currentBranch answers empty for a detached HEAD, never the literal \"HEAD\"", () => {
  const dir = scratchRepo();
  const sha = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "-q", sha]);
  assert.equal(currentBranch(dir), "");
});

test("buildReportArgs publishes the branch, including empty for detached HEAD", () => {
  const args = buildReportArgs({ workspaceId: "w1", branch: "feature/x", seq: 42 });
  assert.deepEqual(args, [
    "workspace",
    "report-metadata",
    "w1",
    "--source",
    "herdr-plugin-branch",
    "--seq",
    "42",
    "--ttl-ms",
    "86400000",
    "--token",
    "sd_branch=feature/x"
  ]);

  const detached = buildReportArgs({ workspaceId: "w1", branch: "", seq: 42 });
  assert.deepEqual(
    detached.slice(-2),
    ["--token", "sd_branch="],
    "an empty value still publishes — never asked and detached must read differently on the device"
  );
});

test("ensureCheckoutHookInstalled writes a fresh post-checkout hook that calls back into this script, forwarding git's own branch-checkout flag", () => {
  const dir = scratchRepo();
  const scriptPath = "/fake/path/to/herdr-branch.mjs";
  const result = ensureCheckoutHookInstalled(dir, scriptPath);
  assert.equal(result.installed, true);
  const content = readFileSync(result.hookPath, "utf8");
  assert.match(content, /node .*herdr-branch\.mjs.* checkout "\$3"/);
});

test("ensureCheckoutHookInstalled is idempotent: a second call changes nothing", () => {
  const dir = scratchRepo();
  const scriptPath = "/fake/path/to/herdr-branch.mjs";
  const first = ensureCheckoutHookInstalled(dir, scriptPath);
  const before = readFileSync(first.hookPath, "utf8");
  const second = ensureCheckoutHookInstalled(dir, scriptPath);
  assert.equal(second.installed, false);
  assert.equal(readFileSync(first.hookPath, "utf8"), before);
});

test("ensureCheckoutHookInstalled keeps an existing hook from something else and appends alongside it", () => {
  const dir = scratchRepo();
  const hooksDir = git(dir, ["rev-parse", "--git-path", "hooks"]);
  const absoluteHooksDir = hooksDir.startsWith("/") ? hooksDir : join(dir, hooksDir);
  mkdirSync(absoluteHooksDir, { recursive: true });
  const hookPath = join(absoluteHooksDir, "post-checkout");
  writeFileSync(hookPath, "#!/bin/sh\necho already here\n");

  ensureCheckoutHookInstalled(dir, "/fake/path/to/herdr-branch.mjs");
  const content = readFileSync(hookPath, "utf8");
  assert.match(content, /echo already here/);
  assert.match(content, /herdr-branch\.mjs.* checkout/);
});

test("run publishes whatever branch is actually checked out", () => {
  const dir = scratchRepo();
  git(dir, ["checkout", "-q", "-b", "feature/y"]);
  const calls = [];
  const result = run({
    env: { HERDR_WORKSPACE_ID: "w1" },
    cwd: dir,
    installHook: false,
    herdrBin: "herdr",
    report: (...args) => calls.push(args)
  });
  assert.equal(result.ran, true);
  assert.equal(result.branch, "feature/y");
  assert.equal(calls.length, 1);
  const [command, args] = calls[0];
  assert.equal(command, "herdr");
  const seqIndex = args.indexOf("--seq") + 1;
  assert.ok(Number(args[seqIndex]) > 0, "seq must be a positive number");
  assert.deepEqual(
    [...args.slice(0, seqIndex - 1), ...args.slice(seqIndex + 1)],
    ["workspace", "report-metadata", "w1", "--source", "herdr-plugin-branch", "--ttl-ms", "86400000", "--token", "sd_branch=feature/y"]
  );
});

test("run does nothing outside a Herdr workspace", () => {
  const dir = scratchRepo();
  const calls = [];
  const result = run({ env: {}, cwd: dir, installHook: false, report: (...args) => calls.push(args) });
  assert.equal(result.ran, false);
  assert.deepEqual(calls, []);
});

test("run installs the checkout hook only when asked to", () => {
  const dir = scratchRepo();
  run({ env: { HERDR_WORKSPACE_ID: "w1" }, cwd: dir, installHook: true, report: () => {} });
  const hooksDir = git(dir, ["rev-parse", "--git-path", "hooks"]);
  const absoluteHooksDir = hooksDir.startsWith("/") ? hooksDir : join(dir, hooksDir);
  assert.ok(existsSync(join(absoluteHooksDir, "post-checkout")));

  const dirWithout = scratchRepo();
  run({ env: { HERDR_WORKSPACE_ID: "w1" }, cwd: dirWithout, installHook: false, report: () => {} });
  const hooksDirWithout = git(dirWithout, ["rev-parse", "--git-path", "hooks"]);
  const absoluteHooksDirWithout = hooksDirWithout.startsWith("/") ? hooksDirWithout : join(dirWithout, hooksDirWithout);
  assert.ok(!existsSync(join(absoluteHooksDirWithout, "post-checkout")));
});
