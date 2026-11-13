// Development CI only. START imports built-ins and metadata readers, never SDK/project code.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const { AbortSignal } = globalThis;
import {
  dotnetGeneratorShardIds,
  selectGeneratorShard,
  loadGeneratorShards,
  validateGeneratorJobContext,
  validateGeneratorShardFragment,
  aggregateGeneratorShardFragments,
  captureGeneratorShardHarness,
  captureGeneratorMutationSources,
} from "./dotnet-generator-shards.mjs";
import {
  captureConsumerNativeSourceFrame,
  requireConsumerNativeSourceFrame,
  validateConsumerNativeSourceFrame,
} from "./consumer-native-acceptance-frame.mjs";

import {
  requireNativeCIArtifactDirectory,
  readNativeCIArtifact,
  requireNativeCIPrivateDirectory,
  readNativeCIPrivateFile,
  writeNativeCIPrivateFile,
} from "./native-ci-artifact-storage.mjs";

export const generatorCIJob = "dotnet-generator-extensions-arm64";
// These exact deferred dependencies stay visible to the reviewed input graph.
// START does not import them before dependencies and the compiled engine exist.
const deferredModules = Object.freeze({
  controller: "scripts/verify-dotnet-generator-extensions-container.mjs",
});
const MAX_BYTES = 1048576,
  PAGE_SIZE = 20,
  MAX_JOBS = 200;
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exact = (value, fields, message) => {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    message,
  );
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort(), message);
};
const positive = (value) =>
  typeof value === "string" && /^[1-9]\d{0,19}$/u.test(value);
const numeric = (value) => Number.isSafeInteger(value) && value > 0;
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const canonical = (value) => {
  const raw = JSON.stringify(value);
  assert.ok(
    Buffer.byteLength(raw) > 0 && Buffer.byteLength(raw) <= MAX_BYTES,
    "Generator CI receipt exceeds transport bound",
  );
  return raw;
};
export function generatorCIOutputKeys(id) {
  assert.ok(dotnetGeneratorShardIds.includes(id), "Unknown generator CI shard");
  return { start: "dotnet_start_" + id, finish: "dotnet_finish_" + id };
}
export function generatorCIJobName(id) {
  generatorCIOutputKeys(id);
  return generatorCIJob + " (" + id + ")";
}
export function generatorCIArtifactName(id, attempt) {
  generatorCIOutputKeys(id);
  assert.ok(Number.isSafeInteger(attempt) && attempt > 0 && attempt <= 10000);
  return "native-dotnet-generator-shard-" + id + "-" + attempt;
}
export function generatorCIObservation(environment) {
  assert.equal(
    environment.GITHUB_ACTIONS,
    "true",
    "Generator CI requires actual workflow metadata",
  );
  assert.match(
    environment.GITHUB_REPOSITORY ?? "",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
  );
  assert.ok(positive(environment.GITHUB_RUN_ID));
  const runAttempt = Number(environment.GITHUB_RUN_ATTEMPT);
  assert.ok(
    Number.isSafeInteger(runAttempt) && runAttempt > 0 && runAttempt <= 10000,
  );
  for (const key of ["GITHUB_SHA", "CHECKTRAIL_DOTNET_CANDIDATE_HEAD"])
    assert.match(environment[key] ?? "", /^[a-f0-9]{40}$/u);
  assert.ok(
    ["pull_request", "push", "schedule", "workflow_dispatch"].includes(
      environment.GITHUB_EVENT_NAME,
    ),
  );
  return {
    repository: environment.GITHUB_REPOSITORY,
    runId: environment.GITHUB_RUN_ID,
    runAttempt,
    headSha: environment.CHECKTRAIL_DOTNET_CANDIDATE_HEAD,
    checkoutSha: environment.GITHUB_SHA,
    event: environment.GITHUB_EVENT_NAME,
  };
}
export function requireGeneratorRun(run, ci) {
  assert.ok(numeric(run.id));
  assert.equal(String(run.id), ci.runId, "Wrong GitHub workflow run");
  assert.equal(
    run.repository?.full_name,
    ci.repository,
    "Wrong GitHub repository",
  );
  assert.equal(
    run.head_sha,
    ci.headSha,
    "Wrong candidate head (not checkout merge SHA)",
  );
  assert.equal(run.run_attempt, ci.runAttempt, "Workflow attempt changed");
  assert.equal(run.event, ci.event);
  assert.equal(run.path, ".github/workflows/ci.yml");
  assert.ok(["in_progress", "completed"].includes(run.status));
  return run;
}
export function createGeneratorMetadataRequest({
  repository,
  token,
  fetchImpl = globalThis.fetch,
  deadlineMs = 120000,
}) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  assert.ok(
    typeof token === "string" &&
      token.length > 0 &&
      !/[^\x21-\x7e]/u.test(token),
    "Missing or invalid step-scoped metadata credential",
  );
  assert.ok(
    Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 120000,
  );
  const deadline = Date.now() + deadlineMs;
  let requests = 0;
  return async (endpoint) => {
    const url = new URL(
      endpoint,
      "https://api.github.com/repos/" + repository + "/actions/",
    );
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(url.username + url.password + url.hash, "");
    const prefix = "/repos/" + repository + "/actions/";
    assert.ok(url.pathname.startsWith(prefix));
    assert.match(
      url.pathname.slice(prefix.length),
      /^(?:runs\/[1-9]\d*(?:\/attempts\/[1-9]\d*\/jobs|\/jobs)?|artifacts\/[1-9]\d*)$/u,
    );
    for (const [key, value] of url.searchParams) {
      assert.ok(["filter", "per_page", "page"].includes(key));
      assert.equal(url.searchParams.getAll(key).length, 1);
      assert.ok(
        key === "filter"
          ? value === "latest"
          : key === "per_page"
            ? value === "20"
            : /^[1-9]$|^10$/u.test(value),
      );
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - Date.now();
      assert.ok(
        remaining > 0 && ++requests <= 40,
        "Generator metadata request budget exhausted",
      );
      const response = await fetchImpl(url.href, {
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(15000, remaining)),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + token,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        if (
          attempt === 0 &&
          [429, 500, 502, 503, 504].includes(response.status)
        )
          continue;
        assert.fail(
          "Generator metadata GET failed (HTTP " + response.status + ")",
        );
      }
      const chunks = [];
      let bytes = 0;
      try {
        assert.ok(response.body, "Missing metadata response body");
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          assert.ok(
            bytes <= 4 * MAX_BYTES,
            "Generator metadata response exceeds bound",
          );
          chunks.push(Buffer.from(chunk));
        }
      } catch (error) {
        await response.body?.cancel().catch(() => {});
        throw error;
      }
      return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
    }
    assert.fail("Generator metadata retry exhausted");
  };
}
/** Complete bounded pages; a short/changing/duplicate inventory is never a successful lookup. */
export async function listGeneratorJobs(request, endpoint, ci) {
  const jobs = [];
  let total;
  for (let page = 1; page <= MAX_JOBS / PAGE_SIZE; page++) {
    const body = await request(
      endpoint +
        (endpoint.includes("?") ? "&" : "?") +
        "per_page=20&page=" +
        page,
    );
    assert.ok(
      Number.isSafeInteger(body.total_count) &&
        body.total_count > 0 &&
        body.total_count <= MAX_JOBS,
      "Generator job inventory exceeds reviewed bound",
    );
    total ??= body.total_count;
    assert.equal(
      body.total_count,
      total,
      "Generator job inventory changed during pagination",
    );
    assert.ok(Array.isArray(body.jobs));
    assert.equal(
      body.jobs.length,
      Math.min(PAGE_SIZE, total - jobs.length),
      "Incomplete generator job page",
    );
    for (const job of body.jobs) {
      assert.ok(numeric(job.id) && job.run_id === Number(ci.runId));
      assert.equal(
        job.head_sha,
        ci.headSha,
        "Foreign candidate in job inventory",
      );
      assert.ok(
        typeof job.name === "string" &&
          job.name.length > 0 &&
          job.name.length <= 256,
      );
      jobs.push(job);
    }
    if (jobs.length === total) break;
  }
  assert.equal(jobs.length, total);
  assert.equal(
    new Set(jobs.map((job) => job.id)).size,
    jobs.length,
    "Duplicate GitHub job ID",
  );
  return jobs;
}
function exactJob(jobs, id) {
  const matches = jobs.filter((row) => row.name === generatorCIJobName(id));
  assert.equal(
    matches.length,
    1,
    "Missing or duplicate exact generator job context",
  );
  return matches[0];
}
export async function observeGeneratorProducer(request, ci, id, checkRunId) {
  generatorCIOutputKeys(id);
  assert.ok(positive(checkRunId), "Missing actual job.check_run_id");
  requireGeneratorRun(await request("runs/" + ci.runId), ci);
  const job = exactJob(
    await listGeneratorJobs(
      request,
      "runs/" + ci.runId + "/attempts/" + ci.runAttempt + "/jobs",
      ci,
    ),
    id,
  );
  assert.equal(
    job.check_run_url,
    "https://api.github.com/repos/" +
      ci.repository +
      "/check-runs/" +
      checkRunId,
    "Job context does not identify this check run",
  );
  assert.equal(
    job.status,
    "in_progress",
    "START cannot use a retained completed alias",
  );
  assert.equal(job.conclusion, null);
  if (Object.hasOwn(job, "run_attempt"))
    assert.equal(job.run_attempt, ci.runAttempt);
  requireGeneratorRun(await request("runs/" + ci.runId), ci);
  return validateGeneratorJobContext({
    repository: ci.repository,
    runId: ci.runId,
    headSha: ci.headSha,
    checkoutSha: ci.checkoutSha,
    jobId: String(job.id),
    jobAttempt: ci.runAttempt,
  });
}
export function createGeneratorCIStart({
  id,
  context,
  loaded,
  checkRunId,
  nonce = randomUUID(),
}) {
  selectGeneratorShard(loaded.manifest, id);
  validateGeneratorJobContext(context);
  assert.ok(positive(checkRunId));
  assert.match(
    nonce,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
  );
  return {
    schemaVersion: 1,
    scope: "dotnet-generator-job-start",
    shard: id,
    context,
    checkRunId,
    nonce,
    manifestSha256: loaded.manifestSha256,
    requirementsSha256: loaded.requirementsSha256,
    metadataAttested: false,
    nativeExecutionInvoked: false,
    gateAComplete: false,
  };
}
export function requireGeneratorCIStart(start, loaded) {
  exact(
    start,
    [
      "schemaVersion",
      "scope",
      "shard",
      "context",
      "checkRunId",
      "nonce",
      "manifestSha256",
      "requirementsSha256",
      "metadataAttested",
      "nativeExecutionInvoked",
      "gateAComplete",
    ],
    "Invalid generator START fields",
  );
  assert.deepEqual(
    start,
    createGeneratorCIStart({
      id: start.shard,
      context: start.context,
      loaded,
      checkRunId: start.checkRunId,
      nonce: start.nonce,
    }),
  );
  return start;
}
function bindSource(source, start) {
  validateConsumerNativeSourceFrame(source);
  assert.equal(
    source.commit,
    start.context.checkoutSha,
    "Source is not the tested checkout",
  );
  assert.equal(source.requirementsSha256, start.requirementsSha256);
}
export function createGeneratorCIEnvelope(start, source, fragment, current) {
  requireGeneratorCIStart(start, current.loaded);
  bindSource(source, start);
  validateGeneratorShardFragment(fragment, {
    ...current,
    context: start.context,
  });
  assert.equal(fragment.shard.id, start.shard);
  assert.equal(
    fragment.source.evidence.compiledEngine.treeSha256,
    source.engineSha256,
  );
  assert.equal(
    fragment.source.evidence.compiledEngine.manifestSha256,
    source.engineManifestSha256,
  );
  return {
    schemaVersion: 1,
    scope: "current-source-dotnet-generator-fragment",
    producer: start,
    source,
    fragment,
    fragmentSha256: digest(fragment),
    wholeProfileQualification: false,
    gateAComplete: false,
  };
}
export function requireGeneratorCIEnvelope(envelope, start, source, current) {
  assert.deepEqual(
    envelope.producer,
    start,
    "Fragment is from another START nonce",
  );
  requireConsumerNativeSourceFrame(envelope.source, source);
  assert.deepEqual(
    envelope,
    createGeneratorCIEnvelope(start, source, envelope.fragment, current),
    "Foreign generator envelope fields",
  );
  canonical(envelope);
  return envelope;
}
export function createGeneratorCIFinish(start, envelope, artifact) {
  exact(artifact, ["id", "name", "digest"], "Invalid generator artifact claim");
  assert.ok(positive(artifact.id) && sha(artifact.digest));
  assert.equal(
    artifact.name,
    generatorCIArtifactName(start.shard, start.context.jobAttempt),
  );
  assert.deepEqual(envelope.producer, start);
  return {
    schemaVersion: 1,
    scope: "dotnet-generator-job-finish",
    producer: start,
    startSha256: digest(start),
    envelopeSha256: digest(envelope),
    fragmentSha256: envelope.fragmentSha256,
    sourceFrameSha256: digest(envelope.source),
    artifact: { ...artifact },
    metadataAttested: false,
    wholeProfileQualification: false,
    gateAComplete: false,
  };
}
export function requireGeneratorProducerClaims(
  start,
  finish,
  { loaded, ci, id, source },
) {
  requireGeneratorCIStart(start, loaded);
  const context = start.context;
  assert.equal(start.shard, id);
  for (const field of ["repository", "runId", "headSha", "checkoutSha"])
    assert.equal(
      context[field],
      ci[field],
      "Foreign generator run/head/checkout",
    );
  assert.ok(
    context.jobAttempt <= ci.runAttempt,
    "Future generator producer attempt",
  );
  bindSource(source, start);
  exact(
    finish,
    [
      "schemaVersion",
      "scope",
      "producer",
      "startSha256",
      "envelopeSha256",
      "fragmentSha256",
      "sourceFrameSha256",
      "artifact",
      "metadataAttested",
      "wholeProfileQualification",
      "gateAComplete",
    ],
    "Invalid generator FINISH fields",
  );
  assert.equal(finish.schemaVersion, 1);
  assert.equal(finish.scope, "dotnet-generator-job-finish");
  assert.deepEqual(
    finish.producer,
    start,
    "FINISH is not from its retained START",
  );
  assert.equal(finish.startSha256, digest(start));
  assert.equal(
    finish.sourceFrameSha256,
    digest(source),
    "Stale FINISH source frame",
  );
  assert.ok(sha(finish.envelopeSha256) && sha(finish.fragmentSha256));
  exact(
    finish.artifact,
    ["id", "name", "digest"],
    "Invalid generator artifact claim",
  );
  assert.ok(positive(finish.artifact.id) && sha(finish.artifact.digest));
  assert.equal(
    finish.artifact.name,
    generatorCIArtifactName(id, context.jobAttempt),
  );
  for (const field of [
    "metadataAttested",
    "wholeProfileQualification",
    "gateAComplete",
  ])
    assert.equal(finish[field], false);
  return { id, start, finish };
}
export function selectGeneratorProducerClaims({
  loaded,
  ci,
  plan,
  needs,
  source,
}) {
  assert.ok(
    plan?.selected && typeof plan.selected[generatorCIJob] === "boolean",
  );
  const job = needs[generatorCIJob];
  if (!plan.selected[generatorCIJob]) {
    assert.equal(job?.result, "skipped");
    assert.ok(
      !job.outputs || Object.keys(job.outputs).length === 0,
      "Unselected generator job cannot provide completion outputs",
    );
    return [];
  }
  assert.equal(job?.result, "success", "Generator outer matrix must succeed");
  exact(
    job.outputs,
    dotnetGeneratorShardIds.flatMap((id) =>
      Object.values(generatorCIOutputKeys(id)),
    ),
    "Missing duplicate or foreign generator START/FINISH output",
  );
  const decode = (key) => {
    const raw = job.outputs[key];
    assert.ok(
      typeof raw === "string" &&
        Buffer.byteLength(raw) <= 16384 &&
        raw.length > 0,
    );
    const value = JSON.parse(raw);
    assert.equal(JSON.stringify(value), raw);
    return value;
  };
  const bindings = dotnetGeneratorShardIds.map((id) => {
    const names = generatorCIOutputKeys(id);
    return requireGeneratorProducerClaims(
      decode(names.start),
      decode(names.finish),
      { loaded, ci, id, source },
    );
  });
  for (const field of ["nonce", "jobId"])
    assert.equal(
      new Set(
        bindings.map((row) =>
          field === "nonce" ? row.start.nonce : row.start.context.jobId,
        ),
      ).size,
      3,
      "Reused producer execution identity",
    );
  assert.equal(
    new Set(bindings.map((row) => row.finish.artifact.id)).size,
    3,
    "Reused generator artifact ID",
  );
  return bindings;
}
function executionIdentity(row) {
  assert.equal(row.status, "completed");
  assert.equal(
    row.conclusion,
    "success",
    "Latest failure cannot use older successful evidence",
  );
  assert.ok(
    typeof row.started_at === "string" &&
      Number.isFinite(Date.parse(row.started_at)),
  );
  assert.ok(
    typeof row.completed_at === "string" &&
      Date.parse(row.completed_at) >= Date.parse(row.started_at),
  );
  assert.ok(
    numeric(row.runner_id) &&
      typeof row.runner_name === "string" &&
      row.runner_name.length > 0 &&
      row.runner_name.length <= 256,
  );
  assert.ok(
    Array.isArray(row.labels) &&
      row.labels.length <= 32 &&
      row.labels.every(
        (value) => typeof value === "string" && value.length <= 256,
      ),
  );
  assert.ok(
    Array.isArray(row.steps) && row.steps.length > 0 && row.steps.length <= 128,
  );
  // Preserve exact terminal step metadata. IDs/created_at/run_attempt are replay
  // aliases on failed-only reruns, not identities of the retained execution.
  canonical(row.steps);
  return Object.fromEntries(
    [
      "name",
      "run_id",
      "head_sha",
      "status",
      "conclusion",
      "started_at",
      "completed_at",
      "runner_id",
      "runner_name",
      "labels",
      "steps",
    ].map((key) => [key, row[key]]),
  );
}
export function bindGeneratorLatestExecution(binding, original, latest, ci) {
  const context = binding.start.context;
  assert.equal(original.name, generatorCIJobName(binding.id));
  assert.equal(latest.name, original.name);
  for (const row of [original, latest]) {
    assert.equal(row.run_id, Number(ci.runId));
    assert.equal(row.head_sha, ci.headSha);
    assert.ok(numeric(row.id));
  }
  assert.equal(
    String(original.id),
    context.jobId,
    "Original execution ID is absent from its claimed attempt",
  );
  assert.equal(
    original.check_run_url,
    "https://api.github.com/repos/" +
      ci.repository +
      "/check-runs/" +
      binding.start.checkRunId,
  );
  if (Object.hasOwn(original, "run_attempt"))
    assert.equal(original.run_attempt, context.jobAttempt);
  if (context.jobAttempt === ci.runAttempt)
    assert.equal(
      original.id,
      latest.id,
      "Fresh producer differs from latest current execution",
    );
  assert.deepEqual(
    executionIdentity(latest),
    executionIdentity(original),
    "Latest alias is not the retained successful producer execution",
  );
  return {
    shard: binding.id,
    producerExecutionJobId: context.jobId,
    producerExecutionAttempt: context.jobAttempt,
    latestObservedJobId: String(latest.id),
    aggregateAttempt: ci.runAttempt,
    retainedAlias: original.id !== latest.id,
  };
}
export function requireGeneratorArtifactMetadata(artifact, binding, ci) {
  assert.ok(numeric(artifact.id));
  const claim = binding.finish.artifact;
  assert.equal(String(artifact.id), claim.id);
  assert.equal(artifact.name, claim.name);
  assert.equal(
    artifact.digest,
    "sha256:" + claim.digest,
    "Artifact digest differs from the upload action claim",
  );
  assert.equal(artifact.expired, false);
  assert.ok(
    Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= 4 * MAX_BYTES,
  );
  assert.equal(artifact.workflow_run?.id, Number(ci.runId));
  assert.equal(artifact.workflow_run.head_sha, ci.headSha);
  return artifact;
}
export async function observeGeneratorBindings(request, bindings, ci) {
  requireGeneratorRun(await request("runs/" + ci.runId), ci);
  const latest = await listGeneratorJobs(
    request,
    "runs/" + ci.runId + "/jobs?filter=latest",
    ci,
  );
  const attempts = new Map();
  for (const attempt of new Set(
    bindings.map((row) => row.start.context.jobAttempt),
  ))
    attempts.set(
      attempt,
      await listGeneratorJobs(
        request,
        "runs/" + ci.runId + "/attempts/" + attempt + "/jobs",
        ci,
      ),
    );
  const observed = [];
  for (const binding of bindings) {
    const original = exactJob(
      attempts.get(binding.start.context.jobAttempt),
      binding.id,
    );
    const execution = bindGeneratorLatestExecution(
      binding,
      original,
      exactJob(latest, binding.id),
      ci,
    );
    const artifact = requireGeneratorArtifactMetadata(
      await request("artifacts/" + binding.finish.artifact.id),
      binding,
      ci,
    );
    observed.push({
      ...execution,
      artifactId: String(artifact.id),
      artifactDigest: artifact.digest,
    });
  }
  requireGeneratorRun(await request("runs/" + ci.runId), ci);
  return observed;
}
export async function readGeneratorCIArtifacts(root, bindings) {
  assert.equal(bindings.length, 3);
  await requireNativeCIArtifactDirectory(root);
  assert.deepEqual(
    (await readdir(root)).sort(),
    bindings.map((row) => row.finish.artifact.name).sort(),
    "Missing or foreign generator artifact directory",
  );
  const envelopes = [];
  for (const binding of bindings) {
    const directory = path.join(root, binding.finish.artifact.name);
    await requireNativeCIArtifactDirectory(directory);
    const name = "dotnet-generator-shard-" + binding.id + ".json";
    assert.deepEqual(
      await readdir(directory),
      [name],
      "Missing duplicate or foreign generator fragment file",
    );
    const envelope = await readNativeCIArtifact(path.join(directory, name));
    assert.equal(
      digest(envelope),
      binding.finish.envelopeSha256,
      "Fragment artifact bytes differ from retained FINISH",
    );
    envelopes.push(envelope);
  }
  return envelopes;
}
export function qualifyGeneratorCohort({
  loaded,
  ci,
  source,
  current,
  bindings,
  observations,
  envelopes,
}) {
  assert.equal(bindings.length, 3);
  assert.equal(observations.length, 3);
  assert.equal(envelopes.length, 3);
  assert.deepEqual(observations.map((row) => row.shard).sort(), [
    ...dotnetGeneratorShardIds,
  ]);
  const fragments = [],
    contexts = {};
  for (const binding of bindings) {
    requireGeneratorProducerClaims(binding.start, binding.finish, {
      loaded,
      ci,
      id: binding.id,
      source,
    });
    const observed = observations.find((row) => row.shard === binding.id);
    assert.equal(observed.producerExecutionJobId, binding.start.context.jobId);
    assert.equal(
      observed.producerExecutionAttempt,
      binding.start.context.jobAttempt,
    );
    assert.equal(observed.aggregateAttempt, ci.runAttempt);
    assert.equal(observed.artifactId, binding.finish.artifact.id);
    assert.equal(
      observed.artifactDigest,
      "sha256:" + binding.finish.artifact.digest,
    );
    const candidates = envelopes.filter(
      (row) => row.producer?.shard === binding.id,
    );
    assert.equal(
      candidates.length,
      1,
      "Missing or duplicate generator envelope shard",
    );
    const envelope = requireGeneratorCIEnvelope(
      candidates[0],
      binding.start,
      source,
      current,
    );
    assert.equal(digest(envelope), binding.finish.envelopeSha256);
    assert.equal(envelope.fragmentSha256, binding.finish.fragmentSha256);
    fragments.push(envelope.fragment);
    contexts[binding.id] = binding.start.context;
  }
  const union = aggregateGeneratorShardFragments({
    ...current,
    loaded,
    fragments,
    contexts,
  });
  return {
    ...union,
    scope: "current-source-hosted-dotnet-generator-cohort",
    source,
    producerArtifacts: observations,
    wholeProfileQualification: true,
    wholeUpstreamClosureVerified: false,
    hostAttestationPerformed: false,
    gateAComplete: false,
  };
}
async function writeOutput(stage, value, environment) {
  const start = stage === "start" ? value : value.producer;
  const names = generatorCIOutputKeys(start.shard),
    raw = canonical(value);
  assert.ok(Buffer.byteLength(raw) <= 16384 && !/[\r\n]/u.test(raw));
  assert.ok(
    environment.GITHUB_OUTPUT && path.isAbsolute(environment.GITHUB_OUTPUT),
  );
  await appendFile(
    environment.GITHUB_OUTPUT,
    "claim=" +
      raw +
      "\n" +
      names[stage] +
      "=" +
      raw +
      "\n" +
      (stage === "start"
        ? "context=" + JSON.stringify(start.context) + "\n"
        : ""),
  );
}
async function currentBytes(repository, loaded) {
  return {
    loaded,
    harness: await captureGeneratorShardHarness(repository),
    mutationSources: await captureGeneratorMutationSources(repository),
  };
}
async function readPublishedEnvelope(directory, id) {
  await requireNativeCIPrivateDirectory(directory);
  const name = "dotnet-generator-shard-" + id + ".json";
  assert.deepEqual(await readdir(directory), [name]);
  const raw = await readNativeCIPrivateFile(path.join(directory, name));
  const envelope = JSON.parse(raw.bytes.toString("utf8"));
  assert.equal(canonical(envelope) + "\n", raw.bytes.toString("utf8"));
  return envelope;
}
async function main(args, environment) {
  const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  const loaded = await loadGeneratorShards(root),
    ci = generatorCIObservation(environment);
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    ci.checkoutSha,
  );
  let metadataRequest;
  const request = (endpoint) => {
    metadataRequest ??= createGeneratorMetadataRequest({
      repository: ci.repository,
      token: environment.GITHUB_TOKEN,
    });
    return metadataRequest(endpoint);
  };
  assert.ok(
    ["start", "run", "publish", "selection", "aggregate"].includes(args[0]),
  );
  if (["start", "run", "publish"].includes(args[0])) {
    assert.equal(args.length, 3);
    assert.equal(args[1], "--shard");
    const id = args[2];
    selectGeneratorShard(loaded.manifest, id);
    assert.equal(environment.GITHUB_JOB, generatorCIJob);
    if (args[0] === "start") {
      const jobContext = JSON.parse(environment.CHECKTRAIL_DOTNET_JOB);
      assert.ok(numeric(jobContext.check_run_id));
      const context = await observeGeneratorProducer(
        request,
        ci,
        id,
        String(jobContext.check_run_id),
      );
      const start = createGeneratorCIStart({
        id,
        context,
        loaded,
        checkRunId: String(jobContext.check_run_id),
      });
      await writeOutput("start", start, environment);
      process.stdout.write(
        JSON.stringify({
          shard: id,
          producerExecutionJobId: context.jobId,
          producerExecutionAttempt: context.jobAttempt,
          nativeExecutionInvoked: false,
        }) + "\n",
      );
      return;
    }
    const start = requireGeneratorCIStart(
      JSON.parse(environment.CHECKTRAIL_DOTNET_START),
      loaded,
    );
    assert.equal(start.shard, id);
    assert.equal(start.context.jobAttempt, ci.runAttempt);
    for (const field of ["repository", "runId", "headSha", "checkoutSha"])
      assert.equal(start.context[field], ci[field]);
    const directory = environment.CHECKTRAIL_DOTNET_FRAGMENT_DIRECTORY;
    assert.ok(directory && path.isAbsolute(directory));
    if (args[0] === "run") {
      assert.equal(
        environment.CHECKTRAIL_DOTNET_GENERATOR_JOB_CONTEXT,
        JSON.stringify(start.context),
      );
      const before = await captureConsumerNativeSourceFrame(root);
      const { runDotnetGeneratorShardContainer } = await import(
        new URL("../" + deferredModules.controller, import.meta.url).href
      );
      const fragment = await runDotnetGeneratorShardContainer(["--shard", id]);
      const after = await captureConsumerNativeSourceFrame(root);
      requireConsumerNativeSourceFrame(after, before);
      const envelope = createGeneratorCIEnvelope(
        start,
        before,
        fragment,
        await currentBytes(root, loaded),
      );
      await mkdir(directory, { mode: 0o700 });
      await requireNativeCIPrivateDirectory(directory);
      await writeNativeCIPrivateFile(
        path.join(directory, "dotnet-generator-shard-" + id + ".json"),
        Buffer.from(canonical(envelope) + "\n"),
      );
      process.stdout.write(
        JSON.stringify({
          shard: id,
          fragmentComplete: true,
          wholeProfileQualification: false,
          gateAComplete: false,
        }) + "\n",
      );
      return;
    }
    const source = await captureConsumerNativeSourceFrame(root);
    const envelope = requireGeneratorCIEnvelope(
      await readPublishedEnvelope(directory, id),
      start,
      source,
      await currentBytes(root, loaded),
    );
    const artifact = {
      id: environment.CHECKTRAIL_DOTNET_ARTIFACT_ID,
      name: environment.CHECKTRAIL_DOTNET_ARTIFACT_NAME,
      digest: environment.CHECKTRAIL_DOTNET_ARTIFACT_DIGEST,
    };
    const finish = createGeneratorCIFinish(start, envelope, artifact);
    requireGeneratorProducerClaims(start, finish, { loaded, ci, id, source });
    requireGeneratorArtifactMetadata(
      await request("artifacts/" + artifact.id),
      { id, start, finish },
      ci,
    );
    await writeOutput("finish", finish, environment);
    return;
  }
  assert.equal(args.length, 1);
  assert.equal(environment.GITHUB_JOB, "ci-complete");
  const source = await captureConsumerNativeSourceFrame(root);
  const bindings = selectGeneratorProducerClaims({
    loaded,
    ci,
    source,
    plan: JSON.parse(environment.CHECKTRAIL_CI_PLAN),
    needs: JSON.parse(environment.CHECKTRAIL_CI_NEEDS),
  });
  if (!bindings.length) {
    if (args[0] === "selection")
      await appendFile(
        environment.GITHUB_OUTPUT,
        "selected=false\nartifact_ids=\n",
      );
    process.stdout.write(
      JSON.stringify({
        selected: false,
        wholeProfileQualification: false,
        gateAComplete: false,
      }) + "\n",
    );
    return;
  }
  const observations = await observeGeneratorBindings(request, bindings, ci);
  if (args[0] === "selection") {
    await appendFile(
      environment.GITHUB_OUTPUT,
      "selected=true\nartifact_ids=" +
        bindings.map((row) => row.finish.artifact.id).join(",") +
        "\n",
    );
    process.stdout.write(
      JSON.stringify({
        selected: true,
        producerArtifacts: observations,
        wholeProfileQualification: false,
        gateAComplete: false,
      }) + "\n",
    );
    return;
  }
  const envelopes = await readGeneratorCIArtifacts(
    environment.CHECKTRAIL_DOTNET_ARTIFACTS,
    bindings,
  );
  const current = await currentBytes(root, loaded);
  const after = await captureConsumerNativeSourceFrame(root);
  requireConsumerNativeSourceFrame(after, source);
  const report = qualifyGeneratorCohort({
    loaded,
    ci,
    source,
    current,
    bindings,
    observations,
    envelopes,
  });
  process.stdout.write(JSON.stringify(report) + "\n");
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main(process.argv.slice(2), process.env);
