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
export type WorkspaceSnapshot = { workspace_id: string; label?: string; number?: number };

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

export type PaneIdentity = { primary: string; context?: string };

/** How the working-state animation is drawn on a key. */
export type WorkingMotion = "darken" | "lighten" | "rainbow";
export const MOTION_BASE_WIDTH = 1.4;

/**
 * Unwraps Herdr's `session.snapshot` reply, which nests the snapshot inside
 * `result`. Returns undefined rather than throwing when the shape is not what
 * this protocol version expects.
 */
export function snapshotFromApi(value: unknown): HerdrSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = (value as { result?: unknown }).result;
  if (!result || typeof result !== "object") return undefined;
  const candidate = (result as { snapshot?: unknown }).snapshot ?? result;
  if (!candidate || typeof candidate !== "object" || !Array.isArray((candidate as HerdrSnapshot).panes)) return undefined;
  return candidate as HerdrSnapshot;
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
