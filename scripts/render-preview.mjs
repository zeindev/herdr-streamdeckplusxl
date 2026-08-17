/**
 * Renders the whole Stream Deck + XL, and the Mini standalone (ADR-0008),
 * each at its real resolution, straight from the surface the reducer
 * projects.
 *
 * This is the feedback loop for work on the device: it needs no hardware, and
 * because it draws the projected surface rather than hand-written examples, an
 * image that looks wrong means the projection is wrong.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { copiedHerdrTheme } from "../.preview/herdr-themes.js";
import { DEVICE_TYPE_MINI, DEVICE_TYPE_XL, MINI_LAYOUT, XL_LAYOUT } from "../.preview/device/geometry.js";
import { readSlots } from "../.preview/device/slots.js";
import { initialState, reduce } from "../.preview/device/state.js";
import { surfaceOf } from "../.preview/device/surface.js";
import { encoderImage, keyImage } from "../.preview/device/paint.js";
import { recordedWorkspace } from "../src/herdr/fixtures/recorded.mjs";

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
const attachMini = { kind: "device-attached", device: { id: "preview-mini", type: DEVICE_TYPE_MINI } };

/**
 * The preview is only evidence if it draws what Herdr actually sends, so the
 * workspace shape comes from the recorded capture rather than being written here.
 */
function workspace(number, label, checkoutPath) {
  const recorded = recordedWorkspace();
  return {
    ...recorded,
    workspace_id: `w${number}`,
    number,
    label,
    worktree: checkoutPath === null ? null : { ...recorded.worktree, checkout_path: checkoutPath }
  };
}

function agentPane(workspaceId, index, status) {
  return { pane_id: `${workspaceId}:p${index}`, workspace_id: workspaceId, agent: "claude", agent_status: status };
}

function live(workspaces, panes, branches, processes = {}, device = attach) {
  return apply([
    device,
    { kind: "herdr-connection", connected: true },
    { kind: "herdr-snapshot", snapshot: { workspaces, tabs: [], panes } },
    { kind: "herdr-worktrees", worktrees: Object.entries(branches).map(([path, branch]) => ({ path, branch })) },
    ...Object.entries(processes).map(([paneId, cmdline]) => runningIn(paneId, cmdline))
  ]);
}

/**
 * A `pane.process_info` reply, in the envelope the reducer actually reads.
 *
 * The whole envelope under `info`, not a bare process under `process`:
 * `foreground_process_group_id` is what says which entry identifies the pane.
 * The wrong shape type-checks in a .mjs file and silently delivers nothing,
 * which had left every pane in this preview drawn as a shell.
 */
function runningIn(paneId, cmdline) {
  return {
    kind: "herdr-process-info",
    paneId,
    info: {
      pane_id: paneId,
      foreground_process_group_id: 1,
      foreground_processes: [{ pid: 1, name: "x", argv0: cmdline.split(" ")[0], cmdline }]
    }
  };
}

/** A pane running something, as Herdr reports one. */
function pane(workspaceId, id, overrides = {}) {
  return { pane_id: `${workspaceId}:${id}`, workspace_id: workspaceId, agent_status: "unknown", ...overrides };
}

/** Three workstreams as they actually run: an agent, a server, a watcher, a shell. */
const liveScene = live(
  [
    workspace(1, "auth rewrite", "/w/auth-rewrite"),
    workspace(2, "billing api", "/w/billing-api"),
    workspace(3, "search perf", "/w/search-perf")
  ],
  [
    agentPane("w1", 1, "blocked"),
    pane("w1", "dev"),
    pane("w1", "test"),
    pane("w1", "sh"),
    agentPane("w2", 1, "working"),
    pane("w2", "dev"),
    pane("w2", "logs"),
    agentPane("w3", 1, "done"),
    pane("w3", "test"),
    pane("w3", "sh")
  ],
  { "/w/auth-rewrite": "feat/auth-rewrite", "/w/billing-api": "feat/billing-api", "/w/search-perf": "perf/search" },
  {
    "w1:dev": "npm run dev",
    "w1:test": "vitest --watch",
    "w1:sh": "-zsh",
    "w2:dev": "next dev",
    "w2:logs": "tail -f log/dev.log",
    "w3:test": "cargo test",
    "w3:sh": "-zsh"
  }
);

/** A role with more panes than its row has keys, so the count has to appear. */
const crowdedScene = live(
  [workspace(1, "auth rewrite", "/w/auth-rewrite")],
  [1, 2, 3, 4, 5].map((n) => pane("w1", `t${n}`)),
  { "/w/auth-rewrite": "feat/auth-rewrite" },
  Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`w1:t${n}`, "vitest --watch"]))
);

/**
 * The three attention signals at once, and the difference acknowledging makes.
 *
 * Channel 1 has an agent waiting on input and a dev server that died and said
 * so — the dead server keeps the key of the pane it crashed in, because the
 * pane outlived it. Channel 2's agent has finished and nobody has looked.
 * Channel 3's agent has also finished and has been acknowledged, so it is still
 * done but has stopped asking — the pair is the point, since one is the other
 * with the mark and the word removed.
 */
const attentionScene = apply(
  [
    attach,
    { kind: "settings-loaded", slots: readSlots(undefined), roles: {}, acknowledged: ["w3:p1"] },
    { kind: "herdr-connection", connected: true },
    {
      kind: "herdr-snapshot",
      snapshot: {
        workspaces: [
          { ...workspace(1, "auth rewrite", "/w/auth-rewrite"), tokens: { sd_exit_dev: "1 w1:dev" } },
          workspace(2, "billing api", "/w/billing-api"),
          workspace(3, "search perf", "/w/search-perf")
        ],
        tabs: [],
        panes: [
          agentPane("w1", 1, "blocked"),
          pane("w1", "dev"),
          pane("w1", "test"),
          pane("w1", "sh"),
          agentPane("w2", 1, "done"),
          pane("w2", "dev"),
          agentPane("w3", 1, "done"),
          pane("w3", "sh")
        ]
      }
    },
    {
      kind: "herdr-worktrees",
      worktrees: [
        { path: "/w/auth-rewrite", branch: "feat/auth-rewrite" },
        { path: "/w/billing-api", branch: "feat/billing-api" },
        { path: "/w/search-perf", branch: "perf/search" }
      ]
    },
    ...Object.entries({
      "w1:dev": "npm run dev",
      "w1:test": "vitest --watch",
      "w1:sh": "-zsh",
      "w2:dev": "next dev",
      "w3:sh": "-zsh"
    }).map(([paneId, cmdline]) => runningIn(paneId, cmdline))
  ]
);

const scenes = {
  offline: apply([attach]),
  syncing: apply([attach, { kind: "herdr-connection", connected: true }]),
  // Herdr lost after it had been live: the branches stay, the counts do not.
  disconnected: apply([{ kind: "herdr-connection", connected: false }], liveScene),
  // Three workstreams, one per channel, each in a different state.
  live: liveScene,
  attention: attentionScene,
  crowded: crowdedScene,
  // The awkward cases: one channel unassigned and offering a worktree, one
  // workspace with no worktree, and a workstream whose panes run no agent.
  partial: live(
    [workspace(1, "primary", null), workspace(2, "search perf", "/w/search-perf")],
    [{ pane_id: "w2:p1", workspace_id: "w2", agent_status: "unknown" }],
    { "/w/search-perf": "perf/search" }
  ),
  // Over budget: a fourth workstream takes no channel and is counted instead.
  overflow: live(
    [
      workspace(1, "auth rewrite", "/w/auth-rewrite"),
      workspace(2, "billing api", "/w/billing-api"),
      workspace(3, "search perf", "/w/search-perf"),
      workspace(4, "flaky tests", "/w/flaky-tests"),
      workspace(5, "docs pass", "/w/docs-pass")
    ],
    [agentPane("w1", 1, "blocked"), agentPane("w2", 1, "working"), agentPane("w3", 1, "idle")],
    {
      "/w/auth-rewrite": "feat/auth-rewrite",
      "/w/billing-api": "feat/billing-api",
      "/w/search-perf": "perf/search"
    }
  )
};

/**
 * The Mini, standalone (ADR-0008, `-vk6`): the same three workstreams as
 * `liveScene`, in the same column order, so the two devices' previews can be
 * compared side by side — plus the cases that only mean something once a
 * second, urgency-ranked pane exists to rank: an orphaned dead service (no
 * pane to land on), and an unassigned channel.
 */
const miniScenes = {
  live: live(
    [workspace(1, "auth rewrite", "/w/auth-rewrite"), workspace(2, "billing api", "/w/billing-api"), workspace(3, "search perf", "/w/search-perf")],
    [
      agentPane("w1", 1, "blocked"),
      pane("w1", "dev"),
      agentPane("w2", 1, "working"),
      pane("w2", "dev"),
      agentPane("w3", 1, "done"),
      pane("w3", "sh")
    ],
    { "/w/auth-rewrite": "feat/auth-rewrite", "/w/billing-api": "feat/billing-api", "/w/search-perf": "perf/search" },
    {},
    attachMini
  ),
  // Channel 1's dev server died and named no pane still there — the top row
  // has to mark it even though the bottom row has nothing of its own to show.
  orphanedExit: apply([
    attachMini,
    { kind: "herdr-connection", connected: true },
    {
      kind: "herdr-snapshot",
      snapshot: {
        workspaces: [
          { ...workspace(1, "auth rewrite", "/w/auth-rewrite"), tokens: { sd_exit_dev: "1" } },
          workspace(2, "billing api", "/w/billing-api")
        ],
        tabs: [],
        panes: [pane("w2", "dev")]
      }
    },
    {
      kind: "herdr-worktrees",
      worktrees: [
        { path: "/w/auth-rewrite", branch: "feat/auth-rewrite" },
        { path: "/w/billing-api", branch: "feat/billing-api" }
      ]
    }
  ]),
  partial: live([workspace(1, "primary", null)], [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "unknown" }], {}, {}, attachMini)
};

mkdirSync("artifacts", { recursive: true });
for (const [name, state] of Object.entries(scenes)) {
  for (const [appearance, theme] of [["dark", dark], ["light", light]]) {
    if (!["live", "attention", "partial", "overflow", "disconnected", "crowded"].includes(name) && appearance === "light") continue;
    writeFileSync(`artifacts/xl-${name}-${appearance}.svg`, devicePreview(state, theme, XL_LAYOUT));
  }
}
for (const [name, state] of Object.entries(miniScenes)) {
  writeFileSync(`artifacts/mini-${name}-dark.svg`, devicePreview(state, dark, MINI_LAYOUT));
}

function devicePreview(state, theme, layout) {
  const [device] = surfaceOf(state).devices;
  if (!device) throw new Error("The preview state has no attached device");

  const width = layout.columns * KEY + (layout.columns + 1) * GAP;
  const gridHeight = layout.rows * KEY + (layout.rows + 1) * GAP;
  const stripWidth = layout.encoders * 200;
  const height = gridHeight + (layout.encoders > 0 ? STRIP_HEIGHT + GAP : 0) + GAP;

  const keys = device.keys.map((face, index) => {
    const column = index % layout.columns;
    const row = Math.floor(index / layout.columns);
    const x = GAP + column * (KEY + GAP);
    const y = GAP + row * (KEY + GAP);
    return place(keyImage(face, theme), x, y, KEY, KEY);
  });

  // The strip is one continuous composition drawn through its regions, so the
  // preview lays them edge to edge exactly as the hardware does. The Mini has
  // none (ADR-0008), so this section is skipped entirely rather than drawing
  // an empty strip that would imply one exists.
  const stripX = (width - stripWidth) / 2;
  const strip =
    layout.encoders > 0
      ? device.encoders.map((face, index) => place(encoderImage(index, face, layout, theme), stripX + index * 200, gridHeight + GAP, 200, STRIP_HEIGHT))
      : [];

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
