---
status: accepted
---

# A workstream's ticket list is derived from Git

The branch name seeds a workstream's ticket list; once commits exist, the ticket keys found in `git log <base>..HEAD` become authoritative. This needs no credentials, updates itself as commits land, and handles the several-tickets-one-pull-request rule natively, because a commit range is inherently many-to-one. The resulting list is published as a workspace token (`sd_tickets`) by the Herdr plugin, per ADR-0004. JIRA is optional and supplies only titles and status for keys already discovered.

## Considered Options

- **JIRA-authoritative**, querying issues whose development panel links the branch or pull request. Rejected: it needs credentials before anything can render, adds network latency to a value shown constantly, and the link only appears once JIRA has indexed the branch.
- **Manual assignment on the device.** Rejected: accurate the day it is set and silently wrong afterwards.
- **Parse the pull-request body.** Rejected: nothing exists before the pull request is opened, which is most of a workstream's life.

## Consequences

- Ticket keys must appear in commit messages. A ticket being worked on but not yet committed for is invisible — the list is empty rather than wrong, which is the acceptable failure.
- The base ref must be known per workstream. `worktree create --base` supplies it at creation; existing worktrees need it inferred or configured.
- The project key pattern is configuration, not something to guess.
