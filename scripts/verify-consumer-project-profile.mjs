import process from "node:process";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import { runRequiredTests } from "./required-test-evidence.mjs";
import { collectConsumerWitnesses } from "./consumer-witness-collection.mjs";
import {
  projectConsumerCollection,
  bindProjectConsumerCollection,
} from "./consumer-witness-project-controller.mjs";
import { viteLibraryPrerequisites } from "../dist/src/vite-library-prerequisites.js";
import { eslintParticipationPrerequisites } from "../dist/src/eslint-participation-prerequisites.js";
const root = fileURLToPath(new URL("../", import.meta.url)),
  profile = process.argv[2];
assert.equal(
  process.argv.length,
  3,
  "Usage: verify-consumer-project-profile.mjs javascript-extensions",
);
assert.equal(profile, "javascript-extensions");
const hash = (value) => createHash("sha256").update(value).digest("hex"),
  before = await captureCompiledEngine(path.join(root, "dist/src")),
  requirements = JSON.parse(
    await readFile(
      path.join(root, "scripts/required-native-tests.json"),
      "utf8",
    ),
  )[profile];
assert.equal(requirements.length, 9);
const runtime = {
  node: process.versions.node,
  platform: process.platform,
  architecture: process.arch,
  hostAttestationPerformed: false,
  toolVersion: execFileSync(process.execPath, ["--version"], {
    encoding: "utf8",
  }).trim(),
  nodeExecutableSha256: hash(await readFile(process.execPath)),
  distributionSha256:
    process.platform === "linux"
      ? hash(await readFile("/etc/os-release"))
      : null,
  imageOS: process.env.ImageOS ?? null,
  imageVersion: process.env.ImageVersion ?? null,
  eslint: await eslintParticipationPrerequisites(
    root,
    path.join(root, "node_modules/eslint/lib/api.js"),
  ),
  library: await viteLibraryPrerequisites(
    root,
    path.join(root, "node_modules/vite/dist/node/index.js"),
    path.join(root, "node_modules/typescript/lib/typescript.js"),
  ),
};
const packet = await collectConsumerWitnesses(
  () => runRequiredTests(requirements, { timeoutMs: 600000 }),
  async (evidence, capture) => {
    assert.equal(evidence.complete, true, JSON.stringify(evidence.problems));
    assert.equal(evidence.required, 9);
    assert.equal(evidence.passed, 9);
    const engine = requireUnchangedCompiledEngine(
      before,
      await captureCompiledEngine(path.join(root, "dist/src")),
    );
    const collection = await projectConsumerCollection(
      root,
      "typescript",
      capture,
      evidence,
      engine,
    );
    return bindProjectConsumerCollection(
      root,
      ["typescript"],
      collection,
      {
        kind: "hosted-runner-metadata",
        imageOS: runtime.imageOS,
        imageVersion: runtime.imageVersion,
      },
      runtime,
    );
  },
);
process.stdout.write(JSON.stringify(packet) + "\n");
