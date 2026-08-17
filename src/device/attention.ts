import type { AgentStatus, HerdrSnapshot, PaneSnapshot, WorkspaceSnapshot } from "../model.js";

/**
 * Why something needs the developer.
 *
 * Five reasons and no more, because every one of them is *declared* by
 * something that knows rather than inferred from terminal text (ADR-0005). A
 * sixth reason would mean a sixth thing to trust.
 *
 * - `waiting` — an agent is blocked on input. Herdr says so itself; nothing
 *   more specific has been declared.
 * - `question` — an agent declared that it asked the developer something and
 *   is waiting to hear back. More specific than `waiting`, so it wins over it
 *   when both would otherwise apply to the same pane. See `DECLARED_ATTENTION_PREFIX`.
 * - `approval` — an agent declared that it needs a permission decision. Also
 *   more specific than `waiting`, for the same reason.
 * - `finished` — an agent is done and nobody has looked at it yet. Either Herdr
 *   reports `done`, or an agent declared it directly; whether it has been
 *   acknowledged is the plugin's either way, because Herdr has no concept of it.
 * - `exited` — a service ended badly and said so. Herdr's own `pane_exited`
 *   cannot say this: it carries no exit status, and for the case that matters
 *   it does not fire at all. See `EXIT_TOKEN_PREFIX`.
 */
export type AttentionReason = "waiting" | "question" | "approval" | "finished" | "exited";

/**
 * One thing asking for the developer, and what it belongs to.
 *
 * `waiting`, `question`, `approval` and `finished` always name a pane, because
 * an agent is alive to report on itself. `exited` names one only *sometimes*,
 * and the optionality is the honest part: a service crashing under the wrapper
 * leaves its pane standing, so there usually is a key to mark, but a service
 * that was the pane's whole command takes the pane with it and leaves only the
 * workstream.
 *
 * Wherever `paneId` is set it names a pane that is in the snapshot. That is an
 * invariant of `attentionOf`, not a hope — a key cannot be drawn for a pane the
 * device is not showing.
 */
export type AttentionItem =
  | { workspaceId: string; reason: "waiting" | "question" | "approval" | "finished"; paneId: string }
  | { workspaceId: string; reason: "exited"; service: string; status: string; paneId?: string };

/** The three things an agent can declare about itself. A closed vocabulary. */
export type DeclaredAttentionKind = "question" | "approval" | "finished";

const DECLARED_ATTENTION_KINDS: ReadonlySet<string> = new Set(["question", "approval", "finished"]);

/**
 * The prefix of a workspace token declaring what one of its agents needs.
 *
 * Named `sd_attn_<n>` rather than the pane-scoped `sd_attention` an earlier
 * version of ADR-0005 planned. That plan was probed against a running Herdr
 * 0.8.0 and found wrong: `pane.report_metadata` — token writes, a title write,
 * and a `--ttl-ms` expiry were each tried — pushes no live event at all, so a
 * declaration living on the pane would sit unseen until something unrelated
 * forced a resync. `workspace.report_metadata` does push `workspace_metadata_updated`
 * live, already relied on by `EXIT_TOKEN_PREFIX`, so the declaration moves
 * there instead. `<n>` is the number Herdr gives the pane within that
 * workspace — `w3:p2` becomes `sd_attn_p2` — one token per pane, so two agents
 * in one workstream keep two independent declarations.
 *
 * The value is `<kind> <pane_id>`: one of `question`, `approval`, `finished`,
 * a space, then the full pane id repeated. The repeated id is what lets the
 * reader believe a declaration only about a pane that is still there and still
 * the one that named itself — the same defence `EXIT_TOKEN_PREFIX` needed
 * after a stale pane id was found stamping one agent's key with another's
 * declaration. `attentionOf` can make a stronger check than that one: it
 * already has the live pane in hand and compares the value against that pane's
 * own id directly, rather than merely checking workspace ownership.
 *
 * Any agent or tool can write this, not only Claude Code — the token is the
 * contract, and `scripts/herdr-attention` is one implementation of it, wired
 * to Claude Code's hooks by `scripts/install-herdr-hooks.mjs`. A declaration
 * wins over Herdr's own `agent_status` whenever it is present and valid,
 * because it is the more specific of the two (ADR-0005).
 */
export const DECLARED_ATTENTION_PREFIX = "sd_attn_";

/**
 * The prefix of a workspace token declaring that a service ended badly.
 *
 * Workspace-scoped rather than pane-scoped, and this is a choice with a cost
 * rather than the only possibility. Probing a running Herdr 0.8.0 both ways:
 * a pane and every token on it vanish the instant the pane's own shell ends,
 * but a service crashing *under the wrapper* does not end that shell, so in the
 * ordinary case a pane token would survive and would even carry a key. The
 * workspace wins anyway because it is the scope that cannot be lost — run the
 * wrapper as a pane's whole command and the pane goes, and a crash reported
 * nowhere is the worst thing a supervision surface can do.
 *
 * The name after the prefix is the service's, so two dead services in one
 * workstream stay two items. The value is the exit status, optionally followed
 * by the pane the service ran in, which is how the item finds a key when there
 * is still one to find.
 */
export const EXIT_TOKEN_PREFIX = "sd_exit_";

/** Pane ids whose finished agent the developer has already acknowledged. */
export type Acknowledged = readonly string[];

/**
 * Everything currently asking for the developer, across every workstream.
 *
 * Order is fixed — workspace, then reason, then pane or service — so a count
 * never depends on the order Herdr happened to list things in.
 */
export function attentionOf(snapshot: HerdrSnapshot | null, acknowledged: Acknowledged = []): AttentionItem[] {
  if (!snapshot) return [];
  const alreadyAcknowledged = new Set(acknowledged);
  // Which workspace each pane belongs to, not merely which panes exist. A
  // declaration names a pane by id, and an id is not proof of anything: Herdr
  // numbers panes `w<n>:p<n>` and reuses them across sessions, so a token
  // written before a restart can name a pane that now belongs to someone else.
  const paneOwners = new Map(snapshot.panes.map((pane) => [pane.pane_id, pane.workspace_id]));
  const items: AttentionItem[] = [];

  for (const pane of snapshot.panes) {
    const declared = declaredReasonFor(pane, snapshot);
    const reason = paneReason(pane, declared, alreadyAcknowledged);
    if (reason && pane.workspace_id) items.push({ workspaceId: pane.workspace_id, reason, paneId: pane.pane_id });
  }
  for (const workspace of snapshot.workspaces ?? []) {
    for (const declared of exitsOf(workspace, paneOwners)) items.push(declared);
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
 * An item with no pane simply is not here. It has not been lost: `attentionIn`
 * still hands it to the channel strip, which is the only place left to show it.
 */
export function attentionByPane(items: readonly AttentionItem[]): ReadonlyMap<string, AttentionReason> {
  const byPane = new Map<string, AttentionReason>();
  for (const item of items) {
    if (item.paneId && !byPane.has(item.paneId)) byPane.set(item.paneId, item.reason);
  }
  return byPane;
}

/**
 * Why a pane is asking, if it is.
 *
 * Only a pane running an agent can be either. A pane without one reports
 * `unknown` for its status — 4 live panes out of 5 did — so reading a status off
 * a service would put attention on every shell in every channel.
 *
 * A declared reason always replaces Herdr's native one rather than joining it
 * — `declared ?? native`, never both — so a pane can never carry two competing
 * marks (ADR-0005). `finished` is gated by acknowledgement the same way
 * whichever side said it, because Herdr has no concept of acknowledged either
 * way and the plugin's tracking of it does not care where `finished` came from.
 */
function paneReason(
  pane: PaneSnapshot,
  declared: DeclaredAttentionKind | null,
  acknowledged: ReadonlySet<string>
): "waiting" | "question" | "approval" | "finished" | null {
  if (!pane.agent) return null;
  const raw = declared ?? nativeReason(pane.agent_status);
  if (raw === "finished") return acknowledged.has(pane.pane_id) ? null : "finished";
  return raw;
}

/** What Herdr's own `agent_status` says, with no declaration in the picture. */
function nativeReason(status: AgentStatus): "waiting" | "finished" | null {
  if (status === "blocked") return "waiting";
  if (status === "done") return "finished";
  return null;
}

/**
 * What one pane's agent has declared about itself, if anything believable.
 *
 * Looks up `sd_attn_<n>` on the pane's own workspace, where `<n>` is this
 * pane's own number — so a stale token left by a since-restarted agent that
 * happened to land on the same pane number is the only collision this cannot
 * catch; `SessionStart` clearing the token is what closes that gap (ADR-0005).
 * A value that does not name this exact pane, or whose kind is not one of the
 * three declared, is not believed: the reader falls back to `nativeReason` as
 * if nothing had been declared at all.
 */
function declaredReasonFor(pane: PaneSnapshot, snapshot: HerdrSnapshot): DeclaredAttentionKind | null {
  if (!pane.workspace_id) return null;
  const workspace = snapshot.workspaces?.find((candidate) => candidate.workspace_id === pane.workspace_id);
  const tokens = workspace?.tokens;
  if (!tokens) return null;
  const raw = tokens[`${DECLARED_ATTENTION_PREFIX}${localPaneNumber(pane.pane_id)}`];
  if (!raw) return null;
  const [kind, namedPane] = String(raw).trim().split(/\s+/);
  if (!DECLARED_ATTENTION_KINDS.has(kind) || namedPane !== pane.pane_id) return null;
  return kind as DeclaredAttentionKind;
}

/** The number Herdr gives a pane within its workspace: "w3:p2" is "p2". */
function localPaneNumber(paneId: string): string {
  const at = paneId.lastIndexOf(":");
  return at < 0 ? paneId : paneId.slice(at + 1);
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
 *
 * A pane named after the status is kept only if it is still here AND still
 * belongs to this workspace. Both halves are load-bearing, and the second was
 * found by running the wrapper for real: a token that named a pane in a
 * different workstream stamped "your service died" onto an unrelated agent's
 * key. A pane id is not proof of anything on its own — anything can write one,
 * and Herdr reuses them — so the declaration is only believed about a pane the
 * declaring workspace actually owns.
 */
function exitsOf(workspace: WorkspaceSnapshot, paneOwners: ReadonlyMap<string, string | undefined>): AttentionItem[] {
  const tokens = workspace.tokens;
  if (!tokens) return [];
  const declared: AttentionItem[] = [];
  for (const [name, value] of Object.entries(tokens)) {
    if (!name.startsWith(EXIT_TOKEN_PREFIX)) continue;
    const service = name.slice(EXIT_TOKEN_PREFIX.length);
    const [status = "", paneId] = String(value ?? "").trim().split(/\s+/);
    if (!service || status === "" || isCleanExit(status)) continue;
    declared.push({
      workspaceId: workspace.workspace_id,
      reason: "exited",
      service,
      status,
      ...(paneId && paneOwners.get(paneId) === workspace.workspace_id ? { paneId } : {})
    });
  }
  return declared;
}

/** Whether a declared status reads as a successful exit. */
function isCleanExit(status: string): boolean {
  const code = Number(status);
  return Number.isFinite(code) && code === 0;
}

/**
 * Every reason, most urgent first. Ordering `attentionOf`'s own output, and
 * shared by every other place that has to pick one reason out of several —
 * a `more` key's hidden panes, a Mini channel's aggregate, a workstream's
 * single most urgent pane — so which one wins is decided in exactly one
 * place rather than risking three lists drifting apart.
 */
export const REASON_ORDER: readonly AttentionReason[] = ["waiting", "question", "approval", "exited", "finished"];

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
 * what acknowledges it. A separate button would be a second thing to remember for
 * an act the first one already performs.
 *
 * `finished` from either side acknowledges: Herdr's own `done`, or an agent's
 * own `Stop`-hook declaration. `snapshot` is what lets a declaration be seen at
 * all — it lives on the pane's workspace, not the pane — so a `null` snapshot
 * (nothing read yet) can only ever fall back to the native reading.
 */
export function acknowledges(pane: PaneSnapshot | undefined, snapshot: HerdrSnapshot | null): boolean {
  if (!pane?.agent) return false;
  const declared = snapshot ? declaredReasonFor(pane, snapshot) : null;
  return (declared ?? nativeReason(pane.agent_status)) === "finished";
}

/** Acknowledges a pane's finished work. An already-acknowledged pane is left alone. */
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
  const stillDone = new Set(snapshot.panes.filter((pane) => acknowledges(pane, snapshot)).map((pane) => pane.pane_id));
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
