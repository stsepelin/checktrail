// Built-in metadata only: the early job marker does not load project code, dependencies or native controllers.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
const hash = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  sha = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
  positive = (value) =>
    typeof value === "string" && /^[1-9][0-9]{0,20}$/.test(value),
  attempt = (value) =>
    typeof value === "string" && /^[1-9][0-9]{0,8}$/.test(value),
  uuid = (value) =>
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    );
const singleJobs = Object.freeze([
    "go-workspaces-arm64",
    "javascript-extensions-arm64",
    "cpp-extensions-arm64",
    "tasks-runtime-arm64",
    "php-context-arm64",
    "rust-context-arm64",
    "ruby-context-arm64",
    "c-context-arm64",
    "cpp-context-arm64",
    "java-context-arm64",
    "kotlin-context-arm64",
    "scala-context-arm64",
    "csharp-context-arm64",
    "fsharp-context-arm64",
    "vb-context-arm64",
    "hcl-context-arm64",
    "yaml-context-arm64",
    "swift-context-arm64",
  ]),
  hostLanes = Object.freeze([
    "ci-linux-node22",
    "ci-linux-node24",
    "ci-linux-node26",
    "ci-macos-node22",
    "ci-macos-node24",
    "ci-macos-node26",
    "windows-node22",
  ]);
const keys = (value, expected) =>
  assert.deepEqual(Object.keys(value).sort(), expected.toSorted());
export function consumerNativeJobLanes(job) {
  if (job === "tasks-runtime") return [...hostLanes];
  assert.ok(singleJobs.includes(job), "Unknown native consumer job");
  return ["single"];
}
export function consumerNativeJobOutputKeys(job, lane) {
  assert.ok(
    consumerNativeJobLanes(job).includes(lane),
    "Unknown native consumer job lane",
  );
  const key = lane.replaceAll("-", "_");
  return { start: "native_start_" + key, finish: "native_finish_" + key };
}
export function consumerNativeArtifactName(job, lane, producerAttempt) {
  consumerNativeJobOutputKeys(job, lane);
  assert.ok(attempt(producerAttempt));
  return "native-consumer-" + job + "-" + lane + "-" + producerAttempt;
}
function producer(start) {
  return Object.fromEntries(
    ["runId", "runAttempt", "sourceCommit", "job", "lane", "nonce"].map(
      (key) => [key, start[key]],
    ),
  );
}
function requireStart(start) {
  keys(start, [
    "schemaVersion",
    "profile",
    "runId",
    "runAttempt",
    "sourceCommit",
    "job",
    "lane",
    "nonce",
    "metadataAttested",
    "nativeExecutionInvoked",
    "gateAComplete",
  ]);
  assert.equal(start.schemaVersion, 1);
  assert.equal(start.profile, "native-consumer-job-start-v1");
  assert.ok(
    positive(start.runId) && attempt(start.runAttempt) && uuid(start.nonce),
  );
  assert.match(start.sourceCommit, /^[a-f0-9]{40}$/);
  consumerNativeJobOutputKeys(start.job, start.lane);
  for (const key of [
    "metadataAttested",
    "nativeExecutionInvoked",
    "gateAComplete",
  ])
    assert.equal(start[key], false);
  return start;
}
export function createConsumerNativeJobStart(environment, lane) {
  assert.equal(
    environment.GITHUB_ACTIONS,
    "true",
    "Native job outputs require their actual workflow metadata",
  );
  return requireStart({
    schemaVersion: 1,
    profile: "native-consumer-job-start-v1",
    runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
    sourceCommit: environment.GITHUB_SHA,
    job: environment.GITHUB_JOB,
    lane,
    nonce: randomUUID(),
    metadataAttested: false,
    nativeExecutionInvoked: false,
    gateAComplete: false,
  });
}
export function createConsumerNativeJobFinish(
  start,
  source,
  capsules,
  artifact,
) {
  requireStart(start);
  assert.equal(source.commit, start.sourceCommit);
  assert.ok(
    Array.isArray(capsules) && capsules.length > 0 && capsules.length <= 2,
  );
  for (const capsule of capsules) {
    assert.deepEqual(capsule.source, source);
    assert.equal(capsule.ci.runId, start.runId);
    assert.equal(capsule.ci.runAttempt, start.runAttempt);
    assert.equal(capsule.ci.job, start.job);
    assert.equal(capsule.ci.metadataAttested, false);
  }
  return {
    schemaVersion: 1,
    profile: "native-consumer-job-finish-v1",
    producer: producer(start),
    startSha256: hash(start),
    sourceFrameSha256: hash(source),
    artifact: { ...artifact },
    capsules: capsules
      .map((row) => ({
        scopeId: row.scope.id,
        sha256: row.capsuleSha256,
        attemptId: row.attemptId,
      }))
      .sort((a, b) => a.scopeId.localeCompare(b.scopeId)),
    metadataAttested: false,
    gateAComplete: false,
  };
}
/** A retained successful job may precede the aggregate attempt; its exact current platform START/FINISH pair chooses the immutable artifact. */
export function requireConsumerNativeProducerClaims(
  start,
  finish,
  { ci, source, job, lane, scopes },
) {
  requireStart(start);
  assert.equal(start.runId, ci.runId);
  assert.equal(start.sourceCommit, source.commit);
  assert.equal(start.job, job);
  assert.equal(start.lane, lane);
  assert.ok(
    attempt(ci.runAttempt) && Number(start.runAttempt) <= Number(ci.runAttempt),
    "Native producer execution attempt is invalid or future",
  );
  keys(finish, [
    "schemaVersion",
    "profile",
    "producer",
    "startSha256",
    "sourceFrameSha256",
    "artifact",
    "capsules",
    "metadataAttested",
    "gateAComplete",
  ]);
  assert.equal(finish.schemaVersion, 1);
  assert.equal(finish.profile, "native-consumer-job-finish-v1");
  assert.deepEqual(
    finish.producer,
    producer(start),
    "Native job FINISH does not match its retained START",
  );
  assert.equal(
    finish.startSha256,
    hash(start),
    "Native job FINISH belongs to another start nonce",
  );
  assert.equal(
    finish.sourceFrameSha256,
    hash(source),
    "Native job artifact belongs to another source frame",
  );
  assert.equal(finish.metadataAttested, false);
  assert.equal(finish.gateAComplete, false);
  keys(finish.artifact, ["id", "name", "digest"]);
  assert.ok(positive(finish.artifact.id));
  assert.equal(
    finish.artifact.name,
    consumerNativeArtifactName(job, lane, start.runAttempt),
  );
  assert.ok(sha(finish.artifact.digest));
  assert.ok(
    Array.isArray(finish.capsules) &&
      finish.capsules.length === scopes.length &&
      scopes.length > 0 &&
      scopes.length <= 2,
  );
  assert.deepEqual(
    finish.capsules.map((row) => row.scopeId).sort(),
    scopes.map((row) => row.id).sort(),
  );
  const attempts = new Set();
  for (const row of finish.capsules) {
    keys(row, ["scopeId", "sha256", "attemptId"]);
    assert.ok(sha(row.sha256) && uuid(row.attemptId));
    assert.equal(attempts.has(row.attemptId), false);
    attempts.add(row.attemptId);
  }
  return { start, finish };
}
export async function writeConsumerNativeJobOutput(
  stage,
  value,
  environment = process.env,
) {
  assert.ok(["start", "finish"].includes(stage));
  const context = stage === "start" ? value : value.producer,
    names = consumerNativeJobOutputKeys(context.job, context.lane),
    raw = JSON.stringify(value);
  assert.ok(Buffer.byteLength(raw) <= 16384 && !/[\r\n]/.test(raw));
  assert.ok(
    environment.GITHUB_OUTPUT && path.isAbsolute(environment.GITHUB_OUTPUT),
  );
  await appendFile(
    environment.GITHUB_OUTPUT,
    "claim=" + raw + "\n" + names[stage] + "=" + raw + "\n",
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.equal(
    process.argv.length,
    4,
    "Usage: consumer-native-job-claims.mjs start LANE",
  );
  assert.equal(process.argv[2], "start");
  const value = createConsumerNativeJobStart(process.env, process.argv[3]);
  await writeConsumerNativeJobOutput("start", value);
  process.stdout.write(
    JSON.stringify({
      job: value.job,
      lane: value.lane,
      marker: "native-consumer-job-start",
      nativeExecutionInvoked: false,
      metadataAttested: false,
      gateAComplete: false,
    }) + "\n",
  );
}
