import type { HerdrEvent } from "../herdr/protocol.js";
import type { HerdrSnapshot, ResolvedThemeSnapshot, WorktreeEntry } from "../model.js";

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
  /** `at` is stamped by the adapter so the reducer needs no clock of its own. */
  | { kind: "herdr-event"; event: HerdrEvent; at: number }
  | { kind: "theme-changed"; theme: ResolvedThemeSnapshot | null }
  | { kind: "key-down"; key: KeyAddress }
  | { kind: "key-up"; key: KeyAddress }
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
  | { kind: "herdr-request"; method: string; params: Record<string, unknown> };
