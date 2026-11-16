import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import {
  captureProvenanceBuildInputs,
  requireProvenanceSourceBuild,
} from "./native-provenance-source-build.mjs";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
import { copyInstalledPackages } from "../dist/test/tool-fixture.js";
import {
  captureProvenanceHarness,
  createProvenanceRuntimeProgress,
  captureProvenanceRuntime,
  captureProvenanceSource,
  provenanceInstalledPrograms,
  provenanceRuntimeArgument,
  provenanceRuntimeHash,
  readProvenanceInput,
  requireProvenanceRuntimeEvidence,
  selectProvenanceRuntimeRequirements,
} from "./native-provenance-runtime-evidence.mjs";
assert.notEqual(
  process.env.CHECKTRAIL_NATIVE_PROVENANCE_INSTALLED,
  "1",
  "Installed cohort cannot install recursively",
);
const repository = fileURLToPath(new URL("../", import.meta.url)),
  slot = provenanceRuntimeArgument(process.argv.slice(2));
const inventory = JSON.parse(
    await readFile(path.join(repository, "docs/gate-a-profiles.v1.json")),
  ),
  definitions = JSON.parse(
    await readFile(path.join(repository, "scripts/required-native-tests.json")),
  );
const requirements = selectProvenanceRuntimeRequirements(
  definitions,
  inventory,
);
const progress = createProvenanceRuntimeProgress({
  cohort: "fresh",
});
const runtime = await progress.run("capture", () =>
    captureProvenanceRuntime(inventory, slot),
  ),
  sourceBinding = await progress.run("capture", () =>
    captureProvenanceSource(repository),
  );
if (slot !== null)
  assert.equal(
    sourceBinding.worktreeClean,
    true,
    "Selected qualification requires clean source",
  );
const inputSources = await progress.run("capture", () =>
    captureProvenanceHarness(repository),
  ),
  harnessSha256 = provenanceRuntimeHash(JSON.stringify(inputSources)),
  requirementsSha256 = provenanceRuntimeHash(JSON.stringify(requirements)),
  before = await progress.run("capture", () =>
    captureCompiledEngine(path.join(repository, "dist/src")),
  );
assert.ok(
  process.env.CHECKTRAIL_NATIVE_PROVENANCE_BUILD_RECEIPT &&
    process.env.CHECKTRAIL_NATIVE_PROVENANCE_BUILD_SHA256,
  "Installed qualification requires its source parent's observed build witness",
);
const buildBytes = await readProvenanceInput(
  process.env.CHECKTRAIL_NATIVE_PROVENANCE_BUILD_RECEIPT,
  2 * 1048576,
  true,
);
assert.equal(
  provenanceRuntimeHash(buildBytes),
  process.env.CHECKTRAIL_NATIVE_PROVENANCE_BUILD_SHA256,
  "Source-build witness changed",
);
const sourceBuild = JSON.parse(buildBytes);
requireProvenanceSourceBuild(sourceBuild, {
  sourceBinding,
  compiledEngine: before,
  inputSources,
  runtime,
});
assert.deepEqual(
  await captureProvenanceBuildInputs(repository),
  sourceBuild.inputs,
  "Source/compiler/config differs from observed build",
);
const temporary = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "checktrail-provenance-install-")),
);
try {
  const [packed] = await progress.run("pack", () =>
    JSON.parse(
      runAcceptanceNpm(
        ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
        { cwd: repository, encoding: "utf8" },
      ),
    ),
  );
  assert.ok(
    typeof packed.filename === "string" &&
      path.basename(packed.filename) === packed.filename,
  );
  const tarball = path.join(temporary, packed.filename),
    consumer = path.join(temporary, "consumer"),
    harness = path.join(temporary, "harness");
  const tarballSha256 = provenanceRuntimeHash(await readFile(tarball));
  const installation = await progress.run("installation", () =>
      installAcceptancePackage(repository, tarball, consumer),
    ),
    installedPackageRoot = await realpath(
      path.join(consumer, "node_modules/@stsepelin/checktrail"),
    ),
    installedEngineRoot = await realpath(
      path.join(installedPackageRoot, "dist/src"),
    );
  const installedBefore = await captureCompiledEngine(installedEngineRoot);
  requireUnchangedCompiledEngine(before, installedBefore);
  await mkdir(path.join(harness, "dist/test"), { recursive: true });
  await symlink(
    process.platform === "win32"
      ? installedEngineRoot
      : path.relative(path.join(harness, "dist"), installedEngineRoot),
    path.join(harness, "dist/src"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const input of inputSources) {
    const target = path.join(harness, input.file);
    await mkdir(path.dirname(target), { recursive: true });
    const bytes = await readFile(
      path.join(
        provenanceInstalledPrograms.includes(input.file)
          ? installedPackageRoot
          : repository,
        input.file,
      ),
    );
    assert.equal(provenanceRuntimeHash(bytes), input.sha256);
    await writeFile(target, bytes, { flag: "wx" });
  }
  const lock = JSON.parse(
      await readFile(path.join(repository, "package-lock.json")),
    ),
    externalSdkClientDependencies = {};
  await copyInstalledPackages(
    harness,
    ["@modelcontextprotocol/client"],
    path.join(repository, "node_modules"),
    ({ relative, version }) => {
      const location = relative.split(path.sep).join("/");
      assert.equal(version, lock.packages["node_modules/" + location].version);
      externalSdkClientDependencies[location] = version;
    },
  );
  const context = {
    schemaVersion: 1,
    mode: "installed",
    installedPackageRoot,
    installedEngineRoot,
    sourceEngineRoot: await realpath(path.join(repository, "dist/src")),
    sourceBinding,
    sourceBuild,
    inputSources,
    harnessSha256,
    runtime,
    compiledEngine: before,
  };
  const contextBytes = Buffer.from(JSON.stringify(context));
  await writeFile(path.join(harness, "installed-context.json"), contextBytes, {
    flag: "wx",
    mode: 0o600,
  });
  const env = {
    ...process.env,
    CHECKTRAIL_NATIVE_PROVENANCE_INSTALLED: "1",
    CHECKTRAIL_NATIVE_PROVENANCE_INSTALLED_PACKAGE: installedPackageRoot,
    CHECKTRAIL_NATIVE_PROVENANCE_CONTEXT_SHA256:
      provenanceRuntimeHash(contextBytes),
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  delete env.CHECKTRAIL_NATIVE_PROVENANCE_INSTALL_RECEIPT;
  delete env.CHECKTRAIL_NATIVE_PROVENANCE_BUILD_RECEIPT;
  delete env.CHECKTRAIL_NATIVE_PROVENANCE_BUILD_SHA256;
  const evidence = await progress.run("fresh-cases", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/verify-native-provenance-runtime.mjs", slot ?? "--development"],
      {
        cwd: harness,
        env,
        encoding: "utf8",
        timeout: 540000,
        maxBuffer: 4 * 1048576,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    let diagnostic = (result.stdout + result.stderr).slice(-6000);
    try {
      const packet = JSON.parse(result.stdout);
      diagnostic = JSON.stringify({
        passed: packet.passed,
        required: packet.required,
        complete: packet.complete,
        problems: packet.problems,
      }).slice(0, 6000);
    } catch {
      /* Crashed collectors have no structured packet. */
    }
    assert.equal(result.status, 0, diagnostic);
    const evidence = JSON.parse(result.stdout);
    requireProvenanceRuntimeEvidence(evidence, {
      runtime,
      sourceBinding,
      sourceBuild,
      inputSources,
      harnessSha256,
      requirementsSha256,
      compiledEngine: before,
      installed: true,
      requirements,
    });
    return evidence;
  });
  assert.deepEqual(await captureProvenanceRuntime(inventory, slot), runtime);
  assert.deepEqual(await captureProvenanceSource(repository), sourceBinding);
  assert.deepEqual(
    await captureProvenanceBuildInputs(repository),
    sourceBuild.inputs,
  );
  assert.deepEqual(await captureProvenanceHarness(repository), inputSources);
  requireUnchangedCompiledEngine(
    before,
    await captureCompiledEngine(path.join(repository, "dist/src")),
  );
  requireUnchangedCompiledEngine(
    installedBefore,
    await captureCompiledEngine(installedEngineRoot),
  );
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      profile: "native-provenance-installed-v1",
      tarballSha256,
      ...installation,
      harnessSha256,
      harnessOutsideInstalledPackage: true,
      externalSdkClientDependencies,
      evidence,
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
      gateAComplete: false,
    }) + "\n",
  );
} finally {
  await progress.run("cleanup", () =>
    rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 30 : 0,
      retryDelay: 100,
    }),
  );
}
