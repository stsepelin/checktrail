import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { captureCompiledEngine } from "./compiled-engine-evidence.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** Read actual controller inputs. Native tool and image observations come from its existing runtime probe. */
export async function captureConsumerWitnessController(
  root,
  family,
  runtimeImage,
  runtime,
  tool,
) {
  assert.ok(["go", "python", "php", "rust"].includes(family));
  const profile = "context-" + family;
  const required = JSON.parse(
    await readFile(
      path.join(root, "scripts/required-native-tests.json"),
      "utf8",
    ),
  )[profile];
  assert.equal(required.length, 9);
  const acceptanceFile = "dist/test/gate-context-" + family + ".test.js";
  assert.ok(required.every((row) => row.file === acceptanceFile));
  const files = [
    "dist/test/consumer-witness-fixture.js",
    acceptanceFile,
    "scripts/required-native-tests.json",
    "scripts/compiled-engine-evidence.mjs",
    "scripts/consumer-witness-attempts.mjs",
  ];
  const identities = await Promise.all(
    files.map(async (file) => {
      const bytes = await readFile(path.join(root, file));
      return { bytes: bytes.length, sha256: hash(bytes) };
    }),
  );
  const engine = await captureCompiledEngine(path.join(root, "dist/src"));
  const definition =
    family === "php"
      ? "scripts/php-context-tools.Dockerfile"
      : family === "rust"
        ? "scripts/rust-context-tools.Dockerfile"
        : ".github/workflows/ci.yml";
  const definitionSha256 = hash(await readFile(path.join(root, definition)));
  const observedImage =
    runtimeImage.kind === "oci-image-observation"
      ? { kind: runtimeImage.kind, id: runtimeImage.id, definitionSha256 }
      : {
          kind: "hosted-runner-metadata",
          imageOS: runtimeImage.imageOS,
          imageVersion: runtimeImage.imageVersion,
          distributionSha256: runtime.distributionSha256,
          metadataAttested: false,
        };
  const inventory = JSON.parse(
    await readFile(path.join(root, "docs/gate-a-profiles.v1.json"), "utf8"),
  );
  let pythonVersion;
  if (family === "python") {
    const workflow = parse(
      await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8"),
    );
    const pythonSteps = workflow.jobs["go-workspaces-arm64"].steps.filter(
      (step) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/setup-python@"),
    );
    assert.equal(pythonSteps.length, 1);
    pythonVersion = pythonSteps[0].with["python-version"];
  }
  const version = runtime.toolVersion;
  const toolVersionMatched =
    family === "go"
      ? version.startsWith("go version go" + inventory.toolVersions.go + " ")
      : family === "php"
        ? version === inventory.toolVersions.php
        : family === "rust"
          ? version.startsWith("rustc " + inventory.toolVersions.rust + " ")
          : version === "Python " + pythonVersion;
  const toolInputsSha256 = hash(
    JSON.stringify({
      definitionSha256,
      runtimeImage: observedImage,
      tool,
      runtimeVersion: runtime.toolVersion,
    }),
  );
  return {
    family,
    toolVersionMatched,
    requirements: required,
    engineSha256: engine.treeSha256,
    harnessSha256: hash(
      JSON.stringify([
        identities[0],
        identities[1],
        identities[3],
        identities[4],
      ]),
    ),
    requirementsSha256: hash(JSON.stringify(required)),
    acceptanceSha256: identities[1].sha256,
    packageManifestSha256: hash(
      await readFile(path.join(root, "package.json")),
    ),
    toolInputsSha256,
    runtimeImage: observedImage,
    runtime,
    tool,
  };
}
