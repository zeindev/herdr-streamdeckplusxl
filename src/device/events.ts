import type { HerdrEvent } from "../herdr/protocol.js";
import type { HerdrSnapshot, PaneProcessInfo, ResolvedThemeSnapshot, WorktreeEntry } from "../model.js";
import type { Acknowledged } from "./attention.js";
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
  /**
   * A control-row command's outcome, however it was decided. Some are decided
   * locally with no request at all — the git/pull-request key while nothing is
   * known yet, the actions key with no agent pane to target — because a
   * refusal the reducer already knows the reason for does not need a round
   * trip to Herdr to say so.
   */
  | { kind: "control-acknowledged"; workspaceId: string; column: number; ok: boolean; message?: string; at: number }
  /** A dial-2 worktree command's outcome (`-8e8`), the same shape for the same reason. */
  | { kind: "dial2-acknowledged"; channel: number; ok: boolean; message?: string; at: number }
  /**
   * Geography, role corrections, and acknowledged work, read back from storage
   * when the plugin starts.
   */
  | { kind: "settings-loaded"; slots: Slots; roles: RoleOverrides; acknowledged: Acknowledged }
  /** `at` is stamped by the adapter, so a hold can be told from a tap. */
  | { kind: "key-down"; key: KeyAddress; at: number }
  | { kind: "key-up"; key: KeyAddress; at: number }
  /**
   * The touch strip pressed. The SDK reports whether it was held, so this needs
   * no timer of its own — unlike a key, which only reports down and up.
   */
  | { kind: "encoder-touch"; deviceId: string; encoder: number; hold: boolean }
  /** `at` is stamped by the adapter, the same as a key press, so dial 1's preview timeout has a clock to compare against (`-u5d`). */
  | { kind: "encoder-rotate"; deviceId: string; encoder: number; ticks: number; at: number }
  | { kind: "encoder-down"; deviceId: string; encoder: number; at: number }
  | { kind: "encoder-up"; deviceId: string; encoder: number; at: number }
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
  /**
   * Persist which finished work is acknowledged. Herdr reports `done` and has no
   * concept of acknowledged, so without this every restart would ask again about
   * work the developer dealt with yesterday.
   */
  | { kind: "save-acknowledged"; acknowledged: Acknowledged }
  | { kind: "herdr-request"; method: string; params: Record<string, unknown> }
  /**
   * One control-row verb, sent to Herdr and acknowledged on the key that
   * fired it. `column` and `workspaceId` travel with the request rather than
   * being recovered from its reply, because a reply names neither — the
   * adapter has to know where the acknowledgement belongs before it asks.
   *
   * `successMessage` is decided here rather than in the adapter: what a key
   * says when a verb works is product wording, the same kind of decision
   * `ATTENTION_WORDS` makes for attention reasons, and `plugin.ts` stays a
   * thin relay of whatever the reducer already decided rather than pattern
   * matching `method` to guess it back out.
   */
  | { kind: "control-command"; workspaceId: string; column: number; method: string; params: Record<string, unknown>; successMessage: string }
  /**
   * Sending a prompt is two Herdr calls, not one: `pane.send_text` types it,
   * and a second `pane.send_keys` submits it. There is no single socket method
   * for "type and submit" — the CLI's `pane run` convenience composes the same
   * two calls — so this stays its own command rather than forcing that
   * composition into `control-command`'s single-method shape.
   */
  | { kind: "control-prompt"; workspaceId: string; column: number; paneId: string; text: string }
  /**
   * Dial 2's worktree lifecycle verb (`-8e8`), sent to Herdr and acknowledged
   * on the channel that fired it — `control-command`'s own shape, keyed by
   * channel instead of workspace and column, since dial 2 belongs to a
   * channel rather than to one fixed key on a workstream that is already
   * showing there.
   */
  | { kind: "dial2-command"; channel: number; method: string; params: Record<string, unknown>; successMessage: string };
