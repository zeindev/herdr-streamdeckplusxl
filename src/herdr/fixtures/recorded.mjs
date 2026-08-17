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

/** The worktree Herdr reported alongside that workspace — the branch lives here. */
export function recordedWorktree(overrides = {}) {
  return { ...structuredClone(recordedEvent("worktree_created").data.worktree), ...overrides };
}
