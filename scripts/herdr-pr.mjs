/**
 * herdr-pr — the Herdr-plugin half of ticket `-7bl`: work out whether a
 * pull request exists for a workstream's branch and publish its number and
 * review state as the workspace token `sd_pr`, alongside `sd_tickets`
 * (`herdr-tickets.mjs`, ticket `-5ot`).
 *
 * Runs inside the Herdr plugin process (ADR-0004), not the Stream Deck
 * plugin, so pull-request state keeps updating while the Stream Deck app is
 * closed and is visible inside Herdr itself.
 *
 *   node herdr-pr.mjs startup           # herdr-plugin.toml [[startup]]
 *   node herdr-pr.mjs worktree-created  # herdr-plugin.toml [[events]] on worktree.created
 *   node herdr-pr.mjs worktree-opened   # herdr-plugin.toml [[events]] on worktree.opened
 *   node herdr-pr.mjs poll-loop         # not a manifest entry — spawned by the three above
 *
 * WHY THIS POLLS AT ALL, AND WHY THAT IS A DELIBERATE CADENCE RATHER THAN A
 * TIGHT LOOP. Unlike a commit landing (`herdr-tickets.mjs` reaches for a git
 * hook because a local action exists to hang off), a review being approved
 * or a check finishing happens entirely on GitHub's side — nothing local
 * ever fires for it, so there is no event of any kind to reach for. Each of
 * `startup`, `worktree-created` and `worktree-opened` therefore makes sure a
 * single detached background loop is running for that workspace, checking
 * on an interval (`DEFAULT_POLL_INTERVAL_MS`, five minutes, overridable via
 * `github.json`'s `pollIntervalMs`) rather than on every event this plugin
 * happens to see. A lock file in `HERDR_PLUGIN_STATE_DIR` keyed by workspace
 * id stops a Herdr restart, or a worktree being reopened, from stacking up a
 * second loop alongside one already running. The loop terminates itself once
 * its worktree's checkout directory is gone, which is what `worktree remove`
 * leaves behind — there is no supervision to rely on here (per Herdr's own
 * docs, startup commands are "not supervised daemons"), so self-termination
 * is this script's job alone.
 *
 * WHY AUTHENTICATION IS CONFIGURED RATHER THAN ASSUMED. It would be simplest
 * to shell out to `gh api` and inherit whatever the developer happens to be
 * logged into on this machine — but that is *assumed* auth: it depends on
 * ambient state this script never asked for and cannot see the absence of
 * until a call already fails. Instead a token is read from `github.json`'s
 * `token` field, or the `GH_TOKEN` / `GITHUB_TOKEN` environment variables —
 * both established conventions the developer opts into deliberately, one
 * config file or export away from `gh`'s own expectations, without this
 * script ever going looking for a session it was not told about. Its total
 * absence publishes an explicit `unknown no-auth` token rather than silently
 * reporting nothing, per the ticket's acceptance criteria.
 *
 * WHY A FAILURE PUBLISHES `unknown` RATHER THAN LEAVING THE LAST VALUE IN
 * PLACE. A stale "approved" surviving an outage would read as still true.
 * Every poll tick writes something, so Herdr's own token always reflects the
 * most recent thing this script actually knows, never the last thing it
 * managed to learn before something broke.
 *
 * Config lives at `HERDR_PLUGIN_CONFIG_DIR/github.json`:
 *
 *   { "token": "ghp_...", "pollIntervalMs": 300000, "apiBaseUrl": "https://api.github.com" }
 *
 * Every field is optional; `token` falls back to `GH_TOKEN`/`GITHUB_TOKEN`,
 * `pollIntervalMs` to `DEFAULT_POLL_INTERVAL_MS`, `apiBaseUrl` to GitHub's
 * own API (an enterprise install can override it).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseContext, worktreeFrom } from "./herdr-plugin-context.mjs";

export const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_API_BASE_URL = "https://api.github.com";

const SOURCE = "herdr-plugin-github";
const TOKEN_NAME = "sd_pr";
const SCRIPT_PATH = fileURLToPath(new URL("./herdr-pr.mjs", import.meta.url));

/**
 * `{ owner, repo }` for a GitHub remote URL, in either the SSH or HTTPS shape
 * `gh`/Git themselves accept, or `undefined` for anything else — a
 * self-hosted GitLab, a bare path, no remote at all. Never guesses past what
 * the URL actually says.
 */
export function parseGitHubRemote(url) {
  if (!url) return undefined;
  const patterns = [/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/, /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return { owner: match[1], repo: match[2] };
  }
  return undefined;
}

/** Reads `github.json` from the plugin's config directory, defaults for anything missing or unreadable. */
export function loadConfig(configDir) {
  const empty = { token: undefined, pollIntervalMs: DEFAULT_POLL_INTERVAL_MS, apiBaseUrl: DEFAULT_API_BASE_URL };
  if (!configDir) return empty;
  const path = join(configDir, "github.json");
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      token: typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : undefined,
      pollIntervalMs: Number.isFinite(parsed.pollIntervalMs) && parsed.pollIntervalMs > 0 ? parsed.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS,
      apiBaseUrl: typeof parsed.apiBaseUrl === "string" && parsed.apiBaseUrl.length > 0 ? parsed.apiBaseUrl : DEFAULT_API_BASE_URL
    };
  } catch {
    // A broken config must not stop enrichment from running with defaults —
    // same trade `herdr-tickets.mjs`'s own `loadConfig` makes.
    return empty;
  }
}

/** `config.token`, then `GH_TOKEN`, then `GITHUB_TOKEN` — the only three places this script will look. */
export function resolveAuthToken(env, config) {
  return config.token ?? env.GH_TOKEN ?? env.GITHUB_TOKEN ?? undefined;
}

/**
 * The most recent review state each reviewer left, in the order GitHub
 * returns them (oldest submission first) — so a later `APPROVED` overrides
 * an earlier `CHANGES_REQUESTED` from the same person, and vice versa.
 * `COMMENTED`, `DISMISSED` and `PENDING` never count as anyone's verdict.
 */
export function latestReviewStates(reviews) {
  const byUser = new Map();
  for (const review of reviews) {
    if (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED") continue;
    const login = review.user?.login;
    if (!login) continue;
    byUser.set(login, review.state);
  }
  return [...byUser.values()];
}

/**
 * The vocabulary the ticket asks for — open, approved, changes requested,
 * checks failing, merged — plus `closed`, which none of the five cover but
 * which a real PR can reach (abandoned without merging); reporting it as
 * `open` would be a wrong answer, not merely an incomplete one.
 *
 * Precedence, most urgent first: an outstanding change request is the one
 * state that blocks the developer directly, so it wins even over a failing
 * check; a failing check outranks an approval that arrived before it broke.
 */
export function computeReviewState({ pr, reviews, checkRuns }) {
  if (pr.merged_at) return "merged";
  if (pr.state === "closed") return "closed";

  const states = latestReviewStates(reviews);
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (checkRuns.some((run) => run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "cancelled")) {
    return "checks_failing";
  }
  if (states.includes("APPROVED")) return "approved";
  return "open";
}

/** The `sd_pr` token value for a known pull request: its number and state, space-separated like `sd_exit_`'s own value. */
export function buildTokenValue({ prNumber, state }) {
  return `${prNumber} ${state}`;
}

/** The `herdr` CLI invocation for one report. `value` of `undefined` clears the token — "no pull request yet". */
export function buildReportArgs({ workspaceId, value, seq }) {
  const base = ["workspace", "report-metadata", workspaceId, "--source", SOURCE, "--seq", String(seq)];
  if (value === undefined) return [...base, "--clear-token", TOKEN_NAME];
  return [...base, "--token", `${TOKEN_NAME}=${value}`];
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "herdr-streamdeck-plugin"
  };
}

async function getJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, { headers: githubHeaders(token) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  return response.json();
}

/**
 * The single most-recently-updated pull request for `branch`, or `null` when
 * none exists yet. Searches every state, not only `open`, so a merged or
 * closed pull request is still found and reported rather than looking like
 * "no pull request" the moment it stops being open.
 */
export async function findPullRequestForBranch({ owner, repo, branch, token, apiBaseUrl, fetchImpl }) {
  const url = `${apiBaseUrl}/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=all&sort=updated&direction=desc&per_page=1`;
  const results = await getJson(url, token, fetchImpl);
  return Array.isArray(results) && results.length > 0 ? results[0] : null;
}

/** Reviews and check runs for an open pull request's head commit — skipped entirely for a closed or merged one. */
async function reviewAndChecks({ owner, repo, pr, token, apiBaseUrl, fetchImpl }) {
  const [reviews, checks] = await Promise.all([
    getJson(`${apiBaseUrl}/repos/${owner}/${repo}/pulls/${pr.number}/reviews`, token, fetchImpl),
    getJson(`${apiBaseUrl}/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`, token, fetchImpl)
  ]);
  return { reviews, checkRuns: checks.check_runs ?? [] };
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}

function currentBranch(cwd) {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "";
}

/**
 * One full check: resolve the workstream, ask GitHub, publish `sd_pr`. Never
 * throws — every failure path, including "not on GitHub" and "no token
 * configured", ends in a report of some kind, per the ticket's requirement
 * that a failure degrade to an explicit unknown state rather than silence.
 */
export async function pollOnce({ env, cwd: providedCwd, herdrBin = "herdr", report = spawnSync, fetchImpl = fetch, now = Date.now }) {
  const workspaceId = env.HERDR_WORKSPACE_ID;
  if (!workspaceId) return { ran: false };

  const worktree = worktreeFrom(parseContext(env.HERDR_PLUGIN_CONTEXT_JSON));
  const cwd = providedCwd ?? worktree.checkout_path ?? process.cwd();
  const branch = worktree.branch ?? currentBranch(cwd);
  const config = loadConfig(env.HERDR_PLUGIN_CONFIG_DIR);
  const token = resolveAuthToken(env, config);

  const publish = (value) => {
    report(herdrBin, buildReportArgs({ workspaceId, value, seq: now() }), { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
  };

  if (!token) {
    publish("unknown no-auth");
    return { ran: true, state: "unknown", reason: "no-auth" };
  }

  const remoteUrl = git(cwd, ["remote", "get-url", "origin"]);
  const parsedRemote = parseGitHubRemote(remoteUrl);
  if (!parsedRemote) {
    publish("unknown unsupported-remote");
    return { ran: true, state: "unknown", reason: "unsupported-remote" };
  }

  try {
    const { owner, repo } = parsedRemote;
    const pr = await findPullRequestForBranch({ owner, repo, branch, token, apiBaseUrl: config.apiBaseUrl, fetchImpl });
    if (!pr) {
      publish(undefined);
      return { ran: true, state: "none" };
    }

    let state;
    if (pr.state === "open" && !pr.merged_at) {
      const { reviews, checkRuns } = await reviewAndChecks({ owner, repo, pr, token, apiBaseUrl: config.apiBaseUrl, fetchImpl });
      state = computeReviewState({ pr, reviews, checkRuns });
    } else {
      state = computeReviewState({ pr, reviews: [], checkRuns: [] });
    }

    publish(buildTokenValue({ prNumber: pr.number, state }));
    return { ran: true, state, prNumber: pr.number };
  } catch {
    publish("unknown error");
    return { ran: true, state: "unknown", reason: "error" };
  }
}

function pidFilePath(stateDir, workspaceId) {
  return join(stateDir, `pr-poll-${workspaceId}.pid`);
}

export function readPidFile(stateDir, workspaceId) {
  const path = pidFilePath(stateDir, workspaceId);
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, "utf8").trim());
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

export function writePidFile(stateDir, workspaceId, pid) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(pidFilePath(stateDir, workspaceId), String(pid));
}

/**
 * Claims the right to spawn a poller for `workspaceId`, atomically. `wx`
 * fails the write outright if the file already exists, so two invocations
 * racing each other — `startup` and `worktree.opened` landing close together
 * after a Herdr restart, say — cannot both observe "no pid file" and both
 * spawn a loop; only one write wins, and the other sees `EEXIST`.
 *
 * `removeStaleLock` is passed once the caller has already confirmed the
 * recorded pid is dead, so a crashed poller's file does not block a new one
 * forever. This still leaves one narrow window unclosed — two callers
 * reclaiming the same stale lock at the exact same instant could both delete
 * and both then win their own `wx` write — which is accepted rather than
 * solved with a heavier lock: the cost of losing that race is a duplicate
 * poller for a few seconds until one of them notices the other's pid file on
 * its own next check, not corrupted state.
 */
function acquireLock(stateDir, workspaceId, removeStaleLock) {
  mkdirSync(stateDir, { recursive: true });
  const path = pidFilePath(stateDir, workspaceId);
  if (removeStaleLock) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone — another caller may have reclaimed it first, which is fine.
    }
  }
  try {
    writeFileSync(path, "0", { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

/** Whether a process with this pid is still alive — the standard signal-0 probe, which sends nothing. */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts the background poll loop for `workspaceId` unless one is already
 * running, tracked by a pid file in `stateDir`. Without a state directory —
 * true outside a real Herdr plugin invocation — this does nothing rather
 * than spawn a loop nothing will ever find again.
 */
export function ensurePollerRunning({
  workspaceId,
  stateDir,
  scriptPath = SCRIPT_PATH,
  spawnImpl = spawn,
  isAlive = isProcessAlive,
  readPid = readPidFile,
  writePid = writePidFile,
  acquire = acquireLock,
  env = process.env
}) {
  if (!stateDir || !workspaceId) return { started: false, reason: "no-state-dir" };

  const existing = readPid(stateDir, workspaceId);
  if (existing !== undefined && isAlive(existing)) return { started: false, reason: "already-running", pid: existing };

  if (!acquire(stateDir, workspaceId, existing !== undefined)) return { started: false, reason: "lock-contended" };

  const child = spawnImpl(process.execPath, [scriptPath, "poll-loop"], { detached: true, stdio: "ignore", env });
  child.unref();
  writePid(stateDir, workspaceId, child.pid);
  return { started: true, pid: child.pid };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The loop body itself: poll, then either stop or sleep and repeat.
 * Self-terminates once `cwd` no longer exists, which is what a removed
 * worktree leaves behind — nothing else in this process ever tells it to
 * stop. `shouldStop` and `sleep` are seams for tests; production code never
 * passes them.
 */
export async function runPollLoop({
  env,
  cwd,
  herdrBin = "herdr",
  report = spawnSync,
  fetchImpl = fetch,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  pollImpl = pollOnce,
  sleep = defaultSleep,
  shouldStop = () => false,
  existsImpl = existsSync
}) {
  for (;;) {
    if (!existsImpl(cwd)) return { stopped: "worktree-gone" };
    await pollImpl({ env, cwd, herdrBin, report, fetchImpl });
    if (shouldStop()) return { stopped: "requested" };
    await sleep(intervalMs);
  }
}

const EVENTS_START_POLLER = new Set(["startup", "worktree-created", "worktree-opened"]);

async function main(argv) {
  const event = argv[0];
  const env = process.env;
  const cwd = worktreeFrom(parseContext(env.HERDR_PLUGIN_CONTEXT_JSON)).checkout_path ?? process.cwd();

  try {
    if (event === "poll-loop") {
      const config = loadConfig(env.HERDR_PLUGIN_CONFIG_DIR);
      await runPollLoop({ env, cwd, herdrBin: env.HERDR_BIN_PATH || "herdr", intervalMs: config.pollIntervalMs });
      return;
    }

    if (!EVENTS_START_POLLER.has(event)) {
      console.error(`usage: herdr-pr.mjs <${["startup", "worktree-created", "worktree-opened", "poll-loop"].join("|")}>`);
      process.exit(2);
      return;
    }

    const workspaceId = env.HERDR_WORKSPACE_ID;
    if (workspaceId) {
      await pollOnce({ env, cwd, herdrBin: env.HERDR_BIN_PATH || "herdr" });
      ensurePollerRunning({ workspaceId, stateDir: env.HERDR_PLUGIN_STATE_DIR });
    }
  } catch {
    // Enrichment failing must never surface as a Herdr plugin error to the
    // developer — same trade `herdr-tickets.mjs` makes.
  }
  process.exit(0);
}

// Only run as a CLI when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
