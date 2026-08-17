import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_API_BASE_URL,
  DEFAULT_POLL_INTERVAL_MS,
  buildReportArgs,
  buildTokenValue,
  computeReviewState,
  ensurePollerRunning,
  findPullRequestForBranch,
  isProcessAlive,
  latestReviewStates,
  loadConfig,
  parseGitHubRemote,
  pollOnce,
  readPidFile,
  resolveAuthToken,
  runPollLoop,
  ttlForPollInterval,
  writePidFile
} from "./herdr-pr.mjs";

test("parseGitHubRemote reads owner and repo from the SSH form", () => {
  assert.deepEqual(parseGitHubRemote("git@github.com:acme/widgets.git"), { owner: "acme", repo: "widgets" });
});

test("parseGitHubRemote reads owner and repo from the HTTPS form, with or without .git", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/acme/widgets.git"), { owner: "acme", repo: "widgets" });
  assert.deepEqual(parseGitHubRemote("https://github.com/acme/widgets"), { owner: "acme", repo: "widgets" });
});

test("parseGitHubRemote reports undefined for a non-GitHub remote, or none at all", () => {
  assert.equal(parseGitHubRemote("git@gitlab.com:acme/widgets.git"), undefined);
  assert.equal(parseGitHubRemote(undefined), undefined);
  assert.equal(parseGitHubRemote(""), undefined);
});

test("loadConfig defaults when no config directory or file is given", () => {
  assert.deepEqual(loadConfig(undefined), {
    token: undefined,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    apiBaseUrl: DEFAULT_API_BASE_URL
  });
});

test("loadConfig reads a configured token, interval and API base", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-pr-config-"));
  writeFileSync(join(dir, "github.json"), JSON.stringify({ token: "ghp_x", pollIntervalMs: 60000, apiBaseUrl: "https://ghe.example.com/api/v3" }));
  assert.deepEqual(loadConfig(dir), { token: "ghp_x", pollIntervalMs: 60000, apiBaseUrl: "https://ghe.example.com/api/v3" });
});

test("loadConfig falls back to defaults rather than throwing on invalid JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-pr-config-"));
  writeFileSync(join(dir, "github.json"), "{ not json");
  assert.deepEqual(loadConfig(dir), { token: undefined, pollIntervalMs: DEFAULT_POLL_INTERVAL_MS, apiBaseUrl: DEFAULT_API_BASE_URL });
});

test("resolveAuthToken prefers configured token over either environment variable", () => {
  const token = resolveAuthToken({ GH_TOKEN: "from-env", GITHUB_TOKEN: "also-env" }, { token: "from-config" });
  assert.equal(token, "from-config");
});

test("resolveAuthToken falls back to GH_TOKEN, then GITHUB_TOKEN, then nothing", () => {
  assert.equal(resolveAuthToken({ GH_TOKEN: "gh", GITHUB_TOKEN: "gha" }, {}), "gh");
  assert.equal(resolveAuthToken({ GITHUB_TOKEN: "gha" }, {}), "gha");
  assert.equal(resolveAuthToken({}, {}), undefined);
});

test("latestReviewStates keeps only each reviewer's most recent verdict", () => {
  const reviews = [
    { user: { login: "alice" }, state: "CHANGES_REQUESTED" },
    { user: { login: "bob" }, state: "COMMENTED" },
    { user: { login: "alice" }, state: "APPROVED" }
  ];
  assert.deepEqual(latestReviewStates(reviews), ["APPROVED"]);
});

test("latestReviewStates ignores comments, dismissals and pending reviews entirely", () => {
  const reviews = [
    { user: { login: "alice" }, state: "COMMENTED" },
    { user: { login: "bob" }, state: "DISMISSED" },
    { user: { login: "carol" }, state: "PENDING" }
  ];
  assert.deepEqual(latestReviewStates(reviews), []);
});

test("computeReviewState reports merged for a merged pull request, regardless of reviews", () => {
  const state = computeReviewState({ pr: { state: "closed", merged_at: "2026-01-01T00:00:00Z" }, reviews: [], checkRuns: [] });
  assert.equal(state, "merged");
});

test("computeReviewState reports closed for a closed, unmerged pull request", () => {
  const state = computeReviewState({ pr: { state: "closed", merged_at: null }, reviews: [], checkRuns: [] });
  assert.equal(state, "closed");
});

test("computeReviewState reports open when nothing is outstanding", () => {
  const state = computeReviewState({ pr: { state: "open", merged_at: null }, reviews: [], checkRuns: [] });
  assert.equal(state, "open");
});

test("computeReviewState reports approved once a reviewer approves and nothing else is wrong", () => {
  const state = computeReviewState({
    pr: { state: "open", merged_at: null },
    reviews: [{ user: { login: "alice" }, state: "APPROVED" }],
    checkRuns: []
  });
  assert.equal(state, "approved");
});

test("computeReviewState reports changes_requested even over an approval from someone else", () => {
  const state = computeReviewState({
    pr: { state: "open", merged_at: null },
    reviews: [
      { user: { login: "alice" }, state: "APPROVED" },
      { user: { login: "bob" }, state: "CHANGES_REQUESTED" }
    ],
    checkRuns: []
  });
  assert.equal(state, "changes_requested");
});

test("computeReviewState reports checks_failing when a check run failed and nothing blocks harder", () => {
  const state = computeReviewState({
    pr: { state: "open", merged_at: null },
    reviews: [{ user: { login: "alice" }, state: "APPROVED" }],
    checkRuns: [{ conclusion: "failure" }]
  });
  assert.equal(state, "checks_failing");
});

test("computeReviewState treats a superseded change request as resolved", () => {
  const state = computeReviewState({
    pr: { state: "open", merged_at: null },
    reviews: [
      { user: { login: "alice" }, state: "CHANGES_REQUESTED" },
      { user: { login: "alice" }, state: "APPROVED" }
    ],
    checkRuns: []
  });
  assert.equal(state, "approved");
});

test("buildTokenValue joins the pull-request number and state", () => {
  assert.equal(buildTokenValue({ prNumber: 42, state: "approved" }), "42 approved");
});

test("buildReportArgs publishes a token for a known value, with a ttl", () => {
  assert.deepEqual(buildReportArgs({ workspaceId: "w1", value: "42 approved", seq: 7, ttlMs: 900000 }), [
    "workspace",
    "report-metadata",
    "w1",
    "--source",
    "herdr-plugin-github",
    "--seq",
    "7",
    "--ttl-ms",
    "900000",
    "--token",
    "sd_pr=42 approved"
  ]);
});

test("buildReportArgs publishes 'none' rather than clearing when there is no pull request", () => {
  // -wl7 needs "asked, and there is none yet" distinguishable from "never
  // asked" (or expired past the ttl) — both of which read as the token being
  // entirely absent, not as any particular value.
  assert.deepEqual(buildReportArgs({ workspaceId: "w1", value: "none", seq: 7, ttlMs: 900000 }), [
    "workspace",
    "report-metadata",
    "w1",
    "--source",
    "herdr-plugin-github",
    "--seq",
    "7",
    "--ttl-ms",
    "900000",
    "--token",
    "sd_pr=none"
  ]);
});

test("ttlForPollInterval is a documented multiple of the poll interval, capped at Herdr's own ttl ceiling", () => {
  assert.equal(ttlForPollInterval(300000), 900000);
  assert.equal(ttlForPollInterval(60000), 180000);
  assert.equal(ttlForPollInterval(20 * 60 * 60 * 1000), 24 * 60 * 60 * 1000, "never exceeds Herdr's 24h cap");
});

/** A fake `fetch` that answers from a table keyed by URL, recording every call it saw. */
function stubFetch(table) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const entry = table[url];
    if (!entry) throw new Error(`no stub for ${url}`);
    return { ok: entry.ok ?? true, status: entry.status ?? 200, json: async () => entry.body };
  };
  return { fetchImpl, calls };
}

function withGitRemote(remoteUrl) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-pr-repo-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "seed\n");
  spawnSync("git", ["add", "README.md"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  spawnSync("git", ["remote", "add", "origin", remoteUrl], { cwd: dir });
  return dir;
}

test("pollOnce reports unknown no-auth when no token is configured or available", async () => {
  const dir = withGitRemote("git@github.com:acme/widgets.git");
  const calls = [];
  const result = await pollOnce({
    env: { HERDR_WORKSPACE_ID: "w1" },
    cwd: dir,
    report: (...args) => calls.push(args)
  });
  assert.deepEqual(result, { ran: true, state: "unknown", reason: "no-auth" });
  const args = calls[0][1];
  assert.deepEqual(args.slice(0, 6), ["workspace", "report-metadata", "w1", "--source", "herdr-plugin-github", "--seq"]);
  assert.ok(Number(args[6]) > 0, "seq must be a positive number");
  assert.deepEqual(args.slice(7), ["--ttl-ms", String(DEFAULT_POLL_INTERVAL_MS * 3), "--token", "sd_pr=unknown no-auth"]);
});

test("pollOnce reports unknown unsupported-remote for a non-GitHub origin", async () => {
  const dir = withGitRemote("git@gitlab.com:acme/widgets.git");
  const calls = [];
  const result = await pollOnce({
    env: { HERDR_WORKSPACE_ID: "w1", GH_TOKEN: "t" },
    cwd: dir,
    report: (...args) => calls.push(args)
  });
  assert.equal(result.state, "unknown");
  assert.equal(result.reason, "unsupported-remote");
});

test("pollOnce publishes an explicit 'none' rather than clearing when GitHub has no pull request for the branch", async () => {
  const dir = withGitRemote("git@github.com:acme/widgets.git");
  const { fetchImpl } = stubFetch({
    "https://api.github.com/repos/acme/widgets/pulls?head=acme:main&state=all&sort=updated&direction=desc&per_page=1": { body: [] }
  });
  const calls = [];
  const result = await pollOnce({
    env: { HERDR_WORKSPACE_ID: "w1", GH_TOKEN: "t" },
    cwd: dir,
    fetchImpl,
    report: (...args) => calls.push(args)
  });
  assert.equal(result.state, "none");
  assert.deepEqual(calls[0][1].slice(-2), ["--token", "sd_pr=none"]);
});

test("pollOnce publishes number and state for an open pull request with a real review and checks call", async () => {
  const dir = withGitRemote("git@github.com:acme/widgets.git");
  const pr = { number: 42, state: "open", merged_at: null, head: { sha: "abc123" } };
  const { fetchImpl, calls: fetchCalls } = stubFetch({
    "https://api.github.com/repos/acme/widgets/pulls?head=acme:main&state=all&sort=updated&direction=desc&per_page=1": { body: [pr] },
    "https://api.github.com/repos/acme/widgets/pulls/42/reviews": { body: [{ user: { login: "alice" }, state: "APPROVED" }] },
    "https://api.github.com/repos/acme/widgets/commits/abc123/check-runs": { body: { check_runs: [] } }
  });
  const calls = [];
  const result = await pollOnce({
    env: { HERDR_WORKSPACE_ID: "w1", GH_TOKEN: "t" },
    cwd: dir,
    fetchImpl,
    report: (...args) => calls.push(args)
  });
  assert.equal(result.state, "approved");
  assert.equal(result.prNumber, 42);
  assert.deepEqual(calls[0][1].slice(-1), ["sd_pr=42 approved"]);
  assert.equal(fetchCalls.length, 3, "the PR lookup plus reviews plus checks");
});

test("pollOnce skips reviews and checks entirely for a merged pull request", async () => {
  const dir = withGitRemote("git@github.com:acme/widgets.git");
  const pr = { number: 9, state: "closed", merged_at: "2026-01-01T00:00:00Z", head: { sha: "abc123" } };
  const { fetchImpl, calls: fetchCalls } = stubFetch({
    "https://api.github.com/repos/acme/widgets/pulls?head=acme:main&state=all&sort=updated&direction=desc&per_page=1": { body: [pr] }
  });
  const calls = [];
  const result = await pollOnce({ env: { HERDR_WORKSPACE_ID: "w1", GH_TOKEN: "t" }, cwd: dir, fetchImpl, report: (...args) => calls.push(args) });
  assert.equal(result.state, "merged");
  assert.equal(fetchCalls.length, 1, "no reviews or checks call for a merged PR");
});

test("pollOnce reports unknown error, not the previous value, when the GitHub call fails", async () => {
  const dir = withGitRemote("git@github.com:acme/widgets.git");
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  const calls = [];
  const result = await pollOnce({ env: { HERDR_WORKSPACE_ID: "w1", GH_TOKEN: "t" }, cwd: dir, fetchImpl, report: (...args) => calls.push(args) });
  assert.equal(result.state, "unknown");
  assert.equal(result.reason, "error");
  assert.deepEqual(calls[0][1].slice(-1), ["sd_pr=unknown error"]);
});

test("pollOnce does nothing outside a Herdr workspace", async () => {
  const dir = withGitRemote("git@github.com:acme/widgets.git");
  const calls = [];
  const result = await pollOnce({ env: {}, cwd: dir, report: (...args) => calls.push(args) });
  assert.deepEqual(result, { ran: false });
  assert.deepEqual(calls, []);
});

test("readPidFile and writePidFile round-trip through a state directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-pr-state-"));
  assert.equal(readPidFile(dir, "w1"), undefined);
  writePidFile(dir, "w1", 12345);
  assert.equal(readPidFile(dir, "w1"), 12345);
});

test("isProcessAlive is true for this very process and false for a pid that cannot exist", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(999999999), false);
});

test("ensurePollerRunning does nothing when no state directory is available", () => {
  const spawned = [];
  const result = ensurePollerRunning({ workspaceId: "w1", stateDir: undefined, spawnImpl: () => spawned.push(1) });
  assert.deepEqual(result, { started: false, reason: "no-state-dir" });
  assert.equal(spawned.length, 0);
});

test("ensurePollerRunning spawns a detached loop and records its pid when none is running", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-pr-state-"));
  let spawnedArgs;
  const fakeChild = { pid: 4242, unref: () => {} };
  const result = ensurePollerRunning({
    workspaceId: "w1",
    stateDir: dir,
    spawnImpl: (...args) => {
      spawnedArgs = args;
      return fakeChild;
    },
    isAlive: () => false
  });
  assert.equal(result.started, true);
  assert.equal(result.pid, 4242);
  assert.equal(readPidFile(dir, "w1"), 4242);
  assert.equal(spawnedArgs[1][1], "poll-loop");
});

test("ensurePollerRunning does not spawn a second loop while the recorded pid is still alive", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-pr-state-"));
  writePidFile(dir, "w1", 555);
  const spawned = [];
  const result = ensurePollerRunning({
    workspaceId: "w1",
    stateDir: dir,
    spawnImpl: (...args) => spawned.push(args),
    isAlive: (pid) => pid === 555
  });
  assert.deepEqual(result, { started: false, reason: "already-running", pid: 555 });
  assert.equal(spawned.length, 0);
});

test("ensurePollerRunning replaces a stale pid whose process is no longer alive", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-pr-state-"));
  writePidFile(dir, "w1", 555);
  const fakeChild = { pid: 777, unref: () => {} };
  const result = ensurePollerRunning({
    workspaceId: "w1",
    stateDir: dir,
    spawnImpl: () => fakeChild,
    isAlive: () => false
  });
  assert.equal(result.started, true);
  assert.equal(readPidFile(dir, "w1"), 777);
});

test("ensurePollerRunning does not spawn when the atomic lock is lost to a racing caller", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-pr-state-"));
  const spawned = [];
  const result = ensurePollerRunning({
    workspaceId: "w1",
    stateDir: dir,
    spawnImpl: (...args) => spawned.push(args),
    isAlive: () => false,
    acquire: () => false
  });
  assert.deepEqual(result, { started: false, reason: "lock-contended" });
  assert.equal(spawned.length, 0);
});

test("runPollLoop polls once per interval and stops when told to, without waiting for real time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-pr-loop-"));
  const polls = [];
  const sleeps = [];
  let ticks = 0;
  await runPollLoop({
    env: {},
    cwd: dir,
    intervalMs: 1234,
    pollImpl: async () => polls.push(1),
    sleep: async (ms) => sleeps.push(ms),
    shouldStop: () => ++ticks >= 3
  });
  assert.equal(polls.length, 3);
  assert.deepEqual(sleeps, [1234, 1234]);
});

test("runPollLoop self-terminates without polling once the worktree directory is gone", async () => {
  const polls = [];
  const result = await runPollLoop({
    env: {},
    cwd: "/definitely/does/not/exist/anywhere",
    pollImpl: async () => polls.push(1),
    existsImpl: () => false
  });
  assert.deepEqual(result, { stopped: "worktree-gone" });
  assert.equal(polls.length, 0);
});
