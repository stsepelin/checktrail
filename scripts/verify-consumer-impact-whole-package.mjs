import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import { runRequiredTests } from "./required-test-evidence.mjs";
import { copyInstalledPackages } from "../dist/test/tool-fixture.js";
import {
  consumerRuntimeHarnessFiles,
  selectConsumerRuntimeRequirements,
  observeConsumerRuntime,
  checkConsumerRuntimeSelection,
  compactConsumerEngine,
  requireConsumerTerminalCases,
} from "./consumer-runtime-evidence.mjs";
import {
  selectConsumerFoundation,
  runConsumerFoundation,
} from "./consumer-foundation-evidence.mjs";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(process.argv.length, 2);
const files = [...consumerRuntimeHarnessFiles];
const inputs = await Promise.all(
  files.map(async (file) => ({
    file,
    bytes: await readFile(path.join(repository, file)),
  })),
);
const scope = JSON.parse(
    inputs.find((x) => x.file === "docs/gate-a-profiles.v1.json").bytes,
  ),
  selected = scope.extensionProfiles.find((x) => x.id === "consumer-impact");
assert.ok(selected);
assert.equal(selected.acceptanceCases.length, 9);
const profiles = JSON.parse(
  inputs.find((x) => x.file === "scripts/required-native-tests.json").bytes,
);
const requirements = selectConsumerRuntimeRequirements(profiles, scope);
const slot =
  process.env.CHECKTRAIL_CONSUMER_RUNTIME_ACTIVE === "1"
    ? process.env.CHECKTRAIL_CONSUMER_RUNTIME_SLOT || null
    : null;
const runtime = await observeConsumerRuntime(slot),
  selectedRuntime = checkConsumerRuntimeSelection(
    scope,
    slot,
    runtime,
    process.env.CHECKTRAIL_CONSUMER_RUNTIME_ACTIVE === "1" &&
      process.env.GITHUB_ACTIONS === "true",
  );
const requirementsSha256 = hash(JSON.stringify(requirements));
const harnessSha256 = hash(
    JSON.stringify(inputs.map((x) => [x.file, hash(x.bytes)])),
  ),
  sourceEngine = await captureCompiledEngine(path.join(repository, "dist/src"));
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-consumer-whole-installed-"),
);
const previous = process.env.CHECKTRAIL_CONSUMER_WHOLE_INSTALLED;
try {
  const [packed] = JSON.parse(
    runAcceptanceNpm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const tarball = path.join(temporary, packed.filename),
    tarballSha256 = hash(await readFile(tarball));
  const consumer = path.join(temporary, "consumer"),
    harness = path.join(temporary, "harness");
  const installation = await installAcceptancePackage(
    repository,
    tarball,
    consumer,
  );
  const installed = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail/dist/src",
  );
  await mkdir(path.join(harness, "dist"), { recursive: true });
  await symlink(
    process.platform === "win32"
      ? installed
      : path.relative(path.join(harness, "dist"), installed),
    path.join(harness, "dist/src"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const { file, bytes } of inputs) {
    await mkdir(path.dirname(path.join(harness, file)), { recursive: true });
    await writeFile(path.join(harness, file), bytes, { flag: "wx" });
  }
  const lock = JSON.parse(
      inputs.find((x) => x.file === "package-lock.json").bytes,
    ),
    externalSdkDependencies = {};
  await copyInstalledPackages(
    harness,
    ["@modelcontextprotocol/client"],
    path.join(repository, "node_modules"),
    ({ relative, version }) => {
      const name = relative.split(path.sep).join("/");
      assert.equal(version, lock.packages["node_modules/" + name].version);
      externalSdkDependencies[name] = version;
    },
  );
  assert.equal(
    externalSdkDependencies["@modelcontextprotocol/client"],
    "2.3.1",
  );
  process.env.CHECKTRAIL_CONSUMER_WHOLE_INSTALLED = "1";
  const installedBefore = await captureCompiledEngine(installed);
  requireUnchangedCompiledEngine(sourceEngine, installedBefore);
  const profileEvidence = await runRequiredTests(
    requirements.map((x) => ({ ...x, file: path.join(harness, x.file) })),
    {
      timeoutMs: 600000,
      isolatedCaseWorkers: 1,
      onCaseProgress: (event) =>
        process.stderr.write(
          JSON.stringify({ profile: "consumer-impact-installed", ...event }) +
            "\n",
        ),
    },
  );
  assert.equal(
    profileEvidence.complete,
    true,
    JSON.stringify(profileEvidence.problems),
  );
  assert.equal(profileEvidence.required, 9);
  assert.equal(profileEvidence.passed, 9);
  assert.equal(profileEvidence.ledger.truncated, false);
  assert.deepEqual(
    profileEvidence.ledger.cases.map((c) => [c.name, c.outcome]),
    requirements.map((c) => [c.name, "passed"]),
  );
  requireConsumerTerminalCases(
    profileEvidence,
    requirements,
    hash(
      inputs.find((x) => x.file === "dist/test/gate-consumer-impact.test.js")
        .bytes,
    ),
  );
  const foundationSelection = selectConsumerFoundation(profiles),
    foundationDigests = Object.fromEntries(
      inputs.map((x) => [x.file, hash(x.bytes)]),
    ),
    foundationEvidence = await runConsumerFoundation(
      harness,
      foundationSelection,
      foundationDigests,
      "consumer-foundation-installed",
    );
  const installedAfter = await captureCompiledEngine(installed),
    compiledEngine = requireUnchangedCompiledEngine(
      installedBefore,
      installedAfter,
    );
  requireUnchangedCompiledEngine(
    sourceEngine,
    await captureCompiledEngine(path.join(repository, "dist/src")),
  );
  assert.equal(
    hash(
      JSON.stringify(
        await Promise.all(
          files.map(async (file) => [
            file,
            hash(await readFile(path.join(repository, file))),
          ]),
        ),
      ),
    ),
    harnessSha256,
  );
  assert.deepEqual(await observeConsumerRuntime(slot), runtime);
  const packageSha256 = hash(
    await readFile(
      path.join(consumer, "node_modules/@stsepelin/checktrail/package.json"),
    ),
  );
  const { files: manifest, ...engineIdentity } = compiledEngine;
  assert.equal(manifest.length, engineIdentity.fileCount);
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      profile: "consumer-impact-whole-installed-v1",
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      nodeExecutableSha256: hash(await readFile(process.execPath)),
      tarballSha256,
      runtime,
      selectedRuntime,
      requirementsSha256,
      packageSha256,
      harnessSha256,
      ...installation,
      harnessOutsideInstalledPackage: true,
      externalSdkDependencies,
      compiledEngine: compactConsumerEngine(engineIdentity),
      profileEvidence,
      foundationEvidence,
      foundationRequirementsSha256: hash(JSON.stringify(foundationSelection)),
      gateAConsumerImpactComplete: false,
      gateAComplete: false,
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
    }) + "\n",
  );
} finally {
  if (previous === undefined)
    delete process.env.CHECKTRAIL_CONSUMER_WHOLE_INSTALLED;
  else process.env.CHECKTRAIL_CONSUMER_WHOLE_INSTALLED = previous;
  await rm(temporary, { recursive: true, force: true });
}
