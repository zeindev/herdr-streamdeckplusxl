import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The hook script that declares an agent's own state.
 *
 * It is the producing half of the declared-attention signal (ADR-0005), and
 * the only half that ever sees a Claude Code hook payload, so what it decides
 * to declare is the whole contract. Tested against a stub `herdr` that
 * records its arguments — a stub rather than a live server, because the point
 * being pinned is which calls are made, and making them for real would write
 * tokens into the developer's own session.
 *
 * Every call backgrounds itself and returns immediately (see the script's own
 * header), so tests poll briefly for the stub log to gain its line rather
 * than asserting the instant `spawnSync` returns.
 */
const SCRIPT = fileURLToPath(new URL("./herdr-attention", import.meta.url));

/** A fake `herdr` on PATH that appends every invocation to a log. */
function withStubHerdr() {
  const directory = mkdtempSync(join(tmpdir(), "herdr-attention-"));
  const log = join(directory, "calls.log");
  const stub = join(directory, "herdr");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`);
  chmodSync(stub, 0o755);
  return { directory, log };
}

/** Waits for the backgrounded call to land, rather than racing it. */
async function callsEventually(log, { timeoutMs = 2000, pollMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(log)) {
      const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
      if (calls.length > 0) return calls;
    }
    if (Date.now() >= deadline) return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Runs the script, returning its own status plus whatever `herdr` calls
 * eventually land.
 *
 * The inherited environment is stripped of `HERDR_WORKSPACE_ID` and
 * `HERDR_PANE_ID` first, because these tests usually run from inside a Herdr
 * pane themselves — leaving them in place would make "outside Herdr" mean
 * "inside the developer's own workspace", passing by testing nothing.
 */
async function run(args, { workspaceId = "w1", paneId = "w1:p2", stdin, expectCall = true } = {}) {
  const { directory, log } = withStubHerdr();
  const { HERDR_WORKSPACE_ID: _workspace, HERDR_PANE_ID: _pane, ...environment } = process.env;
  const result = spawnSync(SCRIPT, args, {
    encoding: "utf8",
    input: stdin,
    env: {
      ...environment,
      PATH: `${directory}:${process.env.PATH}`,
      ...(workspaceId === null ? {} : { HERDR_WORKSPACE_ID: workspaceId }),
      ...(paneId === null ? {} : { HERDR_PANE_ID: paneId })
    }
  });
  const calls = expectCall ? await callsEventually(log) : await callsEventually(log, { timeoutMs: 200 });
  return { status: result.status, stderr: result.stderr, calls };
}

test("each declared kind writes the token the reader expects, named for the pane", () => {
  return (async () => {
    for (const kind of ["question", "approval", "finished"]) {
      const { status, calls } = await run([kind]);
      assert.equal(status, 0);
      assert.deepEqual(calls, [`workspace report-metadata w1 --source streamdeck-hooks --token sd_attn_p2=${kind} w1:p2 --ttl-ms 14400000`]);
    }
  })();
});

test("clear removes the same token name every declared kind would have used", () => {
  return (async () => {
    const { status, calls } = await run(["clear"]);
    assert.equal(status, 0);
    assert.deepEqual(calls, ["workspace report-metadata w1 --source streamdeck-hooks --clear-token sd_attn_p2"]);
  })();
});

test("the pane's own number, not the workspace's, is what names the token", () => {
  return (async () => {
    const { calls } = await run(["approval"], { paneId: "w5:p14" });
    assert.deepEqual(calls, ["workspace report-metadata w1 --source streamdeck-hooks --token sd_attn_p14=approval w5:p14 --ttl-ms 14400000"]);
  })();
});

test("outside a Herdr pane, nothing is declared and the script still exits clean", () => {
  return (async () => {
    for (const missing of [{ workspaceId: null }, { paneId: null }]) {
      const { status, calls } = await run(["question"], { ...missing, expectCall: false });
      assert.equal(status, 0);
      assert.deepEqual(calls, [], `${JSON.stringify(missing)} must declare nothing`);
    }
  })();
});

test("a notification hook only declares a question for an idle prompt", () => {
  return (async () => {
    const { status, calls } = await run(["notification"], {
      stdin: JSON.stringify({ hook_event_name: "Notification", notification_type: "idle_prompt" })
    });
    assert.equal(status, 0);
    assert.deepEqual(calls, ["workspace report-metadata w1 --source streamdeck-hooks --token sd_attn_p2=question w1:p2 --ttl-ms 14400000"]);
  })();
});

test("a permission-prompt notification declares nothing, since PermissionRequest owns that", () => {
  return (async () => {
    const { status, calls } = await run(["notification"], {
      stdin: JSON.stringify({ hook_event_name: "Notification", notification_type: "permission_prompt" }),
      expectCall: false
    });
    assert.equal(status, 0);
    assert.deepEqual(calls, []);
  })();
});

test("every other notification kind declares nothing either", () => {
  return (async () => {
    for (const notification_type of ["auth_success", "elicitation_dialog", "agent_needs_input", "agent_completed"]) {
      const { calls } = await run(["notification"], {
        stdin: JSON.stringify({ notification_type }),
        expectCall: false
      });
      assert.deepEqual(calls, [], `${notification_type} is out of the three declared reasons`);
    }
  })();
});

test("a malformed or empty notification payload declares nothing rather than guessing", () => {
  return (async () => {
    for (const stdin of ["", "not json", "{}"]) {
      const { status, calls } = await run(["notification"], { stdin, expectCall: false });
      assert.equal(status, 0);
      assert.deepEqual(calls, []);
    }
  })();
});

test("an unrecognised kind is a usage error, and declares nothing", () => {
  return (async () => {
    const { status, calls } = await run(["urgent"], { expectCall: false });
    assert.equal(status, 2);
    assert.deepEqual(calls, []);
  })();
});

test("running with no kind at all is the same usage error", () => {
  return (async () => {
    const { status } = await run([], { expectCall: false });
    assert.equal(status, 2);
  })();
});

test("the caller is never made to wait on Herdr", () => {
  return (async () => {
    // A slow stub stands in for a hung socket. If the script waited on it,
    // this test would take as long as the stub's own sleep; it must not.
    const directory = mkdtempSync(join(tmpdir(), "herdr-attention-slow-"));
    const stub = join(directory, "herdr");
    writeFileSync(stub, "#!/bin/sh\nsleep 5\n");
    chmodSync(stub, 0o755);
    const { HERDR_WORKSPACE_ID: _workspace, HERDR_PANE_ID: _pane, ...environment } = process.env;

    const startedAt = Date.now();
    const result = spawnSync(SCRIPT, ["finished"], {
      encoding: "utf8",
      env: { ...environment, PATH: `${directory}:${process.env.PATH}`, HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p2" }
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.status, 0);
    assert.ok(elapsedMs < 2000, `the script itself must return fast; took ${elapsedMs}ms`);
  })();
});
