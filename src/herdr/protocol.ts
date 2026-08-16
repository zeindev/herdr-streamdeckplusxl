/**
 * Wire vocabulary for Herdr's socket API.
 *
 * Verified against Herdr 0.8.0, protocol 19, using the schema shipped by
 * `herdr api schema --json` and live traffic on the server socket.
 */

/** Protocol revision this vocabulary was written against. */
export const SUPPORTED_PROTOCOL = 19;

/**
 * Every event Herdr can push. Note these are underscore-separated, while the
 * subscription names that request them are dot-separated — the two vocabularies
 * are deliberately distinct and must not be derived from one another.
 */
export const EVENT_KINDS = [
  "workspace_created",
  "workspace_updated",
  "workspace_metadata_updated",
  "workspace_closed",
  "workspace_renamed",
  "workspace_moved",
  "workspace_reordered",
  "workspace_focused",
  "worktree_created",
  "worktree_opened",
  "worktree_removed",
  "tab_created",
  "tab_closed",
  "tab_renamed",
  "tab_moved",
  "tab_focused",
  "pane_created",
  "pane_closed",
  "pane_updated",
  "pane_focused",
  "pane_moved",
  "pane_output_changed",
  "pane_exited",
  "pane_agent_detected",
  "pane_agent_status_changed",
  "layout_updated"
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

const EVENT_KIND_SET: ReadonlySet<string> = new Set(EVENT_KINDS);

export function isEventKind(value: unknown): value is EventKind {
  return typeof value === "string" && EVENT_KIND_SET.has(value);
}

/**
 * Subscriptions that need no arguments, so one call covers the whole session.
 *
 * The three omitted subscriptions are per-pane and each require a `pane_id`:
 * `pane.agent_status_changed`, `pane.scroll_changed`, and `pane.output_matched`
 * (which also requires `source` and `match`). Subscribing to agent status per
 * pane is unnecessary — `pane_updated` carries `agent_status` for every pane
 * and arrives on this global subscription.
 */
export const GLOBAL_SUBSCRIPTIONS = [
  "workspace.created",
  "workspace.updated",
  "workspace.metadata_updated",
  "workspace.renamed",
  "workspace.moved",
  "workspace.reordered",
  "workspace.closed",
  "workspace.focused",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
  "tab.created",
  "tab.closed",
  "tab.focused",
  "tab.renamed",
  "tab.moved",
  "pane.created",
  "pane.closed",
  "pane.updated",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
  "layout.updated"
] as const;

export type GlobalSubscription = (typeof GLOBAL_SUBSCRIPTIONS)[number];

export type Subscription = { type: string; [argument: string]: unknown };

export type HerdrRequest = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

export type HerdrError = { code: string; message: string };

/** An event pushed by the server. Carries no `id`. */
export type HerdrEvent = { event: EventKind; data: { type: EventKind } & Record<string, unknown> };

/** A reply to a request, correlated by `id`. */
export type HerdrReply =
  | { id: string; ok: true; result: Record<string, unknown> }
  | { id: string; ok: false; error: HerdrError };

export type HerdrMessage =
  | ({ kind: "event" } & HerdrEvent)
  | ({ kind: "reply" } & HerdrReply)
  /** A well-formed line that is neither, kept rather than thrown so callers can log it. */
  | { kind: "unknown"; raw: string };

/**
 * A request that failed to parse never reaches id extraction, so the server
 * replies with an empty id. Such a reply cannot be correlated to its caller.
 */
export const UNCORRELATED_ID = "";
