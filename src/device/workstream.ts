import type { HerdrSnapshot, PaneSnapshot, WorkspaceSnapshot } from "../model.js";

/**
 * What a workstream's checkout is, as the device needs it.
 *
 * `branch` is separate from the rest because Herdr reports it separately: the
 * snapshot's worktree block has no branch at all, so it arrives only with a
 * `worktree.list` reply, or the `sd_branch` workspace token the Herdr plugin
 * publishes (`scripts/herdr-branch.mjs`, ADR-0001, `-0vd.1`) — the token wins
 * when both are present, since it is the one that stays right after a `git
 * switch` made outside Herdr. A channel therefore renders correctly before
 * the branch is known rather than waiting for it.
 *
 * Its three values are three different facts, and the device says which:
 * a name, `null` for a checkout on no branch at all, and `undefined` for one
 * neither source has answered yet.
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
  /**
   * The developer's own name for the effort. Shown only when there is no branch
   * to show instead — see ADR-0003 on what identity the device carries and what
   * it does not.
   */
  label: string;
  worktree: WorkstreamWorktree | null;
  /**
   * Carried straight through from `WorkspaceSnapshot.tokens` — see that type
   * for why it is both optional and nullable. `-wl7`'s enrichment readers
   * (`src/device/enrichment.ts`) are what interpret `sd_tickets` and `sd_pr`
   * out of this; this module only relays it.
   */
  tokens?: Record<string, string> | null;
};

/**
 * Branches Herdr has answered for, keyed by checkout path. A null value is an
 * answer — a checkout on no branch — while a missing key means not yet asked.
 */
export type Branches = Readonly<Record<string, string | null>>;

/**
 * A workstream's identity as the device names it: the branch, or why there
 * is not one.
 *
 * A workstream with no worktree falls back to its label, because otherwise it
 * would have no identity anywhere on the device — the branch is what names a
 * channel now that the keys are all panes, and "NO WORKTREE" names nothing.
 * The three ways a branch can be absent stay distinguishable, since a single
 * "no branch" would hide the difference between them.
 *
 * Shared by the strip's own leading line (`strip.ts`) and the Mini's top-row
 * key (`-vk6`), which names the same workstream the same way rather than
 * inventing a second identity string for a device with less room.
 */
export function workstreamIdentity(workstream: Workstream): string {
  const worktree = workstream.worktree;
  if (!worktree) return workstream.label;
  if (worktree.branch === undefined) return "UNKNOWN";
  return worktree.branch ?? "DETACHED";
}

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
  return [...(snapshot.workspaces ?? [])].sort(byNumberThenId).map((workspace) => toWorkstream(workspace, branches));
}

function toWorkstream(workspace: WorkspaceSnapshot, branches: Branches): Workstream {
  const worktree = workspace.worktree;
  return {
    workspaceId: workspace.workspace_id,
    label: workspace.label?.trim() || (workspace.number ? `WORKSPACE ${workspace.number}` : workspace.workspace_id),
    tokens: workspace.tokens,
    worktree: worktree
      ? {
          repoKey: worktree.repo_key,
          repoName: worktree.repo_name,
          repoRoot: worktree.repo_root,
          checkoutPath: worktree.checkout_path,
          isLinked: worktree.is_linked_worktree,
          branch: branchOf(workspace.tokens, worktree.checkout_path, branches)
        }
      : null
  };
}

/**
 * A worktree's branch: `sd_branch` when the Herdr plugin (`scripts/herdr-branch.mjs`)
 * has published one, `worktree.list`'s own answer otherwise (`ADR-0001`).
 *
 * The token wins whenever it is present, even an empty one — that is the
 * whole fix for `-0vd.1`. `worktree.list` can only be as fresh as the last
 * snapshot read, and a `git switch` inside an existing worktree pushes no
 * Herdr event of any kind, so nothing schedules a fresh read of it; the
 * token instead arrives the moment the branch actually changes, since a
 * token write is itself a structural `workspace_metadata_updated` event.
 * `sd_branch=""` is how the Herdr plugin declares a detached HEAD — the same
 * "on no branch" `worktree.list` itself can answer — so an empty token value
 * reads as `null`, not as an empty name.
 */
function branchOf(tokens: Record<string, string> | null | undefined, checkoutPath: string, branches: Branches): string | null | undefined {
  const published = tokens?.sd_branch;
  if (published !== undefined) return published === "" ? null : published;
  return checkoutPath in branches ? branches[checkoutPath] : undefined;
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
