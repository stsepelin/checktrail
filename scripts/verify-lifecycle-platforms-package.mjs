import process from "node:process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { lifecycleHarnessFiles } from "./lifecycle-runtime-evidence.mjs";
import { copyInstalledPackages } from "../dist/test/tool-fixture.js";
assert.ok(process.argv.length === 2 || process.argv.length === 3);
const slot =
  process.argv[2] ?? process.env.CHECKTRAIL_LIFECYCLE_RUNTIME_SLOT ?? null;
if (slot !== null) {
  assert.ok(
    !process.env.CHECKTRAIL_LIFECYCLE_RUNTIME_SLOT ||
      process.env.CHECKTRAIL_LIFECYCLE_RUNTIME_SLOT === slot,
    "Conflicting lifecycle runtime selection",
  );
  process.env.CHECKTRAIL_LIFECYCLE_RUNTIME_SLOT = slot;
}
const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = lifecycleHarnessFiles;
const inputs = await Promise.all(
  files.map(async (file) => ({
    file,
    bytes: await readFile(path.join(root, file)),
  })),
);
const harnessSha256 = hash(
  JSON.stringify(inputs.map((item) => [item.file, hash(item.bytes)])),
);
const source = await captureCompiledEngine(path.join(root, "dist/src"));
const temporary = await realpath(
  await mkdtemp(path.join(tmpdir(), "checktrail-lifecycle-install-")),
);
try {
  const [packed] = JSON.parse(
    runAcceptanceNpm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: root, encoding: "utf8" },
    ),
  );
  const tarball = path.join(temporary, packed.filename),
    consumer = path.join(temporary, "consumer"),
    harness = path.join(temporary, "harness");
  const installation = await installAcceptancePackage(root, tarball, consumer);
  const installed = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail/dist/src",
  );
  const installedBefore = await captureCompiledEngine(installed);
  requireUnchangedCompiledEngine(source, installedBefore);
  await mkdir(path.join(harness, "dist/test"), { recursive: true });
  await symlink(
    process.platform === "win32"
      ? installed
      : path.relative(path.join(harness, "dist"), installed),
    path.join(harness, "dist/src"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const input of inputs) {
    const target = path.join(harness, input.file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.bytes, { flag: "wx" });
  }
  const lock = JSON.parse(
      await readFile(path.join(root, "package-lock.json"), "utf8"),
    ),
    externalSdkClientDependencies = {};
  await copyInstalledPackages(
    harness,
    ["@modelcontextprotocol/client"],
    path.join(root, "node_modules"),
    ({ relative, version }) => {
      const location = relative.split(path.sep).join("/");
      assert.equal(version, lock.packages["node_modules/" + location].version);
      externalSdkClientDependencies[location] = version;
    },
  );
  const env = { ...process.env, CHECKTRAIL_LIFECYCLE_INSTALLED: "1" };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["scripts/verify-lifecycle-platforms.mjs"],
    {
      cwd: harness,
      env,
      encoding: "utf8",
      timeout: process.platform === "win32" ? 580000 : 280000,
      maxBuffer: 4 * 1048576,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, (result.stdout + result.stderr).slice(-6000));
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.required, 9);
  assert.equal(evidence.passed, 9);
  assert.equal(evidence.installed, true);
  assert.equal(evidence.runtime.slot, slot);
  assert.equal(evidence.selectedRuntime?.id ?? null, slot);
  assert.equal(evidence.harnessSha256, harnessSha256);
  assert.equal(evidence.harnessInputsUnchanged, true);
  assert.equal(evidence.ledger.truncated, false);
  assert.equal(evidence.ledger.cases.length, 9);
  assert.ok(evidence.ledger.cases.every((item) => item.outcome === "passed"));
  requireUnchangedCompiledEngine(
    installedBefore,
    await captureCompiledEngine(installed),
  );
  requireUnchangedCompiledEngine(
    source,
    await captureCompiledEngine(path.join(root, "dist/src")),
  );
  assert.deepEqual(
    await Promise.all(
      files.map(async (file) => [
        file,
        hash(await readFile(path.join(root, file))),
      ]),
    ),
    inputs.map((item) => [item.file, hash(item.bytes)]),
  );
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      profile: "lifecycle-platforms-installed-v1",
      tarballSha256: hash(await readFile(tarball)),
      harnessSha256,
      ...installation,
      compiledEngine: source,
      harnessOutsideInstalledPackage: true,
      externalSdkClientDependencies,
      installedRuntimeEvaluated: true,
      installedCliEvaluated: true,
      installedMcpEvaluated: true,
      evidence,
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
      gateAComplete: false,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
