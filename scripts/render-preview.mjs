/**
 * Renders the whole Stream Deck + XL at its real resolution, straight from the
 * surface the reducer projects.
 *
 * This is the feedback loop for work on the device: it needs no hardware, and
 * because it draws the projected surface rather than hand-written examples, an
 * image that looks wrong means the projection is wrong.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { copiedHerdrTheme } from "../.preview/herdr-themes.js";
import { DEVICE_TYPE_XL, XL_LAYOUT } from "../.preview/device/geometry.js";
import { initialState, reduce } from "../.preview/device/state.js";
import { surfaceOf } from "../.preview/device/surface.js";
import { encoderImage, keyImage } from "../.preview/device/paint.js";

const KEY = 144;
const GAP = 14;
const STRIP_HEIGHT = 100;

const dark = copiedHerdrTheme("catppuccin");
const light = copiedHerdrTheme("catppuccin-latte");
if (!dark || !light) throw new Error("Copied Herdr preview themes are missing");

function apply(events, from = initialState()) {
  let state = from;
  for (const event of events) state = reduce(state, event).state;
  return state;
}

const attach = { kind: "device-attached", device: { id: "preview", type: DEVICE_TYPE_XL } };

const scenes = {
  offline: apply([attach]),
  syncing: apply([attach, { kind: "herdr-connection", connected: true }]),
  live: apply([
    attach,
    { kind: "herdr-connection", connected: true },
    {
      kind: "herdr-snapshot",
      snapshot: {
        workspaces: [{ workspace_id: "w1" }, { workspace_id: "w2" }, { workspace_id: "w3" }],
        tabs: [],
        panes: Array.from({ length: 14 }, (_, index) => ({ pane_id: `w1:p${index}` }))
      }
    }
  ])
};

mkdirSync("artifacts", { recursive: true });
for (const [name, state] of Object.entries(scenes)) {
  for (const [appearance, theme] of [["dark", dark], ["light", light]]) {
    if (name !== "live" && appearance === "light") continue;
    writeFileSync(`artifacts/xl-${name}-${appearance}.svg`, devicePreview(state, theme));
  }
}

function devicePreview(state, theme) {
  const [device] = surfaceOf(state).devices;
  if (!device) throw new Error("The preview state has no attached device");

  const width = XL_LAYOUT.columns * KEY + (XL_LAYOUT.columns + 1) * GAP;
  const gridHeight = XL_LAYOUT.rows * KEY + (XL_LAYOUT.rows + 1) * GAP;
  const stripWidth = XL_LAYOUT.encoders * 200;
  const height = gridHeight + STRIP_HEIGHT + GAP * 2;

  const keys = device.keys.map((face, index) => {
    const column = index % XL_LAYOUT.columns;
    const row = Math.floor(index / XL_LAYOUT.columns);
    const x = GAP + column * (KEY + GAP);
    const y = GAP + row * (KEY + GAP);
    return place(keyImage(face, theme), x, y, KEY, KEY);
  });

  // The strip is one continuous composition drawn through its regions, so the
  // preview lays them edge to edge exactly as the hardware does.
  const stripX = (width - stripWidth) / 2;
  const strip = device.encoders.map((face, index) =>
    place(encoderImage(index, face, XL_LAYOUT, theme), stripX + index * 200, gridHeight + GAP, 200, STRIP_HEIGHT)
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#141414"/>
  ${keys.join("\n  ")}
  ${strip.join("\n  ")}
</svg>`;
}

/** Nests a rendered control into the device sheet at its physical position. */
function place(svg, x, y, width, height) {
  const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? `0 0 ${width} ${height}`;
  return `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="${viewBox}">${inner}</svg>`;
}
