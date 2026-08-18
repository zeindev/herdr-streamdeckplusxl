import type { ResolvedThemeSnapshot } from "../model.js";
import { keySvg, stripRegionSvg } from "../render.js";
import type { AttentionReason } from "./attention.js";
import type { DeviceLayout } from "./geometry.js";
import type { EncoderFace, KeyFace } from "./surface.js";

/**
 * What a key says when it is asking.
 *
 * Plain words rather than the internal names: `waiting` is a reason in the
 * model, but "NEEDS YOU" is what the developer has to act on. Every reason has
 * a word, because a dead service usually does keep its key — the pane it ran in
 * outlives it — and a key with a mark and no word would say the least useful
 * half of what it knows.
 */
const ATTENTION_WORDS: Record<AttentionReason, string> = {
  waiting: "NEEDS YOU",
  question: "QUESTION",
  approval: "APPROVAL",
  finished: "FINISHED",
  exited: "EXITED"
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
        ...(face.attention ? { attention: true } : {}),
        // A dead service is the only thing on this device that is simply broken,
        // and it is the one face with no agent state to colour its outline — so
        // without this the most urgent key would be the faintest one on the grid.
        ...(face.attention === "exited" ? { danger: true } : {})
      };
    case "more":
      // A count of what the row had no key for, named so the number is not bare.
      // It carries the mark when something behind it is asking, because the
      // channel's total counts those panes and they have no key of their own.
      return countView("MORE", face);
    case "text":
      return {
        label: face.label,
        detail: face.detail,
        ...(face.danger ? { danger: true } : {}),
        ...(face.feedback ? { feedback: face.feedback } : {})
      };
    case "workstream":
      // The Mini's top row (ADR-0008): identity where a pane's role would
      // otherwise go, since there is no role to name here — just a workstream
      // and, when something is asking, which of its panes is asking about it.
      return {
        label: face.label,
        detail: face.attention ? ATTENTION_WORDS[face.attention] : undefined,
        ...(face.status ? { status: face.status } : {}),
        ...(face.attention ? { attention: true } : {}),
        ...(face.attention === "exited" ? { danger: true } : {})
      };
    case "queue":
      // The paired Mini's attention queue (`-4w7`): a count across every
      // workstream, worded and marked the same way `more` is within one.
      // "QUEUE", never "inbox" — CONTEXT.md's Attention item entry rules that
      // word out deliberately, and this key is exactly that concept's face.
      return countView("QUEUE", face);
    case "overflow":
      // The paired Mini's overflow count (`-4w7`), moved off the XL strip.
      return { label: "OVERFLOW", count: face.count };
  }
}

/** The shared shape of a count key: `more` within one channel, `queue` across all of them. */
function countView(idleLabel: string, face: { count: number; attention?: AttentionReason }): Parameters<typeof keySvg>[0] {
  return {
    label: face.attention ? ATTENTION_WORDS[face.attention] : idleLabel,
    count: face.count,
    ...(face.attention ? { attention: true } : {}),
    ...(face.attention === "exited" ? { danger: true } : {})
  };
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
