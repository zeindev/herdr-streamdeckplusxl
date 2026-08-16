/**
 * Prints live Herdr events, and optionally records them as a test fixture.
 *
 *   node --experimental-strip-types scripts/capture-events.mjs
 *   node --experimental-strip-types scripts/capture-events.mjs --seconds 30 --out src/herdr/fixtures/session.json
 *
 * Recording real traffic rather than inventing payloads is deliberate: the
 * reducer tests built on these fixtures should fail when Herdr's contract
 * drifts, which hand-written samples would never do.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { HerdrClient, defaultSocketPath } from "../src/herdr/client.ts";
import { EVENT_KINDS } from "../src/herdr/protocol.ts";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const seconds = Number(option("seconds", "0"));
const outputPath = option("out", "");
const quiet = process.argv.includes("--quiet");
/**
 * How many of each kind to keep. `pane_updated` fires on every output revision,
 * so an uncapped capture is almost entirely one repeated event; a cap keeps the
 * payload shapes and the ordering while staying small enough to commit.
 */
const maxPerKind = Number(option("max-per-kind", "12"));

const client = new HerdrClient({ socketPath: option("socket", defaultSocketPath()) });
const captured = [];
const counts = new Map();

client.onConnectionChange((connected) => {
  process.stderr.write(connected ? "connected to Herdr\n" : "disconnected; retrying\n");
});
client.onUnknown((line) => {
  process.stderr.write(`unrecognised line: ${line.slice(0, 200)}\n`);
});
client.onEvent((event) => {
  const seen = (counts.get(event.event) ?? 0) + 1;
  counts.set(event.event, seen);
  if (seen <= maxPerKind) captured.push({ at: Date.now(), ...event });
  if (!quiet) console.log(event.event, JSON.stringify(event.data).slice(0, 160));
});

await client.start();

async function finish() {
  await client.stop();

  const seen = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  process.stderr.write(`\n${captured.length} events kept of ${[...counts.values()].reduce((a, b) => a + b, 0)} seen, over ${seen.length} kinds\n`);
  for (const [kind, count] of seen) {
    const kept = Math.min(count, maxPerKind);
    const note = kept < count ? ` (kept ${kept})` : "";
    process.stderr.write(`  ${String(count).padStart(6)}  ${kind}${note}\n`);
  }
  const unseen = EVENT_KINDS.filter((kind) => !counts.has(kind));
  if (unseen.length) process.stderr.write(`\nnot observed: ${unseen.join(", ")}\n`);

  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify({ capturedAt: new Date().toISOString(), events: captured }, null, 2));
    process.stderr.write(`\nwrote ${captured.length} events to ${outputPath}\n`);
  }
  process.exit(0);
}

if (seconds > 0) setTimeout(finish, seconds * 1000);
process.on("SIGINT", finish);
