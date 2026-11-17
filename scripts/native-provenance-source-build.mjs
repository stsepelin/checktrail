// Finite current-source derivation witness. This is not upstream compiler closure.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { Buffer } from "node:buffer";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const keys = [
  "schemaVersion",
  "fileCount",
  "bytes",
  "treeSha256",
  "manifestSha256",
];
const summary = (tree) =>
  Object.fromEntries(keys.map((key) => [key, tree[key]]));
const compilerFiles = ["package.json", "bin/tsc", "lib/tsc.js", "lib/_tsc.js"];
export const provenanceBuildCommand = Object.freeze([
  "node",
  "node_modules/typescript/bin/tsc",
  "--project",
  "tsconfig.json",
  "--outDir",
  "<fresh-temporary-output>",
]);
async function fileBytes(file, maximum = 32 * 1048576) {
  const before = await lstat(file, { bigint: true });
  assert.ok(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.size > 0n &&
      before.size <= BigInt(maximum),
    "Bounded source-build input required",
  );
  const handle = await open(
    file,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  const same = (a, b) =>
    ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((k) => a[k] === b[k]);
  try {
    const opened = await handle.stat({ bigint: true });
    assert.ok(same(before, opened));
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const r = await handle.read(bytes, count, bytes.length - count, null);
      if (!r.bytesRead) break;
      count += r.bytesRead;
    }
    assert.equal(BigInt(count), opened.size);
    assert.ok(
      same(opened, await handle.stat({ bigint: true })) &&
        same(opened, await lstat(file, { bigint: true })),
      "Source-build input changed while capturing",
    );
    return bytes.subarray(0, count);
  } finally {
    await handle.close();
  }
}
export async function captureProvenanceBuildInputs(repository) {
  const config = await fileBytes(path.join(repository, "tsconfig.json")),
    manifest = await fileBytes(path.join(repository, "package.json")),
    lock = await fileBytes(path.join(repository, "package-lock.json"));
  const parsed = JSON.parse(config),
    pkg = JSON.parse(manifest),
    locked = JSON.parse(lock);
  assert.equal(
    pkg.scripts.build,
    "tsc",
    "Only the first-party literal TypeScript build is selected",
  );
  assert.deepEqual(parsed.include, ["src/**/*.ts", "test/**/*.ts"]);
  assert.equal(parsed.compilerOptions.rootDir, ".");
  assert.equal(parsed.compilerOptions.outDir, "dist");
  assert.ok(
    !Object.hasOwn(parsed, "extends") && !Object.hasOwn(parsed, "references"),
    "Unselected external TypeScript config refused",
  );
  const compilerRoot = await realpath(
    path.join(repository, "node_modules/typescript"),
  );
  const compiler = [];
  for (const file of compilerFiles) {
    const body = await fileBytes(path.join(compilerRoot, file));
    compiler.push({ file, bytes: body.length, sha256: hash(body) });
    if (file === "package.json") {
      const version = JSON.parse(body).version;
      const declared = [
        pkg.dependencies?.typescript,
        pkg.devDependencies?.typescript,
      ].filter((value) => value !== undefined);
      assert.equal(declared.length, 1);
      assert.equal(version, declared[0]);
      assert.equal(version, locked.packages["node_modules/typescript"].version);
    }
  }
  return {
    schemaVersion: 1,
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      nodeExecutableSha256: hash(
        await fileBytes(await realpath(process.execPath), 256 * 1048576),
      ),
    },
    configuration: [
      { file: "tsconfig.json", bytes: config.length, sha256: hash(config) },
      { file: "package.json", bytes: manifest.length, sha256: hash(manifest) },
      { file: "package-lock.json", bytes: lock.length, sha256: hash(lock) },
    ],
    source: summary(await captureCompiledEngine(path.join(repository, "src"))),
    tests: summary(await captureCompiledEngine(path.join(repository, "test"))),
    compiler,
    compilerDependencyClosureVerified: false,
  };
}
export async function observeProvenanceSourceBuild(repository, sourceBinding) {
  const inputs = await captureProvenanceBuildInputs(repository),
    temporary = await realpath(
      await mkdtemp(
        path.join(os.tmpdir(), "checktrail-provenance-source-build-"),
      ),
    );
  try {
    const compiler = await realpath(
      path.join(repository, "node_modules/typescript/bin/tsc"),
    );
    execFileSync(
      process.execPath,
      [
        compiler,
        "--project",
        path.join(repository, "tsconfig.json"),
        "--outDir",
        temporary,
      ],
      {
        cwd: repository,
        timeout: 120000,
        maxBuffer: 2 * 1048576,
        env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.deepEqual(
      await captureProvenanceBuildInputs(repository),
      inputs,
      "Source/compiler/config changed during first-party build",
    );
    const freshEngine = await captureCompiledEngine(
        path.join(temporary, "src"),
      ),
      freshTests = await captureCompiledEngine(path.join(temporary, "test"));
    const currentEngine = await captureCompiledEngine(
        path.join(repository, "dist/src"),
      ),
      currentTests = await captureCompiledEngine(
        path.join(repository, "dist/test"),
      );
    try {
      requireUnchangedCompiledEngine(currentEngine, freshEngine);
      requireUnchangedCompiledEngine(currentTests, freshTests);
    } catch {
      throw new Error(
        "Current compiled engine or test artifacts are stale relative to the observed fresh source build",
      );
    }
    return {
      schemaVersion: 1,
      state: "current-source-typescript-build-reconciled",
      command: provenanceBuildCommand,
      sourceBinding,
      inputs,
      compilerExitCode: 0,
      compilerSignal: null,
      currentArtifactsMatchFreshBuild: true,
      engine: summary(freshEngine),
      tests: summary(freshTests),
      compiledTests: freshTests.files.map((row) => ({
        ...row,
        file: "dist/test/" + row.file,
      })),
      sourceInputSha256: hash(JSON.stringify(inputs)),
      compilerDependencyClosureVerified: false,
      upstreamProducerClosureVerified: false,
    };
  } finally {
    await rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 30 : 0,
      retryDelay: 100,
    });
  }
}
export function requireProvenanceSourceBuild(
  witness,
  { sourceBinding, compiledEngine, inputSources, runtime },
) {
  assert.equal(witness.schemaVersion, 1);
  assert.equal(witness.state, "current-source-typescript-build-reconciled");
  assert.deepEqual(witness.command, provenanceBuildCommand);
  assert.deepEqual(witness.sourceBinding, sourceBinding);
  assert.equal(witness.compilerExitCode, 0);
  assert.equal(witness.compilerSignal, null);
  assert.equal(witness.currentArtifactsMatchFreshBuild, true);
  assert.deepEqual(
    witness.inputs.configuration.map((row) => row.file),
    ["tsconfig.json", "package.json", "package-lock.json"],
  );
  assert.deepEqual(
    witness.inputs.compiler.map((row) => row.file),
    compilerFiles,
  );
  for (const row of [
    ...witness.inputs.configuration,
    ...witness.inputs.compiler,
  ]) {
    assert.ok(Number.isSafeInteger(row.bytes) && row.bytes > 0);
    assert.match(row.sha256, /^[a-f0-9]{64}$/u);
  }
  for (const tree of [witness.inputs.source, witness.inputs.tests]) {
    assert.equal(tree.schemaVersion, 1);
    assert.ok(tree.fileCount > 0 && tree.bytes > 0);
    assert.match(tree.treeSha256, /^[a-f0-9]{64}$/u);
    assert.match(tree.manifestSha256, /^[a-f0-9]{64}$/u);
  }
  for (const key of [
    "node",
    "platform",
    "architecture",
    "nodeExecutableSha256",
  ])
    assert.equal(
      witness.inputs.runtime[key],
      runtime[key],
      "Source-build runtime differs",
    );
  assert.equal(witness.sourceInputSha256, hash(JSON.stringify(witness.inputs)));
  assert.equal(witness.inputs.compilerDependencyClosureVerified, false);
  assert.equal(witness.compilerDependencyClosureVerified, false);
  assert.equal(witness.upstreamProducerClosureVerified, false);
  for (const key of keys)
    assert.equal(
      witness.engine[key],
      compiledEngine[key],
      "Source-build engine binding differs",
    );
  assert.ok(witness.tests.fileCount > 0 && witness.tests.bytes > 0);
  assert.equal(witness.compiledTests.length, witness.tests.fileCount);
  assert.equal(
    new Set(witness.compiledTests.map((row) => row.file)).size,
    witness.compiledTests.length,
  );
  assert.equal(
    witness.tests.treeSha256,
    hash(
      JSON.stringify(
        witness.compiledTests.map((row) => [
          row.file.slice("dist/test/".length),
          row.sha256,
        ]),
      ),
    ),
  );
  assert.equal(
    witness.tests.manifestSha256,
    hash(
      JSON.stringify(
        witness.compiledTests.map((row) => ({
          file: row.file.slice("dist/test/".length),
          bytes: row.bytes,
          sha256: row.sha256,
        })),
      ),
    ),
  );
  for (const input of inputSources.filter((row) =>
    row.file.startsWith("dist/test/"),
  )) {
    const emitted = witness.compiledTests.find(
      (row) => row.file === input.file,
    );
    assert.deepEqual(
      emitted,
      input,
      "Acceptance harness differs from observed fresh source build",
    );
  }
  return witness;
}
