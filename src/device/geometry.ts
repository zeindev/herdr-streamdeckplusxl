/**
 * Physical layout of the devices this product drives (ADR-0008).
 */

/** Elgato `DeviceType` for the Stream Deck + XL. */
export const DEVICE_TYPE_XL = 13;

/** Elgato `DeviceType` for the Stream Deck Mini. */
export const DEVICE_TYPE_MINI = 1;

/**
 * The set of Stream Deck devices currently connected (`Rig` in CONTEXT.md).
 * Decides which layout the Mini draws: mirroring channels alone, or the
 * global surface once an XL is also attached (ADR-0008, `-4w7`). The XL's own
 * layout never depends on this — only the Mini's does.
 */
export type Rig = "xl-only" | "mini-only" | "paired";

export type DeviceLayout = {
  kind: "xl" | "mini";
  columns: number;
  rows: number;
  /**
   * Rotary encoders. Each owns one 200x100 region of the touch strip, so an
   * encoder and its region are one control, not two. Zero on the Mini, which
   * has no dials and no strip (ADR-0008) — nothing downstream may draw one.
   */
  encoders: number;
  /** Columns one channel owns. The grid divides exactly by `CHANNEL_COUNT`. */
  columnsPerChannel: number;
  encodersPerChannel: number;
};

/**
 * 36 keys as 9 columns by 4 rows, and six encoders whose touch-strip regions
 * make up the 1200x100 strip. Both counts divide by three, which is what lets
 * one workstream own a whole vertical channel (ADR-0002).
 */
export const XL_LAYOUT: DeviceLayout = {
  kind: "xl",
  columns: 9,
  rows: 4,
  encoders: 6,
  columnsPerChannel: 3,
  encodersPerChannel: 2
};

/**
 * 6 keys as 3 columns by 2 rows, one column per channel, no encoders. Column
 * order matches the XL exactly — column 1 is the same workstream on both
 * devices, always — so muscle memory transfers rather than competing
 * (ADR-0008, `-vk6`).
 */
export const MINI_LAYOUT: DeviceLayout = {
  kind: "mini",
  columns: 3,
  rows: 2,
  encoders: 0,
  columnsPerChannel: 1,
  encodersPerChannel: 0
};

/**
 * Channels on the device, and therefore workstreams the instrument can show at
 * once. Always three: the cap is enforced by the layout rather than by
 * willpower, and a fourth workstream becomes a counted overflow (ADR-0009).
 */
export const CHANNEL_COUNT = 3;

/** The channel a column belongs to. */
export function channelOfColumn(layout: DeviceLayout, column: number): number {
  return Math.floor(column / layout.columnsPerChannel);
}

/** Where a column sits inside its own channel. */
export function columnInChannel(layout: DeviceLayout, column: number): number {
  return column % layout.columnsPerChannel;
}

/** The absolute key index of a position inside a channel. */
export function channelKeyIndex(layout: DeviceLayout, channel: number, column: number, row: number): number {
  return row * layout.columns + channel * layout.columnsPerChannel + column;
}

export function layoutForDeviceType(deviceType: number): DeviceLayout | null {
  if (deviceType === DEVICE_TYPE_XL) return XL_LAYOUT;
  if (deviceType === DEVICE_TYPE_MINI) return MINI_LAYOUT;
  return null;
}

export function keyCount(layout: DeviceLayout): number {
  return layout.columns * layout.rows;
}

/** Keys are addressed left to right, top to bottom, as the Stream Deck SDK does. */
export function keyAddress(layout: DeviceLayout, index: number): { column: number; row: number } {
  return { column: index % layout.columns, row: Math.floor(index / layout.columns) };
}
