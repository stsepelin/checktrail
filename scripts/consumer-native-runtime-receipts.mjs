import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, lstat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ensureWindowsTaskAccess } from "../dist/src/windows-task-access.js";
import {
  requireConsumerPrivateDirectory,
  readConsumerPrivateFile,
  writeConsumerPrivateFile,
} from "./consumer-native-host-storage.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const maximum = 32 * 1048576;

/** Copy already reconciled controller bytes, never log text or reserialized JSON. */
export async function retainConsumerRuntimeReceipt(
  directory,
  capsule,
  entry,
  stdout,
  stderr,
) {
  await requireConsumerPrivateDirectory(directory);
  assert.equal(capsule.profile, "native-consumer-scope-capsule-v1");
  assert.equal(capsule.scope.acceptanceProfile, "consumer-impact");
  assert.match(capsule.scope.id, /^consumer-impact:[a-z0-9-]+$/);
  assert.match(
    capsule.attemptId,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  const { capsuleSha256, ...body } = capsule;
  assert.equal(hash(Buffer.from(JSON.stringify(body))), capsuleSha256);
  assert.equal(capsule.scopeComplete, true);
  assert.equal(capsule.controller.moduleCompleted, true);
  assert.equal(capsule.controller.processExitObserved, false);
  assert.equal(capsule.controller.requiresSuccessfulOuterJob, true);
  assert.equal(entry.complete, true);
  assert.equal(entry.truncated, false);
  assert.ok(Buffer.isBuffer(stdout) && Buffer.isBuffer(stderr));
  assert.ok(stdout.length > 0 && stdout.length + stderr.length <= maximum);
  const streams = {};
  for (const [name, bytes] of [
    ["stdout", stdout],
    ["stderr", stderr],
  ]) {
    assert.equal(entry[name].bytes, bytes.length);
    assert.equal(entry[name].observedBytes, bytes.length);
    assert.equal(entry[name].sha256, hash(bytes));
    assert.equal(capsule.controller[name + "Bytes"], bytes.length);
    assert.equal(capsule.controller[name + "Sha256"], hash(bytes));
    streams[name] = {
      file: "controller." + name,
      bytes: bytes.length,
      sha256: hash(bytes),
    };
  }
  assert.match(capsule.source.commit, /^[a-f0-9]{40}$/);
  assert.match(capsule.source.gitTree, /^[a-f0-9]{40}$/);
  for (const key of [
    "gateAComplete",
    "hostAttestationPerformed",
    "wholeUpstreamClosureVerified",
    "inferenceInvoked",
    "fieldEvaluationExecuted",
  ])
    assert.equal(capsule[key], false);
  const bundleName =
    capsule.scope.id.replace(":", "--") + "--" + capsule.attemptId;
  const bundle = path.join(directory, bundleName);
  await assert.rejects(lstat(bundle), { code: "ENOENT" });
  const manifest = {
    schemaVersion: 1,
    profile: "native-consumer-runtime-receipt-bytes-v1",
    scopeId: capsule.scope.id,
    attemptId: capsule.attemptId,
    ci: { runId: capsule.ci.runId, runAttempt: capsule.ci.runAttempt },
    source: { commit: capsule.source.commit, gitTree: capsule.source.gitTree },
    capsuleSha256,
    streams,
    controllerModuleCompleted: true,
    processExitObserved: false,
    requiresSuccessfulOuterJob: true,
    hostAttestationPerformed: false,
    gateAComplete: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  };
  // Exclusive directory creation refuses a duplicate; receipt.json commits only a fully verified pair.
  await mkdir(bundle, { mode: 0o700 });
  if (process.platform === "win32")
    ensureWindowsTaskAccess(bundle, "directory", true);
  await requireConsumerPrivateDirectory(bundle);
  for (const [name, bytes] of [
    ["stdout", stdout],
    ["stderr", stderr],
  ]) {
    const filename = path.join(bundle, streams[name].file);
    await writeConsumerPrivateFile(filename, bytes);
    const copied = await readConsumerPrivateFile(filename, maximum);
    assert.equal(copied.bytes.length, streams[name].bytes);
    assert.equal(copied.sha256, streams[name].sha256);
  }
  await writeConsumerPrivateFile(
    path.join(bundle, "receipt.json"),
    Buffer.from(JSON.stringify(manifest) + "\n"),
  );
  return { directory: bundleName, ...manifest };
}
