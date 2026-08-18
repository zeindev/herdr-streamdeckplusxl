import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const packageLock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("dev.herdr.streamdeck.sdPlugin/manifest.json", root), "utf8"));
const herdrPlugin = readFileSync(new URL("herdr-plugin.toml", root), "utf8");

test("all install surfaces publish the same plugin version", () => {
  const herdrVersion = herdrPlugin.match(/^version = "([^"]+)"$/m)?.[1];

  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  assert.equal(herdrVersion, packageJson.version);
  assert.equal(manifest.Version, `${packageJson.version}.0`);
});
