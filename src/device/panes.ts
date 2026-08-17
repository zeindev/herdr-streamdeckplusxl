import type { AgentStatus, PaneProcess, PaneSnapshot } from "../model.js";
import { REASON_ORDER, type AttentionReason } from "./attention.js";
import { ROLE_ROWS, programNameOf, type Role } from "./role.js";
import type { Workstream } from "./workstream.js";

/**
 * What one key of a channel's pane area holds.
 *
 * A `more` cell is the answer to a role having more panes than its row has keys.
 * It exists so that no pane can vanish quietly: the count is the device saying
 * there is something it is not showing.
 */
export type PaneCell =
  | { kind: "pane"; pane: PaneSnapshot; role: Role }
  /**
   * `panes` is the panes the count stands for, not just how many. Anything that
   * marks a key needs to know whether one of the panes behind this count is
   * asking for the developer — otherwise the strip's total could rise with
   * nothing anywhere on the grid to explain it.
   */
  | { kind: "more"; count: number; panes: readonly PaneSnapshot[] };

/**
 * A workstream's panes laid out across its channel's rows, one row per role.
 *
 * The row a pane occupies is its role, and roles are aligned across all three
 * channels, so reading across a row compares every test watcher side by side
 * (ADR-0003). Position therefore has to be a function of role and nothing else —
 * in particular not of arrival order, which changes whenever a pane is opened.
 */
export function paneRowsOf(
  panes: readonly PaneSnapshot[],
  roleFor: (pane: PaneSnapshot) => Role,
  columns: number
): Array<Array<PaneCell | null>> {
  const byRole = new Map<Role, PaneSnapshot[]>();
  for (const pane of panes) {
    const role = roleFor(pane);
    const existing = byRole.get(role);
    if (existing) existing.push(pane);
    else byRole.set(role, [pane]);
  }

  return ROLE_ROWS.map((roles) => {
    // Within a shared row the roles keep the order the row declares, and within
    // a role the panes are sorted, so nothing moves because a pane was opened.
    const ordered = roles.flatMap((role) =>
      [...(byRole.get(role) ?? [])]
        .sort((left, right) => left.pane_id.localeCompare(right.pane_id))
        .map((pane): PaneCell => ({ kind: "pane", pane, role }))
    );
    return fitRow(ordered, columns);
  });
}

/**
 * One channel's rows: its workstream's panes and nobody else's.
 *
 * A channel with no workstream has no panes to show, which is different from
 * having none running — the key that offers a worktree says which.
 */
export function channelRows(
  workstream: Workstream | null,
  panes: readonly PaneSnapshot[],
  roleFor: (pane: PaneSnapshot) => Role,
  columns: number
): Array<Array<PaneCell | null>> {
  const mine = workstream ? panes.filter((pane) => pane.workspace_id === workstream.workspaceId) : [];
  return paneRowsOf(mine, roleFor, columns);
}

/**
 * What a pane is called on its key.
 *
 * `terminal_title_stripped` is deliberately not in this list, though it is the
 * most descriptive thing Herdr offers. An agent rewrites its terminal title as
 * it works — the live capture caught titles like "Plan plugin refactor" — so
 * using it would rename the key every few seconds and redraw it every time,
 * which is exactly the flood the whole surface is built to avoid.
 *
 * What is left is stable: the name the developer gave the pane, then the agent
 * or program actually running in it, then the directory it is in.
 */
export function paneKeyLabel(pane: PaneSnapshot, process: PaneProcess | undefined, role: Role): string {
  const chosen = pane.label?.trim();
  if (chosen) return chosen;
  if (role === "agent" && pane.agent?.trim()) return pane.agent.trim();
  // The same derivation detection uses, so a key can never be labelled with one
  // program while being placed by another.
  const program = programNameOf(process);
  if (program) return program;
  return directoryOf(pane.cwd) || pane.pane_id;
}

/**
 * A workstream's own agent pane — the same one its channel's agent row shows
 * first, so the actions key's prompt and interrupt never target a different
 * pane than the one on row 0.
 */
export function agentPaneOf(workspaceId: string, panes: readonly PaneSnapshot[]): PaneSnapshot | undefined {
  return panes
    .filter((pane) => pane.workspace_id === workspaceId && pane.agent)
    .sort((left, right) => left.pane_id.localeCompare(right.pane_id))[0];
}

/**
 * A workstream's most urgent pane, chosen by a defined ranking (`-vk6`): the
 * Mini has room for exactly one pane per channel, so which one earns the key
 * has to be decided somewhere, not left implicit.
 *
 * 1. Whichever pane is asking, in `REASON_ORDER` — the same priority a
 *    `more` key already uses to pick which hidden reason to show, so the
 *    Mini and the XL agree about what "most urgent" means.
 * 2. Failing that, whichever pane is actively `working` — the one most
 *    likely to become interesting next.
 * 3. Failing that, any pane running an agent at all.
 * 4. Failing that, any pane the workstream has.
 *
 * Each step breaks ties by `pane_id`, so the choice never depends on Herdr's
 * own listing order and never flickers between two equally-ranked panes on a
 * redraw neither of them caused.
 */
export function mostUrgentPaneOf(
  workstream: Workstream,
  panes: readonly PaneSnapshot[],
  attention: ReadonlyMap<string, AttentionReason>
): PaneSnapshot | undefined {
  const mine = panes
    .filter((pane) => pane.workspace_id === workstream.workspaceId)
    .sort((left, right) => left.pane_id.localeCompare(right.pane_id));
  if (mine.length === 0) return undefined;

  for (const reason of REASON_ORDER) {
    const asking = mine.find((pane) => attention.get(pane.pane_id) === reason);
    if (asking) return asking;
  }
  return mine.find((pane) => pane.agent && pane.agent_status === "working") ?? mine.find((pane) => pane.agent) ?? mine[0];
}

/** `blocked` first, since it needs the developer; `working` and `done` next, most active first; `idle` last; `undefined` for no agents at all. */
const AGENT_STATUS_PRIORITY: readonly AgentStatus[] = ["blocked", "working", "done", "idle"];

/**
 * A workstream's aggregated agent state (`-vk6`): the Mini has no room to
 * show every pane individually, so its top-row key needs one status that
 * stands for the whole channel. Only agent panes are counted — a pane with
 * no agent reports Herdr's `unknown` for every service, and folding that
 * into the aggregate would drown out a channel with one real agent and four
 * quiet shells.
 */
export function channelAgentStatus(workstream: Workstream, panes: readonly PaneSnapshot[]): AgentStatus | undefined {
  const statuses = new Set(
    panes.filter((pane) => pane.workspace_id === workstream.workspaceId && pane.agent).map((pane) => pane.agent_status)
  );
  return AGENT_STATUS_PRIORITY.find((status) => statuses.has(status));
}

function directoryOf(cwd: string | undefined): string {
  return cwd?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

/**
 * Fits one row's panes into its keys, counting whatever will not fit.
 *
 * The last key becomes the count rather than the row simply ending, because a
 * pane that is silently absent is worse than one the device admits it cannot
 * show — the whole surface is only worth trusting if it never hides anything.
 */
function fitRow(cells: readonly PaneCell[], columns: number): Array<PaneCell | null> {
  const row: Array<PaneCell | null> = Array.from({ length: columns }, () => null);
  if (cells.length <= columns) {
    cells.forEach((cell, column) => (row[column] = cell));
    return row;
  }
  for (let column = 0; column < columns - 1; column++) row[column] = cells[column];
  const covered = cells.slice(columns - 1);
  row[columns - 1] = {
    kind: "more",
    count: covered.length,
    panes: covered.flatMap((cell) => (cell.kind === "pane" ? [cell.pane] : []))
  };
  return row;
}
