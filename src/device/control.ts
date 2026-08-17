/**
 * The control row: three fixed keys per channel, per ADR-0011 and ADR-0012.
 *
 * `state.ts` owns *when* these fire — a tap, a hold, a second tap within the
 * arm window — and calls only the pure functions here to decide what that
 * means. Nothing in this module reads a clock or sends anything; `at` always
 * arrives from the event that is already carrying one.
 */

/** Which column is which verb, left to right (ADR-0011's fixed order). */
export const FOCUS_COLUMN = 0;
export const GIT_COLUMN = 1;
export const ACTIONS_COLUMN = 2;

/**
 * The fixed prompt the actions key's tap sends. One prompt, not a menu — see
 * ADR-0012 on why the retired Actions Mode's four verbs collapse to this one
 * for a first release. Kept as a named export so the reducer and its tests
 * agree on the exact string without either hand-copying it.
 */
export const CONTINUE_PROMPT = "Continue with your best judgment.";

/**
 * The actions key armed for one workstream's interrupt, and since when.
 *
 * Global rather than per-channel, because only one physical key can be held
 * at a time — a second workstream's actions key cannot be armed while this
 * one is, so there is nothing to gain from tracking more than one.
 */
export type ArmedAction = { workspaceId: string; armedAt: number };

/**
 * How long an armed actions key waits for its confirming tap before giving up
 * and reverting on its own. Matches the retired Actions Mode's Armed Stop,
 * which used the same three seconds (PRODUCT.md, superseded by this ADR).
 */
export const ARM_TIMEOUT_MS = 3000;

/** Arms the actions key for one workstream's interrupt. */
export function arm(workspaceId: string, at: number): ArmedAction {
  return { workspaceId, armedAt: at };
}

/**
 * Whether an armed actions key is still live for the given press.
 *
 * True only for the exact key that armed it, and only within the timeout —
 * both halves matter: a stale arm past its window must not confirm just
 * because nothing else happened to clear it first.
 */
export function isArmedFor(armed: ArmedAction | null, workspaceId: string, column: number, at: number): boolean {
  return armed !== null && armed.workspaceId === workspaceId && column === ACTIONS_COLUMN && at - armed.armedAt <= ARM_TIMEOUT_MS;
}

/** Whether an arm has outlived its window without being confirmed. */
export function dueArmTimeout(armed: ArmedAction | null, at: number): boolean {
  return armed !== null && at - armed.armedAt > ARM_TIMEOUT_MS;
}

/**
 * Whether a press somewhere else should cancel an active arm.
 *
 * Mirrors DESIGN.md's Latest Action Rule: the most recent physical action
 * always wins, so pressing anything other than the armed key itself — another
 * channel's actions key, this channel's other two controls, a pane — cancels
 * the arm rather than leaving it live for a confirmation the developer was
 * not reaching for.
 */
export function armedElsewhere(armed: ArmedAction | null, pressed: { workspaceId: string; column: number } | null): boolean {
  if (armed === null) return false;
  return pressed === null || pressed.workspaceId !== armed.workspaceId || pressed.column !== ACTIONS_COLUMN;
}

/**
 * One control key's brief acknowledgement of what its last press did.
 *
 * `until` is absolute, computed once when the outcome arrives, so the reducer
 * never has to remember how long ago something happened — only compare `at`
 * against a number already sitting in state.
 */
export type ControlOutcome = { workspaceId: string; column: number; ok: boolean; message?: string; until: number };

/** Records one outcome, replacing whatever this key was already showing. */
export function acknowledge(
  outcomes: readonly ControlOutcome[],
  entry: { workspaceId: string; column: number; ok: boolean; message?: string },
  at: number
): ControlOutcome[] {
  const kept = outcomes.filter((outcome) => !(outcome.workspaceId === entry.workspaceId && outcome.column === entry.column));
  return [...kept, { ...entry, until: at + ACK_DISPLAY_MS }];
}

/** How long a control key's acknowledgement stays on the key before reverting. */
export const ACK_DISPLAY_MS = 1500;

/**
 * Drops acknowledgements past their window, returning the same array when
 * nothing was dropped so an unchanged tick causes no redraw.
 */
export function liveAcknowledgements(outcomes: readonly ControlOutcome[], at: number): ControlOutcome[] {
  // Inclusive of its own edge, the same as `isArmedFor`'s window: an outcome
  // due to expire at exactly `at` has not yet been superseded by anything, so
  // dropping it one tick early would be a small, needless flicker.
  const kept = outcomes.filter((outcome) => outcome.until >= at);
  return kept.length === outcomes.length ? (outcomes as ControlOutcome[]) : kept;
}

/** What one control key is currently showing, if it has a live acknowledgement. */
export function acknowledgementFor(
  outcomes: readonly ControlOutcome[],
  workspaceId: string,
  column: number
): ControlOutcome | undefined {
  return outcomes.find((outcome) => outcome.workspaceId === workspaceId && outcome.column === column);
}
