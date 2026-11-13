import assert from "node:assert/strict";
import process from "node:process";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";

import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
assert.ok(process.env.CHECKTRAIL_CONTEXT_RELEASE_PROOF);
const sourceBefore = await captureCompiledEngine(
  path.join(repository, "dist/src"),
);
const temporary = await mkdtemp(
  path.join(await realpath(tmpdir()), "context-proof-package-"),
);
try {
  const [packed] = JSON.parse(
    runAcceptanceNpm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  const tarball = path.join(temporary, packed.filename);
  const tarballSha256 = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  const consumer = path.join(temporary, "consumer");
  const installation = await installAcceptancePackage(
    repository,
    tarball,
    consumer,
  );
  const installed = path.join(consumer, "node_modules/@stsepelin/checktrail");
  const installedBefore = await captureCompiledEngine(
    path.join(installed, "dist/src"),
  );
  requireUnchangedCompiledEngine(sourceBefore, installedBefore);
  const controllers = [
    [
      "families",
      "scripts/verify-context-runtime-proof-families.mjs",
      "passed-all-qualified-parser-families",
    ],
    [
      "mixed",
      "scripts/verify-context-runtime-proof-mixed.mjs",
      "passed-qualified-vb-mixed-boundary",
    ],
    [
      "cache",
      "scripts/verify-context-runtime-proof-cache.mjs",
      "passed-warm-cache-physical-guard",
    ],
    [
      "admission",
      "scripts/verify-context-runtime-proof-admission.mjs",
      "passed-final-context-proof-admission",
    ],
    [
      "transports",
      "scripts/verify-context-runtime-proof-transports.mjs",
      "passed-context-proof-transports",
    ],
    [
      "authority",
      "scripts/verify-context-runtime-proof-authority.mjs",
      "passed-context-proof-authority",
    ],
  ];
  const captureHarness = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          ...controllers.map(([, file]) => file),
          "scripts/verify-context-runtime-proof-package.mjs",
          "scripts/compiled-engine-evidence.mjs",
          "scripts/install-acceptance-package.mjs",
        ]
          .sort()
          .map(async (file) => [
            file,
            createHash("sha256")
              .update(await readFile(path.join(repository, file)))
              .digest("hex"),
          ]),
      ),
    );
  const harnessBefore = await captureHarness();
  const results = [];
  for (const [mode, target] of [
    ["source", repository],
    ["installed", installed],
  ]) {
    for (const [name, file, expectedState] of controllers) {
      const output = execFileSync(
        process.execPath,
        [path.join(repository, file)],
        {
          cwd: repository,
          env: { ...process.env, CHECKTRAIL_CONTEXT_TARGET_ROOT: target },
          encoding: "utf8",
          timeout: 240000,
          maxBuffer: 2 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const result = JSON.parse(output);
      assert.equal(result.state, expectedState, mode + ":" + name);
      assert.equal(result.modelCalls, 0);
      results.push({ mode, name, ...result });
    }
  }
  const sourceStable = requireUnchangedCompiledEngine(
    sourceBefore,
    await captureCompiledEngine(path.join(repository, "dist/src")),
  );
  const installedStable = requireUnchangedCompiledEngine(
    installedBefore,
    await captureCompiledEngine(path.join(installed, "dist/src")),
  );
  assert.deepEqual(
    await captureHarness(),
    harnessBefore,
    "Context proof acceptance harness changed during execution",
  );
  assert.equal(results.length, 12);
  process.stdout.write(
    JSON.stringify({
      state: "passed-context-runtime-proof-package",
      tarballSha256,
      compiledEngine: {
        fileCount: sourceBefore.fileCount,
        bytes: sourceBefore.bytes,
        treeSha256: sourceBefore.treeSha256,
        manifestSha256: sourceBefore.manifestSha256,
        sourceInstalledByteIdentitiesMatch: true,
        sourceBeforeAfterMatch: sourceStable.beforeAfterByteIdentitiesMatch,
        installedBeforeAfterMatch:
          installedStable.beforeAfterByteIdentitiesMatch,
        actualModuleLoadsTraced: false,
      },
      harnessInputs: harnessBefore,
      harnessInputsUnchanged: true,
      ...installation,
      cohorts: results,
      sourceCohorts: 6,
      installedCohorts: 6,
      modelCalls: 0,
      fullProducerBuildClosureVerified: false,
      completeLicenseClosureVerified: false,
      gateAComplete: false,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
