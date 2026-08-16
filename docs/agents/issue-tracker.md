# Issue tracker: Beads

Issues and PRDs for this repo live in beads. Use the `bd` CLI for all operations. Beads keeps a local database (`.beads/*.db`) with a native dependency graph.

Issue IDs in this repo are prefixed `herdr-streamdeckplusxl-<hash>`.

## Conventions

- **Create an issue**: `bd create "title" -d "description"`. Use `--body-file -` to read the description from stdin. Quick single-line capture: `bd q "title"` (prints only the new ID).
- **Read an issue**: `bd show <id>`
- **List issues**: `bd list`, with filters like `--label` (AND), `--label-any` (OR), `--exclude-label`, `--assignee`, `--all` (include closed).
- **Comment on an issue**: `bd comment <id> "..."`; append a note with `bd note <id> "..."`.
- **Apply / remove labels**: `bd update <id> --add-label "..."` / `--remove-label "..."` (repeatable); replace all with `--set-labels "..."`.
- **Close**: `bd close <id> --reason "..."`

## When a skill says "publish to the issue tracker"

Create a bead with `bd create`.

## When a skill says "fetch the relevant ticket"

Run `bd show <id>`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single bead with **child** beads as tickets.

- **Map**: a single bead labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `bd create "..." -l wayfinder:map`.
- **Child ticket**: a bead linked to the map with `bd link <child-id> <map-id> --type parent-child`. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`).
- **Blocking**: beads' **native dependency edges** — the canonical, graph-visible representation. Add with `bd dep <blocker-id> --blocks <child-id>` (or `bd link <child-id> <blocker-id>`). A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`bd children <map-id>`, `--all` to see state), drop any with an open blocker (`bd dep list <id>` shows `via blocks` edges) or an assignee; first in map order wins.
- **Claim**: `bd update <id> --claim` — atomically sets assignee and status to in_progress; the session's first write.
- **Resolve**: `bd note <id> "<answer>"`, then `bd close <id> --reason "..."`, then append a context pointer (gist + link) to the map's Decisions-so-far.
