---
status: accepted
---

# A workstream is a worktree-backed Herdr workspace

Herdr 0.8.0 already models everything a workstream needs: `WorkspaceInfo.worktree` supplies `repo_key`, `repo_name`, `repo_root`, `checkout_path`, and `is_linked_worktree`; `WorktreeInfo` adds `branch`; `WorkspaceInfo.agent_status` is an aggregate over the workspace's panes; and `tokens` provides up to 32 arbitrary `string → string` pairs per workspace. We therefore define a workstream **as** a worktree-backed Herdr workspace rather than inventing a plugin-side identity that wraps one, so Herdr stays the single source of truth and the two can never drift.

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
