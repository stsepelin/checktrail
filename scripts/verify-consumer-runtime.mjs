import assert from "node:assert/strict";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { verifyConsumerRuntime } from "./consumer-runtime-evidence.mjs";
import { collectConsumerWitnesses } from "./consumer-witness-collection.mjs";
import {
  projectConsumerCollection,
  bindProjectConsumerCollection,
} from "./consumer-witness-project-controller.mjs";
assert.ok(process.argv.length === 2 || process.argv.length === 3);
const root = fileURLToPath(new URL("../", import.meta.url));
const packet = await collectConsumerWitnesses(
  () => verifyConsumerRuntime({ slot: process.argv[2] ?? null }),
  async (receipt, capture) => {
    const collection = await projectConsumerCollection(
      root,
      "javascript",
      capture,
      receipt.profileEvidence,
      receipt.compiledEngine,
    );
    const runtime = {
      ...receipt.runtime,
      hosted: process.env.GITHUB_ACTIONS === "true",
      hostAttestationPerformed: false,
      toolVersion: "v" + receipt.runtime.node,
    };
    const bound = await bindProjectConsumerCollection(
      root,
      ["javascript", "shared-json"],
      collection,
      {
        kind: "hosted-runner-metadata",
        imageOS: runtime.imageOS,
        imageVersion: runtime.imageVersion,
      },
      runtime,
      {
        requireSelectedSlot:
          receipt.selectedRuntime !== null &&
          receipt.selectedRuntime.id !== "native-linux-arm64-node22",
      },
    );
    return { ...receipt, consumerWitnesses: bound };
  },
);
process.stdout.write(JSON.stringify(packet) + "\n");
