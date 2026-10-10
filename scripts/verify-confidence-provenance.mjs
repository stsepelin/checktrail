import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  started = performance.now(),
  hash = (b) => createHash("sha256").update(b).digest("hex"),
  run = (args, env = {}) =>
    execFileSync(process.execPath, args, {
      cwd: repository,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 8 * 1048576,
    }),
  stage = (name) =>
    process.stderr.write(JSON.stringify({ stage: name }) + "\n"),
  requirements = JSON.parse(
    await readFile(
      path.join(repository, "scripts/required-native-tests.json"),
      "utf8",
    ),
  ),
  temporary = await mkdtemp(
    path.join(tmpdir(), "checktrail-confidence-controller-"),
  );
try {
  const executable = await readFile(process.execPath);
  const os = execFileSync("uname", ["-sr"], { encoding: "utf8" }).trim();
  const runtime = {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    nodeBytes: executable.length,
    nodeSha256: hash(executable),
    os,
  };
  stage("preserved-review-probe-and-descriptive-scoring");
  const profiles = ["review", "review-probe", "review-scoring"],
    baseline = JSON.parse(
      run(["scripts/verify-required-native-tests.mjs", ...profiles]),
    );
  assert.equal(
    baseline.required,
    profiles.reduce((n, p) => n + requirements[p].length, 0),
  );
  assert.equal(baseline.ledger.cases.length, baseline.required);
  assert.ok(
    baseline.ledger.cases.every(
      (c) => c.outcome === "passed" && c.terminalSequences.length === 1,
    ),
  );
  assert.equal(baseline.complete, true);
  stage("source-and-fresh-offline-production-installation");
  const receipt = path.join(temporary, "installed.json"),
    source = JSON.parse(
      run(
        ["scripts/verify-required-native-tests.mjs", "confidence-provenance"],
        { CHECKTRAIL_CONFIDENCE_PROVENANCE_INSTALL_RECEIPT: receipt },
      ),
    ),
    installed = JSON.parse(await readFile(receipt, "utf8"));
  assert.equal(source.required, 9);
  assert.equal(source.passed, 9);
  assert.equal(source.complete, true);
  assert.equal(installed.profile.required, 9);
  assert.equal(installed.profile.passed, 9);
  assert.equal(installed.profile.complete, true);
  assert.equal(installed.offlineProductionInstall, true);
  assert.equal(installed.lifecycleScriptsExecuted, false);
  stage("compiling-guard-removals-with-unchanged-callbacks");
  const copy = path.join(temporary, "guards");
  await mkdir(path.join(copy, "scripts"), { recursive: true });
  await cp(path.join(repository, "dist"), path.join(copy, "dist"), {
    recursive: true,
  });
  await cp(
    path.join(repository, "package.json"),
    path.join(copy, "package.json"),
  );
  await cp(
    path.join(repository, "scripts/verify-confidence-provenance-guards.mjs"),
    path.join(copy, "scripts/verify-confidence-provenance-guards.mjs"),
  );
  await symlink(
    path.join(repository, "node_modules"),
    path.join(copy, "node_modules"),
  );
  const guards = JSON.parse(
    execFileSync(
      process.execPath,
      ["scripts/verify-confidence-provenance-guards.mjs"],
      {
        cwd: copy,
        env: { ...process.env },
        encoding: "utf8",
        timeout: 180000,
        maxBuffer: 8 * 1048576,
      },
    ),
  );
  assert.equal(guards.controls.length, 14);
  assert.equal(guards.allComplete, true);
  assert.equal(guards.sourceRestored, true);
  assert.equal(guards.callbacksUnchanged, true);
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      profile: "confidence-provenance",
      runtime,
      environment: {
        execution: "managed-host",
        projectNetworkInvoked: false,
        containerIsolation: false,
      },
      baseline,
      source,
      installed,
      guards,
      durationMs: Math.round(performance.now() - started),
      nativeProbesExecuted: true,
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
      qualityAssessed: false,
      gateAComplete: false,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
