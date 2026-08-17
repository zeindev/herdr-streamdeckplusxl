import streamDeck, {
  action,
  SingletonAction,
  type DialAction,
  type DialDownEvent,
  type DialRotateEvent,
  type DialUpEvent,
  type KeyAction,
  type KeyDownEvent,
  type KeyUpEvent,
  type TouchTapEvent,
  type WillAppearEvent,
  type WillDisappearEvent
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import type { Command, DeviceEvent } from "./device/events.js";
import { keyAddress, layoutForDeviceType, type DeviceLayout } from "./device/geometry.js";
import { readRoles, storedRoles } from "./device/role.js";
import { readSlots, storedSlots } from "./device/slots.js";
import { initialState, reduce, type State } from "./device/state.js";
import { changedControls, surfaceOf, type ControlChange, type EncoderFace, type KeyFace, type Surface } from "./device/surface.js";
import { encoderImage, keyImage } from "./device/paint.js";
import { HerdrClient } from "./herdr/client.js";
import { hasResolvedTheme, processInfoFromResult, snapshotFromResult, worktreesFromResult } from "./model.js";
import { copiedThemeFromHerdrConfig } from "./theme.js";

/**
 * How often the reducer is offered the current time, and the fastest the device
 * redraws. Herdr's `pane_updated` arrives dozens of times a second, so drawing
 * per event would swamp the hardware; changes are gathered and flushed on this
 * beat instead.
 */
const TICK_MS = 100;

/**
 * The adapter around the seam.
 *
 * Every decision lives in `reduce` and `surfaceOf`, which are pure and tested.
 * This file only carries events in, sends commands out, and turns described
 * faces into pixels — it holds no product logic of its own.
 */
class Adapter {
  private readonly herdr = new HerdrClient();
  private state = initialState();
  private rendered: Surface = { devices: [] };
  private dirty = true;
  private flushing = false;

  /** Live action instances, addressed the way the surface addresses controls. */
  private readonly keys = new Map<string, KeyAction>();
  private readonly encoders = new Map<string, DialAction>();
  /**
   * Where each action instance sits. A disappearing action reports only its id,
   * never its coordinates, so the address has to be remembered on the way in.
   */
  private readonly addresses = new Map<string, string>();

  start(): void {
    // Geography first: the channels must mean what they meant yesterday before
    // anything from Herdr can fill them in.
    void this.loadSlots();

    this.herdr.onConnectionChange((connected) => this.dispatch({ kind: "herdr-connection", connected }));
    this.herdr.onEvent((event) => this.dispatch({ kind: "herdr-event", event, at: Date.now() }));
    this.herdr.onSubscribeFailure((error) => streamDeck.logger.error(`Herdr refused the subscription: ${error.message}`));
    this.herdr.onUnknown((line) => streamDeck.logger.debug(`Unrecognised Herdr line: ${line.slice(0, 200)}`));

    for (const device of streamDeck.devices) this.attach(String(device.id), Number(device.type));
    streamDeck.devices.onDeviceDidConnect(({ device }) => this.attach(String(device.id), Number(device.type)));
    streamDeck.devices.onDeviceDidDisconnect(({ device }) =>
      this.dispatch({ kind: "device-detached", deviceId: String(device.id) })
    );

    setInterval(() => {
      this.dispatch({ kind: "tick", at: Date.now() });
      void this.flush();
    }, TICK_MS);

    void this.herdr.start();
  }

  private async loadSlots(): Promise<void> {
    try {
      const stored = await streamDeck.settings.getGlobalSettings();
      this.dispatch({ kind: "settings-loaded", slots: readSlots(stored), roles: readRoles(stored) });
    } catch (error) {
      // An unreadable setting costs the remembered geography, not the device.
      streamDeck.logger.error(`Could not read slot assignments: ${(error as Error).message}`);
    }
  }

  /**
   * Merges into the stored settings rather than replacing them.
   *
   * Global settings are one object shared by everything the plugin remembers, so
   * writing slot assignments with `setGlobalSettings` alone would erase the role
   * corrections sitting beside them.
   */
  private async saveSettings(part: JsonObject): Promise<void> {
    const stored = await streamDeck.settings.getGlobalSettings();
    await streamDeck.settings.setGlobalSettings({ ...stored, ...part });
  }

  private attach(deviceId: string, type: number): void {
    if (!layoutForDeviceType(type)) {
      streamDeck.logger.info(`Ignoring unsupported Stream Deck type ${type}`);
      return;
    }
    this.dispatch({ kind: "device-attached", device: { id: deviceId, type } });
  }

  /** One event in, new state and commands out. The only way state ever changes. */
  dispatch(event: DeviceEvent): void {
    const step = reduce(this.state, event);
    if (step.state !== this.state) {
      this.state = step.state;
      this.dirty = true;
    }
    for (const command of step.commands) void this.run(command);
  }

  private async run(command: Command): Promise<void> {
    try {
      if (command.kind === "load-snapshot") {
        const snapshot = snapshotFromResult(await this.herdr.request("session.snapshot"));
        if (!snapshot) throw new Error("Herdr returned no usable snapshot");
        // Herdr owns colour, but its snapshot does not expose a resolved palette
        // yet, so until it does the theme comes from a copy of Herdr's config.
        const theme = hasResolvedTheme(snapshot.theme) ? snapshot.theme : await copiedThemeFromHerdrConfig();
        this.dispatch({ kind: "herdr-snapshot", snapshot });
        this.dispatch({ kind: "theme-changed", theme });
        return;
      }
      if (command.kind === "load-worktrees") {
        const result = await this.herdr.request("worktree.list", { workspace_id: command.workspaceId });
        this.dispatch({ kind: "herdr-worktrees", worktrees: worktreesFromResult(result) });
        return;
      }
      if (command.kind === "load-process-info") {
        const result = await this.herdr.request("pane.process_info", { pane_id: command.paneId });
        this.dispatch({ kind: "herdr-process-info", paneId: command.paneId, info: processInfoFromResult(result) ?? null });
        return;
      }
      // Both durable settings live in one global object, so each write has to
      // carry the other rather than replacing it.
      if (command.kind === "save-slots") {
        await this.saveSettings(storedSlots(command.slots));
        return;
      }
      if (command.kind === "save-roles") {
        await this.saveSettings(storedRoles(command.roles));
        return;
      }
      await this.herdr.request(command.method, command.params);
    } catch (error) {
      streamDeck.logger.error(`Command ${command.kind} failed: ${(error as Error).message}`);
    }
  }

  registerKey(address: string, instance: KeyAction): void {
    this.keys.set(address, instance);
    this.addresses.set(instance.id, address);
    this.redrawFromScratch();
  }

  registerEncoder(address: string, instance: DialAction): void {
    this.encoders.set(address, instance);
    this.addresses.set(instance.id, address);
    this.redrawFromScratch();
  }

  forget(actionId: string): void {
    const address = this.addresses.get(actionId);
    if (address === undefined) return;
    this.addresses.delete(actionId);
    this.keys.delete(address);
    this.encoders.delete(address);
  }

  /**
   * A control that has just appeared has no image, so the remembered surface is
   * discarded and every face is drawn again on the next flush.
   */
  private redrawFromScratch(): void {
    this.rendered = { devices: [] };
    this.dirty = true;
  }

  /** Draws only the controls whose described face actually moved. */
  private async flush(): Promise<void> {
    if (!this.dirty || this.flushing) return;
    this.dirty = false;
    this.flushing = true;
    try {
      const next = surfaceOf(this.state);
      const changes = changedControls(this.rendered, next);
      this.rendered = next;
      for (const change of changes) await this.draw(change);
    } catch (error) {
      streamDeck.logger.error(`Redraw failed: ${(error as Error).message}`);
    } finally {
      this.flushing = false;
    }
  }

  private async draw(change: ControlChange): Promise<void> {
    const layout = this.layoutOf(change.deviceId);
    if (!layout) return;

    if (change.control === "key") {
      const { column, row } = keyAddress(layout, change.index);
      const instance = this.keys.get(`${change.deviceId}:${column},${row}`);
      if (!instance) return; // Not placed on the active profile page.
      await instance.setImage(dataUri(keyImage(change.face as KeyFace, this.state.theme)));
      return;
    }

    const instance = this.encoders.get(`${change.deviceId}:${change.index}`);
    if (!instance) return;
    // An encoder's touch-strip region is drawn through the layout feedback.
    // `setImage` on a dial sets its icon inside the Stream Deck app, not on the
    // hardware, so it is deliberately not used here.
    await instance.setFeedback({
      "full-canvas": dataUri(encoderImage(change.index, change.face as EncoderFace, layout, this.state.theme))
    });
  }

  private layoutOf(deviceId: string): DeviceLayout | null {
    const device = this.state.devices.find((candidate) => candidate.id === deviceId);
    return device ? layoutForDeviceType(device.type) : null;
  }
}

const adapter = new Adapter();

function dataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** Coordinates come from the action instance; multi-action payloads carry none. */
function addressOf(instance: KeyAction | DialAction): string | null {
  const coordinates = instance.coordinates;
  return coordinates ? `${instance.device.id}:${coordinates.column},${coordinates.row}` : null;
}

/**
 * One action fills every key position on the profile. The reducer decides what
 * each position means, so the plugin needs no separate action per purpose.
 */
@action({ UUID: "dev.herdr.streamdeck.key" })
class ChannelKey extends SingletonAction {
  override onWillAppear(event: WillAppearEvent): void {
    if (!event.action.isKey()) return;
    const address = addressOf(event.action);
    if (address) adapter.registerKey(address, event.action);
  }

  override onWillDisappear(event: WillDisappearEvent): void {
    adapter.forget(event.action.id);
  }

  override onKeyDown(event: KeyDownEvent): void {
    this.press("key-down", event.action);
  }

  override onKeyUp(event: KeyUpEvent): void {
    this.press("key-up", event.action);
  }

  private press(kind: "key-down" | "key-up", instance: KeyAction): void {
    const coordinates = instance.coordinates;
    if (!coordinates) return;
    adapter.dispatch({
      kind,
      key: { deviceId: String(instance.device.id), column: coordinates.column, row: coordinates.row },
      at: Date.now()
    });
  }
}

/** One action fills every encoder. Its index is its column on the profile. */
@action({ UUID: "dev.herdr.streamdeck.encoder" })
class ChannelEncoder extends SingletonAction {
  override onWillAppear(event: WillAppearEvent): void {
    if (!event.action.isDial()) return;
    const index = event.action.coordinates?.column;
    if (index === undefined) return;
    adapter.registerEncoder(`${event.action.device.id}:${index}`, event.action);
  }

  override onWillDisappear(event: WillDisappearEvent): void {
    adapter.forget(event.action.id);
  }

  /**
   * The touch strip. Its hold is where slot reassignment lives, having moved off
   * the keys when the panes took that row; the SDK reports the hold itself, so
   * this needs no timer of its own.
   */
  override onTouchTap(event: TouchTapEvent): void {
    const index = event.action.coordinates?.column;
    if (index === undefined) return;
    adapter.dispatch({
      kind: "encoder-touch",
      deviceId: String(event.action.device.id),
      encoder: index,
      hold: event.payload.hold
    });
  }

  override onDialRotate(event: DialRotateEvent): void {
    const index = event.action.coordinates?.column;
    if (index === undefined) return;
    adapter.dispatch({
      kind: "encoder-rotate",
      deviceId: String(event.action.device.id),
      encoder: index,
      ticks: event.payload.ticks
    });
  }

  override onDialDown(event: DialDownEvent): void {
    const index = event.action.coordinates?.column;
    if (index === undefined) return;
    adapter.dispatch({ kind: "encoder-down", deviceId: String(event.action.device.id), encoder: index });
  }

  override onDialUp(event: DialUpEvent): void {
    const index = event.action.coordinates?.column;
    if (index === undefined) return;
    adapter.dispatch({ kind: "encoder-up", deviceId: String(event.action.device.id), encoder: index });
  }
}

streamDeck.actions.registerAction(new ChannelKey());
streamDeck.actions.registerAction(new ChannelEncoder());
streamDeck.connect();
adapter.start();
