import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HerdrClient } from "../../.preview/herdr/client.js";
import { NdjsonDecoder } from "../../.preview/herdr/decode.js";

/**
 * A stand-in Herdr server. Speaks the same newline-delimited JSON, records what
 * it was asked, and can be stopped and restarted on the same socket path so
 * reconnect behaviour is exercised for real rather than simulated.
 */
class FakeHerdr {
  constructor(path) {
    this.path = path;
    this.requests = [];
    this.sockets = new Set();
    this.replyWith = (request) => ({ id: request.id, result: { type: "ok", method: request.method } });
  }

  async start() {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => {});
      // Reuses the production decoder rather than reimplementing the framing,
      // so the fake cannot drift from the wire format under test.
      const decoder = new NdjsonDecoder();
      socket.on("data", (chunk) => {
        for (const line of decoder.push(chunk.toString())) {
          const request = JSON.parse(line);
          this.requests.push(request);
          const reply = this.replyWith(request);
          if (reply) socket.write(JSON.stringify(reply) + "\n");
        }
      });
    });
    await new Promise((resolve) => this.server.listen(this.path, resolve));
  }

  /** Pushes a server-initiated event to every connected client. */
  emit(event, data) {
    for (const socket of this.sockets) {
      socket.write(JSON.stringify({ event, data: { type: event, ...data } }) + "\n");
    }
  }

  /** Drops all connections without closing the listener, as a crash would. */
  dropConnections() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  async stop() {
    this.dropConnections();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    this.server = undefined;
  }

  methodsCalled() {
    return this.requests.map((request) => request.method);
  }
}

/**
 * Runs a test against a fake server, guaranteeing both the server and every
 * client it created are shut down. Without this, a failed assertion would leave
 * a client retrying forever and the test process would never exit.
 */
async function withServer(run) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-client-test-"));
  const server = new FakeHerdr(join(directory, "herdr.sock"));
  const clients = [];
  const makeClient = (options = {}) => {
    const client = new HerdrClient({ socketPath: server.path, ...options });
    clients.push(client);
    return client;
  };
  await server.start();
  try {
    await run(server, makeClient);
  } finally {
    for (const client of clients) await client.stop();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

/** Waits for a condition, failing the test with a readable message rather than hanging. */
async function until(condition, description, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${description}`);
}

test("connecting subscribes to every global event in one call", async () => {
  await withServer(async (server, makeClient) => {
    const client = makeClient();
    await client.start();
    await until(() => server.requests.length > 0, "the subscribe request");

    const subscribes = server.requests.filter((request) => request.method === "events.subscribe");
    assert.equal(subscribes.length, 1, "one subscribe call, not one per event");
    const types = subscribes[0].params.subscriptions.map((subscription) => subscription.type);
    assert.equal(types.length, 24);
    assert.ok(types.includes("pane.updated"));
    assert.ok(types.includes("worktree.created"));
    assert.ok(
      types.every((type) => Object.keys(subscribes[0].params.subscriptions[types.indexOf(type)]).length === 1),
      "global subscriptions take no arguments"
    );
  });
});

test("a refused subscription is reported and never reads as connected", async () => {
  await withServer(async (server, makeClient) => {
    server.replyWith = (request) => ({
      id: request.id,
      error: { code: "invalid_request", message: "unsupported subscription" }
    });
    const client = makeClient({ reconnectDelayMs: 5_000 });
    const failures = [];
    client.onSubscribeFailure((error) => failures.push(error));

    await client.start();
    await until(() => failures.length > 0, "the subscribe failure to be reported");

    // An open socket that Herdr refused to subscribe would deliver nothing, so
    // reporting it as connected would leave the device silently stale forever.
    assert.equal(client.connected, false);
    assert.match(failures[0].message, /unsupported subscription/);
  });
});

test("a subscription that is never answered does not leave the client connected", async () => {
  await withServer(async (server, makeClient) => {
    server.replyWith = () => null; // accept the socket, answer nothing
    const client = makeClient({ requestTimeoutMs: 60, reconnectDelayMs: 5_000 });
    const failures = [];
    client.onSubscribeFailure((error) => failures.push(error));

    await client.start();
    await until(() => failures.length > 0, "the subscribe to time out");

    assert.equal(client.connected, false);
    assert.match(failures[0].message, /timed out/);
  });
});

test("connected means subscribed, not merely socket-open", async () => {
  await withServer(async (server, makeClient) => {
    let acknowledge;
    server.replyWith = (request) => {
      if (request.method !== "events.subscribe") return null;
      acknowledge = () => {
        for (const socket of server.sockets) {
          socket.write(JSON.stringify({ id: request.id, result: { type: "subscription_started" } }) + "\n");
        }
      };
      return null; // held until the test releases it
    };
    const client = makeClient({ requestTimeoutMs: 5_000 });
    await client.start();
    await until(() => acknowledge !== undefined, "the subscribe to reach the server");

    assert.equal(client.connected, false, "still waiting on the acknowledgement");
    acknowledge();
    await until(() => client.connected, "connection once the subscription is acknowledged");
  });
});

test("a request that gets no reply rejects instead of hanging", async () => {
  await withServer(async (server, makeClient) => {
    server.replyWith = (request) =>
      request.method === "events.subscribe" ? { id: request.id, result: { type: "subscription_started" } } : null;
    const client = makeClient({ requestTimeoutMs: 60 });
    await client.start();
    await until(() => client.connected, "the connection");

    await assert.rejects(client.request("pane.list", {}), /timed out/);
  });
});

test("pushed events reach subscribers as typed events", async () => {
  await withServer(async (server, makeClient) => {
    const client = makeClient();
    const seen = [];
    client.onEvent((event) => seen.push(event));
    await client.start();
    await until(() => client.connected, "the connection");

    server.emit("pane_updated", { pane: { pane_id: "w1:p1", agent_status: "working" } });
    server.emit("worktree_created", { worktree: { path: "/tmp/wt", label: "auth" } });
    await until(() => seen.length === 2, "two events");

    assert.equal(seen[0].event, "pane_updated");
    assert.equal(seen[0].data.pane.agent_status, "working");
    assert.equal(seen[1].event, "worktree_created");
  });
});

test("an unrecognised event does not disturb the events around it", async () => {
  await withServer(async (server, makeClient) => {
    const client = makeClient();
    const seen = [];
    const unknown = [];
    client.onEvent((event) => seen.push(event.event));
    client.onUnknown((line) => unknown.push(line));
    await client.start();
    await until(() => client.connected, "the connection");

    server.emit("pane_created", { pane: { pane_id: "w1:p1" } });
    server.emit("from_a_newer_herdr", {});
    server.emit("pane_closed", { pane: { pane_id: "w1:p1" } });
    await until(() => seen.length === 2, "the two known events");

    assert.deepEqual(seen, ["pane_created", "pane_closed"]);
    assert.equal(unknown.length, 1);
    assert.ok(client.connected, "an unknown event must not drop the connection");
  });
});

test("a request resolves with its own reply even when replies arrive out of order", async () => {
  await withServer(async (server, makeClient) => {
    server.replyWith = (request) => {
      if (request.method === "events.subscribe") return { id: request.id, result: { type: "subscription_started" } };
      return null; // answered manually below
    };
    const client = makeClient();
    await client.start();
    await until(() => client.connected, "the connection");

    const slow = client.request("pane.list", {});
    const fast = client.request("workspace.list", {});
    await until(() => server.requests.length === 3, "both requests to arrive");

    const [, slowRequest, fastRequest] = server.requests;
    for (const socket of server.sockets) {
      socket.write(JSON.stringify({ id: fastRequest.id, result: { which: "fast" } }) + "\n");
      socket.write(JSON.stringify({ id: slowRequest.id, result: { which: "slow" } }) + "\n");
    }

    assert.deepEqual(await fast, { which: "fast" });
    assert.deepEqual(await slow, { which: "slow" });
  });
});

test("an error reply rejects that request with its code and message", async () => {
  await withServer(async (server, makeClient) => {
    server.replyWith = (request) =>
      request.method === "events.subscribe"
        ? { id: request.id, result: { type: "subscription_started" } }
        : { id: request.id, error: { code: "invalid_request", message: "missing field `pane_id`" } };

    const client = makeClient();
    await client.start();
    await until(() => client.connected, "the connection");

    await assert.rejects(client.request("pane.zoom", {}), (error) => {
      assert.equal(error.code, "invalid_request");
      assert.match(error.message, /pane_id/);
      return true;
    });
  });
});

test("the client reconnects and resubscribes after the server restarts", async () => {
  await withServer(async (server, makeClient) => {
    const client = makeClient({ reconnectDelayMs: 10 });
    // Recorded rather than polled: the disconnected window can be shorter than
    // any poll interval, so observing it directly would be a race.
    const connections = [];
    client.onConnectionChange((connected) => connections.push(connected));
    const seen = [];
    client.onEvent((event) => seen.push(event.event));

    const subscribeCount = () => server.requests.filter((request) => request.method === "events.subscribe").length;
    await client.start();
    // Being connected is not enough: the subscribe must have reached the server,
    // or dropping the connection would destroy the socket before it flushed.
    await until(() => subscribeCount() === 1, "the first subscribe to reach the server");

    server.dropConnections();
    await until(() => connections.length === 3, "a disconnect followed by a reconnect");
    assert.deepEqual(connections, [true, false, true]);
    await until(() => subscribeCount() === 2, "the resubscribe to reach the server");

    server.emit("pane_focused", { pane: { pane_id: "w1:p1" } });
    await until(() => seen.length === 1, "events flowing again after reconnect");
  });
});

test("a request made while disconnected rejects rather than hanging forever", async () => {
  await withServer(async (server, makeClient) => {
    const client = makeClient({ reconnectDelayMs: 5_000 });
    await client.start();
    await until(() => client.connected, "the connection");

    const pending = client.request("pane.list", {});
    server.dropConnections();
    await assert.rejects(pending, /connection lost/i);
  });
});

test("stopping prevents any further reconnection", async () => {
  await withServer(async (server, makeClient) => {
    const client = makeClient({ reconnectDelayMs: 5 });
    await client.start();
    await until(() => client.connected, "the connection");
    const before = server.requests.length;

    await client.stop();
    server.dropConnections();
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(client.connected, false);
    assert.equal(server.requests.length, before, "no reconnect attempts after stop");
  });
});

test("the client waits for a server that is not listening yet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-client-test-"));
  const path = join(directory, "herdr.sock");
  const client = new HerdrClient({ socketPath: path, reconnectDelayMs: 10 });
  const server = new FakeHerdr(path);
  try {
    await client.start();
    assert.equal(client.connected, false, "nothing to connect to yet");

    await server.start();
    // Connected trails the subscribe by one round trip, so wait for the end
    // state rather than asserting the instant the request lands.
    await until(() => client.connected, "connection once the server appears", 3000);
    assert.equal(server.requests.filter((r) => r.method === "events.subscribe").length, 1);
  } finally {
    await client.stop();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
