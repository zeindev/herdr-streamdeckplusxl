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
  return keySvg(keyView(face), theme);
}

function keyView(face: KeyFace): Parameters<typeof keySvg>[0] {
  switch (face.kind) {
    case "blank":
      return { label: "", blank: true };
    case "empty":
      // ADR-0009 wants an empty slot to invite a worktree, so it is worded as
      // well as drawn — the plus glyph alone says nothing.
      return { label: "", empty: true, slot: face.slot, detail: "NEW WORKTREE" };
    case "pane":
      // The role is the footer and the status drives the outline, so a pane says
      // what it is and how it is doing without relying on colour alone.
      return { label: face.label, detail: face.role.toUpperCase(), ...(face.status ? { status: face.status } : {}) };
    case "more":
      // A count of what the row had no key for, named so the number is not bare.
      return { label: "MORE", count: face.count };
    case "text":
      return { label: face.label, detail: face.detail };
  }
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
  return stripRegionSvg(index, layout.encoders, layout.encodersPerChannel, face, theme);
}
