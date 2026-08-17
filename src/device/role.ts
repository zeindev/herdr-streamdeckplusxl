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
  const command = process?.cmdline?.trim() || process?.argv0?.trim();
  return command || undefined;
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
 * Patterns matched against a command line, most specific first.
 *
 * Order is the whole design here: `npm test` and `npm run dev` differ only in
 * their script, and a test watcher started through a package manager must not be
 * read as a dev server just because both begin `npm run`.
 */
const PATTERNS: ReadonlyArray<{ role: Role; pattern: RegExp }> = [
  // Following a log is unmistakable and would otherwise match nothing.
  { role: "logs", pattern: /\btail\b[^|]*\s-[a-zA-Z]*f|\bjournalctl\b[^|]*\s(-f|--follow)|\blogs\b[^|]*\s(-f|--follow)/ },
  {
    role: "tests",
    pattern:
      /\b(vitest|jest|pytest|mocha|karma|phpunit|rspec|nyc|playwright|cypress)\b|\b(npm|pnpm|yarn|bun|deno)\s+(run\s+)?tests?\b|\b(cargo|go|dotnet|mix|swift)\s+test\b|\bnode\s+--test\b/
  },
  {
    role: "server",
    pattern:
      /\b(vite|next|nuxt|nodemon|uvicorn|gunicorn|puma|unicorn|webpack|esbuild|parcel|serve|http-server|ng)\b|\b(npm|pnpm|yarn|bun|deno)\s+(run\s+)?(dev|start|serve|watch)\b|\b(rails|flask|django-admin|manage\.py)\b|\bdocker[\s-]compose\b[^|]*\bup\b|\bcargo\s+(run|watch)\b/
  },
  // A login shell arrives as "-zsh", so the dash is part of the shape.
  { role: "shell", pattern: /^-?(z|ba|k|c|t|fi)?sh\b/ }
];

function detectedRole(process: PaneProcess | undefined): Role {
  const command = process?.cmdline?.trim() || process?.argv0?.trim();
  if (!command) return "shell";
  const basename = command.replace(/^-/, "").split(/\s+/)[0].split(/[\\/]/).pop() ?? "";
  for (const { role, pattern } of PATTERNS) {
    if (pattern.test(command) || pattern.test(basename)) return role;
  }
  // An unrecognised program is a shell rather than nothing: it is something the
  // developer is running by hand, which is what the shell row is for.
  return "shell";
}
