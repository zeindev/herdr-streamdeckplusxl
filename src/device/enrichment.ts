import { displayWidth } from "../text.js";
import type { Workstream } from "./workstream.js";

/**
 * Reads what the Herdr plugin publishes (ADR-0004) into what the strip shows
 * (`-wl7`). Neither process talks to the other directly — Herdr's own
 * `tokens` is the interface, exactly as `attention.ts` already reads
 * `sd_attn_`/`sd_exit_` off the same field.
 *
 * The token names are not invented here: `sd_tickets` is defined by
 * `scripts/herdr-tickets.mjs` (`-5ot`), `sd_pr` by `scripts/herdr-pr.mjs`
 * (`-7bl`). This module only interprets what they already write.
 *
 * `UNKNOWN` means exactly one thing across both readings: the token is
 * entirely absent from `tokens`, which is what a workstream Herdr has never
 * heard the plugin report for looks like, and — because both publishers set
 * a `--ttl-ms` — what a workstream Herdr's plugin *stopped* reporting for
 * eventually looks like too, once the last answer's lifetime runs out.
 * Neither publisher clears its token for a genuine "asked, and there is
 * nothing" answer; both write an explicit value instead, so that case is
 * never confused with unknown here.
 */
export const UNKNOWN = "?";

export const TICKETS_TOKEN = "sd_tickets";
export const PR_TOKEN = "sd_pr";

/**
 * Cells beyond which showing the ticket keys themselves would cost more of
 * the reading line than the fact is worth — enough for one or two short
 * keys ("AB-12, CD-9"), never enough to threaten swallowing the whole line
 * the way an unbounded key list could for a workstream with many tickets.
 */
export const TICKET_KEYS_MAX_CELLS = 12;

/**
 * The `TKT` reading's value: the ticket keys themselves when they fit in
 * `TICKET_KEYS_MAX_CELLS`, the count otherwise, and `UNKNOWN` when
 * `sd_tickets` has never been reported or its answer has expired.
 *
 * An empty-but-known list — `sd_tickets=`, `scripts/herdr-tickets.mjs`'s way
 * of saying "asked, and there are none" — reads as `"0"`, a real count
 * rather than `UNKNOWN`, which would claim nobody had asked at all.
 */
export function ticketsReadingValue(workstream: Workstream): string {
  const raw = workstream.tokens?.[TICKETS_TOKEN];
  if (raw === undefined || raw === null) return UNKNOWN;
  const keys = raw
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  if (keys.length === 0) return "0";
  const joined = keys.join(", ");
  return displayWidth(joined) <= TICKET_KEYS_MAX_CELLS ? joined : String(keys.length);
}

/**
 * The four-cell code each `sd_pr` state maps to. Every state
 * `scripts/herdr-pr.mjs` actually publishes has an entry; a state it does
 * not (yet) publish — most notably a draft pull request — has nowhere to
 * slot in today, so `pullRequestReadingValue` falls back to `UNKNOWN` for
 * anything unrecognised rather than guessing at a code for it.
 */
const PR_STATE_CODES: Readonly<Record<string, string>> = {
  open: "OPEN",
  approved: "APRV",
  changes_requested: "CHNG",
  checks_failing: "FAIL",
  merged: "MRGD",
  closed: "CLSD"
};

/**
 * The `PR` reading's value, held to the four cells the layout promises it
 * without spending the droppable `AGENTS` reading (`-wl7`'s own hard
 * constraint, recorded where the reservation lives in `strip.ts`).
 *
 * `sd_pr=none` — "asked, and there is no pull request yet" — reads as
 * `"NONE"`, kept deliberately distinct from `"OPEN"` (a pull request exists
 * and nothing is outstanding on it): the one acceptance criterion this
 * reading exists to satisfy is that those two stay tellable apart.
 */
export function pullRequestReadingValue(workstream: Workstream): string {
  const raw = workstream.tokens?.[PR_TOKEN];
  if (raw === undefined || raw === null || raw === "") return UNKNOWN;
  if (raw === "none") return "NONE";
  const [first, ...stateParts] = raw.trim().split(/\s+/);
  // "unknown" is `scripts/herdr-pr.mjs`'s own failure prefix (`unknown
  // no-auth`, `unknown error`, ...) — matched as the exact first word rather
  // than a substring check, so a state this reader has never heard of reads
  // as unrecognised (falling through to the lookup below, which also answers
  // UNKNOWN) rather than any value merely starting with those letters being
  // misread as a failure report.
  if (first === "unknown") return UNKNOWN;
  return PR_STATE_CODES[stateParts.join(" ")] ?? UNKNOWN;
}
