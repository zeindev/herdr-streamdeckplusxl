import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { NdjsonDecoder, decodeMessage } from "./decode.ts";
import {
  GLOBAL_SUBSCRIPTIONS,
  type HerdrError,
  type HerdrEvent,
  type HerdrRequest
} from "./protocol.ts";

const DEFAULT_RECONNECT_DELAY_MS = 1000;

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
};

type Pending = {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

/**
 * A live connection to Herdr's socket API.
 *
 * Herdr is the source of truth and this client is a thin adapter over it: it
 * subscribes once per connection, forwards every event it understands, and
 * reconnects on its own so a Herdr restart never requires restarting anything
 * downstream. It holds no domain state and interprets no payloads.
 *
 * Events arrive far faster than a device can redraw — `pane_updated` fires on
 * every output revision, which is dozens per second while an agent is working.
 * Coalescing is deliberately the consumer's job, so nothing is dropped here.
 */
export class HerdrClient {
  private readonly socketPath: string;
  private readonly reconnectDelayMs: number;
  private readonly decoder = new NdjsonDecoder();
  private readonly eventListeners = new Set<(event: HerdrEvent) => void>();
  private readonly unknownListeners = new Set<(line: string) => void>();
  private readonly connectionListeners = new Set<(connected: boolean) => void>();
  private readonly pending = new Map<string, Pending>();

  private socket: Socket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private nextRequestId = 0;

  /** True while a socket is open and subscribed. */
  connected = false;

  constructor(options: HerdrClientOptions = {}) {
    this.socketPath = options.socketPath ?? defaultSocketPath();
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
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

  /** Sends a request and resolves with its result, rejecting on an error reply. */
  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket || !this.connected) {
      return Promise.reject(new Error(`cannot call ${method}: not connected to Herdr`));
    }
    const id = `sd-${++this.nextRequestId}`;
    const message: HerdrRequest = { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.write(JSON.stringify(message) + "\n", (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
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
        // Subscribing before announcing the connection means a caller reacting
        // to `connected` can immediately issue requests that depend on it.
        this.sendSubscribe(socket);
        this.setConnected(true);
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

  private sendSubscribe(socket: Socket): void {
    const request: HerdrRequest = {
      id: "sd-subscribe",
      method: "events.subscribe",
      params: { subscriptions: GLOBAL_SUBSCRIPTIONS.map((type) => ({ type })) }
    };
    socket.write(JSON.stringify(request) + "\n");
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
      const pending = this.pending.get(message.id);
      if (!pending) continue; // The subscribe acknowledgement, or a reply we no longer await.
      this.pending.delete(message.id);
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
    for (const [, pending] of this.pending) pending.reject(reason);
    this.pending.clear();
    this.setConnected(false);
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    for (const listener of this.connectionListeners) listener(connected);
  }
}
