import type { PaneProcess, PaneProcessInfo, PaneSnapshot } from "../model.js";

/**
 * What a pane is for, and therefore which row of its channel it sits on.
 *
 * The vocabulary is fixed: adding a role changes the layout of every channel at
 * once (ADR-0003), so this is a closed set rather than an open one.
 */
export type Role = "agent" | "server" | "tests" | "logs" | "shell";

/**
 * The roles each row of a channel's pane area holds, top to bottom.
 *
 * Roles are aligned across all three channels, so reading down a channel shows
 * one workstream and reading across a row compares every test watcher, or every
 * dev server, side by side. The third row is shared because three roles that are
 * each usually one pane fit together better than three rows mostly empty.
 */
export const ROLE_ROWS: ReadonlyArray<readonly Role[]> = [["agent"], ["server"], ["tests", "logs", "shell"]];

/** Every role, in the order rows and cycling take them. */
export const ROLES: readonly Role[] = ROLE_ROWS.flat();

/**
 * The process that says what a pane is for.
 *
 * Not the first in the list, which is the mistake this exists to prevent: a
 * coding agent spawns its own children, and a live capture showed an agent pane
 * whose first foreground process was an MCP server it had started. The process
 * that identifies the pane is the one leading the foreground group, so that is
 * the one matched on.
 */
export function identifyingProcess(info: PaneProcessInfo | undefined): PaneProcess | undefined {
  const processes = info?.foreground_processes;
  if (!processes?.length) return undefined;
  const leader = processes.find((process) => process.pid === info?.foreground_process_group_id);
  // Falling back to the last entry rather than the first: children are listed
  // before the process that spawned them.
  return leader ?? processes[processes.length - 1];
}

/**
 * How an override remembers a pane, so it outlives the pane being restarted.
 *
 * The command line rather than the pane id, because a dev server restarted after
 * a crash is the same job with a new pane. `argv0` is included because a bare
 * command line can be ambiguous, and `name` is deliberately excluded — a live
 * capture showed Claude reporting its process `name` as its version string,
 * `2.1.233`, which would key an override to a release.
 */
export function commandKeyOf(process: PaneProcess | undefined): string | undefined {
  return commandLineOf(process) || undefined;
}

/**
 * The command line a pane is running, as one string.
 *
 * `cmdline` first because it carries the arguments, and the arguments are where
 * the meaning usually is — `npm` alone says nothing.
 */
export function commandLineOf(process: PaneProcess | undefined): string {
  return process?.cmdline?.trim() || process?.argv0?.trim() || "";
}

/**
 * The name of the program a pane is running, with no path and no arguments.
 *
 * Runners are stepped over, so `npx vitest` names vitest rather than npx. This
 * is what a key is labelled with as well as what detection matches on, so the
 * two can never disagree about which program a pane is running.
 */
export function programNameOf(process: PaneProcess | undefined): string {
  return programToken(commandLineOf(process));
}

/**
 * What a pane is for, worked out from what is actually running in it.
 *
 * Never from terminal output, which `DESIGN.md` bans and which would make the
 * surface untrustworthy. The order is: an override the developer set, then
 * Herdr's own agent detection, then the foreground process.
 */
export function roleOf(pane: PaneSnapshot, process: PaneProcess | undefined, overrides: RoleOverrides = {}): Role {
  const overridden = overrides[commandKeyOf(process) ?? ""];
  if (overridden && ROLES.includes(overridden)) return overridden;
  // Herdr detects agents itself and pushes the answer on the snapshot, so an
  // agent needs no process lookup and cannot be got wrong by pattern matching.
  if (pane.agent) return "agent";
  return detectedRole(process);
}

/** Roles the developer has corrected, keyed by command line. */
export type RoleOverrides = Readonly<Record<string, Role>>;

/** What Herdr has told us is running in each pane, by pane id. */
export type PaneProcesses = Readonly<Record<string, PaneProcess | null>>;

/**
 * Binds the two lookups a role needs into one function of a pane, so the reducer
 * and the projection answer "what is this pane for" the same way.
 */
export function roleResolver(processes: PaneProcesses, overrides: RoleOverrides): (pane: PaneSnapshot) => Role {
  return (pane) => roleOf(pane, processes[pane.pane_id] ?? undefined, overrides);
}

/**
 * Reads role corrections back out of stored settings.
 *
 * Nothing is trusted: settings can be written by an older version or edited by
 * hand, and a role this version does not have would silently place a pane
 * nowhere. Anything unreadable is simply not a correction.
 */
export function readRoles(stored: unknown): RoleOverrides {
  const roles = (stored as { roles?: unknown } | null | undefined)?.roles;
  if (!roles || typeof roles !== "object") return {};
  const entries = Object.entries(roles as Record<string, unknown>).filter(
    (entry): entry is [string, Role] => typeof entry[1] === "string" && ROLES.includes(entry[1] as Role)
  );
  return Object.fromEntries(entries);
}

/** The shape written to settings. Kept beside `readRoles` so the two agree. */
export function storedRoles(roles: RoleOverrides): { roles: Record<string, Role> } {
  return { roles: { ...roles } };
}

/** The role after this one, wrapping, which is what holding a pane key does. */
export function nextRole(role: Role): Role {
  return ROLES[(ROLES.indexOf(role) + 1) % ROLES.length];
}

/**
 * Ways of running something else, which say nothing about what a pane is for.
 *
 * `npx vitest` is a test watcher and `pnpm exec jest` is too, so the runner is
 * stepped over to reach the program that actually matters.
 */
const RUNNERS: ReadonlySet<string> = new Set([
  "npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx", "deno", "poetry", "uv", "uvx", "pipenv", "bundle", "exec", "run"
]);

/**
 * Programs recognised by name, matched against a whole token and never against
 * the middle of the command line.
 *
 * Whole-token matching is the point. Searching the line for `next` reads
 * `nvim next.config.js` as a dev server, which is the kind of confident wrong
 * answer that teaches a developer to stop believing the device.
 */
const PROGRAMS: ReadonlyArray<{ role: Role; names: ReadonlySet<string> }> = [
  {
    role: "tests",
    names: new Set(["vitest", "jest", "pytest", "mocha", "karma", "phpunit", "rspec", "nyc", "playwright", "cypress", "ava"])
  },
  {
    role: "server",
    names: new Set([
      "vite", "next", "nuxt", "nodemon", "uvicorn", "gunicorn", "puma", "unicorn", "webpack", "esbuild",
      "parcel", "serve", "http-server", "ng", "rails", "flask", "hugo", "jekyll"
    ])
  },
  { role: "shell", names: new Set(["sh", "zsh", "bash", "fish", "ksh", "csh", "tcsh", "dash", "nu", "xonsh"]) }
];

/**
 * Ways of asking a runner to do something, where the subcommand is what counts.
 *
 * These do match across the line, because that is where the meaning is: `npm`
 * alone says nothing and `npm run dev` says everything. Tests come before
 * servers because the two differ only in their script.
 */
const INVOCATIONS: ReadonlyArray<{ role: Role; pattern: RegExp }> = [
  // Only the part before a pipe is the job: `tail -f x | grep y` is still a log
  // follow, but `grep -f patterns x` on the right of one is not.
  { role: "logs", pattern: /\btail\b[^|]*\s-[a-zA-Z]*[fF]\b|\bjournalctl\b[^|]*\s(-f|--follow)\b|\blogs\b[^|]*\s(-f|--follow)\b/ },
  {
    role: "tests",
    pattern:
      /\b(npm|pnpm|yarn|bun|deno)\s+(run\s+)?tests?\b|\b(cargo|go|dotnet|mix|swift|zig)\s+test\b|\bnode\s+--test\b|\bpytest\b|\bmanage\.py\s+test\b|\bgradlew?\s+test\b/
  },
  {
    role: "server",
    pattern:
      /\b(npm|pnpm|yarn|bun|deno)\s+(run\s+)?(dev|start|serve|watch)\b|\bdocker[\s-]compose\b[^|]*\bup\b|\bcargo\s+(run|watch)\b|\bmanage\.py\s+runserver\b/
  }
];

/**
 * What a command line says a pane is for.
 *
 * An unrecognised program is a shell rather than nothing: it is something the
 * developer is running by hand, which is what the shell row is for.
 */
function detectedRole(process: PaneProcess | undefined): Role {
  const command = commandLineOf(process);
  if (!command) return "shell";

  for (const { role, pattern } of INVOCATIONS) {
    if (pattern.test(command)) return role;
  }

  const named = programToken(command);
  for (const { role, names } of PROGRAMS) {
    if (names.has(named)) return role;
  }
  return "shell";
}

/** The first token that names a program rather than a way of running one. */
function programToken(command: string): string {
  const tokens = command.split(/\s+/).map(basenameOf).filter(Boolean);
  return tokens.find((token) => !RUNNERS.has(token)) ?? tokens[0] ?? "";
}

/** A token's program name: no path, no leading dash from a login shell, no arguments. */
function basenameOf(token: string): string {
  return token.replace(/^-/, "").split(/[\\/]/).pop() ?? "";
}
