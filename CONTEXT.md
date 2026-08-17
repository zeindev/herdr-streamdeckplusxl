# Herdr Stream Deck

A physical control surface that lets one developer run several parallel software-development efforts through Herdr, with the Stream Deck carrying identity, state, and attention so the developer does not have to poll terminals.

## Language

### Work organisation

**Workstream**:
One coherent delivery effort — a repository checkout on a branch, the tickets it will deliver, and the agents and services running inside it. Realised as a worktree-backed Herdr workspace.
_Avoid_: Stream, effort, project, task, workspace (when the delivery effort is meant rather than the Herdr entity)

**Repository**:
A Git repository, identified by Herdr as `repo_key`. Often a monorepo, so it may host several workstreams at once.
_Avoid_: Repo, project, codebase

**Worktree**:
A Git worktree checkout on disk, giving a branch its own working directory. Herdr owns its lifecycle through `worktree create`, `open`, and `remove`.
_Avoid_: Checkout, clone, working copy

**Ticket**:
One JIRA issue. Several tickets are normally delivered by a single workstream in a single pull request.
_Avoid_: Issue, story, card, task

**Pull request**:
The eventual GitHub pull request a workstream delivers. Exactly one per workstream.
_Avoid_: PR (in prose), change request, merge request

### Herdr entities

**Workspace**:
Herdr's top-level container, holding tabs and panes. A worktree-backed workspace carries `worktree` details and an aggregated `agent_status`. This is the entity a workstream is realised as.
_Avoid_: Space, session, window

**Pane**:
One terminal inside a Herdr workspace, optionally running an agent. Carries `agent_status`, `cwd`, `tokens`, and a label.
_Avoid_: Terminal, split, window, thread

**Agent**:
A coding agent, usually Claude, detected by Herdr as running in a pane. Reports one of `idle`, `working`, `blocked`, `done`, `unknown`.
_Avoid_: Assistant, bot, AI

**Service**:
A long-running process in a pane that is not an agent — dev server, API, worker, test watcher, log tail.
_Avoid_: Process, task, daemon

**Token**:
A `string → string` pair the plugin attaches to a workspace or pane through `report_metadata`. Herdr stores and broadcasts it without interpreting it. Up to 32 per entity.
_Avoid_: Metadata, tag, label, annotation

### Device

**Slot**:
A fixed physical position on the Stream Deck that always means the same thing, so the position itself is memorable.
_Avoid_: Button, key (when the assigned meaning is meant rather than the hardware), position

**Channel**:
The block of controls one workstream owns on the Stream Deck + XL — three columns of keys, two dials, and two touch-strip regions. Three channels fill the device. Channel order is left to right and is shared by every device.
_Avoid_: Column, lane, section, zone

**Control row**:
The bottom row of a channel: three fixed keys belonging to that workstream rather than to any pane.
_Avoid_: Action row, footer, button row

**Rig**:
The set of Stream Deck devices currently connected. Three are supported: XL alone, Mini alone, and both together. The rig decides the layout, and it can change while running.
_Avoid_: Setup, config, hardware, profile

**Role**:
What a pane is for — agent, server, tests, logs, or shell. Determines which row the pane occupies inside its channel, so the same role sits at the same height in every channel.
_Avoid_: Kind, type, category, purpose

**Global surface**:
The controls belonging to no single workstream — the cross-workstream attention queue, overflow count, worktree creation, recent, and settings. It exists only on a Stream Deck Mini; the Stream Deck + XL has no shared rail.
_Avoid_: Global rail, action bar, toolbar, footer

**Overflow**:
The number of workstreams that exist but hold no slot. Counted and shown, never listed — the count is the only pressure to close one.
_Avoid_: Extra, backlog, queue, hidden workstreams

**Attention item**:
Something that needs the developer, regardless of which workstream it belongs to.
_Avoid_: Notification, alert, inbox item, event
