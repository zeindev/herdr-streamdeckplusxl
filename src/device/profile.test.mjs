import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { DEVICE_TYPE_XL, XL_LAYOUT, keyCount } from "../../.preview/device/geometry.js";

/**
 * The profile is what places this plugin's actions onto the hardware. Without
 * it the plugin loads, connects, and draws nothing, because the SDK only lets a
 * plugin address controls through action instances a profile has put there —
 * a failure that is invisible in every other test.
 */
const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("dev.herdr.streamdeck.sdPlugin/manifest.json", root), "utf8"));

function profilePage() {
  const contents = new URL("profiles/Herdr Stream Deck XL.streamDeckProfile.contents/", root);
  const [bundle] = readdirSync(contents).filter((name) => name.endsWith(".sdProfile"));
  assert.ok(bundle, "the generated profile bundle is missing; run npm run profile");
  const pages = new URL(`${bundle}/Profiles/`, contents);
  const [page] = readdirSync(pages);
  return JSON.parse(readFileSync(new URL(`${page}/manifest.json`, pages), "utf8"));
}

test("the plugin ships a profile bound to the Stream Deck + XL", () => {
  assert.ok(Array.isArray(manifest.Profiles) && manifest.Profiles.length === 1);
  const [profile] = manifest.Profiles;
  assert.equal(profile.DeviceType, DEVICE_TYPE_XL);
  assert.equal(profile.AutoInstall, true, "the profile must install itself, not wait to be imported");
  assert.equal(profile.Name, "profiles/Herdr Stream Deck XL");
});

test("the packaged profile sits where the manifest says it does", () => {
  const packaged = new URL(`dev.herdr.streamdeck.sdPlugin/${manifest.Profiles[0].Name}.streamDeckProfile/`, root);
  assert.ok(readdirSync(packaged).some((name) => name.endsWith(".sdProfile")), "the profile is not packaged into the plugin");
});

test("the profile fills every key of the 9 by 4 grid", () => {
  const keypad = profilePage().Controllers.find((controller) => controller.Type === "Keypad");
  assert.ok(keypad, "the profile declares no keypad controller");

  const placed = Object.keys(keypad.Actions).sort();
  assert.equal(placed.length, keyCount(XL_LAYOUT));

  const expected = [];
  for (let row = 0; row < XL_LAYOUT.rows; row++) {
    for (let column = 0; column < XL_LAYOUT.columns; column++) expected.push(`${column},${row}`);
  }
  assert.deepEqual(placed, expected.sort(), "every coordinate in the grid must carry an action");
});

test("the profile fills every encoder", () => {
  const encoders = profilePage().Controllers.find((controller) => controller.Type === "Encoder");
  assert.ok(encoders, "the profile declares no encoder controller");
  assert.equal(Object.keys(encoders.Actions).length, XL_LAYOUT.encoders);
});

test("every placed action is one the plugin actually declares", () => {
  const declared = new Set(manifest.Actions.map((declaration) => declaration.UUID));
  for (const controller of profilePage().Controllers) {
    for (const [coordinate, placed] of Object.entries(controller.Actions)) {
      assert.ok(declared.has(placed.UUID), `${coordinate} places an undeclared action ${placed.UUID}`);
      assert.equal(placed.States[0].ShowTitle, false, "the plugin draws its own labels");
    }
  }
});

test("action identifiers are stable, so regenerating the profile is not a diff", () => {
  const before = profilePage();
  const identifiers = Object.values(before.Controllers[0].Actions).map((placed) => placed.ActionID);
  assert.equal(new Set(identifiers).size, identifiers.length, "each placement needs its own identifier");
  assert.ok(identifiers.every((id) => /^[0-9A-F-]{36}$/.test(id)));
});
