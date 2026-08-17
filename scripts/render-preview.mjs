/**
 * Renders the whole Stream Deck + XL at its real resolution, straight from the
 * surface the reducer projects.
 *
 * This is the feedback loop for work on the device: it needs no hardware, and
 * because it draws the projected surface rather than hand-written examples, an
 * image that looks wrong means the projection is wrong.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

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

/**
 * The preview is only evidence if it draws what Herdr actually sends, so the
 * workspace shape comes from the recorded capture rather than being written here.
 */
const capture = JSON.parse(readFileSync(new URL("../src/herdr/fixtures/capture.json", import.meta.url), "utf8"));
const recordedWorkspace = capture.events.find((event) => event.event === "workspace_created").data.workspace;

function workspace(number, label, checkoutPath) {
  return {
    ...structuredClone(recordedWorkspace),
    workspace_id: `w${number}`,
    number,
    label,
    ...(checkoutPath === null
      ? { worktree: null }
      : { worktree: { ...structuredClone(recordedWorkspace.worktree), checkout_path: checkoutPath } })
  };
}

function agentPane(workspaceId, index, status) {
  return { pane_id: `${workspaceId}:p${index}`, workspace_id: workspaceId, agent: "claude", agent_status: status };
}

function live(workspaces, panes, branches) {
  return apply([
    attach,
    { kind: "herdr-connection", connected: true },
    { kind: "herdr-snapshot", snapshot: { workspaces, tabs: [], panes } },
    { kind: "herdr-worktrees", worktrees: Object.entries(branches).map(([path, branch]) => ({ path, branch })) }
  ]);
}

const scenes = {
  offline: apply([attach]),
  syncing: apply([attach, { kind: "herdr-connection", connected: true }]),
  // Three workstreams, one per channel, each in a different state.
  live: live(
    [
      workspace(1, "auth rewrite", "/w/auth-rewrite"),
      workspace(2, "billing api", "/w/billing-api"),
      workspace(3, "search perf", "/w/search-perf")
    ],
    [
      agentPane("w1", 1, "blocked"),
      agentPane("w2", 1, "working"),
      agentPane("w3", 1, "done")
    ],
    { "/w/auth-rewrite": "feat/auth-rewrite", "/w/billing-api": "feat/billing-api", "/w/search-perf": "perf/search" }
  ),
  // The awkward cases: one slot unassigned, one workspace with no worktree, and
  // a workstream whose panes run no agent.
  partial: live(
    [workspace(1, "primary", null), workspace(2, "search perf", "/w/search-perf")],
    [{ pane_id: "w2:p1", workspace_id: "w2", agent_status: "unknown" }],
    { "/w/search-perf": "perf/search" }
  )
};

mkdirSync("artifacts", { recursive: true });
for (const [name, state] of Object.entries(scenes)) {
  for (const [appearance, theme] of [["dark", dark], ["light", light]]) {
    if (name !== "live" && name !== "partial" && appearance === "light") continue;
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
