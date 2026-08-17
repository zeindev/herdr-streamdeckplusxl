/**
 * Physical layout of the devices this product drives.
 *
 * Only the Stream Deck + XL is described here. The Stream Deck Mini is an
 * accepted target (ADR-0008) but nothing renders it yet, so its geometry
 * arrives with the ticket that does.
 */

/** Elgato `DeviceType` for the Stream Deck + XL. */
export const DEVICE_TYPE_XL = 13;

export type DeviceLayout = {
  kind: "xl";
  columns: number;
  rows: number;
  /**
   * Rotary encoders. Each owns one 200x100 region of the touch strip, so an
   * encoder and its region are one control, not two.
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
 * Channels on the device, and therefore workstreams the instrument can show at
 * once. Always three: the cap is enforced by the layout rather than by
 * willpower, and a fourth workstream becomes a counted overflow (ADR-0009).
 */
export const CHANNEL_COUNT = 3;

/**
 * The row of a channel that carries who the workstream is and how it is doing.
 *
 * Row 0 for now. ADR-0003 gives the top three rows to panes and puts identity on
 * the strip, so this row returns to panes once the strip carries identity
 * permanently — until then it is the only place a channel can be read, and the
 * only place a channel can be pressed.
 */
export const HEADER_ROW = 0;

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
  return deviceType === DEVICE_TYPE_XL ? XL_LAYOUT : null;
}

export function keyCount(layout: DeviceLayout): number {
  return layout.columns * layout.rows;
}

/** Keys are addressed left to right, top to bottom, as the Stream Deck SDK does. */
export function keyAddress(layout: DeviceLayout, index: number): { column: number; row: number } {
  return { column: index % layout.columns, row: Math.floor(index / layout.columns) };
}
