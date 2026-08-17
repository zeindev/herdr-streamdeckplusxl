import type { HerdrEvent } from "../herdr/protocol.js";
import type { HerdrSnapshot, ResolvedThemeSnapshot } from "../model.js";

/** A physical key, identified by the device it belongs to and where it sits. */
export type KeyAddress = { deviceId: string; column: number; row: number };

export type DeviceInfo = { id: string; type: number };

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
  /** `at` is stamped by the adapter so the reducer needs no clock of its own. */
  | { kind: "herdr-event"; event: HerdrEvent; at: number }
  | { kind: "theme-changed"; theme: ResolvedThemeSnapshot | null }
  | { kind: "key-down"; key: KeyAddress }
  | { kind: "key-up"; key: KeyAddress }
  | { kind: "dial-rotate"; deviceId: string; dial: number; ticks: number }
  | { kind: "dial-down"; deviceId: string; dial: number }
  | { kind: "dial-up"; deviceId: string; dial: number }
  /** A regular heartbeat. Drives anything time-based so the reducer stays pure. */
  | { kind: "tick"; at: number };

/** What the reducer asks the outside world to do. */
export type Command =
  /** Read Herdr's whole state, which is the only source of truth (ADR-0004). */
  | { kind: "load-snapshot" }
  | { kind: "herdr-request"; method: string; params: Record<string, unknown> };
