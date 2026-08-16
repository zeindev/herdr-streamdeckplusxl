import { isEventKind, type HerdrMessage } from "./protocol.ts";

/**
 * Reassembles newline-delimited JSON from a stream that splits wherever the
 * socket happens to flush. Herdr frames every message as one line.
 */
export class NdjsonDecoder {
  /** The trailing fragment of an incomplete line, exposed for tests and logging. */
  pending = "";

  push(chunk: string): string[] {
    this.pending += chunk;
    const lines: string[] = [];
    let boundary = this.pending.indexOf("\n");
    while (boundary >= 0) {
      const line = this.pending.slice(0, boundary);
      this.pending = this.pending.slice(boundary + 1);
      if (line.trim()) lines.push(line);
      boundary = this.pending.indexOf("\n");
    }
    return lines;
  }

  /** Discards any partial line. Call on reconnect so a truncated frame cannot bleed into the new stream. */
  reset(): void {
    this.pending = "";
  }
}

/**
 * Classifies one line into an event, a reply, or neither.
 *
 * Nothing here throws: a server that sends something unrecognised must not be
 * able to kill the connection, so unparseable lines surface as `unknown` and
 * are the caller's to log.
 */
export function decodeMessage(line: string): HerdrMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "unknown", raw: line };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unknown", raw: line };
  }
  const message = parsed as Record<string, unknown>;

  if ("event" in message) {
    const data = message.data;
    if (!isEventKind(message.event) || !data || typeof data !== "object") {
      return { kind: "unknown", raw: line };
    }
    return {
      kind: "event",
      event: message.event,
      data: data as { type: typeof message.event } & Record<string, unknown>
    };
  }

  if (typeof message.id === "string") {
    const error = message.error;
    if (error && typeof error === "object") {
      const { code, message: text } = error as Record<string, unknown>;
      return {
        kind: "reply",
        ok: false,
        id: message.id,
        error: { code: typeof code === "string" ? code : "unknown", message: typeof text === "string" ? text : line }
      };
    }
    const result = message.result;
    if (result && typeof result === "object") {
      return { kind: "reply", ok: true, id: message.id, result: result as Record<string, unknown> };
    }
  }

  return { kind: "unknown", raw: line };
}
