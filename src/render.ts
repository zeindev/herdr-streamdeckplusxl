import { MOTION_BASE_WIDTH, type AgentStatus, type PaneSnapshot, type ResolvedThemeSnapshot, type WorkingMotion } from "./model.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const monoFont = `font-family="Consolas" font-weight="700"`;

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
  feedback?: "success";
  workingFrame?: number;
  workingMotion?: WorkingMotion;
  workingWidth?: number;
  workingIntensity?: number;
};

/**
 * One region of the touch strip. The surface describes a control as a title and
 * a value; anything richer belongs to the projection, not the renderer.
 */
export type StripView = { title: string; value: string };

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
    ${selection}${outline}${workingHighlight}${slot}
    ${label}
    ${footer}${empty}
  </svg>`;
}

/**
 * Renders one 200px region of the strip.
 *
 * The strip is one continuous composition drawn through several regions, so the
 * canvas spans the whole strip and each region is a window onto it. Its width
 * therefore depends on the device: six regions on the Stream Deck + XL.
 */
export function stripRegionSvg(
  region: number,
  regionCount: number,
  view: StripView,
  theme?: ResolvedThemeSnapshot | null
): string {
  const palette = theme?.palette;
  const text = oledForeground(theme, "text");
  const subtext = oledForeground(theme, "subtext");
  const accent = palette ? oledColor(palette.accent, 3) : "#ffffff";
  const width = regionCount * 200;
  const x = region * 200 + 18;
  const bar = view.title || view.value ? `<rect x="${region * 200}" y="0" width="5" height="100" fill="${accent}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="${region * 200} 0 200 100">
    <rect width="${width}" height="100" fill="#000000"/>
    ${bar}
    <text x="${x}" y="32" ${monoFont} font-size="20" letter-spacing="0.2" fill="${subtext}">${escapeXml(truncate(view.title, 10))}</text>
    <text x="${x}" y="73" ${monoFont} font-size="28" fill="${text}">${escapeXml(truncate(view.value, 10))}</text>
  </svg>`;
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
      tail = tail.replace(/^[-_\s]+/u, "").trim();
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
    if (/[-_\s]/u.test(characters[index])) {
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
  if (rest[0] && /[-_\s]/u.test(rest[0])) rest.shift();
  return [hardLine, rest.join("").trim()];
}

function truncate(value: string, width: number): string {
  return displayWidth(value) <= width ? value : `${splitAtWidth(value, Math.max(1, width - 1))[0]}…`;
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

function graphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

function splitAtWidth(value: string, width: number): [string, string] {
  const characters = graphemes(value);
  let index = 0;
  let used = 0;
  while (index < characters.length && used + graphemeWidth(characters[index]) <= width) used += graphemeWidth(characters[index++]);
  return [characters.slice(0, index).join(""), characters.slice(index).join("")];
}

function displayWidth(value: string): number {
  return graphemes(value).reduce((width, character) => width + graphemeWidth(character), 0);
}

// ponytail: Device labels use terminal-style cell widths; measure the shipped font only if physical overflow proves this estimate insufficient.
function graphemeWidth(value: string): number {
  return /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u.test(value) ? 2 : 1;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}
