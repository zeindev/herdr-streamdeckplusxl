import type { ResolvedThemeSnapshot } from "../model.js";
import { keySvg, stripRegionSvg } from "../render.js";
import type { PaneAttention } from "./attention.js";
import type { DeviceLayout } from "./geometry.js";
import type { EncoderFace, KeyFace } from "./surface.js";

/**
 * What a key says when it is asking.
 *
 * Plain words rather than the internal names: `waiting` is a reason in the
 * model, but "NEEDS YOU" is what the developer has to act on. A dead service has
 * no entry because it has no key — `PaneAttention` excludes it, so this record
 * cannot grow one by accident.
 */
const ATTENTION_WORDS: Record<PaneAttention, string> = {
  waiting: "NEEDS YOU",
  finished: "FINISHED"
};

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
      //
      // A pane that is asking spends its footer on saying so, and takes a mark in
      // the corner as well. Two carriers rather than one: the word survives for
      // anyone who cannot separate the outline colours, and the mark is what
      // catches the eye from across a desk. The role is what gives way, because
      // the row the key sits on already says it.
      return {
        label: face.label,
        detail: face.attention ? ATTENTION_WORDS[face.attention] : face.role.toUpperCase(),
        ...(face.status ? { status: face.status } : {}),
        ...(face.attention ? { attention: true } : {})
      };
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
