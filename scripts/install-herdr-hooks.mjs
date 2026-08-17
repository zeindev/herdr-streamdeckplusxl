/**
 * install-herdr-hooks — wires Claude Code's own hooks to scripts/herdr-attention,
 * so an agent's question, approval and finished states reach the Stream Deck
 * without the device ever reading a terminal (ADR-0005, ticket -97u).
 *
 *   node scripts/install-herdr-hooks.mjs               # installs into ~/.claude/settings.json
 *   node scripts/install-herdr-hooks.mjs --dry-run      # reports what would change, writes nothing
 *   node scripts/install-herdr-hooks.mjs --target PATH  # installs somewhere else (mainly for tests)
 *
 * WHY THE USER-LEVEL FILE. A workstream is a repository, and a developer's
 * Stream Deck is meant to triage attention across several of them at once —
 * so the hooks have to fire in whichever repository Claude Code happens to be
 * running in, not only this one. `~/.claude/settings.json` applies to every
 * project; a project-scoped `.claude/settings.json` would only help inside
 * this repository, which is not the point of the feature.
 *
 * WHY THIS WRITES OUTSIDE THE REPO AT ALL. The hooks genuinely have to live
 * in the developer's own Claude Code configuration — there is no way to scope
 * a hook to "wherever Herdr happens to be" from inside this repo alone. That
 * is a real side effect on the user's machine, which is why this script backs
 * up what it found before changing anything and never runs itself as a side
 * effect of another command.
 *
 * SAFE TO RUN TWICE. Every hook entry it would add is checked against what is
 * already there — by the exact command string, not just the event name — so
 * a second run changes nothing and reports as much. Everything already in the
 * file that this script did not add is left completely alone: existing hook
 * entries for other tools, other settings, formatting choices outside the
 * `hooks` object.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(new URL("./herdr-attention", import.meta.url));

/**
 * Which Claude Code hook fires which declaration. ADR-0005 records why each
 * event was picked over the alternatives (`PermissionRequest` over the
 * always-firing `PreToolUse`, `notification_type` over a bare `Notification`,
 * three separate clearing events over one).
 */
const HOOK_SUBCOMMANDS = {
  Notification: "notification",
  PermissionRequest: "approval",
  Stop: "finished",
  SessionStart: "clear",
  UserPromptSubmit: "clear",
  PreToolUse: "clear"
};

export function defaultTarget() {
  return join(homedir(), ".claude", "settings.json");
}

/** Every event/command pair this installer wants present, built from one script path. */
export function desiredHooks(scriptPath = SCRIPT_PATH) {
  return Object.entries(HOOK_SUBCOMMANDS).map(([event, subcommand]) => ({
    event,
    command: `${scriptPath} ${subcommand}`
  }));
}

/** Whether one event's hook array already carries this exact command. */
function hasCommand(entries, command) {
  return (entries ?? []).some(
    (entry) => Array.isArray(entry.hooks) && entry.hooks.some((hook) => hook.type === "command" && hook.command === command)
  );
}

/**
 * Adds whatever `desiredHooks` describes that `settings` does not already
 * have, mutating a clone rather than the input. Every existing key, and every
 * existing entry in a `hooks` array this touches, survives untouched — only
 * new entries are appended.
 *
 * Returns the new settings object plus which events actually gained an entry,
 * so the caller can report a true no-op distinctly from a real change.
 */
export function withHooksInstalled(settings, scriptPath = SCRIPT_PATH) {
  const next = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const added = [];

  for (const { event, command } of desiredHooks(scriptPath)) {
    const existing = next.hooks[event] ?? [];
    if (hasCommand(existing, command)) continue;
    next.hooks[event] = [...existing, { hooks: [{ type: "command", command }] }];
    added.push(event);
  }

  return { settings: next, added };
}

/** Reads a settings file, or `{}` for one that does not exist yet. */
function readSettings(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON, so it was left untouched. Fix or remove it and rerun. (${error.message})`
    );
  }
}

function backupPathFor(target) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${target}.bak.${stamp}`;
}

/**
 * Installs the hooks into `target`, or reports what would change when
 * `dryRun` is set. Never writes when nothing would change, so a second real
 * run leaves no new backup either.
 */
export function install({ target = defaultTarget(), scriptPath = SCRIPT_PATH, dryRun = false } = {}) {
  if (existsSync(scriptPath)) chmodSync(scriptPath, 0o755);

  const before = readSettings(target);
  const { settings: after, added } = withHooksInstalled(before, scriptPath);

  if (added.length === 0) {
    return { target, added, backup: null, wrote: false };
  }

  if (dryRun) {
    return { target, added, backup: null, wrote: false };
  }

  mkdirSync(dirname(target), { recursive: true });
  let backup = null;
  if (existsSync(target)) {
    backup = backupPathFor(target);
    copyFileSync(target, backup);
  }
  writeFileSync(target, `${JSON.stringify(after, null, 2)}\n`);
  return { target, added, backup, wrote: true };
}

function report({ target, added, backup, wrote }, dryRun) {
  if (added.length === 0) {
    console.log(`Herdr's attention hooks are already installed in ${target}. Nothing changed.`);
    return;
  }
  const verb = dryRun ? "Would add" : "Added";
  console.log(`${verb} hooks for: ${added.join(", ")}`);
  console.log(`${dryRun ? "Target" : "Wrote"}: ${target}`);
  if (backup) console.log(`Backed up the previous file to: ${backup}`);
  if (!wrote && !dryRun) console.log("Nothing was written.");
}

function parseArgs(argv) {
  const args = { dryRun: false, target: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--target") args.target = argv[++i];
    else throw new Error(`unrecognised argument: ${argv[i]}`);
  }
  if (args.target !== undefined && !isAbsolute(args.target)) args.target = resolve(args.target);
  return args;
}

// Only run as a CLI when executed directly, not when imported by the tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { dryRun, target } = parseArgs(process.argv.slice(2));
    const result = install({ ...(target ? { target } : {}), dryRun });
    report(result, dryRun);
  } catch (error) {
    console.error(`install-herdr-hooks: ${error.message}`);
    process.exit(1);
  }
}
