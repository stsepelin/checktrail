import process from "node:process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  rename,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { runRequiredTests } from "./required-test-evidence.mjs";
import { readConsumerWitnessNamespace } from "./consumer-witness-collection.mjs";
import {
  registerConsumerCaptureNamespace,
  finishConsumerCaptureRegistration,
} from "./consumer-native-capture-registry.mjs";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import {
  inspectConsumerWitnesses,
  selectConsumerWitnessRequirements,
  bindConsumerWitnessController,
  requireQualifiedConsumerWitnessFamily,
} from "./consumer-witness-evidence.mjs";
import { captureConsumerWitnessController } from "./consumer-witness-controller.mjs";
import {
  observeConsumerWitnessTool,
  observeConsumerWitnessJvmInputs,
  observeConsumerWitnessManagedInputs,
  observeConsumerWitnessDataInputs,
  observeConsumerWitnessSwiftInputs,
  consumerWitnessCaptureParent,
} from "../dist/test/consumer-witness-fixture.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const profile = process.argv[2];
assert.equal(
  process.argv.length,
  3,
  "Usage: verify-consumer-witness-profile.mjs context-go|context-python|context-php|context-rust|context-ruby|context-c|context-cpp|context-java|context-kotlin|context-scala|context-csharp|context-fsharp|context-vb|context-hcl|context-yaml|context-swift",
);
assert.ok(
  [
    "context-go",
    "context-python",
    "context-php",
    "context-rust",
    "context-ruby",
    "context-c",
    "context-cpp",
    "context-java",
    "context-kotlin",
    "context-scala",
    "context-csharp",
    "context-fsharp",
    "context-vb",
    "context-hcl",
    "context-yaml",
    "context-swift",
  ].includes(profile),
);
const family = profile.slice("context-".length);
const parse = async (name) =>
  JSON.parse(await readFile(path.join(root, name), "utf8"));
const manifest = await parse("docs/gate-a-consumer-witnesses.v1.json");
const inventory = await parse("docs/gate-a-profiles.v1.json");
const requirements = await parse("scripts/required-native-tests.json");
const selected = selectConsumerWitnessRequirements(
  manifest,
  inventory,
  requirements,
).find((row) => row.id === family);
assert.ok(selected);
assert.equal(
  selected.collectorImplementation,
  "prepared",
  "Consumer family collector remains pending",
);
const files = [
  selected.acceptanceFile,
  "dist/test/consumer-witness-fixture.js",
  "scripts/verify-consumer-witness-profile.mjs",
  "scripts/consumer-witness-evidence.mjs",
  "scripts/consumer-witness-controller.mjs",
  "scripts/consumer-witness-attempts.mjs",
  "scripts/consumer-witness-jvm.mjs",
  "scripts/consumer-witness-managed.mjs",
  "scripts/consumer-witness-data.mjs",
  "scripts/consumer-witness-swift.mjs",
  "scripts/consumer-witness-project.mjs",
  "scripts/consumer-runtime-selection.mjs",
  "scripts/consumer-witness-collection.mjs",
  "scripts/consumer-native-capture-registry.mjs",
  ".github/workflows/ci.yml",
  ...([
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
    ? ["scripts/" + family + "-context-tools.Dockerfile"]
    : []),
  "scripts/required-test-evidence.mjs",
  "scripts/required-native-tests.json",
  "scripts/compiled-engine-evidence.mjs",
  "scripts/verify-import-context-package.mjs",
  "docs/gate-a-consumer-witnesses.v1.json",
  "docs/gate-a-profiles.v1.json",
  "package.json",
  "package-lock.json",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identities = () =>
  Promise.all(
    files.map(async (file) => ({
      file,
      sha256: hash(await readFile(path.join(root, file))),
    })),
  );
const beforeInputs = await identities();
const beforeEngine = await captureCompiledEngine(path.join(root, "dist/src"));
const beforeTool = await observeConsumerWitnessTool(family);
const runtime = {
  node: process.versions.node,
  platform: process.platform,
  architecture: process.arch,
  nodeExecutableSha256: hash(await readFile(process.execPath)),
  distributionSha256:
    process.platform === "linux"
      ? hash(await readFile("/etc/os-release"))
      : null,
  imageOS: process.env.ImageOS ?? null,
  imageVersion: process.env.ImageVersion ?? null,
  hostAttestationPerformed: false,
  toolVersion: execFileSync(
    {
      go: "go",
      python: "python3",
      php: "php",
      rust: "rustc",
      ruby: "ruby",
      c: "gcc",
      cpp: "g++",
      java: "javac",
      kotlin: "java",
      scala: "java",
      csharp: "dotnet",
      fsharp: "dotnet",
      vb: "dotnet",
      hcl: "terraform",
      yaml: process.execPath,
      swift: "swiftc",
    }[family],
    {
      go: ["version"],
      python: ["--version"],
      php: ["-r", "echo PHP_VERSION;"],
      rust: ["--version"],
      ruby: ["--disable-gems", "--version"],
      c: ["-dumpfullversion"],
      cpp: ["-dumpfullversion"],
      java: ["--version"],
      kotlin: ["--version"],
      scala: ["--version"],
      csharp: ["--version"],
      fsharp: ["--version"],
      vb: ["--version"],
      hcl: ["version", "-json"],
      yaml: ["--version"],
      swift: ["--version"],
    }[family],
    {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, GOTOOLCHAIN: "local", GOENV: "off" },
    },
  ).trim(),
};
if (["c", "cpp"].includes(family)) {
  const compiler = family === "c" ? "gcc" : "g++";
  runtime.compilerTarget = execFileSync(compiler, ["-dumpmachine"], {
    encoding: "utf8",
    timeout: 10000,
  }).trim();
  runtime.compilerIdentity = execFileSync(compiler, ["--version"], {
    encoding: "utf8",
    timeout: 10000,
  }).trim();
}
if (["java", "kotlin", "scala"].includes(family)) {
  runtime.jvmInputs = await observeConsumerWitnessJvmInputs(family);
  runtime.java = execFileSync("java", ["--version"], {
    encoding: "utf8",
    timeout: 10000,
  }).trim();
  runtime.javac = execFileSync("javac", ["--version"], {
    encoding: "utf8",
    timeout: 10000,
  }).trim();
}
if (["csharp", "fsharp", "vb"].includes(family)) {
  runtime.managedInputs = await observeConsumerWitnessManagedInputs(family);
  runtime.dotnet = execFileSync("dotnet", ["--version"], {
    encoding: "utf8",
    timeout: 10000,
  }).trim();
  runtime.runtimes = execFileSync("dotnet", ["--list-runtimes"], {
    encoding: "utf8",
    timeout: 10000,
  }).trim();
}
if (["hcl", "yaml"].includes(family)) {
  runtime.dataInputs = await observeConsumerWitnessDataInputs(family);
  if (family === "hcl") {
    runtime.terraform = JSON.parse(runtime.toolVersion);
    runtime.toolVersion = runtime.terraform.terraform_version;
  } else runtime.toolVersion = runtime.dataInputs.package.version;
}
if (family === "swift") {
  runtime.swiftInputs = await observeConsumerWitnessSwiftInputs();
  runtime.swift = runtime.toolVersion;
}
const expectedController = await captureConsumerWitnessController(
  root,
  family,
  {
    kind: "hosted-runner-metadata",
    imageOS: runtime.imageOS,
    imageVersion: runtime.imageVersion,
  },
  runtime,
  beforeTool,
);
const namespace = await realpath(
  await mkdtemp(
    path.join(
      await consumerWitnessCaptureParent(
        process.env.CHECKTRAIL_CONSUMER_CAPTURE_ROOT,
      ),
      "checktrail-consumer-witness-",
    ),
  ),
);
const previous = process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR;
let complete = false,
  registration = null;
assert.equal(
  previous,
  undefined,
  "Nested consumer collection would mix independent namespaces",
);
async function checkpoint(value) {
  const pending = path.join(namespace, ".controller.pending"),
    target = path.join(namespace, "controller.json");
  await writeFile(pending, JSON.stringify(value) + "\n", { mode: 0o600 });
  await rename(pending, target);
}
try {
  registration = await registerConsumerCaptureNamespace(
    namespace,
    "native-consumer",
  );
  await checkpoint({
    schemaVersion: 1,
    state: "running",
    family,
    gateAComplete: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  });
  process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR = namespace;
  const evidence = await runRequiredTests(requirements[selected.profile], {
    timeoutMs: 600000,
  });
  const { observations, attemptRecords } =
    await readConsumerWitnessNamespace(namespace);
  assert.equal(evidence.complete, true, JSON.stringify(evidence.problems));
  assert.equal(evidence.required, 9);
  assert.equal(evidence.passed, 9);
  assert.equal(evidence.ledger.truncated, false);
  assert.deepEqual(
    await identities(),
    beforeInputs,
    "Consumer collector inputs changed",
  );
  assert.deepEqual(
    await observeConsumerWitnessTool(family),
    beforeTool,
    "Native tool bytes changed",
  );
  for (const row of observations)
    assert.equal(row.tool.sha256, beforeTool.sha256);
  const engine = requireUnchangedCompiledEngine(
    beforeEngine,
    await captureCompiledEngine(path.join(root, "dist/src")),
  );
  // The native invocation records are physical observations. This first collector
  // does not manufacture image/toolchain qualification from environment labels.
  // Existing per-tool qualification controllers must supply the final bindings.
  const result = {
    schemaVersion: 1,
    profile: "native-consumer-witness-collection-v1",
    family,
    evidence,
    observations,
    attemptRecords,
    observedTool: beforeTool,
    inputIdentities: beforeInputs,
    harnessSha256: hash(JSON.stringify(beforeInputs)),
    compiledEngine: {
      fileCount: engine.fileCount,
      bytes: engine.bytes,
      treeSha256: engine.treeSha256,
      manifestSha256: engine.manifestSha256,
      beforeAfterByteIdentitiesMatch: engine.beforeAfterByteIdentitiesMatch,
    },
    controllerBindingSource: "current-host-runtime-observer",
    nativeControllerBindingsReady: true,
    nativeHostAttestationPerformed: false,
    gateAComplete: false,
    qualityAssessed: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  };
  const bindings = bindConsumerWitnessController(result, expectedController);
  const coverage = inspectConsumerWitnesses(
    manifest,
    inventory,
    requirements,
    observations,
    bindings,
    attemptRecords,
  );
  assert.deepEqual(
    coverage.issues,
    [],
    "Consumer witness reconciliation issues remain",
  );
  const current = coverage.families.find((row) => row.family === family);
  assert.equal(
    current.observedWitnesses,
    6,
    "All source/fresh canonical native variants must be observed",
  );
  assert.equal(current.missing.length, 0);
  // Hosted Go/Python run here as final controllers; OCI families are qualified
  // by their outer controller after binding the physically observed image ID.
  if (family === "go" || family === "python")
    requireQualifiedConsumerWitnessFamily(coverage, family);
  result.bindings = bindings;
  result.coverage = coverage;
  await checkpoint({
    schemaVersion: 1,
    state:
      family === "go" || family === "python"
        ? "collected-qualified-family"
        : "collected-unqualified",
    family,
    observations: observations.length,
    gateAComplete: false,
  });
  await finishConsumerCaptureRegistration(registration, "collected-retained");
  process.stdout.write(JSON.stringify(result) + "\n");
  complete = true;
} catch (error) {
  try {
    await finishConsumerCaptureRegistration(registration, "failed-retained");
  } catch (storageError) {
    process.stderr.write(
      "Consumer registry failure retained: " +
        String(storageError).slice(0, 1024) +
        "\n",
    );
  }
  try {
    await checkpoint({
      schemaVersion: 1,
      state: "failed-incomplete",
      family,
      error: String(error).slice(0, 4000),
      gateAComplete: false,
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
    });
  } catch (storageError) {
    process.stderr.write(
      "Consumer failure checkpoint unavailable: " +
        String(storageError).slice(0, 1024) +
        "\n",
    );
  }
  process.stderr.write(
    "Incomplete consumer capture retained at " + namespace + "\n",
  );
  throw error;
} finally {
  if (previous === undefined)
    delete process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR;
  else process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR = previous;
  if (complete && registration === null)
    await rm(namespace, { recursive: true, force: true });
}
