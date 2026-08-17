import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { DEVICE_TYPE_MINI, DEVICE_TYPE_XL, MINI_LAYOUT, XL_LAYOUT, keyCount } from "../../.preview/device/geometry.js";

/**
 * The profile is what places this plugin's actions onto the hardware. Without
 * it the plugin loads, connects, and draws nothing, because the SDK only lets a
 * plugin address controls through action instances a profile has put there —
 * a failure that is invisible in every other test.
 *
 * Two devices, two profiles (ADR-0008): the XL's own plus the Mini's, which
 * has no encoders and no strip and therefore no Encoder controller at all.
 */
const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("dev.herdr.streamdeck.sdPlugin/manifest.json", root), "utf8"));

const PROFILES = [
  { name: "Herdr Stream Deck XL", deviceType: DEVICE_TYPE_XL, layout: XL_LAYOUT },
  { name: "Herdr Stream Deck Mini", deviceType: DEVICE_TYPE_MINI, layout: MINI_LAYOUT }
];

function profileEntry(name) {
  return manifest.Profiles.find((profile) => profile.Name === `profiles/${name}`);
}

function profilePage(name) {
  const contents = new URL(`profiles/${name}.streamDeckProfile.contents/`, root);
  const [bundle] = readdirSync(contents).filter((entry) => entry.endsWith(".sdProfile"));
  assert.ok(bundle, `the generated profile bundle for ${name} is missing; run npm run profile`);
  const pages = new URL(`${bundle}/Profiles/`, contents);
  const [page] = readdirSync(pages);
  return JSON.parse(readFileSync(new URL(`${page}/manifest.json`, pages), "utf8"));
}

test("the plugin ships exactly one profile per supported device", () => {
  assert.ok(Array.isArray(manifest.Profiles) && manifest.Profiles.length === PROFILES.length);
});

for (const { name, deviceType } of PROFILES) {
  test(`the plugin ships a profile bound to ${name}`, () => {
    const profile = profileEntry(name);
    assert.ok(profile, `no manifest entry names profiles/${name}`);
    assert.equal(profile.DeviceType, deviceType);
    assert.equal(profile.AutoInstall, true, "the profile must install itself, not wait to be imported");
    assert.equal(profile.Name, `profiles/${name}`);
  });

  test(`the packaged ${name} profile sits where the manifest says it does`, () => {
    const packaged = new URL(`dev.herdr.streamdeck.sdPlugin/${profileEntry(name).Name}.streamDeckProfile/`, root);
    assert.ok(readdirSync(packaged).some((entry) => entry.endsWith(".sdProfile")), "the profile is not packaged into the plugin");
  });

  test(`the ${name} profile fills every key of its grid`, () => {
    const layoutForProfile = PROFILES.find((profile) => profile.name === name).layout;
    const keypad = profilePage(name).Controllers.find((controller) => controller.Type === "Keypad");
    assert.ok(keypad, "the profile declares no keypad controller");

    const placed = Object.keys(keypad.Actions).sort();
    assert.equal(placed.length, keyCount(layoutForProfile));

    const expected = [];
    for (let row = 0; row < layoutForProfile.rows; row++) {
      for (let column = 0; column < layoutForProfile.columns; column++) expected.push(`${column},${row}`);
    }
    assert.deepEqual(placed, expected.sort(), "every coordinate in the grid must carry an action");
  });

  test(`every action ${name}'s profile places is one the plugin actually declares`, () => {
    const declared = new Set(manifest.Actions.map((declaration) => declaration.UUID));
    for (const controller of profilePage(name).Controllers) {
      for (const [coordinate, placed] of Object.entries(controller.Actions)) {
        assert.ok(declared.has(placed.UUID), `${coordinate} places an undeclared action ${placed.UUID}`);
        assert.equal(placed.States[0].ShowTitle, false, "the plugin draws its own labels");
      }
    }
  });

  test(`${name}'s action identifiers are stable, so regenerating the profile is not a diff`, () => {
    const before = profilePage(name);
    const identifiers = Object.values(before.Controllers[0].Actions).map((placed) => placed.ActionID);
    assert.equal(new Set(identifiers).size, identifiers.length, "each placement needs its own identifier");
    assert.ok(identifiers.every((id) => /^[0-9A-F-]{36}$/.test(id)));
  });
}

test("the XL profile fills every encoder", () => {
  const encoders = profilePage("Herdr Stream Deck XL").Controllers.find((controller) => controller.Type === "Encoder");
  assert.ok(encoders, "the profile declares no encoder controller");
  assert.equal(Object.keys(encoders.Actions).length, XL_LAYOUT.encoders);
});

test("the Mini profile declares no encoder controller at all, since it has no dials or strip", () => {
  const encoders = profilePage("Herdr Stream Deck Mini").Controllers.find((controller) => controller.Type === "Encoder");
  assert.equal(encoders, undefined, "an empty Encoder controller would still imply dials that do not exist");
});
