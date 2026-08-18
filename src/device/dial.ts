import type { PaneSnapshot } from "../model.js";
import { attentionIn, type AttentionItem } from "./attention.js";
import { truncateMiddle } from "../text.js";
import { READING_CELLS } from "./strip.js";
import type { Workstream } from "./workstream.js";

/**
 * Dial 1: navigate a workstream's panes and attention, then focus a pane
 * (ADR-0007, `-u5d`).
 *
 * `state.ts` owns *when* this fires — a rotate, a push, a timeout tick — and
 * calls only the pure functions here to decide what that means. Nothing in
 * this module reads a clock or sends anything; `at` always arrives from the
 * event that is already carrying one.
 */

/**
 * One thing dial 1 can select.
 *
 * A pane's own attention (waiting, a question, an approval, finished) is not
 * a separate item — rotating to the pane already reaches it, the same way a
 * pane key's own mark does. The one attention reason that can name no pane at
 * all is `exited`: a service that died and took its pane with it. Without an
 * entry for that case, dial 1 could reach every pane a workstream has and
 * still miss the one thing most likely to be wrong.
 */
export type DialItem =
  | { kind: "pane"; pane: PaneSnapshot }
  | { kind: "attention"; item: Extract<AttentionItem, { reason: "exited" }> };

/**
 * A workstream's dial-1 items, in the order rotating visits them: paneless
 * attention first, since it is otherwise unreachable from this dial, then
 * every pane by id, the same tie-break every other pane listing on this
 * device already uses, so the order never depends on Herdr's own listing.
 */
export function dialItemsOf(workstream: Workstream, panes: readonly PaneSnapshot[], attention: readonly AttentionItem[]): DialItem[] {
  const mine = attentionIn(attention, workstream.workspaceId).filter(
    (item): item is Extract<AttentionItem, { reason: "exited" }> => item.reason === "exited" && !item.paneId
  );
  const ordered = panes
    .filter((pane) => pane.workspace_id === workstream.workspaceId)
    .sort((left, right) => left.pane_id.localeCompare(right.pane_id));
  return [...mine.map((item): DialItem => ({ kind: "attention", item })), ...ordered.map((pane): DialItem => ({ kind: "pane", pane }))];
}

/**
 * Where dial 1 stands for one channel.
 *
 * A selection previews an item without touching Herdr — turning is free to
 * explore. Pushing a pane focuses it and clears the preview, returning the
 * strip to its permanent status.
 */
export type DialSelection = { mode: "browse"; index: number; at: number };

/**
 * How long a browsed-but-unpressed selection stands before reverting to the
 * channel's ordinary strip on its own — long enough to read the preview and
 * decide, short enough that walking away does not leave the strip stuck
 * showing a choice that was never made.
 */
export const DIAL_PREVIEW_TIMEOUT_MS = 4000;

/**
 * Moves the browsed selection, wrapping. `null` (nothing browsed yet) is
 * treated as the position just before the first item, so the first rotate
 * either direction lands on an end rather than the middle of the list.
 *
 * Returns `null` when the channel has nothing to browse — an empty list is
 * not a selection of nothing, it is nothing to select.
 */
export function rotateBrowse(current: DialSelection | null, items: readonly DialItem[], ticks: number, at: number): DialSelection | null {
  if (items.length === 0) return null;
  const from = current?.index ?? -1;
  return { mode: "browse", index: wrap(from + ticks, items.length), at };
}

/**
 * The pane a push should focus. A paneless attention item has nothing to
 * focus — it says so by returning null, the same honesty the queue key already
 * has for the same case (`-4w7`).
 */
export function selectedPane(current: DialSelection, items: readonly DialItem[]): PaneSnapshot | null {
  const item = items[wrap(current.index, items.length)];
  if (!item || item.kind !== "pane") return null;
  return item.pane;
}

/** Clears a browsed selection that has stood past its timeout. */
export function revertIdleDial1(selection: DialSelection | null, at: number): DialSelection | null {
  if (!selection) return null;
  return at - selection.at > DIAL_PREVIEW_TIMEOUT_MS ? null : selection;
}

function wrap(index: number, length: number): number {
  return ((index % length) + length) % length;
}

/** A dial item's name, the same word a pane key or the queue already uses for it. */
function dialItemLabel(item: DialItem): string {
  return item.kind === "pane" ? item.pane.label?.trim() || item.pane.pane_id : `${item.item.reason.toUpperCase()} ${item.item.service}`;
}

/**
 * What the strip says while dial 1 is in use (ADR-0007's permanent status
 * stands down for it), so the selection is identifiable without a press. A
 * `notice` already replaces a channel's readings for OFFLINE/SYNCING; this
 * reuses exactly that mechanism rather than inventing a second one, and it
 * loses to a connection notice — a preview is not trustworthy either once
 * Herdr is unreachable.
 */
export function dial1Notice(selection: DialSelection | null, items: readonly DialItem[]): string | null {
  if (!selection) return null;
  const item = items[wrap(selection.index, items.length)];
  if (!item) return null;
  return truncateMiddle(`> ${dialItemLabel(item)}`, READING_CELLS);
}
