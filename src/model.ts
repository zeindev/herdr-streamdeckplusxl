export type RgbColor = { r: number; g: number; b: number };

export type ThemePalette = {
  accent: RgbColor | null;
  panel_bg: RgbColor | null;
  surface0: RgbColor | null;
  surface1: RgbColor | null;
  surface_dim: RgbColor | null;
  overlay0: RgbColor | null;
  overlay1: RgbColor | null;
  text: RgbColor | null;
  subtext0: RgbColor | null;
  mauve: RgbColor | null;
  green: RgbColor | null;
  yellow: RgbColor | null;
  red: RgbColor | null;
  blue: RgbColor | null;
  teal: RgbColor | null;
  peach: RgbColor | null;
};

export type ThemeSnapshot = {
  name: string;
  appearance: "dark" | "light" | null;
  palette: ThemePalette;
};

export type ResolvedThemeSnapshot = ThemeSnapshot & {
  appearance: "dark" | "light";
  palette: { [K in keyof ThemePalette]: RgbColor };
};

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type PaneSnapshot = {
  pane_id: string;
  agent?: string;
  workspace_id?: string;
  tab_id?: string;
  terminal_id?: string;
  focused: boolean;
  agent_status: AgentStatus;
  agent_session?: AgentSessionRef;
  label?: string;
  terminal_title_stripped?: string;
  cwd?: string;
};

export type TabSnapshot = { tab_id: string; workspace_id: string; label?: string; number?: number };

/**
 * The worktree details Herdr attaches to a workspace.
 *
 * Note what is absent: there is no branch here. Herdr's `WorkspaceWorktreeInfo`
 * carries exactly these five fields, and the branch lives on `WorktreeEntry`,
 * which only `worktree.list` and the `worktree_*` events return.
 */
export type WorkspaceWorktreeSnapshot = {
  repo_key: string;
  repo_name: string;
  repo_root: string;
  checkout_path: string;
  is_linked_worktree: boolean;
};

export type WorkspaceSnapshot = {
  workspace_id: string;
  label?: string;
  number?: number;
  focused?: boolean;
  pane_count?: number;
  tab_count?: number;
  /**
   * Herdr's own aggregate over the workspace's panes. Correct when read, but
   * never pushed — see `agentStatusOfPanes`, which is what keeps a channel live.
   */
  agent_status?: AgentStatus;
  /** Null for a workspace that is not a checkout Herdr tracks. */
  worktree?: WorkspaceWorktreeSnapshot | null;
  tokens?: Record<string, string>;
};

/** One entry of a `worktree.list` reply: the only place a branch is reported. */
export type WorktreeEntry = {
  path: string;
  branch?: string | null;
  label?: string;
  is_linked_worktree?: boolean;
  open_workspace_id?: string | null;
};

export type AgentSessionRef = {
  source: string;
  agent: string;
  kind: string;
  value: string;
};

export type HerdrSnapshot = {
  focused_pane_id?: string;
  panes: PaneSnapshot[];
  tabs?: TabSnapshot[];
  workspaces?: WorkspaceSnapshot[];
  theme?: ThemeSnapshot;
};

/**
 * How a pane is named on the device. Kept with `paneLabel` and `paneIdentity`
 * below: nothing calls them yet, but they encode the fallback order (label,
 * then terminal title, then the working directory's basename) that the ticket
 * placing panes on keys depends on, and which would be re-derived worse.
 */
export type PaneIdentity = { primary: string; context?: string };

/** How the working-state animation is drawn on a key. */
export type WorkingMotion = "darken" | "lighten" | "rainbow";
export const MOTION_BASE_WIDTH = 1.4;

/**
 * Reads the snapshot out of a `session.snapshot` result, which nests it under
 * `snapshot`. Returns undefined rather than throwing when the shape is not what
 * this protocol version expects.
 */
export function snapshotFromResult(result: Record<string, unknown>): HerdrSnapshot | undefined {
  const candidate = result.snapshot ?? result;
  if (!candidate || typeof candidate !== "object" || !Array.isArray((candidate as HerdrSnapshot).panes)) return undefined;
  return candidate as HerdrSnapshot;
}

/**
 * Reads the worktrees out of a `worktree.list` result. Returns an empty list
 * rather than throwing when the shape is not what this protocol version expects,
 * so a branch that cannot be read leaves the rest of the device working.
 */
export function worktreesFromResult(result: Record<string, unknown>): WorktreeEntry[] {
  const worktrees = result.worktrees;
  if (!Array.isArray(worktrees)) return [];
  return worktrees.filter(
    (entry): entry is WorktreeEntry => Boolean(entry) && typeof (entry as WorktreeEntry).path === "string"
  );
}

/**
 * How urgently a status wants the developer, most urgent first.
 *
 * `blocked` is an agent waiting on input and `done` is finished work not yet
 * picked up, so both need someone; `working` and `idle` do not. `unknown` is
 * last because it carries no reading at all (ADR-0005).
 */
const AGENT_STATUS_URGENCY: readonly AgentStatus[] = ["blocked", "done", "working", "idle", "unknown"];

/**
 * The single agent status for a group of panes: the most urgent one any agent in
 * it reports, or undefined when none of them runs an agent.
 *
 * This exists because `WorkspaceSnapshot.agent_status` is never pushed. Verified
 * against Herdr 0.8.0: a 45-second listen on every global subscription saw 417
 * `pane_updated` events carrying 8 agent-status changes, and zero
 * `workspace_updated`. Reading Herdr's aggregate would therefore freeze a
 * channel at whatever it was when the snapshot was last re-read, so the aggregate
 * is recomputed from the panes that `pane_updated` does keep current.
 *
 * Only panes actually running an agent are counted. A pane with no agent reports
 * `unknown` — four of five panes did on the live session — so counting them would
 * drown a real reading in noise.
 */
export function agentStatusOfPanes(panes: readonly PaneSnapshot[]): AgentStatus | undefined {
  let best: AgentStatus | undefined;
  for (const pane of panes) {
    if (!pane.agent) continue;
    if (!best || urgencyOf(pane.agent_status) < urgencyOf(best)) best = pane.agent_status;
  }
  return best;
}

/** A status this protocol version does not know ranks last, never first. */
function urgencyOf(status: AgentStatus): number {
  const rank = AGENT_STATUS_URGENCY.indexOf(status);
  return rank < 0 ? AGENT_STATUS_URGENCY.length : rank;
}

export function paneLabel(pane: PaneSnapshot | undefined, fallback: string): string {
  if (!pane) return fallback;
  if (pane.label?.trim()) return pane.label.trim();
  if (pane.terminal_title_stripped?.trim()) return pane.terminal_title_stripped.trim();
  const cwd = pane.cwd?.replace(/[\\/]+$/, "");
  return cwd?.split(/[\\/]/).pop() || fallback;
}

export function paneIdentity(pane: PaneSnapshot | undefined, snapshot: HerdrSnapshot | null, fallback: string): PaneIdentity {
  if (!pane) return { primary: fallback };
  const workspace = snapshot?.workspaces?.find((item) => item.workspace_id === pane.workspace_id);
  const tab = snapshot?.tabs?.find((item) => item.tab_id === pane.tab_id);
  const repo = pane.cwd?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  const primary = firstDistinct(pane.label, pane.terminal_title_stripped, repo, fallback) || fallback;
  const workspaceLabel = cleanLabel(workspace?.label) || (workspace?.number ? `SPACE ${workspace.number}` : undefined);
  const rawTab = cleanLabel(tab?.label);
  const tabLabel = rawTab ? (/^\d+$/.test(rawTab) ? `T${rawTab}` : rawTab) : (tab?.number ? `T${tab.number}` : undefined);
  const context = [workspaceLabel, tabLabel].filter((value, index, values) => value && value !== primary && values.indexOf(value) === index).join(" › ");
  return { primary, ...(context ? { context } : {}) };
}


export function hasResolvedTheme(theme: ThemeSnapshot | undefined): theme is ResolvedThemeSnapshot {
  return Boolean(theme?.appearance && Object.values(theme.palette).every((token) => token !== null));
}



function cleanLabel(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function firstDistinct(...values: Array<string | undefined>): string | undefined {
  return values.map(cleanLabel).find(Boolean);
}
