import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repository = new URL("../", import.meta.url);

function executable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

test("the macOS installer opens a cache copy that survives Herdr relocating its temporary checkout", () => {
  const fixture = mkdtempSync(join(tmpdir(), "herdr-streamdeck-installer-"));
  const scripts = join(fixture, "scripts");
  const plugin = join(fixture, "dev.herdr.streamdeck.sdPlugin");
  const commands = join(fixture, "commands");
  const cache = join(fixture, "cache");
  const openedPath = join(fixture, "opened-path.txt");

  mkdirSync(join(plugin, "bin"), { recursive: true });
  mkdirSync(join(fixture, "licenses"));
  mkdirSync(scripts);
  mkdirSync(commands);
  cpSync(new URL("scripts/install-streamdeck.sh", repository), join(scripts, "install-streamdeck.sh"));
  writeFileSync(join(plugin, "bin", "plugin.js"), "// fixture\n");
  writeFileSync(join(plugin, "manifest.json"), "{}\n");
  writeFileSync(join(fixture, "LICENSE"), "fixture\n");
  writeFileSync(join(fixture, "THIRD_PARTY_NOTICES.md"), "fixture\n");
  writeFileSync(join(fixture, "licenses", "fixture.txt"), "fixture\n");

  executable(join(commands, "herdr"), "#!/bin/sh\nexit 0\n");
  executable(join(commands, "uname"), "#!/bin/sh\necho Darwin\n");
  executable(join(commands, "open"), `#!/bin/sh\nprintf '%s' "$1" > "${openedPath}"\n`);

  const result = spawnSync("sh", [join(scripts, "install-streamdeck.sh")], {
    cwd: fixture,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${commands}:${process.env.PATH}`,
      XDG_CACHE_HOME: cache
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const expected = join(cache, "herdr", "installers", "herdr-streamdeck.streamDeckPlugin");
  assert.equal(readFileSync(openedPath, "utf8"), expected, "Stream Deck was opened on the temporary checkout artifact");
  assert.equal(existsSync(expected), true, "the package handed to Stream Deck did not survive installer exit");
});
