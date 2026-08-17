/**
 * herdr-tickets — the Herdr-plugin half of ADR-0006: derive a workstream's
 * ticket list from Git and publish it as the workspace token `sd_tickets`.
 *
 * Runs inside the Herdr plugin process (ADR-0004), not the Stream Deck
 * plugin, so the list stays fresh while the Stream Deck app is closed and is
 * visible inside Herdr itself.
 *
 *   node herdr-tickets.mjs startup           # herdr-plugin.toml [[startup]]
 *   node herdr-tickets.mjs worktree-created   # herdr-plugin.toml [[events]] on worktree.created
 *   node herdr-tickets.mjs worktree-opened    # herdr-plugin.toml [[events]] on worktree.opened
 *   node herdr-tickets.mjs commit             # installed as this worktree's own post-commit hook
 *
 * WHY A GIT HOOK RE-TRIGGERS THIS. Herdr's 27 subscriptions carry nothing for
 * "a commit landed" — probed against the full event catalog, confirmed absent
 * (see docs/adr/0004). ADR-0006 still requires re-publishing when commits
 * land, so `startup`, `worktree-created` and `worktree-opened` each also
 * make sure this worktree's `post-commit` hook calls back into this script
 * with `commit`, the same pattern `scripts/herdr-attention` already uses one
 * layer up — reaching for the place the real event lives rather than polling
 * for it (ADR-0004 rejects polling for exactly this reason). A pane inside a
 * Herdr-managed worktree already carries `HERDR_WORKSPACE_ID` in its
 * environment (`scripts/herdr-attention` relies on the same fact), so the
 * hook needs no context beyond what the shell already has.
 *
 * WHY THE BASE REF CAN BE CONFIGURED. Herdr's `WorktreeInfo` carries no base
 * ref at all (verified against `src/device/workstream.ts`'s own reading of
 * it) so "inferred or configured otherwise" (ADR-0006) is not optional. This
 * reads `HERDR_PLUGIN_CONFIG_DIR/tickets.json`:
 *
 *   { "projectKeyPattern": "[A-Z][A-Z0-9]+-\\d+", "baseRefs": { "<repo_key>": "origin/develop" } }
 *
 * Both fields are optional; the pattern defaults to a generic JIRA-shaped
 * key, and a repository with no entry falls back to inferring its base from
 * the remote's default branch, then a short list of common branch names.
 *
 * WHY AN EMPTY LIST CLEARS THE TOKEN RATHER THAN PUBLISHING ONE. Matches the
 * convention `sd_attn_`/`sd_exit_` already set: "nothing to report" reads as
 * an absent token, not a token whose value happens to be empty.
 *
 * SILENT WHEREVER IT CANNOT ACT, same trade `scripts/herdr-attention` and
 * `scripts/herdr-service` make: outside a Herdr workspace, or on any error
 * talking to Herdr or Git, this exits clean rather than risk a workstream's
 * commit finishing on account of an enrichment script.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PROJECT_KEY_PATTERN = "[A-Z][A-Z0-9]+-\\d+";

const SOURCE = "herdr-plugin-tickets";
const TOKEN_NAME = "sd_tickets";
const BASE_REF_CANDIDATES = ["origin/main", "origin/master", "main", "master", "develop"];
const HOOK_MARKER = "# installed-by: herdr-tickets";

const SCRIPT_PATH = fileURLToPath(new URL("./herdr-tickets.mjs", import.meta.url));

/** Compiles the configured pattern into a global matcher, one capture-free run. */
function compileTicketPattern(source) {
  return new RegExp(source, "g");
}

/**
 * Every ticket key `pattern` matches in `text`, deduplicated and in the
 * order they were first seen — stable, per ADR-0006's acceptance criteria,
 * rather than sorted or grouped.
 */
export function extractTicketKeys(text, patternSource = DEFAULT_PROJECT_KEY_PATTERN) {
  const pattern = compileTicketPattern(patternSource);
  const seen = new Set();
  const keys = [];
  for (const match of text.matchAll(pattern)) {
    const key = match[0];
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * The list ADR-0006 defines: commit-range keys are authoritative the moment
 * any commit exists, wholesale replacing the branch-seeded guess rather than
 * merging with it — a workstream with commits but no ticket keys in them
 * yields an empty list, never a stale branch-derived one.
 */
export function deriveTicketKeys({ branch, commitSubjects, hasCommits, patternSource = DEFAULT_PROJECT_KEY_PATTERN }) {
  if (hasCommits) return extractTicketKeys(commitSubjects.join("\n"), patternSource);
  return extractTicketKeys(branch ?? "", patternSource);
}

/** Reads `tickets.json` from the plugin's config directory, defaults for anything missing or unreadable. */
export function loadConfig(configDir) {
  const empty = { projectKeyPattern: DEFAULT_PROJECT_KEY_PATTERN, baseRefs: {} };
  if (!configDir) return empty;
  const path = join(configDir, "tickets.json");
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      projectKeyPattern: typeof parsed.projectKeyPattern === "string" ? parsed.projectKeyPattern : DEFAULT_PROJECT_KEY_PATTERN,
      baseRefs: typeof parsed.baseRefs === "object" && parsed.baseRefs !== null ? parsed.baseRefs : {}
    };
  } catch {
    // A broken config must not stop enrichment from running at all; it just
    // runs with defaults, the same trade `install-herdr-hooks` makes the
    // other direction (there, a broken file is refused rather than guessed
    // past, because that write is destructive; this read is not).
    return empty;
  }
}

/**
 * Runs a git subcommand in `cwd`, returning trimmed stdout or `undefined` on
 * any nonzero exit — every caller treats "git could not answer" the same as
 * "there is nothing to report" rather than as an error to surface.
 */
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}

/**
 * The base ref ADR-0006 requires, in priority order: an explicit
 * `tickets.json` entry for this repository, since a developer who configured
 * one meant it to override anything automatic; the base Herdr itself
 * recorded when the worktree was created, if the plugin context carries one
 * ("`worktree create --base` supplies it at creation" — ADR-0006); then the
 * remote's own default branch; then a short list of common names, each
 * checked for existing before being trusted.
 *
 * `worktreeBaseRef` is read defensively under a couple of plausible field
 * names because neither Herdr's public docs nor `WorktreeInfo` (ADR-0001)
 * confirm the exact shape of what `worktree.created`'s context carries for
 * this — only that the CLI argument exists at creation time. Reading it when
 * present costs nothing; its absence just falls through to inference, same
 * as an existing worktree with no such history.
 */
export function resolveBaseRef({ cwd, repoKey, config, worktreeBaseRef }) {
  const configured = repoKey ? config.baseRefs?.[repoKey] : undefined;
  if (configured) return configured;

  if (worktreeBaseRef) return worktreeBaseRef;

  const remoteHead = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) return remoteHead;

  for (const candidate of BASE_REF_CANDIDATES) {
    if (git(cwd, ["rev-parse", "--verify", "--quiet", candidate]) !== undefined) return candidate;
  }
  return undefined;
}

/**
 * Whether any commit exists between `baseRef` and `HEAD`, and their subject
 * lines if so. Any failure — an unresolved base, an invalid ref, detached
 * history — reads as "no commits yet" so the caller falls back to the
 * branch-seeded list rather than guessing from a broken range.
 */
function commitsSinceBase(cwd, baseRef) {
  if (!baseRef) return { hasCommits: false, subjects: [] };
  const count = git(cwd, ["rev-list", "--count", `${baseRef}..HEAD`]);
  if (count === undefined || Number(count) <= 0) return { hasCommits: false, subjects: [] };
  const log = git(cwd, ["log", `${baseRef}..HEAD`, "--format=%s"]);
  if (log === undefined) return { hasCommits: false, subjects: [] };
  return { hasCommits: true, subjects: log.split("\n").filter(Boolean) };
}

function currentBranch(cwd) {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "";
}

/** The `herdr` CLI invocation this run should make, or `undefined` for nothing to report. */
export function buildReportArgs({ workspaceId, ticketKeys, seq }) {
  const base = ["workspace", "report-metadata", workspaceId, "--source", SOURCE, "--seq", String(seq)];
  if (ticketKeys.length === 0) return [...base, "--clear-token", TOKEN_NAME];
  return [...base, "--token", `${TOKEN_NAME}=${ticketKeys.join(",")}`];
}

/** Best-effort parse of the plugin invocation context Herdr injects. Never throws. */
function parseContext(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Makes sure this worktree's `post-commit` hook calls back into this script,
 * so a commit landing re-publishes the ticket list (ADR-0006). Idempotent
 * and additive: an existing hook from something else is kept, ours is
 * appended once and never duplicated. `cwd` may be any path inside the
 * worktree; `git rev-parse --git-path` resolves to the shared hooks
 * directory even for a linked worktree.
 */
export function ensureCommitHookInstalled(cwd, scriptPath = SCRIPT_PATH) {
  const hooksDir = git(cwd, ["rev-parse", "--git-path", "hooks"]);
  if (!hooksDir) return { installed: false };

  const absoluteHooksDir = hooksDir.startsWith("/") ? hooksDir : join(cwd, hooksDir);
  const hookPath = join(absoluteHooksDir, "post-commit");
  const invocation = `node ${JSON.stringify(scriptPath)} commit`;

  const existing = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : "";
  if (existing.includes(invocation)) return { installed: false, hookPath };

  mkdirSync(absoluteHooksDir, { recursive: true });
  const content = existing.length > 0 ? existing : "#!/bin/sh\n";
  const withHook = `${content.replace(/\n?$/, "\n")}${HOOK_MARKER}\n${invocation} >/dev/null 2>&1 &\n`;
  writeFileSync(hookPath, withHook);
  chmodSync(hookPath, 0o755);
  return { installed: true, hookPath };
}

/**
 * Scans this workstream and publishes `sd_tickets`. `installHook` is true
 * only for the events where re-establishing it is worth the extra git call:
 * startup and either worktree event, not every single commit.
 */
export function run({ env, cwd: providedCwd, installHook, herdrBin = "herdr", report = spawnSync }) {
  const workspaceId = env.HERDR_WORKSPACE_ID;
  if (!workspaceId) return { ran: false };

  const context = parseContext(env.HERDR_PLUGIN_CONTEXT_JSON);
  const worktree = context.worktree ?? {};
  const cwd = providedCwd ?? worktree.checkout_path ?? process.cwd();
  const repoKey = worktree.repo_key;
  const branch = worktree.branch ?? currentBranch(cwd);

  const worktreeBaseRef = worktree.base_ref ?? worktree.base_branch ?? worktree.base;
  const config = loadConfig(env.HERDR_PLUGIN_CONFIG_DIR);
  const baseRef = resolveBaseRef({ cwd, repoKey, config, worktreeBaseRef });
  const { hasCommits, subjects } = commitsSinceBase(cwd, baseRef);
  const ticketKeys = deriveTicketKeys({ branch, commitSubjects: subjects, hasCommits, patternSource: config.projectKeyPattern });

  const args = buildReportArgs({ workspaceId, ticketKeys, seq: Date.now() });
  report(herdrBin, args, { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });

  if (installHook) ensureCommitHookInstalled(cwd);

  return { ran: true, ticketKeys, baseRef };
}

const EVENT_INSTALLS_HOOK = {
  startup: true,
  "worktree-created": true,
  "worktree-opened": true,
  commit: false
};

function main(argv) {
  const event = argv[0];
  if (!(event in EVENT_INSTALLS_HOOK)) {
    console.error(`usage: herdr-tickets.mjs <${Object.keys(EVENT_INSTALLS_HOOK).join("|")}>`);
    process.exit(2);
  }
  try {
    run({ env: process.env, installHook: EVENT_INSTALLS_HOOK[event], herdrBin: process.env.HERDR_BIN_PATH || "herdr" });
  } catch {
    // Enrichment failing must never surface as a Herdr plugin error to the
    // developer — same trade every other script in this file makes.
  }
  process.exit(0);
}

// Only run as a CLI when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
