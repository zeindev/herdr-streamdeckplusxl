/**
 * Measuring and cutting text in terminal-style cells.
 *
 * This sits below both the projection and the renderer because both need it and
 * neither owns it: the projection decides *what* fits on a control, the renderer
 * decides how it is drawn, and they must agree about width or the two will
 * disagree about what was dropped.
 */

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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
 * Cuts the *start* off instead, keeping the end.
 *
 * Used where the tail is what distinguishes one value from another — branch
 * names being the case that matters here, since `feature/auth/rewrite` and
 * `feature/auth/revert` differ only at the end.
 */
export function truncateStart(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;
  const characters = graphemes(value);
  let kept = "";
  let used = 1; // The ellipsis costs a cell of its own.
  for (let index = characters.length - 1; index >= 0; index--) {
    const next = used + graphemeWidth(characters[index]);
    if (next > width) break;
    used = next;
    kept = characters[index] + kept;
  }
  return `…${kept}`;
}

// ponytail: Device labels use terminal-style cell widths; measure the shipped font only if physical overflow proves this estimate insufficient.
export function graphemeWidth(value: string): number {
  return WIDE.test(value) ? 2 : 1;
}

/** Ranges the terminal renders two cells wide. */
const WIDE =
  /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
