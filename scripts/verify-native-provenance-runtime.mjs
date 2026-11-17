import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import {
  captureProvenanceBuildInputs,
  observeProvenanceSourceBuild,
  requireProvenanceSourceBuild,
} from "./native-provenance-source-build.mjs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import { runRequiredTests } from "./required-test-evidence.mjs";
import { withRuntimeInstallationCapture } from "./runtime-installation-capture.mjs";
import {
  captureProvenanceHarness,
  collectProvenanceRuntimeInstallation,
  createProvenanceRuntimeProgress,
  captureProvenanceRuntime,
  captureProvenanceSource,
  provenanceRuntimeArgument,
  provenanceRuntimeHash,
  provenanceRuntimeQualified,
  publishProvenanceRuntimeReceipt,
  readProvenanceInput,
  requireProvenanceInstalledLayout,
  requireProvenanceRuntimeCases,
  selectProvenanceRuntimeRequirements,
} from "./native-provenance-runtime-evidence.mjs";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  slot = provenanceRuntimeArgument(process.argv.slice(2));
assert.ok(
  process.env.CHECKTRAIL_NATIVE_PROVENANCE_RUNTIME_SLOT === undefined ||
    process.env.CHECKTRAIL_NATIVE_PROVENANCE_RUNTIME_SLOT === slot,
  "Conflicting provenance runtime selection",
);
const definitions = JSON.parse(
    await readFile(path.join(repository, "scripts/required-native-tests.json")),
  ),
  inventory = JSON.parse(
    await readFile(path.join(repository, "docs/gate-a-profiles.v1.json")),
  );
const requirements = selectProvenanceRuntimeRequirements(
  definitions,
  inventory,
);
const installed = process.env.CHECKTRAIL_NATIVE_PROVENANCE_INSTALLED === "1";
const progress = createProvenanceRuntimeProgress({
  cohort: installed ? "fresh" : "source",
});
const runtime = await progress.run("capture", () =>
  captureProvenanceRuntime(inventory, slot),
);
let context = null,
  sourceBinding,
  executionBinding = {
    engineLocation: "current-source",
    helperLocation: "current-source",
    harnessOutsideInstalledPackage: false,
  };
if (installed) {
  const raw = await readProvenanceInput(
    path.join(repository, "installed-context.json"),
    2 * 1048576,
    true,
  );
  assert.ok(raw.length > 0 && raw.length <= 2 * 1048576);
  assert.equal(
    provenanceRuntimeHash(raw),
    process.env.CHECKTRAIL_NATIVE_PROVENANCE_CONTEXT_SHA256,
    "Installed context changed",
  );
  context = JSON.parse(raw);
  executionBinding = await progress.run("capture", () =>
    requireProvenanceInstalledLayout(repository, context),
  );
  sourceBinding = context.sourceBinding;
} else
  sourceBinding = await progress.run("capture", () =>
    captureProvenanceSource(repository),
  );
if (slot !== null)
  assert.equal(
    sourceBinding.worktreeClean,
    true,
    "Selected qualification requires clean source",
  );
process.env.CHECKTRAIL_NATIVE_LICENSE_COMPOSITION_NATIVE = "1";
const inputSources = await progress.run("capture", () =>
    captureProvenanceHarness(repository),
  ),
  harnessSha256 = provenanceRuntimeHash(JSON.stringify(inputSources)),
  requirementsSha256 = provenanceRuntimeHash(JSON.stringify(requirements));
if (context) {
  assert.deepEqual(context.inputSources, inputSources);
  assert.equal(context.harnessSha256, harnessSha256);
  assert.deepEqual(context.runtime, runtime);
}
const before = await progress.run("capture", () =>
  captureCompiledEngine(path.join(repository, "dist/src")),
);
if (context) {
  for (const key of [
    "schemaVersion",
    "fileCount",
    "bytes",
    "treeSha256",
    "manifestSha256",
  ])
    assert.equal(
      before[key],
      context.compiledEngine[key],
      "Installed engine differs from selected source",
    );
}
const sourceBuild = await progress.run("source-build", async () => {
  const result = context
    ? context.sourceBuild
    : await observeProvenanceSourceBuild(repository, sourceBinding);
  requireProvenanceSourceBuild(result, {
    sourceBinding,
    compiledEngine: before,
    inputSources,
    runtime,
  });
  return result;
});
await withRuntimeInstallationCapture(
  "native-provenance",
  { installed, slot },
  async (capture) => {
    const previousBuildFile =
        process.env.CHECKTRAIL_NATIVE_PROVENANCE_BUILD_RECEIPT,
      previousBuildSha = process.env.CHECKTRAIL_NATIVE_PROVENANCE_BUILD_SHA256;
    if (!installed) {
      const bytes = Buffer.from(JSON.stringify(sourceBuild));
      const file = path.join(
        path.dirname(process.env.CHECKTRAIL_NATIVE_PROVENANCE_INSTALL_RECEIPT),
        "source-build.json",
      );
      await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
      process.env.CHECKTRAIL_NATIVE_PROVENANCE_BUILD_RECEIPT = file;
      process.env.CHECKTRAIL_NATIVE_PROVENANCE_BUILD_SHA256 =
        provenanceRuntimeHash(bytes);
    }
    try {
      const report = await progress.run(
        installed ? "fresh-cases" : "source-cases",
        () =>
          runRequiredTests(
            requirements.map((row) => ({
              ...row,
              file: path.join(repository, row.file),
            })),
            { timeoutMs: 600000, onTestProgress: progress.caseEvent },
          ),
      );
      assert.deepEqual(
        await captureProvenanceRuntime(inventory, slot),
        runtime,
        "Runtime changed during provenance acceptance",
      );
      assert.deepEqual(
        await captureProvenanceHarness(repository),
        inputSources,
        "Harness changed during provenance acceptance",
      );
      if (context) await requireProvenanceInstalledLayout(repository, context);
      else
        assert.deepEqual(
          await captureProvenanceSource(repository),
          sourceBinding,
          "Source changed during provenance acceptance",
        );
      if (!installed)
        assert.deepEqual(
          await captureProvenanceBuildInputs(repository),
          sourceBuild.inputs,
          "Source/compiler/config changed after first-party build",
        );
      const compiledEngine = requireUnchangedCompiledEngine(
        before,
        await captureCompiledEngine(path.join(repository, "dist/src")),
      );
      const result = {
        schemaVersion: 1,
        profile: "native-provenance-runtime-v1",
        ...report,
        installed,
        installedEvidence: null,
        runtime,
        sourceBinding,
        sourceBuild,
        inputSources,
        harnessSha256,
        requirementsSha256,
        compiledEngine,
        executionBinding,
        harnessInputsUnchanged: true,
        selectedSlotQualified: provenanceRuntimeQualified(
          runtime,
          report,
          sourceBuild,
        ),
        inferenceInvoked: false,
        fieldEvaluationExecuted: false,
        upstreamProducerClosureVerified: false,
        completeOriginalNoticeClosureVerified: false,
        gateAComplete: false,
      };
      if (report.complete) {
        requireProvenanceRuntimeCases(
          result,
          requirements,
          inputSources.find((x) => x.file === requirements[0].file).sha256,
        );
        if (!installed)
          result.installedEvidence = await progress.run("install-capture", () =>
            collectProvenanceRuntimeInstallation({
              repository,
              slot,
              source: result,
              requirements,
              capture,
            }),
          );
      }
      const rawReceipt = Buffer.from(JSON.stringify(result) + "\n");
      try {
        if (
          !installed &&
          process.env.CHECKTRAIL_NATIVE_PROVENANCE_RUNTIME_RECEIPT !== undefined
        )
          await publishProvenanceRuntimeReceipt(
            rawReceipt,
            process.env.CHECKTRAIL_NATIVE_PROVENANCE_RUNTIME_RECEIPT,
            {
              runtime,
              sourceBinding,
              sourceBuild,
              inputSources,
              harnessSha256,
              requirementsSha256,
              compiledEngine: before,
              requirements,
              installed: false,
            },
          );
      } finally {
        process.stdout.write(rawReceipt);
      }

      process.exitCode = report.complete ? 0 : 1;
    } finally {
      if (previousBuildFile === undefined)
        delete process.env.CHECKTRAIL_NATIVE_PROVENANCE_BUILD_RECEIPT;
      else
        process.env.CHECKTRAIL_NATIVE_PROVENANCE_BUILD_RECEIPT =
          previousBuildFile;
      if (previousBuildSha === undefined)
        delete process.env.CHECKTRAIL_NATIVE_PROVENANCE_BUILD_SHA256;
      else
        process.env.CHECKTRAIL_NATIVE_PROVENANCE_BUILD_SHA256 =
          previousBuildSha;
    }
  },
);
