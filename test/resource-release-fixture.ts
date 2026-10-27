import assert from "node:assert/strict";
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { fixture } from "./helpers.js";
import { ensureWindowsTaskAccess } from "../src/windows-task-access.js";
const tools = await import(
  new URL("../../scripts/release-readiness-tools.mjs", import.meta.url).href
);
export const releaseToolsAvailable = await lstat(
  tools.releaseToolsDirectory,
).then(
  () => true,
  (error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  },
);
export async function resourcePrerequisiteControl(t: TestContext) {
  const original = await tools.observeReleaseTools();
  assert.equal(original.baselineVersion, "0.1.0-alpha.4");
  assert.ok(original.dependencyEntries > 1);
  const root = await realpath(await fixture(t, {}));
  let index = 0;
  async function copy() {
    const destination = path.join(root, "selected-" + index++);
    await mkdir(destination, { mode: 0o700 });
    if (process.platform === "win32")
      ensureWindowsTaskAccess(destination, "directory", true);
    await cp(tools.releaseToolsDirectory, destination, {
      recursive: true,
      verbatimSymlinks: true,
    });
    assert.deepEqual(
      await tools.observeReleaseTools(destination, original),
      original,
    );
    return destination;
  }
  for (const [relative, reason] of [
    ["baseline.tgz", /Older package byte count differs/],
    ["package.json", /Prepared legacy tool manifest changed/],
    ["package-lock.json", /Prepared legacy dependency lock changed/],
    [
      "node_modules/@stsepelin/checktrail/LICENSE",
      /Installed older package license differs/,
    ],
    [
      "node_modules/@stsepelin/checktrail/dist/src/cli.js",
      /Legacy preparation receipt or selected bytes changed/,
    ],
  ] as const) {
    const selected = await copy();
    await appendFile(
      path.join(selected, relative),
      "\n// Original changed prerequisite bytes.\n",
    );
    await assert.rejects(tools.observeReleaseTools(selected, original), {
      code: "ERR_ASSERTION",
      message: reason,
    });
  }
  const metadata = await copy();
  const receipt = path.join(metadata, "receipt.json");
  await rm(receipt);
  await assert.rejects(tools.observeReleaseTools(metadata, original), {
    code: "ENOENT",
  });
  const alias = path.join(root, "alias");
  await symlink(
    tools.releaseToolsDirectory,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(tools.observeReleaseTools(alias, original), /canonical/);
  const forged = await copy();
  const changedModule = path.join(
    forged,
    "node_modules/@stsepelin/checktrail/dist/src/cli.js",
  );
  await appendFile(
    changedModule,
    "\n// Original coherently rehashed dependency change.\n",
  );
  const { mutationDependencies } =
    await import("../src/mutation-native-copy.js");
  const changedGraph = await mutationDependencies(
    forged,
    "node_modules",
    () => true,
  );
  const forgedReceipt = JSON.parse(
    await readFile(path.join(forged, "receipt.json"), "utf8"),
  );
  forgedReceipt.dependencyFingerprint = changedGraph.fingerprint;
  await writeFile(
    path.join(forged, "receipt.json"),
    JSON.stringify(forgedReceipt),
  );
  await assert.rejects(tools.observeReleaseTools(forged, original), {
    code: "ERR_ASSERTION",
    message: /Selected legacy dependency bytes changed/,
  });
  const noReceiptAlias = await copy();
  await rm(path.join(noReceiptAlias, "receipt.json"));
  await writeFile(
    path.join(noReceiptAlias, "receipt-original.json"),
    await readFile(path.join(tools.releaseToolsDirectory, "receipt.json")),
  );
  await symlink(
    "receipt-original.json",
    path.join(noReceiptAlias, "receipt.json"),
    "file",
  );
  await assert.rejects(
    tools.observeReleaseTools(noReceiptAlias, original),
    /regular non-link/,
  );
  const archive = await readFile(
    path.join(tools.releaseToolsDirectory, "baseline.tgz"),
  );
  const failure = new Error(
    "Original synthetic dependency preparation failure",
  );
  const destination = path.join(root, "must-not-publish");
  let invoked = 0;
  await assert.rejects(
    tools.prepareReleaseTools({
      directory: destination,
      offlineDependencies: true,
      fetchImpl: async () => new Response(Uint8Array.from(archive)),
      invokeNpm: async (args: string[], options: { cwd: string }) => {
        invoked++;
        assert.deepEqual(args, [
          "ci",
          "--offline",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ]);
        await writeFile(
          path.join(options.cwd, "incomplete-marker"),
          "Original partial preparation.",
        );
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(invoked, 1);
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(root)).filter((name) =>
      name.startsWith(".prepare-release-readiness-"),
    ),
    [],
  );
  const published = path.join(root, "published-valid");
  const prepared = await tools.prepareReleaseTools({
    directory: published,
    offlineDependencies: true,
    fetchImpl: async () => new Response(Uint8Array.from(archive)),
  });
  assert.equal(prepared.directory, published);
  assert.equal(prepared.baselineExecuted, false);
  assert.equal(prepared.lifecycleScriptsExecuted, false);
  await assert.doesNotReject(async () => {
    assert.deepEqual(
      await tools.observeReleaseTools(published, original),
      original,
    );
  }, "Complete prepared inputs and receipt must be physically published together");
  let replacementFetches = 0;
  await assert.rejects(
    tools.prepareReleaseTools({
      directory: published,
      fetchImpl: async () => {
        replacementFetches++;
        return new Response(Uint8Array.from(archive));
      },
    }),
  );
  assert.equal(
    replacementFetches,
    0,
    "A published selection must refuse before any new acquisition",
  );
  assert.deepEqual(
    await tools.observeReleaseTools(published, original),
    original,
  );
  // The native container receives only exact public tarballs, never host registry metadata.
  const hostCache = await realpath(
    packageTools
      .runAcceptanceNpm(["config", "get", "cache"], { encoding: "utf8" })
      .trim(),
  );
  const publicCache = path.join(root, "public-cache");
  const cacheScript = fileURLToPath(
    new URL("prepare-resource-cache-subset.mjs", resourceScripts),
  );
  const preparedCache = JSON.parse(
    (
      await execute(process.execPath, [cacheScript, hostCache, publicCache], {
        timeout: 30000,
      })
    ).stdout,
  );
  assert.equal(preparedCache.registryMetadataCopied, false);
  assert.equal(preparedCache.historicalLocalPackageTarballsCopied, false);
  const entries = new Map<string, string>();
  for (const file of [
    path.join(repository, "package-lock.json"),
    fileURLToPath(
      new URL("release-readiness-tools/package-lock.json", resourceScripts),
    ),
  ]) {
    const lock = JSON.parse(await readFile(file, "utf8"));
    for (const entry of Object.values(lock.packages) as {
      dev?: boolean;
      resolved?: string;
      integrity?: string;
    }[]) {
      if (
        entry.dev ||
        !entry.resolved?.startsWith("https://registry.npmjs.org/")
      )
        continue;
      const hex = Buffer.from(entry.integrity!.slice(7), "base64").toString(
        "hex",
      );
      entries.set(
        path.join(
          "_cacache/content-v2/sha512",
          hex.slice(0, 2),
          hex.slice(2, 4),
          hex.slice(4),
        ),
        entry.integrity!,
      );
    }
  }
  assert.equal(preparedCache.lockedRegistryTarballs, entries.size);
  let publicBytes = 0;
  for (const [relative, integrity] of entries) {
    const bytes = await readFile(path.join(publicCache, relative));
    publicBytes += bytes.length;
    assert.equal(
      "sha512-" + createHash("sha512").update(bytes).digest("base64"),
      integrity,
    );
  }
  assert.equal(preparedCache.bytes, publicBytes);
  assert.deepEqual(await readdir(publicCache), ["_cacache"]);
  const [selectedEntry] = entries.keys();
  assert.ok(selectedEntry);
  for (const kind of ["absent", "changed", "alias"]) {
    const brokenCache = path.join(root, "cache-" + kind),
      destination = path.join(root, "cache-refused-" + kind);
    await cp(publicCache, brokenCache, { recursive: true });
    const selectedFile = path.join(brokenCache, selectedEntry);
    if (kind === "changed")
      await appendFile(selectedFile, "Original changed registry artifact.");
    else {
      const bytes = await readFile(selectedFile);
      await rm(selectedFile);
      if (kind === "alias") {
        await writeFile(selectedFile + ".original", bytes);
        await symlink(
          path.basename(selectedFile) + ".original",
          selectedFile,
          "file",
        );
      }
    }
    await assert.rejects(
      execute(process.execPath, [cacheScript, brokenCache, destination], {
        timeout: 30000,
      }),
      (error: unknown) => {
        assert.equal((error as { code: number }).code, 1);
        assert.match(
          (error as { stderr: string }).stderr,
          kind === "absent" ? /ENOENT/ : /ERR_ASSERTION/,
        );
        return true;
      },
    );
    await assert.rejects(lstat(destination), { code: "ENOENT" });
  }
  assert.deepEqual(
    (await readdir(root)).filter((name) =>
      name.startsWith("resource-public-cache-"),
    ),
    [],
  );
  // A failed preparation must leave the independently selected original intact.
  assert.deepEqual(
    await tools.observeReleaseTools(tools.releaseToolsDirectory, original),
    original,
  );
  assert.equal(
    (await readFile(path.join(tools.releaseToolsDirectory, "baseline.tgz")))
      .length,
    archive.length,
  );
}

const resourceScripts = new URL("../../scripts/", import.meta.url);
const resourceModules = await import(
  new URL("native-resource-workloads.mjs", resourceScripts).href
);
const posixMeasurement = await import(
  new URL("measure-native-resources.mjs", resourceScripts).href
);
const windowsMeasurement = await import(
  new URL("measure-windows-resources.mjs", resourceScripts).href
);
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const execute = promisify(execFile);
const nodeHeaders =
  process.env.CHECKTRAIL_TEST_NODE_HEADERS ??
  path.resolve(
    path.dirname(await realpath(process.execPath)),
    "../include/node",
  );
const resourceGoAvailable = await execute("go", ["version"], {
  timeout: 10000,
  env: { ...process.env, GOTOOLCHAIN: "local" },
}).then(
  (result) => /^go version go1\.27\.1 /.test(result.stdout.trim()),
  () => false,
);
export const resourceMeasurementsAvailable =
  resourceGoAvailable &&
  (process.platform === "win32" ||
    (["linux", "darwin"].includes(process.platform) &&
      (await lstat(path.join(nodeHeaders, "node_api.h")).then(
        () => true,
        (error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        },
      ))));
type MeasurementTools = { bundle: string; observer: string } | undefined;
async function measurementTools(t: TestContext): Promise<MeasurementTools> {
  if (process.platform === "win32") return undefined;
  const root = await realpath(await fixture(t, {}));
  const { prepareNativeResourceTools } = await import(
    new URL("prepared-native-resource-tools.mjs", resourceScripts).href
  );
  const { bundle, observer } = await prepareNativeResourceTools(
    root,
    await realpath(nodeHeaders),
  );
  return { bundle, observer };
}
async function measuredFixture(
  t: TestContext,
  id: "small" | "large" | "polyglot",
  selected: MeasurementTools,
) {
  const root = await realpath(await fixture(t, {})),
    directory = await realpath(await fixture(t, {}));
  const expected = await resourceModules.createNativeResourceFixture(root, id);
  return { root, directory, expected, ...selected };
}
async function measure(spec: Awaited<ReturnType<typeof measuredFixture>>) {
  const started = performance.now();
  const value =
    process.platform === "win32"
      ? await windowsMeasurement.measureWindowsResourceSample(spec)
      : await posixMeasurement.measureNativeResourceSample(spec);
  const elapsed = performance.now() - started;
  assert.ok(
    value.validationWallMs > 0 && value.validationWallMs <= elapsed,
    "The measured validation interval must fit the actual sampling call",
  );
  assert.equal(value.workerTransport.completeForObservedStreams, true);
  assert.equal(
    value.workerTransport.observedBytes,
    value.workerTransport.stdoutBytes + value.workerTransport.stderrBytes,
  );
  assert.equal(value.observer.childPid, value.pid);
  assert.equal(value.checks, spec.expected.checks);
  assert.equal(value.executedTests, spec.expected.executedTests);
  assert.ok(value.storage.physicalStoreBytes > 0);
  assert.equal(
    value.storage.physicalStoreBytes,
    value.storage.physicalStoreFiles.reduce(
      (n: number, f: { bytes: number }) => n + f.bytes,
      0,
    ),
  );
  assert.equal(value.validationCpuExcludesArchiveWrites, true);
  assert.equal(value.wholeWorkerCountersIncludeArchiveWrites, true);
  if (process.platform === "win32") {
    assert.equal(value.observer.cleanup, "confirmed");
    assert.equal(value.observer.resources.state, "collected");
    assert.equal(value.cpuUnit, "100ns");
    assert.ok(value.jobCpu.user100ns + value.jobCpu.kernel100ns > 0);
    assert.ok(value.directPeakWorkingSetBytes > 0);
    assert.equal(value.summedProcessTreeRss, false);
  } else {
    assert.equal(value.observer.completed, true);
    assert.equal(value.observer.exitCode, 0);
    assert.equal(value.observer.signal, null);
    assert.ok(
      value.observer.wallMicroseconds >=
        Math.floor(value.validationWallMs * 1000),
    );
    assert.ok(
      value.counters.children.userCpuMicroseconds +
        value.counters.children.systemCpuMicroseconds >
        0,
    );
    assert.ok(value.counters.children.peakRssKiB > 0);
    assert.equal(value.counters.summedProcessTreeRss, false);
    assert.equal(value.counters.unreapedDescendantCoverage, "unverified");
    assert.equal(value.snapshots.before.children.userCpuMicroseconds, 0);
    assert.equal(value.snapshots.before.children.systemCpuMicroseconds, 0);
    assert.equal(value.snapshots.before.children.peakRssKiB, 0);
  }
  const rendered = JSON.stringify(value);
  assert.equal(rendered.includes(spec.root), false);
  assert.equal(rendered.includes(spec.directory), false);
  assert.equal(rendered.includes("λ🚀"), false);
  return value;
}
export async function resourceRejectedControl(
  t: TestContext,
  kind: "broken" | "stale" | "empty",
) {
  const selected = await measurementTools(t),
    spec = await measuredFixture(t, "small", selected);
  const control = await realpath(await fixture(t, {})),
    marker = path.join(control, "body-reached");
  const file = path.join(spec.root, "values.test.js");
  if (kind === "empty") {
    await writeFile(
      file,
      `import{test}from'node:test';import{writeFileSync}from'node:fs';test.skip('original empty resource cohort',()=>writeFileSync(${JSON.stringify(marker)},'Original reached body.'));\n`,
    );
  } else {
    const original = await readFile(file, "utf8"),
      anchor = "test('sums every original resource fixture module',()=>{";
    assert.equal(original.split(anchor).length, 2);
    const instrumentation =
      `writeFileSync(${JSON.stringify(marker)},'Original reached resource assertion.');` +
      (kind === "stale"
        ? `writeFileSync(new URL('./value-0000.js',import.meta.url),'export const value=0; // Original source changed during sampling\\n');`
        : "");
    await writeFile(
      file,
      "import{writeFileSync}from'node:fs';\n" +
        original.replace(anchor, anchor + instrumentation),
    );
    if (kind === "broken")
      await writeFile(
        path.join(spec.root, "value-0000.js"),
        "export const value=100;\n",
      );
  }
  await assert.rejects(measure(spec), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ERR_ASSERTION");
    assert.match(
      (error as Error).message,
      kind === "stale"
        ? /Resource workload source changed/
        : /Resource workload validation did not pass/,
    );
    return true;
  });
  if (kind === "empty") await assert.rejects(lstat(marker), { code: "ENOENT" });
  else
    assert.equal(
      await readFile(marker, "utf8"),
      "Original reached resource assertion.",
    );
  await assert.rejects(lstat(path.join(spec.directory, "tasks")), {
    code: "ENOENT",
  });
}
export async function resourceFixedControl(t: TestContext) {
  const selected = await measurementTools(t),
    rows = [];
  const go = await execute("go", ["version"], {
    timeout: 10000,
    env: { ...process.env, GOTOOLCHAIN: "local" },
  });
  assert.match(go.stdout.trim(), /^go version go1\.27\.1 /);
  for (const id of ["small", "large", "polyglot"] as const)
    rows.push(await measure(await measuredFixture(t, id, selected)));
  assert.ok(rows[1].reportBytes > rows[0].reportBytes);
  assert.ok(rows[1].observedOutputBytes > rows[0].observedOutputBytes);
  assert.equal(rows[0].storage.archiveBytes, 0);
  assert.equal(rows[1].storage.archiveBytes, rows[1].reportBytes);
  assert.equal(rows[1].storage.reconstructedSha256, rows[1].reportSha256);
  assert.ok(rows[1].storage.archiveChunks > 1);
  assert.equal(rows[2].executedTests, 2);
}

const repository = fileURLToPath(new URL("../../", import.meta.url));
const packageTools = await import(
  new URL("install-acceptance-package.mjs", resourceScripts).href
);
const upgradeTools = await import(
  new URL("package-upgrade-readiness.mjs", resourceScripts).href
);
const engineEvidence = await import(
  new URL("compiled-engine-evidence.mjs", resourceScripts).href
);
const { createHash } = await import("node:crypto");
const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
async function candidateArchive(t: TestContext) {
  const selected = process.env.CHECKTRAIL_RESOURCE_CANDIDATE_ARCHIVE;
  if (selected) {
    assert.equal(path.isAbsolute(selected), true);
    assert.equal(await realpath(selected), selected);
    assert.equal(
      sha256(await readFile(selected)),
      process.env.CHECKTRAIL_RESOURCE_CANDIDATE_SHA256,
    );
    return selected;
  }
  const directory = await realpath(await fixture(t, {}));
  const [packed] = JSON.parse(
    packageTools.runAcceptanceNpm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
      { cwd: repository, encoding: "utf8", timeout: 60000 },
    ),
  );
  assert.ok(
    packed.files.some(
      (file: { path: string }) => file.path === "dist/src/index.js",
    ),
  );
  assert.ok(
    packed.files.some(
      (file: { path: string }) => file.path === "dist/src/cli.js",
    ),
  );
  assert.ok(
    packed.files.every(
      (file: { path: string }) =>
        !/^(?:test|scripts|reports|research_notes|\.checktrail)\//.test(
          file.path,
        ),
    ),
  );
  return path.join(directory, packed.filename);
}
export async function resourceNearMissControl(t: TestContext) {
  const original = await tools.observeReleaseTools();
  const {
    pin,
    manifest: legacyManifest,
    lock: legacyLock,
  } = await tools.releaseToolsInputs();
  const archive = await candidateArchive(t);
  const manifest = JSON.parse(
    await readFile(path.join(repository, "package.json"), "utf8"),
  );
  const baselineArchive = path.join(
    tools.releaseToolsDirectory,
    "baseline.tgz",
  );
  const baselineInstallation = {
    manifest: JSON.parse(legacyManifest),
    lock: JSON.parse(legacyLock),
  };
  baselineInstallation.manifest.dependencies["@stsepelin/checktrail"] =
    "file:" + baselineArchive;
  baselineInstallation.lock.packages[""].dependencies =
    baselineInstallation.manifest.dependencies;
  baselineInstallation.lock.packages[
    "node_modules/@stsepelin/checktrail"
  ].resolved = "file:" + baselineArchive;
  const candidateInstallation = packageTools.acceptanceConsumerLock(
    manifest,
    JSON.parse(
      await readFile(path.join(repository, "package-lock.json"), "utf8"),
    ),
    archive,
    "sha512-" +
      createHash("sha512")
        .update(await readFile(archive))
        .digest("base64"),
  );
  const result = await upgradeTools.verifyPackageUpgrade(
    baselineArchive,
    archive,
    {
      baselineIdentity: pin,
      candidateVersion: manifest.version,
      baselineInstallation,
      candidateInstallation,
    },
  );
  assert.equal(result.dependencySelection, "locked-production-inputs");
  assert.equal(
    result.stages[0].dependencyLockSha256,
    result.stages[2].dependencyLockSha256,
  );
  assert.notEqual(
    result.stages[0].dependencyLockSha256,
    result.stages[1].dependencyLockSha256,
  );
  assert.equal(result.installation, "offline");
  assert.equal(result.priorReportImport, "passed");
  assert.deepEqual(
    result.stages.map((stage: { phase: string }) => stage.phase),
    ["baseline", "upgrade", "rollback"],
  );
  for (const stage of result.stages) {
    const unavailable =
      process.platform === "win32" && stage.phase !== "upgrade";
    assert.equal(
      stage.version,
      stage.phase === "upgrade" ? manifest.version : pin.version,
    );
    assert.equal(
      stage.cli,
      unavailable ? "unavailable-in-older-release" : "passed",
    );
    assert.equal(
      stage.library,
      unavailable ? "unavailable-in-older-release" : "passed",
    );
    assert.equal(stage.executedBodies, unavailable ? 0 : 4);
    assert.equal(stage.mcp, "passed");
    assert.equal(stage.configuration, "unchanged");
  }
  assert.equal(result.inferenceInvoked, false);
  assert.equal(result.fieldEvaluationExecuted, false);
  assert.deepEqual(
    await tools.observeReleaseTools(tools.releaseToolsDirectory, original),
    original,
  );
}

import { createPlan, validate } from "../src/engine.js";
import { projectPlan, projectReport } from "../src/output.js";
import { createReviewContext, projectReviewContext } from "../src/review.js";
import { inventory } from "../src/inventory.js";
import { runProcess } from "../src/runner.js";
import {
  captureFixtureProcessGroup,
  cleanupFixtureProcessGroup,
  type FixtureProcessGroup,
} from "./helpers.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { setTimeout as delay } from "node:timers/promises";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
export async function resourcePrivacyControl(t: TestContext) {
  const owner = await realpath(await fixture(t, {})),
    marker = path.join(owner, "bodies.jsonl");
  const secret = "ORIGINAL_SYNTHETIC_RESOURCE_PRIVATE_PAYLOAD";
  const subject = `export const label=${JSON.stringify(secret)};\n`;
  const root = await realpath(
    await fixture(t, {
      "package.json": JSON.stringify({
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      }),
      "checktrail.json": JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["javascript.node-test"] }],
      }),
      "subject.js": subject,
      "quota.test.js": `import{test}from'node:test';import assert from'node:assert/strict';import{appendFileSync}from'node:fs';import{label}from'./subject.js';for(const n of [2,3])test('original quota '+n,()=>{appendFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,n})+String.fromCharCode(10));console.log(label);assert.equal(Array.from({length:n},()=>true).filter(Boolean).length,n);});\n`,
      ".checktrail/selection.json": JSON.stringify({
        schemaVersion: 1,
        files: ["subject.js"],
        topics: [],
      }),
    }),
  );
  const hidden = (value: unknown) => {
    const text = JSON.stringify(value);
    for (const privateValue of [
      root,
      owner,
      secret,
      "quota.test.js",
      "subject.js",
    ])
      assert.equal(
        text.includes(privateValue),
        false,
        "Summary disclosed a private resource value",
      );
  };
  const before = (await inventory(root)).fingerprint;
  const { plan } = await createPlan(root);
  hidden(projectPlan(plan, false));
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await assert.rejects(lstat(marker), { code: "ENOENT" });
  const report = await validate(root, { trusted: true });
  assert.equal(report.outcome, "passed");
  assert.deepEqual(report.checks[0]!.tests, {
    total: 2,
    passed: 2,
    failed: 0,
    skipped: 0,
  });
  hidden(projectReport(report, false));
  assert.equal(
    JSON.stringify(projectReport(report, true)).includes(secret),
    true,
  );
  const selection = { schemaVersion: 1, files: ["subject.js"], topics: [] };
  const context = await createReviewContext(root, selection);
  hidden(projectReviewContext(context, false));
  assert.equal(
    JSON.stringify(projectReviewContext(context, true)).includes(secret),
    true,
  );
  const bytes = async () => await readFile(marker, "utf8");
  const initial = await bytes();
  assert.equal(initial.trimEnd().split("\n").length, 2);
  for (const args of [
    ["plan"],
    ["run"],
    ["review-context", "--input", ".checktrail/selection.json", "--detailed"],
  ]) {
    if (args[0] === "run") {
      await assert.rejects(
        execute(process.execPath, [cli, ...args, "--root", root], {
          timeout: 30000,
        }),
        (error: unknown) => {
          assert.equal((error as { code: number }).code, 2);
          return true;
        },
      );
    } else {
      const result = await execute(
        process.execPath,
        [cli, ...args, "--root", root],
        { timeout: 30000 },
      );
      hidden(JSON.parse(result.stdout));
    }
  }
  await assert.rejects(
    execute(
      process.execPath,
      [
        cli,
        "review-context",
        "--root",
        root,
        "--input",
        ".checktrail/selection.json",
        "--allow-review-source",
      ],
      { timeout: 30000 },
    ),
    (error: unknown) => {
      assert.equal((error as { code: number }).code, 2);
      return true;
    },
  );
  const disclosed = await execute(
    process.execPath,
    [
      cli,
      "review-context",
      "--root",
      root,
      "--input",
      ".checktrail/selection.json",
      "--detailed",
      "--allow-review-source",
    ],
    { timeout: 30000 },
  );
  assert.equal(disclosed.stdout.includes(secret), true);
  for (const flags of [[], ["--detailed", "--allow-review-source"]]) {
    const client = new Client(
      { name: "original-resource-readiness", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [cli, "serve", "--root", root, ...flags],
          stderr: "pipe",
        }),
      );
      const planned = await client.callTool({
        name: "validation_plan",
        arguments: {},
      });
      assert.notEqual(planned.isError, true);
      if (!flags.length) hidden(planned);
      const selected = await client.callTool({
        name: "review_context",
        arguments: selection,
      });
      assert.notEqual(selected.isError, true);
      assert.equal(JSON.stringify(selected).includes(secret), flags.length > 0);
      if (!flags.length) hidden(selected);
      for (const arguments_ of [
        {},
        { trusted: true },
        { allowExecution: true },
      ]) {
        const denied = await client.callTool({
          name: "validation_run",
          arguments: arguments_,
        });
        assert.equal(denied.isError, true);
        hidden(denied);
      }
      const injected = await client.callTool({
        name: "review_context",
        arguments: { ...selection, allowReviewSource: true },
      });
      assert.equal(injected.isError, true);
    } finally {
      await client.close();
    }
  }
  assert.equal(
    await bytes(),
    initial,
    "Read-only CLI/MCP operations executed a project body",
  );
  const client = new Client(
    { name: "original-resource-execution", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "serve", "--root", root, "--allow-execution"],
        stderr: "pipe",
      }),
    );
    const run = await client.callTool({
      name: "validation_run",
      arguments: { timeoutMs: 30000 },
    });
    assert.notEqual(run.isError, true);
    hidden(run);
    const value = run.structuredContent as { outcome: string; runId: string };
    assert.equal(value.outcome, "passed");
    const retained = await client.callTool({
      name: "validation_report",
      arguments: { runId: value.runId },
    });
    assert.deepEqual(retained.structuredContent, run.structuredContent);
    hidden(retained);
  } finally {
    await client.close();
  }
  const final = await bytes();
  assert.equal(final.startsWith(initial), true);
  assert.equal(final.trimEnd().split("\n").length, 4);
  assert.equal((await inventory(root)).fingerprint, before);
}

async function reachedResourceFamily(file: string) {
  const until = performance.now() + 20000;
  while (performance.now() < until) {
    try {
      const rows = JSON.parse(await readFile(file, "utf8")) as {
        pid: number;
        parent: number;
      }[];
      assert.equal(rows.length, 3);
      assert.equal(new Set(rows.map((row) => row.pid)).size, 3);
      assert.ok(
        rows.every((row) => Number.isSafeInteger(row.pid) && row.pid > 1),
      );
      assert.equal(rows[1]!.parent, rows[0]!.pid);
      assert.equal(rows[2]!.parent, rows[1]!.pid);
      return rows;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError)
      )
        throw error;
    }
    await delay(20);
  }
  throw Error(
    "Original resource lifecycle family never reached its native bodies",
  );
}
export async function resourceLifecycleControl(t: TestContext) {
  for (const kind of ["cancel", "timeout", "output"] as const) {
    const root = await realpath(await fixture(t, {})),
      owner = await realpath(await fixture(t, {})),
      marker = path.join(owner, "family.json"),
      gate = path.join(owner, "release-output");
    const leaf =
      "process.send({pid:process.pid,parent:process.ppid});setInterval(()=>{},1000);";
    const middle = `const child=require('node:child_process').fork('-e',[${JSON.stringify(leaf)}],{execArgv:[],stdio:['ignore','inherit','inherit','ipc']});child.on('message',leaf=>process.send([{pid:process.pid,parent:process.ppid},leaf]));setInterval(()=>{},1000);`;
    const code = `const fs=require('node:fs'),child=require('node:child_process').fork('-e',[${JSON.stringify(middle)}],{execArgv:[],stdio:['ignore','inherit','inherit','ipc']});child.on('message',rows=>{fs.writeFileSync(${JSON.stringify(marker)}+'.part',JSON.stringify([{pid:process.pid,parent:process.ppid},...rows]));fs.renameSync(${JSON.stringify(marker)}+'.part',${JSON.stringify(marker)});});setInterval(()=>{if(${JSON.stringify(kind)}==='output'&&fs.existsSync(${JSON.stringify(gate)})){process.stdout.write('λ🚀'.repeat(65536));process.stderr.write('original resource output');}},20);`;
    const before = (await inventory(root)).fingerprint,
      controller = new AbortController();
    let group: FixtureProcessGroup | undefined;
    const running = runProcess(
      root,
      { executable: process.execPath, args: ["-e", code], cwd: "." },
      {
        timeoutMs: kind === "timeout" ? 15000 : 45000,
        maxOutputBytes: 4096,
        captureRawOutput: true,
        signal: controller.signal,
      },
    );
    // Observe rejection immediately; the finally block still awaits cleanup.
    void running.catch(() => {});
    try {
      const rows = await reachedResourceFamily(marker);
      if (process.platform !== "win32")
        group = await captureFixtureProcessGroup(rows[0]!.pid, rows[0]!.parent);
      if (kind === "cancel") controller.abort();
      if (kind === "output")
        await writeFile(gate, "Original output body reached.");
      const result = await running;
      assert.equal(result.errorCode, undefined, JSON.stringify(result));
      assert.equal(result.cancelled, kind === "cancel");
      assert.equal(result.timedOut, kind === "timeout");
      assert.equal(result.truncated, kind === "output");
      assert.notEqual(result.exitCode, 0);
      assert.equal(
        result.signal,
        process.platform === "win32" ? null : "SIGKILL",
      );
      if (kind === "output") {
        assert.ok(result.outputBytes! > 4096);
        assert.equal(result.capturedOutput!.completeForObservedStreams, false);
        assert.equal(
          result.capturedOutput!.stdout.bytes +
            result.capturedOutput!.stderr.bytes,
          4096,
        );
      }
      if (process.platform === "win32") {
        assert.equal(result.windowsExecution!.cleanup, "confirmed");
        assert.equal(result.windowsExecution!.activeAfterCleanup, 0);
        assert.equal(result.windowsExecution!.resources?.state, "collected");
        if (result.windowsExecution!.resources?.state === "collected")
          assert.ok(result.windowsExecution!.resources.totalJobProcesses >= 3);
      }
      for (const row of rows)
        assert.throws(
          () => process.kill(row.pid, 0),
          { code: "ESRCH" },
          "An owned resource lifecycle descendant survived completion",
        );
      assert.equal((await inventory(root)).fingerprint, before);
      assert.deepEqual(await readdir(root), []);
    } finally {
      controller.abort();
      try {
        await running;
      } finally {
        if (group) await cleanupFixtureProcessGroup(group);
      }
    }
  }
}

async function runResourceInstalledControls(t: TestContext, whole: boolean) {
  // A controller can invoke this same callback inside its already-fresh layout.
  if (process.env.CHECKTRAIL_RESOURCE_INSTALLED === "1") {
    await resourceRejectedControl(t, "broken");
    await resourceFixedControl(t);
    await resourceNearMissControl(t);
    return;
  }
  const root = await realpath(await fixture(t, {})),
    consumer = path.join(root, "consumer"),
    harness = path.join(root, "harness");
  const archive = await candidateArchive(t),
    archiveHash = sha256(await readFile(archive));
  const sourceEngine = await engineEvidence.captureCompiledEngine(
    path.join(repository, "dist/src"),
  );
  const installed = await packageTools.installAcceptancePackage(
    repository,
    archive,
    consumer,
  );
  assert.equal(installed.offlineProductionInstall, true);
  assert.equal(installed.lifecycleScriptsExecuted, false);
  const installedEngine = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail/dist/src",
  );
  engineEvidence.requireUnchangedCompiledEngine(
    sourceEngine,
    await engineEvidence.captureCompiledEngine(installedEngine),
  );
  await mkdir(path.join(harness, "dist/test"), { recursive: true });
  await symlink(
    installedEngine,
    path.join(harness, "dist/src"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await symlink(
    path.join(repository, "node_modules"),
    path.join(harness, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const { resourceReleaseHarnessFiles: files } = await import(
    new URL("resource-release-evidence.mjs", resourceScripts).href
  );
  const frozen = await Promise.all(
    files.map(async (file: string) => ({
      file,
      bytes: await readFile(path.join(repository, file)),
    })),
  );
  for (const input of frozen) {
    const dest = path.join(harness, input.file);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, input.bytes, { flag: "wx" });
  }
  const selected = path.join(harness, ".checktrail/release-readiness-tools");
  await mkdir(selected, { recursive: true, mode: 0o700 });
  if (process.platform === "win32")
    ensureWindowsTaskAccess(selected, "directory", true);
  await cp(tools.releaseToolsDirectory, selected, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CHECKTRAIL_RESOURCE_INSTALLED: "1",
    CHECKTRAIL_RESOURCE_CANDIDATE_ARCHIVE: archive,
    CHECKTRAIL_RESOURCE_CANDIDATE_SHA256: archiveHash,
  };
  delete env.NODE_TEST_CONTEXT;
  const kinds = whole
    ? [
        "broken",
        "fixed",
        "near-miss",
        "prerequisite",
        "stale",
        "empty",
        "privacy",
        "lifecycle",
        "installed",
      ]
    : ["broken", "fixed", "near-miss"];
  const requirements = kinds.map((kind) => ({
    file: path.join(
      harness,
      "dist/test/gate-resource-release-readiness.test.js",
    ),
    name: "resource-release-readiness " + kind + " acceptance",
  }));
  const code = `import{runRequiredTests}from ${JSON.stringify(new URL("required-test-evidence.mjs", pathToFileURL(path.join(harness, "scripts/")).href).href)};const result=await runRequiredTests(${JSON.stringify(requirements)},{timeoutMs:600000,isolatedCaseWorkers:1});process.stdout.write(JSON.stringify(result));process.exitCode=result.complete?0:1;`;
  const controller = path.join(harness, "resource-required-controller.mjs");
  await writeFile(controller, code, { flag: "wx", mode: 0o600 });
  const result = await execute(process.execPath, [controller], {
    cwd: harness,
    env,
    timeout: 600000,
    maxBuffer: 4 * 1048576,
  }).then(
    (result) => ({ ...result, code: 0 }),
    (error: unknown) => {
      const failure = error as {
        code: unknown;
        signal: unknown;
        stdout: unknown;
      };
      if (
        typeof failure.code !== "number" ||
        failure.signal ||
        typeof failure.stdout !== "string"
      )
        throw error;
      return { code: failure.code, stdout: failure.stdout };
    },
  );
  assert.equal(await readFile(controller, "utf8"), code);
  const profile = JSON.parse(result.stdout);
  assert.equal(
    result.code,
    0,
    "Fresh resource callbacks failed: " + JSON.stringify(profile.problems),
  );
  assert.equal(profile.complete, true, JSON.stringify(profile.problems));
  assert.equal(profile.required, kinds.length);
  assert.equal(profile.passed, kinds.length);
  assert.equal(profile.ledger.truncated, false);
  assert.equal(profile.ledger.cases.length, kinds.length);
  assert.ok(
    profile.ledger.cases.every(
      (entry: { outcome: string }) => entry.outcome === "passed",
    ),
  );
  engineEvidence.requireUnchangedCompiledEngine(
    sourceEngine,
    await engineEvidence.captureCompiledEngine(installedEngine),
  );
  assert.equal(sha256(await readFile(archive)), archiveHash);
  for (const input of frozen) {
    assert.deepEqual(
      await readFile(path.join(repository, input.file)),
      input.bytes,
    );
    assert.deepEqual(
      await readFile(path.join(harness, input.file)),
      input.bytes,
    );
  }
  return {
    profile,
    tarballSha256: archiveHash,
    offlineProductionInstall: installed.offlineProductionInstall,
    lifecycleScriptsExecuted: installed.lifecycleScriptsExecuted,
    compiledEngineSha256: sourceEngine.treeSha256,
    harnessOutsideInstalledPackage: true,
    harnessSha256: sha256(
      JSON.stringify(
        frozen.map((input: { file: string; bytes: Uint8Array }) => [
          input.file,
          sha256(input.bytes),
        ]),
      ),
    ),
  };
}
export async function resourceInstalledControl(t: TestContext) {
  await runResourceInstalledControls(t, false);
}
export async function resourceWholeInstalled(t: TestContext) {
  return await runResourceInstalledControls(t, true);
}
