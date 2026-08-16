import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";

const watching = Boolean(process.env.ROLLUP_WATCH);

/**
 * tsconfig enables `allowImportingTsExtensions` so Node's type stripping can run
 * the tests directly against source, which requires `noEmit`. Rollup needs the
 * transpiled output, so it opts emit back in — a combination tsc reports as
 * TS5096. Rollup resolves the `.ts` specifiers itself and the bundle is correct,
 * so this one warning is suppressed rather than left to mask real ones.
 */
const KNOWN_BENIGN_WARNING = "TS5096";

export default {
  onwarn(warning, warn) {
    if (warning.message?.includes(KNOWN_BENIGN_WARNING)) return;
    warn(warning);
  },
  input: "src/plugin.ts",
  output: {
    file: "dev.herdr.streamdeck.sdPlugin/bin/plugin.js",
    sourcemap: watching
  },
  plugins: [
    // tsconfig sets noEmit so it can allow .ts import specifiers; Rollup needs
    // the transpiled output, so it opts back in here.
    typescript({ noEmit: false, emitDeclarationOnly: false }),
    nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    commonjs(),
    !watching && terser(),
    {
      name: "module-package",
      generateBundle() {
        this.emitFile({ fileName: "package.json", source: "{\"type\":\"module\"}", type: "asset" });
      }
    }
  ]
};
