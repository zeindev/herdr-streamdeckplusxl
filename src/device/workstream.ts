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
 * snapshot's worktree block has no branch at all, so it arrives only with a
 * `worktree.list` reply. A channel therefore renders correctly before the branch
 * is known rather than waiting for it.
 *
 * Its three values are three different facts, and the device says which:
 * a name, `null` for a checkout on no branch at all, and `undefined` for one
 * Herdr has not been asked about yet.
 */
export type WorkstreamWorktree = {
  repoKey: string;
  repoName: string;
  repoRoot: string;
  checkoutPath: string;
  isLinked: boolean;
  branch: string | null | undefined;
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
  /** Undefined when no pane in the workspace runs an agent. */
  agentStatus: AgentStatus | undefined;
  worktree: WorkstreamWorktree | null;
};

/**
 * Branches Herdr has answered for, keyed by checkout path. A null value is an
 * answer — a checkout on no branch — while a missing key means not yet asked.
 */
export type Branches = Readonly<Record<string, string | null>>;

/**
 * Every workspace Herdr holds, as workstreams, in the order channels take them.
 *
 * Order is Herdr's workspace `number`, with the id breaking ties so the same
 * snapshot always yields the same order.
 *
 * This order decides only which workstream is offered a free channel first, and
 * in what order overflow is listed. It does **not** decide which channel a
 * workstream ends up in — `slots.ts` owns that, and keeps it fixed for the life
 * of the workstream, so the shuffle this order would otherwise cause cannot
 * reach the device (ADR-0009).
 */
export function workstreamsOf(snapshot: HerdrSnapshot | null, branches: Branches = {}): Workstream[] {
  if (!snapshot) return [];
  const panesByWorkspace = groupPanesByWorkspace(snapshot.panes);
  return [...(snapshot.workspaces ?? [])]
    .sort(byNumberThenId)
    .map((workspace) => toWorkstream(workspace, panesByWorkspace.get(workspace.workspace_id) ?? [], branches));
}

function toWorkstream(workspace: WorkspaceSnapshot, panes: PaneSnapshot[], branches: Branches): Workstream {
  const worktree = workspace.worktree;
  return {
    workspaceId: workspace.workspace_id,
    label: workspace.label?.trim() || (workspace.number ? `WORKSPACE ${workspace.number}` : workspace.workspace_id),
    agentStatus: agentStatusOfPanes(panes),
    worktree: worktree
      ? {
          repoKey: worktree.repo_key,
          repoName: worktree.repo_name,
          repoRoot: worktree.repo_root,
          checkoutPath: worktree.checkout_path,
          isLinked: worktree.is_linked_worktree,
          branch: worktree.checkout_path in branches ? branches[worktree.checkout_path] : undefined
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
 * One workspace per distinct repository, which is how many `worktree.list` calls
 * it takes to learn every branch: the call answers for a whole repository at
 * once, so asking once per workstream would repeat the same answer.
 */
export function oneWorkspacePerRepository(workstreams: readonly Workstream[]): string[] {
  const byRepo = new Map<string, string>();
  for (const workstream of workstreams) {
    if (!workstream.worktree) continue;
    if (!byRepo.has(workstream.worktree.repoKey)) byRepo.set(workstream.worktree.repoKey, workstream.workspaceId);
  }
  return [...byRepo.values()];
}
