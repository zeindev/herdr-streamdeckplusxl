import { readFile } from "node:fs/promises";
import { rollup } from "rollup";
import config from "../rollup.config.mjs";

const configurations = Array.isArray(config) ? config : [config];

for (const configuration of configurations) {
  const outputs = Array.isArray(configuration.output) ? configuration.output : [configuration.output];
  const bundle = await rollup(configuration);

  try {
    for (const outputOptions of outputs) {
      if (!outputOptions?.file) throw new Error("Bundle freshness check requires output.file");

      const generated = await bundle.generate(outputOptions);
      const chunks = generated.output.filter((entry) => entry.type === "chunk");
      if (chunks.length !== 1) throw new Error(`Expected one generated chunk, found ${chunks.length}`);

      const committed = await readFile(outputOptions.file, "utf8");
      if (committed !== chunks[0].code) {
        console.error(`Stale bundle: ${outputOptions.file}`);
        console.error("Run npm run build and commit the generated runtime.");
        process.exitCode = 1;
      }
    }
  } finally {
    await bundle.close();
  }
}

// Terser's worker pool can keep the programmatic Rollup process alive after
// generation is complete. This check has no background work left to preserve.
process.exit(process.exitCode ?? 0);
