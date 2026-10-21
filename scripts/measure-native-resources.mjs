import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { inventory } from "../dist/src/inventory.js";
import { runProcess } from "../dist/src/runner.js";
import {
  nativeResourceCases,
  createNativeResourceFixture,
  resourceHash,
} from "./native-resource-workloads.mjs";
import { readNativeResourceReceipt } from "./native-resource-receipt.mjs";
const repository = fileURLToPath(new URL("../", import.meta.url));
const worker = fileURLToPath(
  new URL("./native-resource-workload-worker.mjs", import.meta.url),
);
const inputFiles = [
  "scripts/measure-native-resources.mjs",
  "scripts/native-resource-workloads.mjs",
  "scripts/native-resource-workload-worker.mjs",
  "scripts/native-child-resource.c",
  "scripts/native-child-resource.mjs",
  "scripts/prepare-native-child-resource.mjs",
  "scripts/native-resource-observer.c",
  "scripts/native-resource-receipt.mjs",
  "scripts/prepare-native-resource-observer.mjs",
  "package-lock.json",
];
async function treeDigest(directory) {
  const rows = [];
  async function walk(relative) {
    for (const item of (
      await readdir(path.join(directory, relative), { withFileTypes: true })
    ).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const file = path.join(relative, item.name);
      if (item.isDirectory()) await walk(file);
      else {
        assert.ok(item.isFile());
        rows.push([
          file.split(path.sep).join("/"),
          resourceHash(await readFile(path.join(directory, file))),
        ]);
      }
    }
  }
  await walk("");
  return resourceHash(Buffer.from(JSON.stringify(rows)));
}
async function goIdentity() {
  let executable;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    try {
      executable = await realpath(path.join(directory, "go"));
      break;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  assert.ok(executable, "Pinned native Go prerequisite unavailable");
  const version = spawnSync(executable, ["version"], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 65536,
  });
  assert.equal(version.status, 0, version.stderr);
  assert.ok(!version.error && !version.signal);
  assert.match(
    version.stdout.trim(),
    /^go version go1\.27\.1 (?:darwin|linux)\/(?:arm64|amd64)$/,
    "Native resource profile requires Go 1.27.1",
  );
  return {
    version: version.stdout.trim(),
    executableSha256: resourceHash(await readFile(executable)),
    completeCompilerAndStandardLibraryClosure: false,
  };
}
async function identity() {
  return {
    go: await goIdentity(),
    inputs: await Promise.all(
      inputFiles.map(async (file) => ({
        file,
        sha256: resourceHash(await readFile(path.join(repository, file))),
      })),
    ),
    compiledEngineSha256: await treeDigest(path.join(repository, "dist/src")),
    node: process.versions.node,
    nodeExecutableSha256: resourceHash(
      await readFile(await realpath(process.execPath)),
    ),
    platform: process.platform,
    architecture: process.arch,
  };
}
export async function measureNativeResourceSample({
  root,
  expected,
  bundle,
  observer,
  directory,
}) {
  const requestId = randomBytes(16).toString("hex"),
    receiptFile = path.join(directory, "observer.json"),
    specificationFile = path.join(directory, "fixture.json");
  await writeFile(specificationFile, JSON.stringify(expected) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  const source = await inventory(root);
  assert.equal(source.files.length, expected.files);
  const execution = await runProcess(
    root,
    {
      executable: observer,
      args: [
        receiptFile,
        requestId,
        await realpath(process.execPath),
        worker,
        root,
        bundle,
        directory,
        specificationFile,
      ],
      cwd: ".",
    },
    { timeoutMs: 120000, maxOutputBytes: 64 * 1024, captureRawOutput: true },
  );
  assert.equal(execution.exitCode, 0, execution.stderr);
  assert.ok(
    !execution.errorCode &&
      !execution.signal &&
      !execution.timedOut &&
      !execution.cancelled &&
      !execution.truncated,
    "Resource observer execution is incomplete",
  );
  const measurement = JSON.parse(execution.stdout),
    receipt = await readNativeResourceReceipt(receiptFile, {
      requestId,
      platform: process.platform,
    });
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.signal, null);
  assert.equal(
    receipt.childPid,
    measurement.pid,
    "Resource observer reaped another worker",
  );
  assert.equal(measurement.sourceFingerprint, source.fingerprint);
  assert.equal(
    (await inventory(root)).fingerprint,
    source.fingerprint,
    "Resource fixture changed during sampling",
  );
  assert.equal(measurement.checks, expected.checks);
  assert.equal(measurement.executedTests, expected.executedTests);
  return {
    ...measurement,
    observer: receipt,
    workerTransport: {
      observedBytes: execution.outputBytes,
      stdoutBytes: execution.capturedOutput.stdout.bytes,
      stderrBytes: execution.capturedOutput.stderr.bytes,
      completeForObservedStreams:
        execution.capturedOutput.completeForObservedStreams,
    },
    fixturesCreatedOutsideMeasurement: true,
    preparationExcludedFromMeasurement: true,
  };
}
export async function measureNativeResources(headers, samples = 10) {
  assert.ok(
    Number.isInteger(samples) && samples >= 5 && samples <= 30,
    "Expected 5..30 complete samples",
  );
  assert.ok(
    ["darwin", "linux"].includes(process.platform),
    "Native resource platform unavailable",
  );
  const actualHeaders = await realpath(headers);
  assert.equal(
    path.resolve(headers),
    actualHeaders,
    "Explicit Node headers must be canonical",
  );
  const before = await identity(),
    temporary = await realpath(
      await mkdtemp(path.join(tmpdir(), "checktrail-native-resources-")),
    );
  try {
    const counterOutput = path.join(temporary, "counter"),
      observerOutput = path.join(temporary, "observer");
    await mkdir(counterOutput, { mode: 0o700 });
    await mkdir(observerOutput, { mode: 0o700 });
    const builds = [];
    for (const [script, args] of [
      ["prepare-native-child-resource.mjs", [counterOutput, actualHeaders]],
      ["prepare-native-resource-observer.mjs", [observerOutput]],
    ]) {
      const result = spawnSync(
        process.execPath,
        [path.join(repository, "scripts", script), ...args],
        { encoding: "utf8", timeout: 45000, maxBuffer: 65536 },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!result.error && !result.signal);
      builds.push(JSON.parse(result.stdout));
    }
    const fixtures = [];
    for (const specification of nativeResourceCases) {
      const root = path.join(temporary, specification.id);
      await mkdir(root, { mode: 0o700 });
      const expected = await createNativeResourceFixture(
        root,
        specification.id,
      );
      fixtures.push({ root, expected });
    }
    const results = [];
    for (let round = 0; round < samples; round++) {
      for (let offset = 0; offset < fixtures.length; offset++) {
        const { root, expected } = fixtures[(round + offset) % fixtures.length],
          directory = path.join(temporary, `${expected.id}-${round}`);
        await mkdir(directory, { mode: 0o700 });
        const measurement = await measureNativeResourceSample({
          root,
          expected,
          directory,
          bundle: path.join(counterOutput, "native-child-resource"),
          observer: path.join(
            observerOutput,
            "native-resource-observer/observer",
          ),
        });
        results.push({
          case: expected.id,
          round,
          fixture: expected,
          ...measurement,
        });
      }
    }
    assert.equal(results.length, samples * nativeResourceCases.length);
    assert.deepEqual(
      await identity(),
      before,
      "Native resource source or runtime changed during sampling",
    );
    return {
      schemaVersion: 1,
      scope:
        "Original synthetic small/large/JavaScript-Go native validation and durable report storage; external operator measurement tooling",
      ...before,
      builds,
      samplesPerCase: samples,
      results,
      method: {
        freshProcessPerSample: true,
        rotatedCaseOrder: true,
        fixturesCreatedOutsideMeasurements: true,
        preparationExcludedFromMeasurements: true,
        validationCountersExcludeArchiveWrites: true,
        observerCoversWholeWorker: true,
        summedProcessTreeRss: false,
        unreapedDescendantCoverage: "unverified",
        goFilesystemCache: "uncontrolled",
        goBuildCache:
          "private profile cache shared across samples; no engine validation caching",
        initialHarnessInventoryExcludedFromValidationCounters: true,
        peakRssIncludesWorkerLifetime: true,
        goBuildCacheStorageAccounted: false,
        compilerSdkClosureVerified: false,
        regressionBudget: null,
      },
      measurementHarnessShipped: false,
      resourceReleaseReadinessComplete: false,
      nativeWindowsAcceptance: false,
      inferenceExecuted: false,
      fieldEvaluationExecuted: false,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  assert.ok(
    (args.length === 2 || args.length === 4) &&
      args[0] === "--node-headers" &&
      (args.length === 2 ||
        (args[2] === "--samples" && /^[0-9]+$/.test(args[3]))),
    "Usage: measure-native-resources.mjs --node-headers CANONICAL_HEADERS [--samples 5..30]",
  );
  process.stdout.write(
    JSON.stringify(
      await measureNativeResources(
        args[1],
        args.length === 4 ? Number(args[3]) : 10,
      ),
      null,
      2,
    ) + "\n",
  );
}
