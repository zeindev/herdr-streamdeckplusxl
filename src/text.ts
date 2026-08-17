/**
 * Measuring and cutting text in terminal-style cells.
 *
 * This sits below both the projection and the renderer because both need it and
 * neither owns it: the projection decides *what* fits on a control, the renderer
 * decides how it is drawn, and they must agree about width or the two will
 * disagree about what was dropped.
 */

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Cells between two readings on the strip.
 *
 * Here rather than in either of them because the projection budgets for this gap
 * and the renderer draws it, and if the two disagreed the projection would say
 * something fits that the renderer then overruns.
 */
export const READING_GAP = 2;

export function graphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

/** Width in cells, counting a wide grapheme as two. */
export function displayWidth(value: string): number {
  return graphemes(value).reduce((width, character) => width + graphemeWidth(character), 0);
}

export function splitAtWidth(value: string, width: number): [string, string] {
  const characters = graphemes(value);
  let index = 0;
  let used = 0;
  while (index < characters.length && used + graphemeWidth(characters[index]) <= width) {
    used += graphemeWidth(characters[index++]);
  }
  return [characters.slice(0, index).join(""), characters.slice(index).join("")];
}

/** Cuts the end off, marking that something was cut. */
export function truncate(value: string, width: number): string {
  return displayWidth(value) <= width ? value : `${splitAtWidth(value, Math.max(1, width - 1))[0]}…`;
}

/**
 * Cuts the *middle* out, keeping both ends.
 *
 * Neither end alone is safe to lose. Branch names are the case that matters:
 * `feature/auth/rewrite` and `feature/auth/revert` differ only at the end, so
 * cutting the tail would merge them — but `alice/fix-login` and `bob/fix-login`
 * differ only at the start, so cutting the head merges those instead. Keeping
 * both ends is the only cut that survives either.
 *
 * The tail gets the larger share, because that is where a branch name usually
 * carries what the work actually is.
 */
export function truncateMiddle(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;
  if (width <= 1) return "…";
  const forEnds = width - 1;
  const headWidth = Math.floor(forEnds / 3);
  const [head] = splitAtWidth(value, headWidth);
  return `${head}…${keepEnd(value, forEnds - displayWidth(head))}`;
}

/** The last `width` cells of a value. */
function keepEnd(value: string, width: number): string {
  const characters = graphemes(value);
  let kept = "";
  let used = 0;
  for (let index = characters.length - 1; index >= 0; index--) {
    const next = used + graphemeWidth(characters[index]);
    if (next > width) break;
    used = next;
    kept = characters[index] + kept;
  }
  return kept;
}

// ponytail: Device labels use terminal-style cell widths; measure the shipped font only if physical overflow proves this estimate insufficient.
function graphemeWidth(value: string): number {
  return WIDE.test(value) ? 2 : 1;
}

/** Ranges the terminal renders two cells wide. */
const WIDE =
  /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
