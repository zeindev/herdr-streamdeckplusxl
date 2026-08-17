import type { HerdrEvent } from "../herdr/protocol.js";
import type { HerdrSnapshot, PaneProcessInfo, ResolvedThemeSnapshot, WorktreeEntry } from "../model.js";
import type { RoleOverrides } from "./role.js";
import type { Slots } from "./slots.js";

/** A physical key, identified by the device it belongs to and where it sits. */
export type KeyAddress = { deviceId: string; column: number; row: number };

export type DeviceInfo = { id: string; type: number };

/** True when two addresses name the same physical key. */
export function sameKey(left: KeyAddress, right: KeyAddress): boolean {
  return left.deviceId === right.deviceId && left.column === right.column && left.row === right.row;
}

/**
 * Everything that can move the device forward, from either direction: Herdr
 * pushing state, the user pressing something, hardware appearing, and time
 * passing. The reducer takes these and nothing else.
 */
export type DeviceEvent =
  | { kind: "device-attached"; device: DeviceInfo }
  | { kind: "device-detached"; deviceId: string }
  | { kind: "herdr-connection"; connected: boolean }
  | { kind: "herdr-snapshot"; snapshot: HerdrSnapshot }
  /** A `worktree.list` reply, which is the only place a branch is reported. */
  | { kind: "herdr-worktrees"; worktrees: WorktreeEntry[] }
  /**
   * A `pane.process_info` reply, whole. Which of its processes identifies the
   * pane is a decision, so the reducer makes it rather than the adapter.
   */
  | { kind: "herdr-process-info"; paneId: string; info: PaneProcessInfo | null }
  /** `at` is stamped by the adapter so the reducer needs no clock of its own. */
  | { kind: "herdr-event"; event: HerdrEvent; at: number }
  | { kind: "theme-changed"; theme: ResolvedThemeSnapshot | null }
  /** Geography and role corrections read back from storage when the plugin starts. */
  | { kind: "settings-loaded"; slots: Slots; roles: RoleOverrides }
  /** `at` is stamped by the adapter, so a hold can be told from a tap. */
  | { kind: "key-down"; key: KeyAddress; at: number }
  | { kind: "key-up"; key: KeyAddress; at: number }
  /**
   * The touch strip pressed. The SDK reports whether it was held, so this needs
   * no timer of its own — unlike a key, which only reports down and up.
   */
  | { kind: "encoder-touch"; deviceId: string; encoder: number; hold: boolean }
  | { kind: "encoder-rotate"; deviceId: string; encoder: number; ticks: number }
  | { kind: "encoder-down"; deviceId: string; encoder: number }
  | { kind: "encoder-up"; deviceId: string; encoder: number }
  /** A regular heartbeat. Drives anything time-based so the reducer stays pure. */
  | { kind: "tick"; at: number };

/** What the reducer asks the outside world to do. */
export type Command =
  /** Read Herdr's whole state, which is the only source of truth (ADR-0004). */
  | { kind: "load-snapshot" }
  /**
   * Read one repository's worktrees, to learn its branches. The snapshot does not
   * carry them, so this is a second read rather than a redundant one.
   */
  | { kind: "load-worktrees"; workspaceId: string }
  /**
   * Persist slot assignments. They must outlive both Herdr and the Stream Deck
   * app, so they live in the app's settings rather than in a workspace token,
   * which dies with its workspace (ADR-0009).
   */
  | { kind: "save-slots"; slots: Slots }
  /**
   * Read what is running in one pane, to work out what the pane is for. One
   * request per pane: `pane.process_info` answers for a single pane, and null
   * means the focused one rather than all of them.
   */
  | { kind: "load-process-info"; paneId: string }
  /** Persist role corrections, which outlive the panes they were made on. */
  | { kind: "save-roles"; roles: RoleOverrides }
  | { kind: "herdr-request"; method: string; params: Record<string, unknown> };
