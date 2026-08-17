/**
 * Generates every Stream Deck profile this plugin ships (ADR-0008): the +
 * XL's 9x4 grid of keys plus 6 encoders, and the Mini's 3x2 grid of keys
 * alone.
 *
 * A profile is what places this plugin's actions onto a device's controls.
 * Without one the plugin loads, connects, and draws nothing, because the SDK
 * only lets a plugin address controls through action instances the profile
 * has put there.
 *
 * Each is generated rather than hand-written: dozens of near-identical
 * entries with stable identifiers are something a script should own.
 *
 *   node scripts/build-profile.mjs
 */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY_UUID = "dev.herdr.streamdeck.key";
const ENCODER_UUID = "dev.herdr.streamdeck.encoder";
const VERSION = "0.1.0.0";

/**
 * One profile to generate. `deviceModel` empty means "any device of this
 * type": the profile binds through `deviceType` in the plugin manifest.
 * Fill a model in once its code has been read off real hardware.
 */
const PROFILES = [
  { name: "Herdr Stream Deck XL", deviceType: 13, deviceModel: "", columns: 9, rows: 4, encoders: 6 },
  // No encoders: the Mini has no dials and no strip (ADR-0008), so its
  // profile places only the Keypad action and never an Encoder one.
  { name: "Herdr Stream Deck Mini", deviceType: 1, deviceModel: "", columns: 3, rows: 2, encoders: 0 }
];

/**
 * Identifiers are derived from what they identify, so regenerating a profile
 * produces the same file rather than a diff full of fresh random UUIDs.
 */
function stableId(name, seed) {
  const hex = createHash("sha1").update(`${name}:${seed}`).digest("hex").toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function entry(name, uuid, actionName, seed, encoder) {
  return {
    ActionID: stableId(name, seed),
    ...(encoder ? { Encoder: { IconVisible: false } } : {}),
    LinkedTitle: false,
    Name: actionName,
    Plugin: { Name: actionName, UUID: uuid, Version: VERSION },
    Resources: null,
    Settings: {},
    State: 0,
    States: [{ Title: "", ShowTitle: false }],
    UUID: uuid
  };
}

function build({ name, deviceType, deviceModel, columns, rows, encoders }) {
  const keys = {};
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      keys[`${column},${row}`] = entry(name, KEY_UUID, "Channel Key", `key:${column},${row}`, false);
    }
  }

  const encoderEntries = {};
  for (let index = 0; index < encoders; index++) {
    encoderEntries[`${index},0`] = entry(name, ENCODER_UUID, "Channel Encoder", `encoder:${index}`, true);
  }

  const controllers = [{ Actions: keys, Type: "Keypad" }];
  // Omitted entirely for a device with none, rather than an empty Encoder
  // controller — the Mini's profile should say it has no dials by absence,
  // not by a controller with nothing in it.
  if (encoders > 0) controllers.push({ Actions: encoderEntries, Type: "Encoder" });

  const pageId = stableId(name, "page").toLowerCase();
  const page = { Controllers: controllers, Icon: "", Name: "" };
  const profile = {
    Device: { Model: deviceModel, UUID: "" },
    Name: name,
    Pages: { Current: pageId, Default: pageId, Pages: [pageId] },
    Version: "3.0"
  };

  const root = `profiles/${name}.streamDeckProfile.contents`;
  const sdProfile = join(root, `${stableId(name, "profile").toLowerCase()}.sdProfile`);
  const pageDirectory = join(sdProfile, "Profiles", pageId.toUpperCase());

  rmSync(root, { recursive: true, force: true });
  mkdirSync(pageDirectory, { recursive: true });
  writeFileSync(join(sdProfile, "manifest.json"), `${JSON.stringify(profile, null, 2)}\n`);
  writeFileSync(join(pageDirectory, "manifest.json"), `${JSON.stringify(page, null, 2)}\n`);

  // The plugin manifest references the profile relative to the .sdPlugin
  // folder, so the generated bundle is copied in beside it.
  const packaged = `dev.herdr.streamdeck.sdPlugin/profiles/${name}.streamDeckProfile`;
  rmSync(packaged, { recursive: true, force: true });
  mkdirSync(packaged, { recursive: true });
  cpSync(root, packaged, { recursive: true });

  return { name, deviceType, deviceModel, keyCount: Object.keys(keys).length, encoderCount: Object.keys(encoderEntries).length };
}

const results = PROFILES.map(build);

writeFileSync(
  "profiles/profile.json",
  `${JSON.stringify(
    results.map(({ name, deviceType, deviceModel }) => ({ DeviceType: deviceType, DeviceModel: deviceModel, Name: name })),
    null,
    2
  )}\n`
);

for (const { name, keyCount, encoderCount } of results) {
  const placed = keyCount + encoderCount;
  process.stdout.write(`${name}: ${keyCount} keys and ${encoderCount} encoders placed (${placed} controls)\n`);
}
