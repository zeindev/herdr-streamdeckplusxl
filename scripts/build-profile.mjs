/**
 * Generates the Stream Deck + XL profile.
 *
 * The profile is what places this plugin's actions onto all 36 keys and 6
 * encoders. Without it the plugin loads, connects, and draws nothing, because
 * the SDK only lets a plugin address controls through action instances the
 * profile has put there.
 *
 * It is generated rather than hand-written: 42 near-identical entries with
 * stable identifiers are something a script should own.
 *
 *   node scripts/build-profile.mjs
 */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NAME = "Herdr Stream Deck XL";
const KEY_UUID = "dev.herdr.streamdeck.key";
const ENCODER_UUID = "dev.herdr.streamdeck.encoder";
const VERSION = "0.1.0.0";

/** Elgato's `DeviceType` for the Stream Deck + XL. */
const DEVICE_TYPE = 13;
/**
 * The hardware model code. Empty means "any device of this type": the profile
 * binds through `DeviceType` in the plugin manifest. Fill this in once the
 * model code has been read off real hardware.
 */
const DEVICE_MODEL = "";

const COLUMNS = 9;
const ROWS = 4;
const ENCODERS = 6;

/**
 * Identifiers are derived from what they identify, so regenerating the profile
 * produces the same file rather than a diff full of fresh random UUIDs.
 */
function stableId(seed) {
  const hex = createHash("sha1").update(`${NAME}:${seed}`).digest("hex").toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function entry(uuid, name, seed, encoder) {
  return {
    ActionID: stableId(seed),
    ...(encoder ? { Encoder: { IconVisible: false } } : {}),
    LinkedTitle: false,
    Name: name,
    Plugin: { Name: name, UUID: uuid, Version: VERSION },
    Resources: null,
    Settings: {},
    State: 0,
    States: [{ Title: "", ShowTitle: false }],
    UUID: uuid
  };
}

const keys = {};
for (let row = 0; row < ROWS; row++) {
  for (let column = 0; column < COLUMNS; column++) {
    keys[`${column},${row}`] = entry(KEY_UUID, "Channel Key", `key:${column},${row}`, false);
  }
}

const encoders = {};
for (let index = 0; index < ENCODERS; index++) {
  encoders[`${index},0`] = entry(ENCODER_UUID, "Channel Encoder", `encoder:${index}`, true);
}

const pageId = stableId("page").toLowerCase();
const page = {
  Controllers: [
    { Actions: keys, Type: "Keypad" },
    { Actions: encoders, Type: "Encoder" }
  ],
  Icon: "",
  Name: ""
};

const profile = {
  Device: { Model: DEVICE_MODEL, UUID: "" },
  Name: NAME,
  Pages: { Current: pageId, Default: pageId, Pages: [pageId] },
  Version: "3.0"
};

const root = `profiles/${NAME}.streamDeckProfile.contents`;
const sdProfile = join(root, `${stableId("profile").toLowerCase()}.sdProfile`);
const pageDirectory = join(sdProfile, "Profiles", pageId.toUpperCase());

rmSync(root, { recursive: true, force: true });
mkdirSync(pageDirectory, { recursive: true });
writeFileSync("profiles/profile.json", `${JSON.stringify({ DeviceType: DEVICE_TYPE, DeviceModel: DEVICE_MODEL, Name: NAME }, null, 2)}\n`);
writeFileSync(join(sdProfile, "manifest.json"), `${JSON.stringify(profile, null, 2)}\n`);
writeFileSync(join(pageDirectory, "manifest.json"), `${JSON.stringify(page, null, 2)}\n`);

// The plugin manifest references the profile relative to the .sdPlugin folder,
// so the generated bundle is copied in beside it.
const packaged = `dev.herdr.streamdeck.sdPlugin/profiles/${NAME}.streamDeckProfile`;
rmSync(packaged, { recursive: true, force: true });
mkdirSync(packaged, { recursive: true });
cpSync(root, packaged, { recursive: true });

const placed = Object.keys(keys).length + Object.keys(encoders).length;
process.stdout.write(`${NAME}: ${Object.keys(keys).length} keys and ${Object.keys(encoders).length} encoders placed (${placed} controls)\n`);
