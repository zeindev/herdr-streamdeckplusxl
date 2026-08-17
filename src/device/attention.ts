import type { HerdrSnapshot, PaneSnapshot, WorkspaceSnapshot } from "../model.js";

/**
 * Why something needs the developer.
 *
 * Three reasons and no more, because every one of them is *declared* by
 * something that knows rather than inferred from terminal text (ADR-0005). A
 * fourth reason would mean a fourth thing to trust.
 *
 * - `waiting` — an agent is blocked on input. Herdr says so itself.
 * - `finished` — an agent is done and nobody has looked at it yet. Herdr reports
 *   done; unseen-ness is the plugin's, because Herdr has no concept of it.
 * - `exited` — a service ended badly and said so. Herdr's own `pane_exited`
 *   cannot say this: it carries no exit status, and the pane it names is gone
 *   from the session by the time the event arrives, so there is neither a code
 *   to read nor a key to put the answer on. See `EXIT_TOKEN_PREFIX`.
 */
export type AttentionReason = "waiting" | "finished" | "exited";

/**
 * The reasons a *key* can carry.
 *
 * `exited` is excluded by the type rather than by a rule someone has to
 * remember: the pane it would name is gone from the session, so there is no key
 * to draw it on, and anything trying to put one there fails to compile.
 */
export type PaneAttention = Exclude<AttentionReason, "exited">;

/**
 * One thing asking for the developer, and what it belongs to.
 *
 * `waiting` and `finished` name a pane, so they can show on that pane's key.
 * `exited` cannot: the pane died with its process. It names the service instead
 * and shows on the workstream's strip only. That asymmetry is real and the
 * device says so rather than inventing a key for a pane that no longer exists.
 */
export type AttentionItem =
  | { workspaceId: string; reason: PaneAttention; paneId: string }
  | { workspaceId: string; reason: "exited"; service: string; status: string };

/**
 * The prefix of a workspace token declaring that a service ended badly.
 *
 * Workspace-scoped rather than pane-scoped, which is forced rather than chosen:
 * probing a running Herdr 0.8.0 showed that a pane and every token on it vanish
 * from the session the instant its process ends, so a declaration written on the
 * pane would be written into nothing. A workspace survives its panes, and its
 * tokens survive with it.
 *
 * The name after the prefix is the service's, so two dead services in one
 * workstream stay two items. The value is the exit status.
 */
export const EXIT_TOKEN_PREFIX = "sd_exit_";

/** Pane ids whose finished agent the developer has already seen. */
export type Acknowledged = readonly string[];

/**
 * Everything currently asking for the developer, across every workstream.
 *
 * Order is fixed — workspace, then reason, then pane or service — so a count
 * never depends on the order Herdr happened to list things in.
 */
export function attentionOf(snapshot: HerdrSnapshot | null, acknowledged: Acknowledged = []): AttentionItem[] {
  if (!snapshot) return [];
  const seen = new Set(acknowledged);
  const items: AttentionItem[] = [];

  for (const pane of snapshot.panes ?? []) {
    const reason = paneReason(pane, seen);
    if (reason && pane.workspace_id) items.push({ workspaceId: pane.workspace_id, reason, paneId: pane.pane_id });
  }
  for (const workspace of snapshot.workspaces ?? []) {
    for (const declared of exitsOf(workspace)) items.push(declared);
  }

  return items.sort(byWorkspaceThenReasonThenName);
}

/** The items belonging to one workstream. */
export function attentionIn(items: readonly AttentionItem[], workspaceId: string | null): AttentionItem[] {
  return workspaceId === null ? [] : items.filter((item) => item.workspaceId === workspaceId);
}

/**
 * What each pane is asking for, by pane id, for the keys.
 *
 * Items with no pane are absent rather than dropped silently — they are counted
 * on the strip by `attentionIn`, which is the only place they can be shown.
 */
export function attentionByPane(items: readonly AttentionItem[]): ReadonlyMap<string, PaneAttention> {
  const byPane = new Map<string, PaneAttention>();
  for (const item of items) {
    if (item.reason !== "exited" && !byPane.has(item.paneId)) byPane.set(item.paneId, item.reason);
  }
  return byPane;
}

/**
 * Why a pane is asking, if it is.
 *
 * Only a pane running an agent can be either. A pane without one reports
 * `unknown` for its status — 4 live panes out of 5 did — so reading a status off
 * a service would put attention on every shell in every channel.
 */
function paneReason(pane: PaneSnapshot, acknowledged: ReadonlySet<string>): PaneAttention | null {
  if (!pane.agent) return null;
  if (pane.agent_status === "blocked") return "waiting";
  if (pane.agent_status === "done") return acknowledged.has(pane.pane_id) ? null : "finished";
  return null;
}

/**
 * The bad exits declared on one workspace.
 *
 * A token declaring a clean exit raises nothing, and that is enforced here
 * rather than left to whoever writes the token. The acceptance criterion is that
 * a clean exit does not raise attention, and a criterion the code does not
 * refuse to break is only a hope.
 *
 * Clean means "reads as zero", not "is the character 0": `00` and `+0` are what
 * a shell or another language's formatter can easily produce, and refusing only
 * the exact string would let those ring the bell for a service that exited
 * perfectly. A value that is not a number at all is *not* treated as clean —
 * something deliberately declared it, and the honest reading of a declaration
 * nobody can parse is that something is wrong.
 *
 * An empty value is refused: it says nothing, and something that says nothing
 * must not be able to ring a bell. A token with no name after the prefix is
 * refused too, because two nameless declarations could not be told apart and
 * would collapse into one.
 */
function exitsOf(workspace: WorkspaceSnapshot): AttentionItem[] {
  const tokens = workspace.tokens;
  if (!tokens) return [];
  const declared: AttentionItem[] = [];
  for (const [name, value] of Object.entries(tokens)) {
    if (!name.startsWith(EXIT_TOKEN_PREFIX)) continue;
    const service = name.slice(EXIT_TOKEN_PREFIX.length);
    const status = typeof value === "string" ? value.trim() : "";
    if (!service || status === "" || isCleanExit(status)) continue;
    declared.push({ workspaceId: workspace.workspace_id, reason: "exited", service, status });
  }
  return declared;
}

/** Whether a declared status reads as a successful exit. */
function isCleanExit(status: string): boolean {
  const code = Number(status);
  return Number.isFinite(code) && code === 0;
}

const REASON_ORDER: readonly AttentionReason[] = ["waiting", "exited", "finished"];

function byWorkspaceThenReasonThenName(left: AttentionItem, right: AttentionItem): number {
  if (left.workspaceId !== right.workspaceId) return left.workspaceId.localeCompare(right.workspaceId);
  const byReason = REASON_ORDER.indexOf(left.reason) - REASON_ORDER.indexOf(right.reason);
  if (byReason !== 0) return byReason;
  return nameOf(left).localeCompare(nameOf(right));
}

function nameOf(item: AttentionItem): string {
  return item.reason === "exited" ? item.service : item.paneId;
}

/**
 * Whether tapping this pane would acknowledge finished work.
 *
 * Acknowledging is not its own gesture. Tapping a pane key already focuses that
 * pane in Herdr, which is the developer going to look at it, so that same tap is
 * what marks it seen. A separate button would be a second thing to remember for
 * an act the first one already performs.
 */
export function acknowledges(pane: PaneSnapshot | undefined): boolean {
  return Boolean(pane?.agent) && pane?.agent_status === "done";
}

/** Marks a pane's finished work as seen. Already-seen panes are left alone. */
export function acknowledge(acknowledged: Acknowledged, paneId: string): Acknowledged {
  return acknowledged.includes(paneId) ? acknowledged : [...acknowledged, paneId];
}

/**
 * Drops acknowledgements that have nothing left to acknowledge.
 *
 * This is what makes a *second* completion ring again. An acknowledgement is of
 * one finished piece of work, not of a pane, so it lasts exactly as long as that
 * work stays finished: an agent that goes back to working and finishes again is
 * asking about something new, and a mark that survived would swallow it. A pane
 * that no longer exists is dropped by the same rule, since it is not done either
 * — otherwise the list would grow for as long as the plugin runs.
 *
 * With no snapshot nothing is dropped, which is the difference between "these
 * panes are not done" and "nothing is known yet". Settings are read before the
 * first snapshot arrives, so judging them against an empty session would throw
 * away every acknowledgement the developer made and then write the loss back.
 *
 * Returns the same value when nothing was dropped, so an unchanged snapshot
 * causes no write and no redraw.
 */
export function keepAcknowledged(acknowledged: Acknowledged, snapshot: HerdrSnapshot | null): Acknowledged {
  if (!snapshot) return acknowledged;
  const stillDone = new Set(snapshot.panes.filter(acknowledges).map((pane) => pane.pane_id));
  const kept = acknowledged.filter((paneId) => stillDone.has(paneId));
  return kept.length === acknowledged.length ? acknowledged : kept;
}

/**
 * Reads acknowledgements back out of stored settings.
 *
 * Nothing is trusted, for the same reason slots and roles are not: settings can
 * be written by an older version or edited by hand. Anything unreadable is
 * simply not an acknowledgement, which costs one extra glance rather than a
 * broken device.
 */
export function readAcknowledged(stored: unknown): Acknowledged {
  const value = (stored as { acknowledged?: unknown } | null | undefined)?.acknowledged;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((paneId): paneId is string => typeof paneId === "string" && paneId !== ""))];
}

/** The shape written to settings. Kept beside `readAcknowledged` so the two agree. */
export function storedAcknowledged(acknowledged: Acknowledged): { acknowledged: string[] } {
  return { acknowledged: [...acknowledged] };
}

export function sameAcknowledged(left: Acknowledged, right: Acknowledged): boolean {
  return left.length === right.length && left.every((paneId, index) => paneId === right[index]);
}
