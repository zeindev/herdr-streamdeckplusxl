import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The wrapper that declares a service's bad exit.
 *
 * It is the producing half of the crashed-service signal, and the only half
 * that ever sees an exit status, so what it decides to declare is the whole
 * contract. Tested by running it for real against a stub `herdr` that records
 * its arguments — a stub rather than a live server, because the point being
 * pinned is which calls are made, and making them for real would write tokens
 * into the developer's own session.
 */
const WRAPPER = fileURLToPath(new URL("./herdr-service", import.meta.url));

/** A fake `herdr` on PATH that appends every invocation to a log. */
function withStubHerdr() {
  const directory = mkdtempSync(join(tmpdir(), "herdr-service-"));
  const log = join(directory, "calls.log");
  const stub = join(directory, "herdr");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`);
  chmodSync(stub, 0o755);
  return { directory, log, stub };
}

/**
 * Runs the wrapper, returning its status and every `herdr` call it made.
 *
 * The inherited environment is stripped of `HERDR_WORKSPACE_ID` and
 * `HERDR_PANE_ID` before anything is set, because these tests are themselves
 * usually run from inside a Herdr pane — leaving them in place made "outside
 * Herdr" mean "inside the developer's own workspace", and the case would have
 * passed by testing nothing.
 */
function runWrapper(args, { workspaceId = "w1", paneId = "w1:p2" } = {}) {
  const { directory, log } = withStubHerdr();
  const { HERDR_WORKSPACE_ID: _workspace, HERDR_PANE_ID: _pane, ...environment } = process.env;
  const result = spawnSync(WRAPPER, args, {
    encoding: "utf8",
    env: {
      ...environment,
      PATH: `${directory}:${process.env.PATH}`,
      ...(workspaceId === null ? {} : { HERDR_WORKSPACE_ID: workspaceId }),
      ...(paneId === null ? {} : { HERDR_PANE_ID: paneId })
    }
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

const tokenCalls = (calls) => calls.filter((call) => call.includes("--token"));
const clearCalls = (calls) => calls.filter((call) => call.includes("--clear-token"));

test("a service that exits cleanly declares nothing", () => {
  const { status, calls } = runWrapper(["dev", "sh", "-c", "exit 0"]);
  assert.equal(status, 0);
  assert.deepEqual(tokenCalls(calls), [], "a clean exit must not raise attention");
});

test("a service that dies declares its status on the workspace", () => {
  const { status, calls } = runWrapper(["dev", "sh", "-c", "exit 3"]);
  assert.equal(status, 3, "the wrapper is transparent about what the service did");
  assert.deepEqual(tokenCalls(calls), [
    "workspace report-metadata w1 --source streamdeck-service --token sd_exit_dev=3 w1:p2"
  ]);
});

test("the declaration names the pane the service ran in, so the item can find a key", () => {
  // A service crashing under this wrapper does not end the pane's shell, so the
  // pane is still on the device afterwards. Probed on a running Herdr: the pane
  // survives and pane_exited never fires. Carrying the pane id is what lets the
  // dead service be marked on its own key instead of the strip alone.
  const { calls } = runWrapper(["dev", "sh", "-c", "exit 3"], { paneId: "w9:p4" });
  assert.deepEqual(tokenCalls(calls), [
    "workspace report-metadata w1 --source streamdeck-service --token sd_exit_dev=3 w9:p4"
  ]);
});

test("with no pane to name, the status travels alone rather than malformed", () => {
  const { calls } = runWrapper(["dev", "sh", "-c", "exit 3"], { paneId: null });
  assert.deepEqual(tokenCalls(calls), [
    "workspace report-metadata w1 --source streamdeck-service --token sd_exit_dev=3"
  ]);
});

test("starting clears the last run's declaration, which is what makes a restart resolve it", () => {
  const { calls } = runWrapper(["dev", "sh", "-c", "exit 0"]);
  assert.deepEqual(clearCalls(calls), [
    "workspace report-metadata w1 --source streamdeck-service --clear-token sd_exit_dev"
  ]);
});

test("the clear happens before the service runs, not after it finishes", () => {
  // A dead service that is restarted has to stop asking the moment it comes
  // back up, not when it next dies.
  const { calls } = runWrapper(["dev", "sh", "-c", "exit 3"]);
  assert.ok(calls[0].includes("--clear-token"), `expected the clear first, got ${JSON.stringify(calls)}`);
});

test("stopping a service on purpose declares nothing, however it was stopped", () => {
  // 130 is Ctrl-C, 143 is SIGTERM, 129 is the hangup a closing pane sends. All
  // three are the developer stopping it, and reporting them would make the
  // device cry wolf every time a pane was closed — which is the whole failure
  // this approach exists to avoid.
  for (const status of [129, 130, 143]) {
    const run = runWrapper(["dev", "sh", "-c", `exit ${status}`]);
    assert.equal(run.status, status);
    assert.deepEqual(tokenCalls(run.calls), [], `${status} is a deliberate stop`);
  }
});

test("a name that would collide with another service is refused, not corrected", () => {
  // Truncating or rewriting would report two services as one, which is worse
  // than being told to pick a different name once, when it is being set up.
  for (const name of ["", "has space", "sd/exit", "a".repeat(25)]) {
    const { status, calls } = runWrapper([name, "sh", "-c", "exit 0"]);
    assert.equal(status, 2, `${JSON.stringify(name)} should be refused`);
    assert.deepEqual(calls, [], "nothing is declared for a name that was never accepted");
  }
});

test("a refused name does not run the command either", () => {
  const { status, stdout } = runWrapper(["has space", "sh", "-c", "echo ran"]);
  assert.equal(status, 2);
  assert.equal(stdout.includes("ran"), false, "refusing the name must not half-start the service");
});

test("a name at the limit is accepted, so the limit is the limit and not one less", () => {
  const name = "a".repeat(24);
  const { status, calls } = runWrapper([name, "sh", "-c", "exit 1"]);
  assert.equal(status, 1);
  assert.deepEqual(tokenCalls(calls), [
    `workspace report-metadata w1 --source streamdeck-service --token sd_exit_${name}=1 w1:p2`
  ]);
});

test("too few arguments is a usage error rather than a silent no-op", () => {
  assert.equal(runWrapper([]).status, 2);
  assert.equal(runWrapper(["dev"]).status, 2);
});

test("outside Herdr the service still runs and nothing is declared", () => {
  // The developer asked to run a dev server. The Stream Deck is the accessory,
  // so the same command line has to work in CI and in a plain terminal.
  const { status, calls } = runWrapper(["dev", "sh", "-c", "exit 3"], { workspaceId: null });
  assert.equal(status, 3);
  assert.deepEqual(calls, []);
});

test("the service's own arguments reach it untouched", () => {
  const { stdout, status } = runWrapper(["dev", "sh", "-c", 'printf "%s|" "$@"', "sh", "one two", "--flag=x"]);
  assert.equal(status, 0);
  assert.equal(stdout, "one two|--flag=x|");
});

test("the declared value is the status the reader treats as a bad exit", () => {
  // The two halves have to agree: the wrapper writes the status as a decimal
  // string, and the reader ignores "0". A wrapper that wrote something else, or
  // a reader that parsed something else, would make the signal silent.
  const { calls } = runWrapper(["dev", "sh", "-c", "exit 137"], { paneId: null });
  const [declared] = tokenCalls(calls);
  assert.equal(declared.endsWith("--token sd_exit_dev=137"), true);
});
