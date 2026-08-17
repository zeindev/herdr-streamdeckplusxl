import type { PaneSnapshot } from "../model.js";
import { READING_GAP, displayWidth, truncateMiddle } from "../text.js";
import type { Workstream } from "./workstream.js";

/**
 * One reading on a channel's strip: what it is, and what it says.
 *
 * The label is never dropped and never abbreviated to a glyph, so a value on the
 * strip can always be named — a bare number on a 200px region is unreadable a
 * week later.
 */
export type StripReading = { label: string; value: string };

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
  readings: StripReading[];
  /**
   * Replaces the readings when they cannot be trusted, and null when they can.
   *
   * The branch survives a notice because a branch does not change when Herdr
   * dies; the counts do, so they go rather than lie.
   */
  notice: string | null;
};

/**
 * Cells of text a channel's strip can hold on each line.
 *
 * These are budgets rather than preferences: the type floor is 18px (ADR-0010),
 * so content that does not fit is dropped and never shrunk to make it fit.
 *
 * Where the numbers come from: a channel owns 400px, less its accent bar and the
 * padding either side, leaving about 359px. Consolas advances roughly 0.55em, so
 * the branch line at 28px holds about 23 cells and the readings line at 20px
 * about 32. A cut branch spends one of its own cells on the mark saying it was
 * cut, so the budget counts that rather than setting a cell aside for it.
 */
export const BRANCH_CELLS = 23;
export const READING_CELLS = 32;

/** Cells the overflow count takes from the last channel: "OVER +9" and its gap. */
export const OVERFLOW_CELLS = 9;

/**
 * The value shown where enrichment will go but has not arrived.
 *
 * An explicit unknown rather than a blank: a blank reading looks like a reading
 * that does not exist, and the whole point of reserving the space is that the
 * developer learns where to look before there is anything to see.
 */
export const UNKNOWN = "?";

/**
 * A reading, plus what the layout must promise it.
 *
 * `required` readings are the reasons the strip exists and are kept even when
 * that means dropping everything else. `reserve` is the width the layout sets
 * aside whatever the value currently is, so a reading that grows when enrichment
 * finally arrives cannot shove its neighbours off the strip.
 *
 * Both are enforced below rather than merely intended: "these are never dropped"
 * and "filling these in moves nothing" were each true only by accident of the
 * numbers before they were made structural.
 */
type Candidate = StripReading & { required: boolean; reserve: number };

export type StripBlockOptions = {
  /** Cells given up to something else on the strip, such as the overflow count. */
  reserved?: number;
  /** A message to show instead of the readings. */
  notice?: string | null;
};

/**
 * A channel's strip block: the branch on top, then the readings that fit.
 *
 * Readings are laid out left to right in a fixed order so one is always found in
 * the same place, and the droppable ones furthest right give way first.
 */
export function stripBlockOf(
  workstream: Workstream | null,
  panes: readonly PaneSnapshot[],
  { reserved = 0, notice = null }: StripBlockOptions = {}
): StripBlock {
  if (!workstream) return { branch: null, readings: [], notice };
  const branch = truncateMiddle(branchTextOf(workstream), BRANCH_CELLS);
  if (notice) return { branch, readings: [], notice };
  return { branch, readings: fitted(candidatesFor(workstream, panes), READING_CELLS - reserved), notice: null };
}

/**
 * Why there is no branch, when there is none. The three are different facts and
 * the strip says which, since a single "no branch" would hide the difference.
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
 * The ticket count and the pull request are reserved here rather than added
 * later, at the width their real values will need, so `-wl7` filling them in
 * changes what they say and not where anything sits.
 */
function candidatesFor(workstream: Workstream, panes: readonly PaneSnapshot[]): Candidate[] {
  const mine = panes.filter((pane) => pane.workspace_id === workstream.workspaceId);
  return [
    { label: "ATTN", value: String(needingAttention(mine)), required: true, reserve: 1 },
    { label: "TKT", value: UNKNOWN, required: true, reserve: 1 },
    // Four cells is what the layout can promise a pull request without costing
    // the optional reading below, so `-wl7` has to say its state in four: OPEN,
    // DRFT, or a number. Going wider is allowed and simply spends AGENTS, which
    // is what being the droppable one means.
    { label: "PR", value: UNKNOWN, required: true, reserve: 4 },
    { label: "AGENTS", value: String(mine.filter((pane) => pane.agent).length), required: false, reserve: 1 }
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

/**
 * Keeps the readings that fit, in order, dropping droppable ones from the right.
 *
 * A required reading is kept whatever the budget says: a strip that silently
 * stopped reporting attention would be worse than one that runs long, and the
 * budget is sized so that cannot happen in practice anyway.
 */
function fitted(candidates: readonly Candidate[], cells: number): StripReading[] {
  const kept: Candidate[] = [];
  let used = 0;
  for (const [index, candidate] of candidates.entries()) {
    const width = reservedWidth(candidate) + (kept.length === 0 ? 0 : READING_GAP);
    // A droppable reading must leave room for every required one still to come.
    if (!candidate.required && used + width + requiredWidthFrom(candidates, index + 1) > cells) continue;
    used += width;
    kept.push(candidate);
  }
  return kept.map(({ label, value }) => ({ label, value }));
}

function requiredWidthFrom(candidates: readonly Candidate[], index: number): number {
  return candidates
    .slice(index)
    .filter((candidate) => candidate.required)
    .reduce((total, candidate) => total + reservedWidth(candidate) + READING_GAP, 0);
}

/** What a reading takes up: its label, a space, and the wider of value or reserve. */
function reservedWidth(candidate: Candidate): number {
  return displayWidth(candidate.label) + 1 + Math.max(displayWidth(candidate.value), candidate.reserve);
}

/** What a reading takes up once its value is known. */
export function readingWidth(reading: StripReading): number {
  return displayWidth(reading.label) + 1 + displayWidth(reading.value);
}
