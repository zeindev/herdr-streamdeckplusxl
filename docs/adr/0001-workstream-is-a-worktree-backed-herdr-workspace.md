---
status: accepted
---

# A workstream is a worktree-backed Herdr workspace

Herdr 0.8.0 already models everything a workstream needs: `WorkspaceInfo.worktree` supplies `repo_key`, `repo_name`, `repo_root`, `checkout_path`, and `is_linked_worktree`; `WorktreeInfo` adds `branch`; `WorkspaceInfo.agent_status` is an aggregate over the workspace's panes; and `tokens` provides up to 32 arbitrary `string → string` pairs per workspace. We therefore define a workstream **as** a worktree-backed Herdr workspace rather than inventing a plugin-side identity that wraps one, so Herdr stays the single source of truth and the two can never drift.

**Correction, found while building the channels (ticket `-3rd`).** Two of those four claims are true of Herdr's data but not of how it reaches the device, and both were verified against a running Herdr rather than the schema alone.

1. **The branch is not on the workspace.** `WorkspaceInfo.worktree` is a `WorkspaceWorktreeInfo`, whose five fields are exactly the ones listed above — no branch. `branch` lives on `WorktreeInfo`, which only `worktree.list` and the `worktree_*` events return. Reading a branch therefore costs a second request per repository, correlated by `path` and `open_workspace_id`. It is cheap — `worktree.list` answers for a whole repository at once — but it is not free, and a channel must render before the answer arrives.
2. **`WorkspaceInfo.agent_status` is never pushed.** A 45-second listen on every global subscription saw 417 `pane_updated` events carrying 8 agent-status changes on one pane, and zero `workspace_updated`. Herdr computes the aggregate correctly whenever it is read, but only a fresh `session.snapshot` re-reads it, and `pane_updated` is not a structural event, so nothing schedules that read. Consuming Herdr's aggregate would freeze every channel at whatever it was at the last structural change. The plugin therefore **recomputes** the aggregate from the workspace's panes, counting only panes with a non-null `agent` — a pane with no agent reports `unknown`, and four of five panes on the live session did.

A consequence of the first correction worth stating plainly: **the branch can go stale.** Nothing re-reads `worktree.list` except a snapshot read, and a `git switch` inside an existing worktree emits no Herdr event at all — no structural event, nothing. A branch changed from the terminal rather than through Herdr will therefore keep showing the old name until something else forces a snapshot. Polling for it would reintroduce exactly what ADR-0004 removed, so this stands as a known limit until Herdr grows an event for it.

Neither correction changes the decision: a workstream is still a worktree-backed workspace and Herdr is still the single source of truth. What changes is that "consume, never recompute" holds for identity but not for aggregate state.

The plugin's only durable state is the assignment of workstreams to the three physical slots. A slot may hold an unbound placeholder, so the device keeps stable geography before a worktree exists and across Herdr restarts.

## Considered Options

- **Plugin-owned workstream records** softly bound to workspaces. Rejected: it recreates the fuzzy rebinding problem already visible in `resolvePin` (`src/model.ts:350`), where roughly 24 lines of fallback matching try to re-find a pane after a restart. Doing that for whole workstreams multiplies the failure mode.
- **Pull-request-anchored identity.** Rejected: it matches the delivery unit exactly, but requires GitHub integration before anything can render, and a workstream has no identity before its pull request is opened.
- **Repository-primary hierarchy** with worktrees as children. Rejected: it fits monorepos poorly, where all three workstreams would usually collapse under one repository and waste the top level.

## Consequences

- The top level of the device holds workstreams, capped at three — replacing `PRODUCT.md`'s model of unlimited pages of pinned panes. Panes become the layer below. This is a replacement, not an enlargement.
- Ticket keys and the pull-request number live in workspace tokens, so no Herdr core change is needed to carry them.
- Non-worktree workspaces, including the primary checkout, still need a defined status on the device.
- Creating a workstream from the device becomes a `worktree.create` call, making stream creation a first-class device action.
