import type { ResolvedThemeSnapshot } from "../model.js";
import { keySvg, stripRegionSvg } from "../render.js";
import type { DeviceLayout } from "./geometry.js";
import type { EncoderFace, KeyFace } from "./surface.js";

/**
 * Turns described faces into images.
 *
 * The one place the surface meets the renderer, so the device and the preview
 * draw the same thing from the same code. If they diverged, the preview would
 * stop being evidence.
 */

export function keyImage(face: KeyFace, theme: ResolvedThemeSnapshot | null): string {
  return keySvg(face.kind === "blank" ? { label: "", blank: true } : { label: face.label, detail: face.detail }, theme);
}

/**
 * An encoder's image is one 200px window onto the continuous strip, so it needs
 * to know how many regions the whole strip has.
 */
export function encoderImage(
  index: number,
  face: EncoderFace,
  layout: DeviceLayout,
  theme: ResolvedThemeSnapshot | null
): string {
  return stripRegionSvg(index, layout.encoders, face, theme);
}
