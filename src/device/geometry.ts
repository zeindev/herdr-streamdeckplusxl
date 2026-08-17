/**
 * Physical layout of the devices this product drives.
 *
 * Only the Stream Deck + XL is described here. The Stream Deck Mini is an
 * accepted target (ADR-0008) but nothing renders it yet, so its geometry
 * arrives with the ticket that does.
 */

/** Elgato `DeviceType` for the Stream Deck + XL. */
export const DEVICE_TYPE_XL = 13;

/** Workstreams visible at once, and therefore channels across the device (ADR-0009). */
export const CHANNEL_COUNT = 3;

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

export function layoutForDeviceType(deviceType: number): DeviceLayout | null {
  return deviceType === DEVICE_TYPE_XL ? XL_LAYOUT : null;
}

export function keyCount(layout: DeviceLayout): number {
  return layout.columns * layout.rows;
}

/** Keys are addressed left to right, top to bottom, as the Stream Deck SDK does. */
export function keyIndex(layout: DeviceLayout, column: number, row: number): number {
  return row * layout.columns + column;
}

export function keyAddress(layout: DeviceLayout, index: number): { column: number; row: number } {
  return { column: index % layout.columns, row: Math.floor(index / layout.columns) };
}

/** Which workstream owns this column. Channel order is left to right, always (ADR-0008). */
export function channelOfColumn(layout: DeviceLayout, column: number): number {
  return Math.floor(column / layout.columnsPerChannel);
}

/**
 * The bottom row of every channel is its own three control keys rather than
 * panes, and there is no rail shared across channels (ADR-0011).
 */
export function isControlRow(layout: DeviceLayout, row: number): boolean {
  return row === layout.rows - 1;
}

export function channelOfEncoder(layout: DeviceLayout, encoder: number): number {
  return Math.floor(encoder / layout.encodersPerChannel);
}
