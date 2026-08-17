/**
 * herdr-plugin-context — the one place that reads `HERDR_PLUGIN_CONTEXT_JSON`.
 *
 * Shared by every Herdr-plugin script in this directory (`herdr-tickets.mjs`,
 * `herdr-pr.mjs`, and any that follow) so the same defensive parse — and the
 * same shape for "no worktree info available" — lives in exactly one place
 * rather than being re-derived per script.
 */

/** Best-effort parse of the plugin invocation context Herdr injects. Never throws. */
export function parseContext(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** The worktree block of a parsed context, or `{}` when the invocation carried none. */
export function worktreeFrom(context) {
  return context.worktree ?? {};
}
