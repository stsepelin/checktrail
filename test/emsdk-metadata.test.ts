import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Register the same inert synthetic cohort in the mandatory compiled suite.
const repository = fileURLToPath(new URL("../../", import.meta.url));
await import(
  pathToFileURL(
    path.join(
      repository,
      "scripts/producer-qualification/emsdk-metadata.test.mjs",
    ),
  ).href
);
