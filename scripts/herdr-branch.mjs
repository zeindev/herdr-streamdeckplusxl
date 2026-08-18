/**
 * herdr-branch — the Herdr-plugin half of the decision recorded in
 * ADR-0001: publish the workstream's actual current branch as the workspace
 * token `sd_branch`, so a `git switch` or `git checkout` inside the
 * worktree — which pushes no Herdr event of any kind — still reaches the
 * device.
 *
 * Runs inside the Herdr plugin process (ADR-0004), not the Stream Deck
 * plugin, so the branch stays fresh while the Stream Deck app is closed.
 *
 *   node herdr-branch.mjs startup           # herdr-plugin.toml [[startup]]
 *   node herdr-branch.mjs worktree-created  # herdr-plugin.toml [[events]] on worktree.created
 *   node herdr-branch.mjs worktree-opened   # herdr-plugin.toml [[events]] on worktree.opened
 *   node herdr-branch.mjs checkout <flag>   # installed as this worktree's own post-checkout hook
 *
 * WHY A GIT HOOK, NOT A HERDR EVENT. Verified live against Herdr 0.8.0,
 * protocol 19 (ticket `-0vd.1`, recorded in ADR-0001): a `git switch` or
 * `git checkout` inside an existing worktree pushes no Herdr event at
 * all — not structural, not anything — so nothing on the socket side can
 * ever notice a branch changing that way. Git's own `post-checkout` hook
 * fires on exactly this, the same "reach for where the real event lives
 * rather than poll for it" move `scripts/herdr-tickets.mjs`'s `post-commit`
 * hook already makes for commits landing (ADR-0004 rejects polling for
 * exactly this reason, and a fix here must not reintroduce it).
 *
 * WHY DETACHED HEAD PUBLISHES AN EMPTY STRING, NOT "HEAD". `git rev-parse
 * --abbrev-ref HEAD` answers the literal string `"HEAD"` when detached,
 * which would read on the device as a workstream on a branch actually named
 * "HEAD". `git symbolic-ref -q --short HEAD` instead fails cleanly when
 * detached, the same "on no branch" case the device already renders for a
 * checkout Herdr itself reports with no branch (`src/device/workstream.ts`),
 * so an empty string is published rather than a name that is not one.
 *
 * WHY THE TOKEN WINS OVER `worktree.list` WHEN BOTH ARE PRESENT. Herdr's own
 * answer can only be as fresh as the last snapshot read; this one is pushed
 * the moment the branch actually changes. `src/device/workstream.ts` prefers
 * `sd_branch` for exactly that reason, falling back to `worktree.list` only
 * when no Herdr plugin has ever published it for this workspace.
 *
 * SILENT WHEREVER IT CANNOT ACT, same trade `scripts/herdr-tickets.mjs` and
 * `scripts/herdr-attention` make: outside a Herdr workspace, or on any error
 * talking to Herdr or Git, this exits clean rather than risk a checkout
 * finishing on account of an enrichment script.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseContext, worktreeFrom } from "./herdr-plugin-context.mjs";

const SOURCE = "herdr-plugin-branch";
const TOKEN_NAME = "sd_branch";
const HOOK_MARKER = "# installed-by: herdr-branch";

/**
 * Herdr's own cap on a token's `--ttl-ms` (ADR-0004). There is no poll
 * cadence to scale against — this republishes on git/worktree events, not on
 * a timer — so the ceiling exists only so a Herdr plugin stopped for good
 * eventually reads as unknown on the device rather than showing a branch
 * that stopped being true. The same reasoning `herdr-tickets.mjs`'s own
 * `TICKETS_TTL_MS` gives, and the same value.
 */
const BRANCH_TTL_MS = 24 * 60 * 60 * 1000;

const SCRIPT_PATH = fileURLToPath(new URL("./herdr-branch.mjs", import.meta.url));

/**
 * Runs a git subcommand in `cwd`, returning trimmed stdout or `undefined` on
 * any nonzero exit — "git could not answer" is treated the same as "there is
 * nothing to report" everywhere this is called, never as an error to surface.
 */
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}

/**
 * The branch this worktree is actually on right now, or `""` for a detached
 * HEAD — never the literal `"HEAD"` `rev-parse --abbrev-ref` would answer.
 */
export function currentBranch(cwd) {
  return git(cwd, ["symbolic-ref", "-q", "--short", "HEAD"]) ?? "";
}

/** The `herdr` CLI invocation this run should make. Always publishes a value, including the empty string for detached HEAD. */
export function buildReportArgs({ workspaceId, branch, seq }) {
  return [
    "workspace",
    "report-metadata",
    workspaceId,
    "--source",
    SOURCE,
    "--seq",
    String(seq),
    "--ttl-ms",
    String(BRANCH_TTL_MS),
    "--token",
    `${TOKEN_NAME}=${branch}`
  ];
}

/**
 * Makes sure this worktree's `post-checkout` hook calls back into this
 * script, so switching branches from the terminal republishes `sd_branch`
 * (`-0vd.1`). Idempotent and additive — the same shape
 * `herdr-tickets.mjs`'s `ensureCommitHookInstalled` already uses for
 * `post-commit`: an existing hook from something else is kept, ours is
 * appended once and never duplicated.
 *
 * Git calls `post-checkout` with three arguments — the previous `HEAD`, the
 * new one, and a flag that is `1` for a branch checkout and `0` for a
 * file-level one (`git checkout -- path/to/file`). The third is forwarded as
 * `$3` and `main` below acts only when it is `1`, so restoring a single file
 * does not spawn a `herdr` call for a branch that never actually changed.
 */
export function ensureCheckoutHookInstalled(cwd, scriptPath = SCRIPT_PATH) {
  const hooksDir = git(cwd, ["rev-parse", "--git-path", "hooks"]);
  if (!hooksDir) return { installed: false };

  const absoluteHooksDir = hooksDir.startsWith("/") ? hooksDir : join(cwd, hooksDir);
  const hookPath = join(absoluteHooksDir, "post-checkout");
  const invocation = `node ${JSON.stringify(scriptPath)} checkout "$3"`;

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
 * Publishes `sd_branch` for this workstream. `installHook` is true only for
 * the events where re-establishing it is worth the extra git call: startup
 * and either worktree event, not every single checkout.
 *
 * `env.HERDR_WORKSPACE_ID` is what makes the `post-checkout` hook path work
 * with no context beyond what the shell already has: a pane inside a
 * Herdr-managed worktree already carries it, the same fact
 * `herdr-tickets.mjs`'s `post-commit` hook relies on — so a `git switch` run
 * from a pane's own shell can identify its workspace without
 * `HERDR_PLUGIN_CONTEXT_JSON`, which only startup and the worktree events
 * carry.
 */
export function run({ env, cwd: providedCwd, installHook, herdrBin = "herdr", report = spawnSync }) {
  const workspaceId = env.HERDR_WORKSPACE_ID;
  if (!workspaceId) return { ran: false };

  const context = parseContext(env.HERDR_PLUGIN_CONTEXT_JSON);
  const worktree = worktreeFrom(context);
  const cwd = providedCwd ?? worktree.checkout_path ?? process.cwd();
  const branch = currentBranch(cwd);

  const args = buildReportArgs({ workspaceId, branch, seq: Date.now() });
  report(herdrBin, args, { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });

  if (installHook) ensureCheckoutHookInstalled(cwd);

  return { ran: true, branch };
}

const EVENT_INSTALLS_HOOK = {
  startup: true,
  "worktree-created": true,
  "worktree-opened": true,
  checkout: false
};

function main(argv) {
  const event = argv[0];
  if (!(event in EVENT_INSTALLS_HOOK)) {
    console.error(`usage: herdr-branch.mjs <${Object.keys(EVENT_INSTALLS_HOOK).join("|")}>`);
    process.exit(2);
  }
  // `post-checkout`'s own third argument: `1` for a branch checkout, `0` for
  // a file-level one (`git checkout -- path/to/file`). A file restore has
  // not changed the branch, so there is nothing here worth a `herdr` call.
  if (event === "checkout" && argv[1] === "0") process.exit(0);
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
