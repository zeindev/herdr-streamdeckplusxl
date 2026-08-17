/**
 * Payloads taken from real Herdr traffic.
 *
 * Tests and the preview both build their scenarios from these rather than from
 * hand-written objects, so a payload Herdr stops sending in the shape recorded
 * here fails the suite instead of quietly passing against an invention.
 */
import { readFileSync } from "node:fs";

const capture = JSON.parse(readFileSync(new URL("./capture.json", import.meta.url), "utf8"));

export const recordedEvents = capture.events;

/** The first recorded event of a kind, or a thrown error naming what is missing. */
export function recordedEvent(kind) {
  const found = capture.events.find((event) => event.event === kind);
  if (!found) throw new Error(`the capture has no ${kind} to build from`);
  return found;
}

/** A workspace exactly as Herdr sent one, with only the named fields replaced. */
export function recordedWorkspace(overrides = {}) {
  return { ...structuredClone(recordedEvent("workspace_created").data.workspace), ...overrides };
}

/**
 * A workspace exactly as `session.snapshot` returned one once a token was set.
 *
 * Separate from `recordedWorkspace` on purpose: that one comes from an event,
 * and the reducer never reads tokens off an event. A workspace metadata change
 * is structural, so the reducer re-reads the snapshot and the pushed payload is
 * discarded — this is the leg the code actually uses.
 */
export function recordedSnapshotWorkspaceWithTokens(overrides = {}) {
  return { ...structuredClone(capture.snapshotWorkspaceWithTokens), ...overrides };
}

/** The worktree Herdr reported alongside that workspace — the branch lives here. */
export function recordedWorktree(overrides = {}) {
  return { ...structuredClone(recordedEvent("worktree_created").data.worktree), ...overrides };
}
