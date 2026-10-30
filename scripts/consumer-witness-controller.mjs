import { inspectSwiftInputs } from "./consumer-witness-swift.mjs";
import {
  dataConsumerFamilies,
  inspectDataInputs,
  normalizeDataInputs,
} from "./consumer-witness-data.mjs";
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
      "hcl",
      "yaml",
      "swift",
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
    "scripts/consumer-witness-data.mjs",
    "scripts/consumer-witness-swift.mjs",
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
    "csharp",
    "fsharp",
    "vb",
    "hcl",
    "yaml",
    "swift",
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
  const dataInputs = dataConsumerFamilies.includes(family)
    ? inspectDataInputs(runtime.dataInputs, family)
    : null;
  if (dataInputs) {
    assert.deepEqual(dataInputs.tool, tool);
    toolVersionMatched =
      family === "hcl"
        ? runtime.terraform?.terraform_version ===
            inventory.toolVersions.terraform &&
          tool.sha256 ===
            "c9caf6b26aa487a470bd02d32ffe3e44fe5e95fa7e7f986cb9f2be61654f240c"
        : dataInputs.package.version === inventory.toolVersions.yaml;
  }
  const swiftInputs = family === "swift" ? runtime.swiftInputs : null;
  if (swiftInputs) {
    inspectSwiftInputs(swiftInputs);
    assert.deepEqual(swiftInputs.driver, tool);
    toolVersionMatched =
      inventory.toolVersions.swift === "6.2.0" &&
      runtime.swift ===
        "Swift version 6.2 (swift-6.2-RELEASE)\nTarget: aarch64-unknown-linux-gnu";
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
      swiftInputs,
      dataInputs: dataInputs ? normalizeDataInputs(dataInputs) : null,
    }),
  );
  return {
    family,
    toolVersionMatched,
    nativeTool,
    jvmInputs,
    managedInputs,
    swiftInputs,
    dataInputs,
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
        identities[7],
        identities[8],
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
