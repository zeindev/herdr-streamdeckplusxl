import {
  agentStatusOfPanes,
  type AgentStatus,
  type HerdrSnapshot,
  type PaneSnapshot,
  type WorkspaceSnapshot
} from "../model.js";

/**
 * What a workstream's checkout is, as the device needs it.
 *
 * `branch` is separate from the rest because Herdr reports it separately: the
 * snapshot's worktree block has no branch at all, so it stays null until a
 * `worktree.list` reply supplies one. A channel therefore renders correctly
 * before the branch is known rather than waiting for it.
 */
export type WorkstreamWorktree = {
  repoKey: string;
  repoName: string;
  repoRoot: string;
  checkoutPath: string;
  isLinked: boolean;
  branch: string | null;
};

/**
 * One delivery effort as the device understands it.
 *
 * ADR-0001 defines a workstream as a worktree-backed Herdr workspace, but
 * ADR-0009 lets a workspace with no worktree — the primary checkout — occupy a
 * slot like any other. `worktree` is therefore nullable, and the device says so
 * on the face rather than dropping the workspace and leaving a hole.
 */
export type Workstream = {
  workspaceId: string;
  label: string;
  paneCount: number;
  /** Undefined when no pane in the workspace runs an agent. */
  agentStatus: AgentStatus | undefined;
  worktree: WorkstreamWorktree | null;
};

/** Branches known so far, keyed by checkout path. */
export type Branches = Readonly<Record<string, string>>;

/**
 * Every workspace Herdr holds, as workstreams, in the order channels take them.
 *
 * Order is Herdr's workspace `number`, which is stable for the life of a
 * workspace, with the id breaking ties so the same snapshot always yields the
 * same order. Durable slot assignment, the three-slot cap, and the overflow
 * count belong to a later ticket; until then position follows this order.
 */
export function workstreamsOf(snapshot: HerdrSnapshot | null, branches: Branches = {}): Workstream[] {
  if (!snapshot) return [];
  const panesByWorkspace = groupPanesByWorkspace(snapshot.panes);
  return [...(snapshot.workspaces ?? [])]
    .sort(byNumberThenId)
    .map((workspace) => toWorkstream(workspace, panesByWorkspace.get(workspace.workspace_id) ?? [], branches));
}

/**
 * The workspace each channel shows, one entry per channel. A channel with no
 * workstream holds null, which is what makes an empty slot a rendered thing
 * rather than an absence.
 */
export function channelWorkstreams(workstreams: readonly Workstream[], channels: number): Array<Workstream | null> {
  return Array.from({ length: channels }, (_, channel) => workstreams[channel] ?? null);
}

function toWorkstream(workspace: WorkspaceSnapshot, panes: PaneSnapshot[], branches: Branches): Workstream {
  const worktree = workspace.worktree;
  return {
    workspaceId: workspace.workspace_id,
    label: workspace.label?.trim() || (workspace.number ? `SPACE ${workspace.number}` : workspace.workspace_id),
    // The snapshot's own count is authoritative even when the pane list is
    // partial, and the panes are the fallback when it is absent.
    paneCount: workspace.pane_count ?? panes.length,
    agentStatus: agentStatusOfPanes(panes),
    worktree: worktree
      ? {
          repoKey: worktree.repo_key,
          repoName: worktree.repo_name,
          repoRoot: worktree.repo_root,
          checkoutPath: worktree.checkout_path,
          isLinked: worktree.is_linked_worktree,
          branch: branches[worktree.checkout_path] ?? null
        }
      : null
  };
}

function groupPanesByWorkspace(panes: readonly PaneSnapshot[]): Map<string, PaneSnapshot[]> {
  const grouped = new Map<string, PaneSnapshot[]>();
  for (const pane of panes) {
    if (!pane.workspace_id) continue;
    const existing = grouped.get(pane.workspace_id);
    if (existing) existing.push(pane);
    else grouped.set(pane.workspace_id, [pane]);
  }
  return grouped;
}

function byNumberThenId(left: WorkspaceSnapshot, right: WorkspaceSnapshot): number {
  const difference = (left.number ?? Number.MAX_SAFE_INTEGER) - (right.number ?? Number.MAX_SAFE_INTEGER);
  return difference !== 0 ? difference : left.workspace_id.localeCompare(right.workspace_id);
}

/**
 * The distinct repositories among these workstreams, each named by one of its
 * workspaces. `worktree.list` answers for a whole repository at once, so asking
 * once per repository rather than once per workstream is the same answer for
 * fewer requests.
 */
export function repositoriesToQuery(workstreams: readonly Workstream[]): Array<{ repoKey: string; workspaceId: string }> {
  const byRepo = new Map<string, string>();
  for (const workstream of workstreams) {
    if (!workstream.worktree) continue;
    if (!byRepo.has(workstream.worktree.repoKey)) byRepo.set(workstream.worktree.repoKey, workstream.workspaceId);
  }
  return [...byRepo].map(([repoKey, workspaceId]) => ({ repoKey, workspaceId }));
}
