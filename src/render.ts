import { MOTION_BASE_WIDTH, type AgentStatus, type PaneSnapshot, type ResolvedThemeSnapshot, type WorkingMotion } from "./model.js";
import { READING_GAP, displayWidth, graphemes, splitAtWidth, truncate } from "./text.js";

const monoFont = `font-family="Consolas" font-weight="700"`;

/**
 * Where a label may wrap. The slash is included because branch names are the
 * longest labels the device shows and nearly all of them carry one; without it
 * `feat/auth-rewrite` breaks mid-word.
 */
const WORD_BREAK_CHARACTERS = "[-_/\\s]";
const WORD_BREAK = new RegExp(WORD_BREAK_CHARACTERS, "u");
const LEADING_WORD_BREAKS = new RegExp(`^${WORD_BREAK_CHARACTERS}+`, "u");

export const MOTION_CYCLE_FRAMES = 21;

type KeyView = {
  label: string;
  blank?: boolean;
  count?: number;
  context?: string;
  detail?: string;
  slot?: number;
  status?: AgentStatus | "offline";
  selected?: boolean;
  empty?: boolean;
  danger?: boolean;
  /** This key is asking for the developer. Drawn as a mark, not only a colour. */
  attention?: boolean;
  feedback?: "success";
  workingFrame?: number;
  workingMotion?: WorkingMotion;
  workingWidth?: number;
  workingIntensity?: number;
};

/**
 * What a channel's strip block says. The projection has already decided what
 * fits; the renderer only places it.
 */
export type StripView = {
  block: {
    /** Null when the channel holds no workstream, and nothing is lit. */
    branch: string | null;
    readings: ReadonlyArray<{ label: string; value: string }>;
    /** Shown instead of the readings when they cannot be trusted. */
    notice: string | null;
  };
  /** Drawn at the far right of the whole strip, when there is any. */
  overflow: number;
};

const BRANCH_SIZE = 28;
const FIELD_SIZE = 20;

export function keySvg(view: KeyView, theme?: ResolvedThemeSnapshot | null): string {
  if (view.blank) return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="#000000"/></svg>`;
  const palette = theme?.palette;
  const feedbackColor = view.feedback === "success" ? palette ? oledColor(palette.green) : "#ffffff" : null;
  const text = feedbackColor ? "#000000" : palette && view.danger ? oledColor(palette.red) : oledForeground(theme, "text");
  const subtext = feedbackColor ? "#000000" : oledForeground(theme, "subtext");
  const statusVisual = feedbackColor ? null : statusAppearance(view.status, theme);
  const labelColumns = displayWidth(view.label.trim() || "EMPTY") > 24 ? 12 : 8;
  let lines = splitLabel(view.label, labelColumns);
  if (labelColumns < 12 && lines.length === 3 && displayWidth(lines[2]) <= 3) {
    const balanced = splitLabel(view.label, 12);
    if (balanced.length === 2 && labelFontSize(balanced) >= 20) lines = balanced;
  }
  const labelSize = labelFontSize(lines);
  const labelTracking = Math.max(...lines.map(displayWidth)) >= 9 ? ' letter-spacing="-0.04em"' : "";
  const outlineColor = view.danger
    ? palette ? oledColor(palette.red) : "#ffffff"
    : statusVisual?.color;
  const slot = view.empty && view.slot !== undefined
    ? `<text x="16" y="32" ${monoFont} font-size="26" fill="${subtext}">${view.slot + 1}</text>`
    : "";
  const selection = view.selected && !feedbackColor
    ? `<rect x="11" y="11" width="122" height="122" rx="11" fill="none" stroke="${outlineColor ?? oledForeground(theme, "text")}" stroke-width="3"/>`
    : "";
  const outline = outlineColor
    ? `<rect ${keyOutlineGeometry()} fill="none" stroke="${outlineColor}" stroke-width="${view.danger ? 7 : statusVisual?.width ?? 5}"${statusVisual?.dash ? ` stroke-dasharray="${statusVisual.dash}"` : ""}/>`
    : "";
  const workingHighlight = workingAnimation(view, theme);
  // A filled disc in the corner, which is the one mark on this device that means
  // nothing else. The footer already carries the word, so the key says it twice
  // and neither carrier is colour: the shape reads at a glance from across a
  // desk, and the word survives for anyone who cannot separate the outlines.
  const attention = view.attention && !feedbackColor
    ? `<circle cx="118" cy="26" r="10" fill="${outlineColor ?? oledForeground(theme, "text")}"/>`
    : "";
  const empty = view.empty ? `<path d="M57 76H87M72 61V91" stroke="${subtext}" stroke-width="6" stroke-linecap="round"/>` : "";
  const footerValue = (view.detail || view.context)?.replaceAll(" › ", " · ");
  const footer = footerValue
    ? `<text x="72" y="130" ${monoFont} font-size="18" fill="${subtext}" text-anchor="middle" letter-spacing=".1">${escapeXml(compactContext(footerValue.toUpperCase(), 12))}</text>`
    : "";
  const labelY = lines.length === 1 ? 84 : lines.length === 2 ? 64 : 47;
  const label = view.empty ? "" : view.count === undefined
    ? lines.map((line, index) =>
        `<text x="72" y="${labelY + index * 29}" ${monoFont} font-size="${labelSize}" fill="${text}" text-anchor="middle"${labelTracking}>${escapeXml(line)}</text>`
      ).join("")
    : `<text x="72" y="36" ${monoFont} font-size="22" fill="${text}" text-anchor="middle">${escapeXml(view.label.toUpperCase())}</text>
      <text x="72" y="116" ${monoFont} font-size="72" fill="${statusVisual?.color ?? text}" text-anchor="middle">${view.count}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" fill="${feedbackColor ?? "#000000"}"/>
    ${selection}${outline}${workingHighlight}${slot}${attention}
    ${label}
    ${footer}${empty}
  </svg>`;
}

/**
 * Renders one 200px region of the strip.
 *
 * A channel's two regions are one composition, not two cards: the canvas spans
 * the whole strip, the channel's block is drawn across its full width, and this
 * region is a window onto it. That is what lets a branch run past the seam
 * between two regions instead of being cut in half at it.
 *
 * Only information-bearing pixels are lit — the background is true black
 * everywhere, and a channel holding no workstream draws nothing at all, since it
 * has nothing to report and the key already carries the invitation.
 */
export function stripRegionSvg(
  region: number,
  regionCount: number,
  regionsPerChannel: number,
  view: StripView,
  theme?: ResolvedThemeSnapshot | null
): string {
  const palette = theme?.palette;
  const text = oledForeground(theme, "text");
  const subtext = oledForeground(theme, "subtext");
  const accent = palette ? oledColor(palette.accent, 3) : "#ffffff";
  const width = regionCount * 200;
  const blockX = Math.floor(region / regionsPerChannel) * regionsPerChannel * 200;
  const left = blockX + 18;

  const { branch, readings, notice } = view.block;
  const identity = branch === null ? "" :
    `<rect x="${blockX}" y="0" width="5" height="100" fill="${accent}"/>` +
    `<text x="${left}" y="44" ${monoFont} font-size="${BRANCH_SIZE}" fill="${text}">${escapeXml(branch)}</text>`;
  // A notice takes the readings' line, so a branch above it still reads — and it
  // is drawn whether or not there is one, since a channel holding no workstream
  // still has to say why the strip is dark.
  const below = notice
    ? `<text x="${left}" y="80" ${monoFont} font-size="${FIELD_SIZE}" fill="${subtext}">${escapeXml(notice)}</text>`
    : readingsSvg(readings, left, text, subtext);
  const block = identity + (branch === null && !notice ? "" : below);

  // The overflow count sits at the far right of the whole strip (ADR-0011), and
  // the channel sharing that region has already given up the space for it.
  const overflow = view.overflow > 0
    ? `<text x="${width - 18}" y="80" ${monoFont} font-size="${FIELD_SIZE}" fill="${palette ? oledColor(palette.peach) : "#ffffff"}" text-anchor="end">${escapeXml(`OVER +${view.overflow}`)}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="${region * 200} 0 200 100">
    <rect width="${width}" height="100" fill="#000000"/>
    ${block}${overflow}
  </svg>`;
}

/**
 * Lays the readings out as one run of text, each named so a number is never bare.
 *
 * One `<text>` rather than one per word: the renderer advances the pen itself, so
 * a label and its value cannot collide even where the font is substituted and
 * every advance is wider than assumed. Nothing here measures anything — how much
 * fits was decided by the projection, in cells.
 */
function readingsSvg(readings: StripView["block"]["readings"], left: number, text: string, subtext: string): string {
  if (readings.length === 0) return "";
  const runs = readings
    .map(
      (reading, index) =>
        `${index === 0 ? "" : `<tspan fill="${subtext}">${" ".repeat(READING_GAP)}</tspan>`}` +
        `<tspan fill="${subtext}">${escapeXml(reading.label)} </tspan>` +
        `<tspan fill="${text}">${escapeXml(reading.value)}</tspan>`
    )
    .join("");
  return `<text x="${left}" y="80" ${monoFont} font-size="${FIELD_SIZE}" xml:space="preserve">${runs}</text>`;
}

function workingAnimation(view: KeyView, theme?: ResolvedThemeSnapshot | null): string {
  if (view.status !== "working" || view.workingFrame === undefined) return "";
  const frame = Math.max(0, view.workingFrame);
  const motion = view.workingMotion ?? "lighten";
  const width = (view.workingWidth ?? 1) * MOTION_BASE_WIDTH;
  const baseIntensity = motion === "darken" ? 1.3 : motion === "lighten" ? 2 : 1.6;
  const intensityScale = (view.workingIntensity ?? 1) * baseIntensity;
  const outlinePerimeter = 400 + 36 * Math.PI;
  const center = ((frame % MOTION_CYCLE_FRAMES) / MOTION_CYCLE_FRAMES) * outlinePerimeter;
  const segmentCount = Math.round(19 * width);
  const segmentLength = outlinePerimeter * 0.009;
  const segmentSpacing = outlinePerimeter * 0.008;
  const rect = `${keyOutlineGeometry()} fill="none" stroke-width="5"`;
  return Array.from({ length: segmentCount }, (_, index) => {
    const progress = index / (segmentCount - 1);
    const intensity = Math.min(1, (0.02 + 0.43 * Math.sin(Math.PI * progress) ** 2) * intensityScale);
    const position = (center + (index - (segmentCount - 1) / 2) * segmentSpacing + outlinePerimeter) % outlinePerimeter;
    const color = motion === "darken"
      ? "#000000"
      : motion === "lighten"
        ? oledForeground(theme, "text")
        : rainbowSwooshColor(progress);
    return `<rect ${rect} stroke="${color}" stroke-opacity="${intensity.toFixed(2)}" stroke-dasharray="${segmentLength.toFixed(2)} ${(outlinePerimeter * 2 - segmentLength).toFixed(2)}" stroke-dashoffset="${(-(position - segmentLength / 2)).toFixed(1)}"/>`;
  }).join("");
}

function keyOutlineGeometry(): string {
  return `x="4" y="4" width="136" height="136" rx="18"`;
}

const rainbowSwooshStops = [
  [175, 46, 255],
  [255, 51, 85],
  [255, 218, 83],
  [30, 228, 188]
] as const;

function rainbowSwooshColor(progress: number): string {
  const position = progress * (rainbowSwooshStops.length - 1);
  const index = Math.min(Math.floor(position), rainbowSwooshStops.length - 2);
  const amount = position - index;
  const start = rainbowSwooshStops[index];
  const end = rainbowSwooshStops[index + 1];
  return `rgb(${start.map((channel, channelIndex) => Math.round(channel + (end[channelIndex] - channel) * amount)).join(" ")})`;
}

function statusAppearance(status: KeyView["status"], theme?: ResolvedThemeSnapshot | null): { color: string; width: number; dash?: string } | null {
  const palette = theme?.palette;
  switch (status) {
    case "blocked": return { color: palette ? oledColor(palette.yellow) : "#ffffff", width: 5 };
    case "working": return { color: palette ? oledColor(palette.blue) : "#ffffff", width: 5 };
    case "done": return { color: palette ? oledColor(palette.green) : "#ffffff", width: 7 };
    case "offline": return { color: palette ? oledColor(palette.red) : "#ffffff", width: 5 };
    case "idle": return { color: palette ? oledColor(palette.overlay0) : "#9a9ca5", width: 3 };
    case "unknown": return { color: palette ? oledColor(palette.overlay0) : "#9a9ca5", width: 3, dash: "10 8" };
    default: return null;
  }
}

function color(rgb: { r: number; g: number; b: number }): string {
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b})`;
}

export function oledForeground(theme: ResolvedThemeSnapshot | null | undefined, role: "text" | "subtext"): string {
  if (!theme) return role === "text" ? "#ffffff" : "#9a9ca5";
  return oledColor(role === "text" ? theme.palette.text : theme.palette.subtext0);
}

function oledColor(rgb: { r: number; g: number; b: number }, minimumContrast = 4.5): string {
  if ((relativeLuminance(rgb) + 0.05) / 0.05 >= minimumContrast) return color(rgb);
  let low = 0;
  let high = 1;
  let adjusted = rgb;
  for (let step = 0; step < 8; step++) {
    const amount = (low + high) / 2;
    adjusted = {
      r: Math.round(rgb.r + (255 - rgb.r) * amount),
      g: Math.round(rgb.g + (255 - rgb.g) * amount),
      b: Math.round(rgb.b + (255 - rgb.b) * amount)
    };
    if ((relativeLuminance(adjusted) + 0.05) / 0.05 >= minimumContrast) high = amount;
    else low = amount;
  }
  return color({
    r: Math.round(rgb.r + (255 - rgb.r) * high),
    g: Math.round(rgb.g + (255 - rgb.g) * high),
    b: Math.round(rgb.b + (255 - rgb.b) * high)
  });
}

function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function splitLabel(value: string, width: number): string[] {
  const clean = value.trim() || "EMPTY";
  if (displayWidth(clean) <= width) return [clean];
  const lines: string[] = [];
  let rest = clean;
  for (let remainingLines = 3; remainingLines > 1 && displayWidth(rest) > width; remainingLines--) {
    let [line, tail] = splitLabelLine(rest, width);
    if (displayWidth(tail) > width * (remainingLines - 1)) {
      [line, tail] = splitAtWidth(rest, width);
      tail = tail.replace(LEADING_WORD_BREAKS, "").trim();
    }
    lines.push(line);
    rest = tail;
  }
  if (rest) lines.push(truncate(rest, width));
  return lines.map((line, index) => index < lines.length - 1 && line.endsWith("-") ? line.slice(0, -1) : line);
}

function labelFontSize(lines: string[]): number {
  return Math.max(18, 36 - Math.max(...lines.map(displayWidth)) * 1.5);
}

function splitLabelLine(value: string, width: number): [string, string] {
  const characters = graphemes(value);
  const [hardLine] = splitAtWidth(value, width);
  const hardLength = graphemes(hardLine).length;
  let breakAt = -1;
  for (let index = hardLength - 1; index >= 0; index--) {
    if (WORD_BREAK.test(characters[index])) {
      breakAt = index;
      break;
    }
  }
  if (breakAt > 0) {
    const keepSeparator = !/\s/u.test(characters[breakAt]);
    return [
      characters.slice(0, breakAt + Number(keepSeparator)).join("").trim(),
      characters.slice(breakAt + 1).join("").trim()
    ];
  }
  const rest = characters.slice(hardLength);
  if (rest[0] && WORD_BREAK.test(rest[0])) rest.shift();
  return [hardLine, rest.join("").trim()];
}

function compactContext(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;
  const separator = [" · ", " › "].find((candidate) => value.includes(candidate));
  if (!separator) return truncate(value, width);
  const split = value.lastIndexOf(separator);
  if (split < 0) return truncate(value, width);
  const suffix = value.slice(split);
  const suffixWidth = displayWidth(suffix);
  if (suffixWidth > width - 2) return truncate(value.slice(split + separator.length), width);
  return `${truncate(value.slice(0, split), width - suffixWidth)}${suffix}`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}
