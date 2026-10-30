import {
  inspectManagedInputs,
  managedConsumerFamilies,
} from "./consumer-witness-managed.mjs";
import {
  inspectJvmInputs,
  jvmConsumerFamilies,
} from "./consumer-witness-jvm.mjs";
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
  assert.ok(
    [
      "go",
      "python",
      "php",
      "rust",
      "ruby",
      "c",
      "cpp",
      "java",
      "kotlin",
      "scala",
      "csharp",
      "fsharp",
      "vb",
    ].includes(family),
  );
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
    "scripts/consumer-witness-jvm.mjs",
    "scripts/consumer-witness-managed.mjs",
  ];
  const identities = await Promise.all(
    files.map(async (file) => {
      const bytes = await readFile(path.join(root, file));
      return { bytes: bytes.length, sha256: hash(bytes) };
    }),
  );
  const engine = await captureCompiledEngine(path.join(root, "dist/src"));
  const definition = [
    "php",
    "rust",
    "ruby",
    "c",
    "cpp",
    "java",
    "kotlin",
    "scala",
  ].includes(family)
    ? "scripts/" + family + "-context-tools.Dockerfile"
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
  let toolVersionMatched =
    family === "go"
      ? version.startsWith("go version go" + inventory.toolVersions.go + " ")
      : family === "php"
        ? version === inventory.toolVersions.php
        : family === "rust"
          ? version.startsWith("rustc " + inventory.toolVersions.rust + " ")
          : family === "ruby"
            ? version.startsWith("ruby " + inventory.toolVersions.ruby + " ")
            : ["c", "cpp"].includes(family)
              ? version === "14.2.0" &&
                runtime.compilerTarget === "aarch64-linux-gnu" &&
                /Debian 14\.2\.0-19/.test(runtime.compilerIdentity ?? "")
              : version === "Python " + pythonVersion;
  const jvmInputs = jvmConsumerFamilies.includes(family)
    ? inspectJvmInputs(runtime.jvmInputs, family)
    : null;
  if (jvmInputs) {
    assert.deepEqual(jvmInputs.compiler, tool);
    const selectedJava =
      runtime.javac === "javac 25.0.4" &&
      /^openjdk 25\.0\.4 /.test(runtime.java ?? "");
    toolVersionMatched =
      selectedJava &&
      (family === "java" ||
        (family === "kotlin"
          ? /kotlinc-jvm 2\.4\.10 /.test(runtime.kotlinVersion ?? "")
          : /Scala compiler version 3\.9\.0/.test(runtime.scalaVersion ?? "")));
  }
  const managedInputs = managedConsumerFamilies.includes(family)
    ? inspectManagedInputs(runtime.managedInputs, family)
    : null;
  if (managedInputs) {
    assert.deepEqual(managedInputs.dotnet, tool);
    const compiler =
      family === "fsharp"
        ? "Microsoft (R) F# Compiler version 15.2.401.0 for F# 10.0"
        : "5.9.0-1.26423.113 (e34a38d2ae1fc26406a317517196e55c68ff83ab)";
    toolVersionMatched =
      runtime.dotnet === inventory.toolVersions.dotnet &&
      runtime.compiler === compiler &&
      /Microsoft.NETCore.App 10\.0\.12(?: |$)/.test(runtime.runtimes ?? "");
  }
  const nativeTool = ["c", "cpp"].includes(family)
    ? {
        name: family === "c" ? "gcc" : "g++",
        role: "supplementary-native-compiler",
        version,
        target: runtime.compilerTarget,
        identity: runtime.compilerIdentity,
        qualifiesSelectedClang: false,
      }
    : null;
  const toolInputsSha256 = hash(
    JSON.stringify({
      definitionSha256,
      runtimeImage: observedImage,
      tool,
      runtimeVersion: runtime.toolVersion,
      nativeTool,
      jvmInputs,
      managedInputs,
    }),
  );
  return {
    family,
    toolVersionMatched,
    nativeTool,
    jvmInputs,
    managedInputs,
    requirements: required,
    engineSha256: engine.treeSha256,
    harnessSha256: hash(
      JSON.stringify([
        identities[0],
        identities[1],
        identities[3],
        identities[4],
        identities[5],
        identities[6],
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
