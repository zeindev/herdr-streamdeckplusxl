import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { NdjsonDecoder, decodeMessage } from "./decode.js";
import {
  GLOBAL_SUBSCRIPTIONS,
  type HerdrError,
  type HerdrEvent,
  type HerdrRequest
} from "./protocol.js";

const DEFAULT_RECONNECT_DELAY_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/** Where Herdr's server socket lives, unless `HERDR_SOCKET` overrides it. */
export function defaultSocketPath(): string {
  return process.env.HERDR_SOCKET || join(homedir(), ".config", "herdr", "herdr.sock");
}

export class HerdrRequestError extends Error {
  readonly code: string;

  constructor({ code, message }: HerdrError) {
    super(message);
    this.name = "HerdrRequestError";
    this.code = code;
  }
}

export type HerdrClientOptions = {
  socketPath?: string;
  /** How long to wait before retrying a lost or refused connection. */
  reconnectDelayMs?: number;
  /** How long a request waits for its reply before giving up. */
  requestTimeoutMs?: number;
};

type Pending = {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * A live connection to Herdr's socket API.
 *
 * Herdr is the source of truth and this client is a thin adapter over it: it
 * subscribes once per connection, forwards every event it understands, and
 * reconnects on its own so a Herdr restart never requires restarting anything
 * downstream. It holds no domain state and interprets no payloads.
 *
 * Two behaviours of the live stream shape how a consumer must be written, and
 * neither is handled here — this client stays faithful and drops nothing:
 *
 * - **It floods.** `pane_updated` fires on every output revision, dozens of
 *   times a second while an agent works. Redrawing per event would be worse
 *   than the polling this replaces, so consumers must coalesce.
 * - **Subscribing replays a backlog.** Herdr delivers a bounded history of past
 *   events on every subscribe, which means on every reconnect too. The replay
 *   describes entities that may no longer exist, so a consumer must treat a
 *   fresh `session.snapshot` as truth and events as deltas on top of it, rather
 *   than rebuilding state from the stream alone.
 */
export class HerdrClient {
  private readonly socketPath: string;
  private readonly reconnectDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly decoder = new NdjsonDecoder();
  private readonly eventListeners = new Set<(event: HerdrEvent) => void>();
  private readonly unknownListeners = new Set<(line: string) => void>();
  private readonly connectionListeners = new Set<(connected: boolean) => void>();
  private readonly subscribeFailureListeners = new Set<(error: Error) => void>();
  private readonly pending = new Map<string, Pending>();

  private socket: Socket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private nextRequestId = 0;

  /**
   * True once the socket is open **and** Herdr has acknowledged the
   * subscription. A socket that is open but unsubscribed would deliver nothing,
   * so reporting it as connected would be a lie.
   */
  connected = false;

  constructor(options: HerdrClientOptions = {}) {
    this.socketPath = options.socketPath ?? defaultSocketPath();
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  onEvent(listener: (event: HerdrEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Lines the server sent that this protocol version does not recognise. */
  onUnknown(listener: (line: string) => void): () => void {
    this.unknownListeners.add(listener);
    return () => this.unknownListeners.delete(listener);
  }

  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  /**
   * A subscription Herdr refused. The connection is dropped and retried, so
   * this repeats; it exists because a silent failure here would leave the
   * device showing stale state forever with no indication why.
   */
  onSubscribeFailure(listener: (error: Error) => void): () => void {
    this.subscribeFailureListeners.add(listener);
    return () => this.subscribeFailureListeners.delete(listener);
  }

  /**
   * Begins connecting and keeps trying until stopped. Resolves once the first
   * attempt has settled, whether or not Herdr was there to answer — a device
   * plugged in before Herdr starts must still come up.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.openOnce();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.teardown(new Error("client stopped"));
  }

  /**
   * Sends one request on a connection of its own and resolves with its result.
   *
   * Herdr closes a connection as soon as it answers a request, and sending a
   * second request on the subscription connection makes it close that too —
   * taking the event stream with it. So every request gets a fresh socket and
   * the subscription connection carries nothing but its own handshake.
   */
  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath);
      const decoder = new NdjsonDecoder();
      let settled = false;
      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        outcome();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`${method} timed out after ${this.requestTimeoutMs}ms`))),
        this.requestTimeoutMs
      );

      const id = `sd-${++this.nextRequestId}`;
      socket.on("connect", () =>
        this.write(socket, { id, method, params }, (error) => {
          if (error) finish(() => reject(error));
        })
      );
      socket.on("data", (chunk: Buffer) => {
        for (const line of decoder.push(chunk.toString())) {
          const message = decodeMessage(line);
          if (message.kind !== "reply") continue;
          if (message.ok) finish(() => resolve(message.result));
          else finish(() => reject(new HerdrRequestError(message.error)));
        }
      });
      socket.on("error", (error) => finish(() => reject(error)));
      socket.on("close", () => finish(() => reject(new Error(`${method} closed before replying`))));
    });
  }

  /**
   * Sends the subscription handshake on the long-lived connection and awaits
   * its acknowledgement. This is the only request that connection ever carries.
   */
  private dispatchSubscribe(socket: Socket, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `sd-${++this.nextRequestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`events.subscribe timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write(socket, { id, method: "events.subscribe", params }, (error) => {
        if (!error) return;
        this.settlePending(id)?.reject(error);
      });
    });
  }

  /** The one place the wire format is applied. */
  private write(socket: Socket, message: HerdrRequest, onError: (error?: Error | null) => void): void {
    socket.write(JSON.stringify(message) + "\n", onError);
  }

  private settlePending(id: string): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    return pending;
  }

  private async openOnce(): Promise<void> {
    if (!this.running) return;
    this.decoder.reset();

    await new Promise<void>((resolve) => {
      const socket = connect(this.socketPath);
      this.socket = socket;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      socket.on("connect", () => {
        // Startup waits for the socket, not for the acknowledgement: an
        // unresponsive Herdr must not delay the plugin by a whole request
        // timeout. `connected` flips once the subscription is acknowledged.
        void this.subscribe(socket);
        settle();
      });
      socket.on("data", (chunk: Buffer) => this.consume(chunk.toString()));
      socket.on("error", () => {
        // Refused or broken: 'close' follows and owns the retry.
      });
      socket.on("close", () => {
        if (this.socket === socket) this.handleDisconnect();
        settle();
      });
    });
  }

  /**
   * Completes the subscription handshake before announcing the connection. If
   * Herdr refuses, the socket is dropped so the ordinary retry path applies
   * rather than leaving an open socket that will never deliver an event.
   */
  private async subscribe(socket: Socket): Promise<void> {
    try {
      await this.dispatchSubscribe(socket, {
        subscriptions: GLOBAL_SUBSCRIPTIONS.map((type) => ({ type }))
      });
      this.setConnected(true);
    } catch (error) {
      for (const listener of this.subscribeFailureListeners) listener(error as Error);
      socket.destroy();
    }
  }

  private consume(chunk: string): void {
    for (const line of this.decoder.push(chunk)) {
      const message = decodeMessage(line);
      if (message.kind === "event") {
        for (const listener of this.eventListeners) listener({ event: message.event, data: message.data });
        continue;
      }
      if (message.kind === "unknown") {
        for (const listener of this.unknownListeners) listener(message.raw);
        continue;
      }
      const pending = this.settlePending(message.id);
      if (!pending) continue; // A reply we no longer await, or one already timed out.
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new HerdrRequestError(message.error));
    }
  }

  private handleDisconnect(): void {
    this.teardown(new Error("connection lost before a reply arrived"));
    if (!this.running) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.openOnce();
    }, this.reconnectDelayMs);
  }

  private teardown(reason: Error): void {
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
    this.decoder.reset();
    for (const id of [...this.pending.keys()]) this.settlePending(id)?.reject(reason);
    this.setConnected(false);
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    for (const listener of this.connectionListeners) listener(connected);
  }
}
