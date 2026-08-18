import { truncateMiddle } from "../text.js";
import { ACK_DISPLAY_MS, ARM_TIMEOUT_MS } from "./control.js";
import { READING_CELLS } from "./strip.js";
import type { Workstream } from "./workstream.js";

/**
 * Dial 2: worktree lifecycle — create and remove (ADR-0007, ADR-0009, `-8e8`).
 *
 * `state.ts` owns *when* this fires — a rotate, a push, an arm timeout — and
 * calls only the pure functions here to decide what that means. Nothing in
 * this module reads a clock or sends anything; `at` always arrives from the
 * event that is already carrying one. The same convention `control.ts` and
 * `dial.ts` (dial 1) already use, not a fourth invented for this ticket.
 *
 * Nothing here ever offers a verb that pauses a workstream — Herdr has no
 * suspend, and ADR-0007 is explicit that the nearest thing, `ctrl+c`, is a
 * stop rather than a pause and must never appear on a control.
 */

/**
 * One thing dial 2 can commit to.
 *
 * An empty channel offers `create`, one candidate per repository the device
 * already knows about — never a repository invented from nothing, since
 * there is no keyboard to name one by hand. A channel already holding a
 * workstream offers `remove`, and only when it has an actual worktree to
 * remove: the primary checkout may occupy a slot like any other (ADR-0009),
 * but it is not a worktree, and there is nothing here for dial 2 to do to it.
 */
export type Dial2Item =
  | { kind: "create"; repoKey: string; repoName: string; repoRoot: string }
  | { kind: "remove"; workspaceId: string };

/**
 * A channel's dial-2 items. `workstream` is the channel's own, `present` is
 * every workstream the device currently knows about — an empty channel's
 * candidates come from there, not from itself.
 */
export function dial2ItemsOf(workstream: Workstream | null, present: readonly Workstream[]): Dial2Item[] {
  if (workstream) return workstream.worktree?.isLinked ? [{ kind: "remove", workspaceId: workstream.workspaceId }] : [];

  const byRepo = new Map<string, Dial2Item>();
  for (const candidate of present) {
    const worktree = candidate.worktree;
    if (!worktree || byRepo.has(worktree.repoKey)) continue;
    byRepo.set(worktree.repoKey, { kind: "create", repoKey: worktree.repoKey, repoName: worktree.repoName, repoRoot: worktree.repoRoot });
  }
  // Sorted by the repository's own key, never by Herdr's listing order, so
  // rotating always visits the same repositories in the same order.
  return [...byRepo.values()].sort((left, right) => repoKeyOf(left).localeCompare(repoKeyOf(right)));
}

function repoKeyOf(item: Dial2Item): string {
  return item.kind === "create" ? item.repoKey : "";
}

/**
 * Where dial 2 stands for one channel: `browse` previews a verb without
 * touching Herdr; `armed` is what pushing a browsed `remove` enters, waiting
 * for the confirming second push. Nothing arms `create` — creating a
 * worktree is not the destructive half of this ticket, so it commits on its
 * first push the same way dial 1's press-to-focus does.
 */
export type Dial2Selection = { mode: "browse"; index: number; at: number } | { mode: "armed"; at: number };

/**
 * How long an armed removal waits for its confirming push before giving up.
 * Reused from `control.ts` rather than a second timeout invented for this
 * ticket — the note on `-8e8` asks for exactly that: one friction primitive,
 * not a second gesture vocabulary. Removal deserves at least as much friction
 * as the actions key's own destructive interrupt, and no more is asked for.
 */
export { ARM_TIMEOUT_MS as REMOVE_ARM_TIMEOUT_MS };

/** Moves the browsed selection, wrapping. Mirrors dial 1's `rotateBrowse`. */
export function rotateDial2Browse(current: Dial2Selection | null, items: readonly Dial2Item[], ticks: number, at: number): Dial2Selection | null {
  if (items.length === 0) return null;
  const from = current?.mode === "browse" ? current.index : -1;
  return { mode: "browse", index: wrap(from + ticks, items.length), at };
}

/** Whether an armed removal has outlived its window without a confirming push. */
export function dueDial2ArmTimeout(selection: Dial2Selection | null, at: number): boolean {
  return selection?.mode === "armed" && at - selection.at > ARM_TIMEOUT_MS;
}

function wrap(index: number, length: number): number {
  return ((index % length) + length) % length;
}

/** The browsed item, resolved the same way a press resolves it — shared by the reducer and the projection. */
export function dial2SelectedItem(selection: Dial2Selection | null, items: readonly Dial2Item[]): Dial2Item | null {
  if (selection?.mode !== "browse" || items.length === 0) return null;
  return items[wrap(selection.index, items.length)] ?? null;
}

/**
 * What a channel's strip says about dial 2, while it is in use — a live
 * acknowledgement (success or failure) always wins over the idle preview,
 * the same precedence the control row's own keys already use.
 */
export function dial2Notice(selection: Dial2Selection | null, items: readonly Dial2Item[]): string | null {
  if (!selection) return null;
  if (selection.mode === "armed") return "REMOVE AGAIN?";
  const item = dial2SelectedItem(selection, items);
  if (!item) return null;
  return item.kind === "create" ? truncateMiddle(`+ ${item.repoName}`, READING_CELLS) : "REMOVE";
}

/**
 * One channel's brief acknowledgement of what dial 2's last push did.
 *
 * Shaped exactly like `control.ts`'s `ControlOutcome`, keyed by channel
 * instead of by workspace and column: a genuinely different scope (a
 * channel's dial rather than one workstream's fixed key), so it stays its
 * own small type rather than forcing the control row's shape to describe
 * something it was never about.
 */
export type Dial2Outcome = { channel: number; ok: boolean; message?: string; until: number };

/** Records one outcome, replacing whatever this channel's dial 2 was already showing. */
export function acknowledgeDial2(
  outcomes: readonly Dial2Outcome[],
  entry: { channel: number; ok: boolean; message?: string },
  at: number
): Dial2Outcome[] {
  const kept = outcomes.filter((outcome) => outcome.channel !== entry.channel);
  return [...kept, { ...entry, until: at + ACK_DISPLAY_MS }];
}

/** Drops acknowledgements past their window, returning the same array when nothing was dropped. */
export function liveDial2Acknowledgements(outcomes: readonly Dial2Outcome[], at: number): Dial2Outcome[] {
  const kept = outcomes.filter((outcome) => outcome.until >= at);
  return kept.length === outcomes.length ? (outcomes as Dial2Outcome[]) : kept;
}

/** What one channel's dial 2 is currently showing, if it has a live acknowledgement. */
export function dial2AcknowledgementFor(outcomes: readonly Dial2Outcome[], channel: number): Dial2Outcome | undefined {
  return outcomes.find((outcome) => outcome.channel === channel);
}
