import type { PaneSnapshot } from "../model.js";
import { displayWidth, truncateStart } from "../text.js";
import type { Workstream } from "./workstream.js";

/**
 * One reading on a channel's strip: what it is, and what it says.
 *
 * The label is never dropped and never abbreviated to a glyph, so a value on the
 * strip can always be named — a bare number on a 200px region is unreadable a
 * week later.
 */
export type StripField = { label: string; value: string };

/**
 * What a channel's 400px of strip shows, described rather than drawn.
 *
 * Both of a channel's regions carry the same block, because the two are one
 * composition windowed in half rather than two cards side by side (ADR-0007).
 */
export type StripBlock = {
  /** The branch, already cut to fit. Null when the channel holds no workstream. */
  branch: string | null;
  /** Left to right, already reduced to what fits. */
  fields: StripField[];
};

/**
 * Cells of text a channel's strip can hold on each line.
 *
 * These are budgets rather than preferences: the type floor is 18px (ADR-0010),
 * so content that does not fit is dropped and never shrunk to make it fit.
 *
 * Where the numbers come from: a channel owns 400px, less its accent bar and the
 * padding either side, leaving about 359px. Consolas advances roughly 0.55em, so
 * the branch line at 28px holds about 23 cells and the field line at 20px about
 * 32. The branch budget is set one below its maximum so a cut branch still has
 * room for the mark that says it was cut.
 */
export const BRANCH_COLUMNS = 22;
export const FIELD_COLUMNS = 32;

/** Cells the overflow count takes out of the last channel's field line: "OVER +n" and its gap. */
export const OVERFLOW_COLUMNS = 9;

/** Two spaces between fields, so a value never runs into the next label. */
const FIELD_GAP = 2;

/**
 * The value shown where enrichment will go but has not arrived.
 *
 * An explicit unknown rather than a blank: a blank field looks like a field that
 * does not exist, and the whole point of reserving the space is that the
 * developer learns where to look before there is anything to see.
 */
export const UNKNOWN = "?";

/**
 * A channel's strip block: the branch on top, then the readings that fit.
 *
 * Fields are laid out left to right in a fixed order so a reading is always
 * found in the same place, and the ones furthest right are dropped first when
 * space runs out. Attention, tickets and the pull request are never dropped —
 * they are the reasons the strip exists — so only the size readings give way.
 */
export function stripBlockOf(workstream: Workstream | null, panes: readonly PaneSnapshot[], reserved = 0): StripBlock {
  if (!workstream) return { branch: null, fields: [] };
  return {
    branch: truncateStart(branchTextOf(workstream), BRANCH_COLUMNS),
    fields: fittedFields(fieldsFor(workstream, panes), FIELD_COLUMNS - reserved)
  };
}

/**
 * Why there is no branch, when there is none. The three reasons are different
 * facts and the strip says which, exactly as the channel's keys do.
 */
function branchTextOf(workstream: Workstream): string {
  const worktree = workstream.worktree;
  if (!worktree) return "NO WORKTREE";
  if (worktree.branch === undefined) return "UNKNOWN";
  return worktree.branch ?? "DETACHED";
}

/**
 * Every reading a channel could show, most important first.
 *
 * Tickets and the pull request are reserved here rather than added later: the
 * space they will occupy is part of the layout from the start, so filling it in
 * later cannot push anything else around.
 */
function fieldsFor(workstream: Workstream, panes: readonly PaneSnapshot[]): StripField[] {
  const mine = panes.filter((pane) => pane.workspace_id === workstream.workspaceId);
  return [
    { label: "ATTN", value: String(needingAttention(mine)) },
    { label: "TKT", value: UNKNOWN },
    { label: "PR", value: UNKNOWN },
    { label: "AGENTS", value: String(mine.filter((pane) => pane.agent).length) }
  ];
}

/**
 * Panes wanting the developer right now.
 *
 * `blocked` is an agent waiting on input and `done` is finished work nobody has
 * picked up; both need someone, and ADR-0005 calls exactly these two the native
 * floor. Herdr has no concept of acknowledged, so a `done` agent keeps asking
 * until its pane moves on — which is the honest reading until unseen-ness is
 * tracked.
 */
function needingAttention(panes: readonly PaneSnapshot[]): number {
  return panes.filter((pane) => pane.agent && (pane.agent_status === "blocked" || pane.agent_status === "done")).length;
}

/** Keeps the fields that fit, in order, dropping from the right. */
function fittedFields(fields: readonly StripField[], columns: number): StripField[] {
  const kept: StripField[] = [];
  let used = 0;
  for (const field of fields) {
    const width = fieldWidth(field) + (kept.length === 0 ? 0 : FIELD_GAP);
    if (used + width > columns) break;
    used += width;
    kept.push(field);
  }
  return kept;
}

export function fieldWidth(field: StripField): number {
  return displayWidth(field.label) + 1 + displayWidth(field.value);
}
