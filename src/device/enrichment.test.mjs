import assert from "node:assert/strict";
import test from "node:test";

import { PR_TOKEN, TICKETS_TOKEN, UNKNOWN, pullRequestReadingValue, ticketsReadingValue } from "../../.preview/device/enrichment.js";
import { displayWidth } from "../../.preview/text.js";

const workstreamWith = (tokens) => ({ workspaceId: "w1", label: "auth", worktree: null, tokens });

test("ticketsReadingValue reads unknown when sd_tickets was never reported", () => {
  assert.equal(ticketsReadingValue(workstreamWith(undefined)), UNKNOWN);
  assert.equal(ticketsReadingValue(workstreamWith(null)), UNKNOWN);
  assert.equal(ticketsReadingValue(workstreamWith({})), UNKNOWN);
});

test("ticketsReadingValue reads a real zero, not unknown, for an explicitly empty list", () => {
  assert.equal(ticketsReadingValue(workstreamWith({ [TICKETS_TOKEN]: "" })), "0");
});

test("ticketsReadingValue shows the keys themselves when they fit", () => {
  assert.equal(ticketsReadingValue(workstreamWith({ [TICKETS_TOKEN]: "AB-1" })), "AB-1");
  assert.equal(ticketsReadingValue(workstreamWith({ [TICKETS_TOKEN]: "AB-1,CD-2" })), "AB-1, CD-2");
});

test("ticketsReadingValue falls back to a count once the keys would not fit", () => {
  const many = ["ALPHA-101", "BETA-202", "GAMMA-303", "DELTA-404"].join(",");
  const value = ticketsReadingValue(workstreamWith({ [TICKETS_TOKEN]: many }));
  assert.equal(value, "4");
});

test("ticketsReadingValue never exceeds the cell budget it promises", () => {
  const many = Array.from({ length: 20 }, (_, index) => `PROJ-${index}`).join(",");
  const value = ticketsReadingValue(workstreamWith({ [TICKETS_TOKEN]: many }));
  assert.ok(displayWidth(value) <= 12, `"${value}" must fit within TICKET_KEYS_MAX_CELLS`);
});

test("pullRequestReadingValue reads unknown when sd_pr was never reported", () => {
  assert.equal(pullRequestReadingValue(workstreamWith(undefined)), UNKNOWN);
  assert.equal(pullRequestReadingValue(workstreamWith(null)), UNKNOWN);
  assert.equal(pullRequestReadingValue(workstreamWith({})), UNKNOWN);
});

test("pullRequestReadingValue distinguishes not-yet-opened from open with nothing outstanding", () => {
  assert.equal(pullRequestReadingValue(workstreamWith({ [PR_TOKEN]: "none" })), "NONE");
  assert.equal(pullRequestReadingValue(workstreamWith({ [PR_TOKEN]: "42 open" })), "OPEN");
  assert.notEqual(
    pullRequestReadingValue(workstreamWith({ [PR_TOKEN]: "none" })),
    pullRequestReadingValue(workstreamWith({ [PR_TOKEN]: "42 open" }))
  );
});

test("pullRequestReadingValue maps every state scripts/herdr-pr.mjs publishes to four cells or fewer", () => {
  const cases = {
    "42 open": "OPEN",
    "42 approved": "APRV",
    "42 changes_requested": "CHNG",
    "42 checks_failing": "FAIL",
    "42 merged": "MRGD",
    "42 closed": "CLSD"
  };
  for (const [raw, expected] of Object.entries(cases)) {
    const value = pullRequestReadingValue(workstreamWith({ [PR_TOKEN]: raw }));
    assert.equal(value, expected, `for "${raw}"`);
    assert.ok(displayWidth(value) <= 4, `"${value}" must fit the four-cell reservation`);
  }
});

test("pullRequestReadingValue reads unknown for any explicit failure value, not a wrong state", () => {
  assert.equal(pullRequestReadingValue(workstreamWith({ [PR_TOKEN]: "unknown no-auth" })), UNKNOWN);
  assert.equal(pullRequestReadingValue(workstreamWith({ [PR_TOKEN]: "unknown unsupported-remote" })), UNKNOWN);
  assert.equal(pullRequestReadingValue(workstreamWith({ [PR_TOKEN]: "unknown error" })), UNKNOWN);
});

test("pullRequestReadingValue reads unknown rather than inventing a code for an unrecognised state", () => {
  // A future state scripts/herdr-pr.mjs does not yet publish (a draft, say)
  // must not silently render as blank or wrong; this is the honest answer
  // until that state has a code of its own.
  assert.equal(pullRequestReadingValue(workstreamWith({ [PR_TOKEN]: "42 draft" })), UNKNOWN);
});
