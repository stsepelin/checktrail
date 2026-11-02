// Developer-only GCC carrier admission. Original producer limits are unchanged.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { strictJson, digest } from "./emsdk-metadata-values.mjs";

export const gccJobReserves = Object.freeze({
  producerCleanup: 600,
  observationFinish: 300,
  export: 1200,
  independentReplay: 180,
  artifactUpload: 300,
  runnerFinalization: 300,
});
export const gccJobEnvelopePolicy = Object.freeze({
  schemaVersion: 1,
  configuredJobSeconds: 355 * 60,
  requestedMaximumObservationSeconds: 330 * 60,
  minimumUsefulObservationSeconds: 270 * 60,
  reservedSeconds: gccJobReserves,
  totalReservedSeconds: Object.values(gccJobReserves).reduce(
    (a, b) => a + b,
    0,
  ),
  serviceClockUncertaintyMs: 2000,
  maximumRequestMs: 15000,
  maximumResponseBytes: 128 * 1024,
});

const exact = (value, pattern) =>
  typeof value === "string" && value.match(pattern)?.[0] === value;

const finite = (value, name) => {
  assert.ok(
    typeof value === "number" && Number.isFinite(value) && value >= 0,
    name,
  );
  return value;
};
const utc = (value, name) => {
  assert.equal(typeof value, "string", name);
  assert.ok(
    exact(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
    name,
  );
  const parsed = Date.parse(value);
  assert.ok(Number.isFinite(parsed), name);
  assert.equal(
    new Date(parsed).toISOString(),
    value.includes(".") ? value : value.slice(0, -1) + ".000Z",
    name,
  );
  return parsed;
};

export function validateGithubGccContext(context) {
  assert.deepEqual(
    Object.keys(context).sort(),
    ["repository", "runId", "runAttempt", "jobName", "headSha"].sort(),
  );
  assert.equal(typeof context.repository, "string");
  const parts = context.repository.split("/");
  assert.equal(parts.length, 2);
  assert.ok(
    exact(parts[0], /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u),
  );
  assert.ok(
    exact(parts[1], /^[A-Za-z0-9_.-]{1,100}$/u) &&
      ![".", ".."].includes(parts[1]),
    "Exact repository path components",
  );
  for (const field of ["runId", "runAttempt"]) {
    assert.equal(typeof context[field], "string");
    assert.ok(exact(context[field], /^[1-9][0-9]{0,14}$/u));
    assert.ok(Number.isSafeInteger(Number(context[field])));
  }
  assert.equal(context.jobName, "original-gcc-observation");
  assert.ok(exact(context.headSha, /^[0-9a-f]{40}$/u));
  return context;
}

export function githubGccJobsUrl(context) {
  validateGithubGccContext(context);
  return (
    "https://api.github.com/repos/" +
    context.repository.split("/").map(encodeURIComponent).join("/") +
    "/actions/runs/" +
    context.runId +
    "/attempts/" +
    context.runAttempt +
    "/jobs?per_page=100"
  );
}

export function admitGccJobEnvelope(capture) {
  const policy = gccJobEnvelopePolicy;
  const context = Object.freeze({
    ...validateGithubGccContext(capture.context),
  });
  assert.equal(capture.url, githubGccJobsUrl(context));
  assert.equal(capture.httpStatus, 200, "Job-clock service did not return200");
  assert.ok(Buffer.isBuffer(capture.responseBytes));
  assert.ok(
    capture.responseBytes.length > 0 &&
      capture.responseBytes.length <= policy.maximumResponseBytes,
    "Job-clock response byte ceiling",
  );
  assert.equal(capture.responseComplete, true, "Incomplete job-clock response");
  assert.equal(capture.observedResponseBytes, capture.responseBytes.length);
  assert.equal(capture.retainedResponseBytes, capture.responseBytes.length);
  assert.equal(capture.observedUnretainedBytes, 0);
  assert.ok(
    capture.contentEncoding === null || capture.contentEncoding === "identity",
    "Encoded job-clock metadata is not admitted",
  );
  assert.ok(
    exact(
      capture.contentType,
      /^application\/(?:json|vnd\.github\+json)(?:; charset=utf-8)?$/iu,
    ),
    "Unknown job-clock metadata content type",
  );
  const body = strictJson(capture.responseBytes, {
    jsonDepth: 32,
    jsonNodes: 30000,
  });
  assert.ok(body !== null && typeof body === "object" && !Array.isArray(body));
  assert.ok(
    Array.isArray(body.jobs) &&
      body.jobs.length === 1 &&
      body.total_count === 1,
    "Expected the singleton selected GCC workflow job",
  );
  const job = body.jobs[0];
  assert.ok(Number.isSafeInteger(job.id) && job.id > 0);
  assert.equal(job.run_id, Number(context.runId));
  assert.equal(
    job.run_url,
    "https://api.github.com/repos/" +
      context.repository +
      "/actions/runs/" +
      context.runId,
  );
  assert.equal(job.name, context.jobName);
  assert.equal(job.head_sha, context.headSha);
  assert.equal(job.status, "in_progress");
  assert.equal(job.conclusion, null);
  const jobStarted = utc(
    job.started_at,
    "Actual job started_at missing/invalid",
  );
  const requestStarted = utc(capture.requestStartedAt, "Request start clock");
  const received = utc(capture.receivedAt, "Response receive clock");
  const carrierStarted = utc(capture.carrierStartedAt, "Carrier UTC start");
  const elapsed = finite(capture.requestElapsedMs, "Request monotonic elapsed");
  const carrierElapsed = finite(
    capture.carrierElapsedMs,
    "Carrier monotonic elapsed",
  );
  assert.ok(
    elapsed <= policy.maximumRequestMs && carrierElapsed >= elapsed,
    "Bounded same-process acquisition clock required",
  );
  assert.ok(
    received >= requestStarted && requestStarted >= carrierStarted,
    "Wall-clock ordering changed",
  );
  assert.ok(
    Math.abs(received - requestStarted - elapsed) <= 1000 &&
      Math.abs(received - carrierStarted - carrierElapsed) <= 1000,
    "UTC/monotonic clock mapping changed",
  );
  assert.equal(typeof capture.serviceDate, "string");
  const serviceNow = Date.parse(capture.serviceDate);
  assert.ok(
    Number.isFinite(serviceNow) &&
      new Date(serviceNow).toUTCString() === capture.serviceDate,
    "Canonical service Date required",
  );
  assert.ok(
    Number.isFinite(serviceNow) &&
      serviceNow >= requestStarted - policy.serviceClockUncertaintyMs &&
      serviceNow <= received + policy.serviceClockUncertaintyMs,
    "Stale or future job-clock service Date",
  );
  assert.ok(
    jobStarted <= serviceNow,
    "Actual job start is after service clock",
  );
  const jobDeadline = jobStarted + policy.configuredJobSeconds * 1000;
  const conservativeNow =
    Math.max(serviceNow, received) + policy.serviceClockUncertaintyMs;
  const seconds = Math.floor(
    Math.min(
      policy.requestedMaximumObservationSeconds,
      (carrierElapsed +
        jobDeadline -
        conservativeNow -
        policy.totalReservedSeconds * 1000) /
        1000,
    ),
  );
  assert.ok(
    Number.isSafeInteger(seconds) &&
      seconds * 1000 - carrierElapsed >=
        policy.minimumUsefulObservationSeconds * 1000,
    "Insufficient remaining whole-job envelope before original execution",
  );
  const cutoff = carrierStarted + seconds * 1000;
  assert.ok(
    cutoff + policy.totalReservedSeconds * 1000 <= jobDeadline,
    "Carrier would borrow cleanup/export/finalization reserve",
  );
  return {
    schemaVersion: 1,
    authority: "fresh-current-run-attempt-GitHub-job-service-observation",
    context,
    job: {
      id: job.id,
      startedAt: job.started_at,
      status: job.status,
      headSha: job.head_sha,
    },
    request: {
      url: capture.url,
      startedAt: capture.requestStartedAt,
      receivedAt: capture.receivedAt,
      elapsedMs: elapsed,
      httpStatus: 200,
    },
    response: {
      bytes: capture.responseBytes.length,
      sha256: digest(capture.responseBytes),
      serviceDate: capture.serviceDate,
      contentType: capture.contentType,
      contentEncoding: capture.contentEncoding,
      complete: true,
      observedBytes: capture.observedResponseBytes,
      retainedBytes: capture.retainedResponseBytes,
    },
    policy,
    carrierStartedAt: capture.carrierStartedAt,
    carrierElapsedAtAdmissionMs: carrierElapsed,
    wholeJobDeadlineAt: new Date(jobDeadline).toISOString(),
    observationSeconds: seconds,
    cutoffAt: new Date(cutoff).toISOString(),
    fullEightHourHostedCapacityVerified: false,
    originalProducerDefaultsOrBudgetChanged: false,
    clockScope:
      "same-carrier-process-monotonic-after-fresh-service-UTC-admission",
  };
}

export function replayGccJobEnvelope(record, responseBytes) {
  const capture = {
    context: record.context,
    url: record.request.url,
    httpStatus: record.request.httpStatus,
    responseBytes,
    responseComplete: record.response.complete,
    observedResponseBytes: record.response.observedBytes,
    retainedResponseBytes: record.response.retainedBytes,
    observedUnretainedBytes:
      record.response.observedBytes - record.response.retainedBytes,
    contentType: record.response.contentType,
    contentEncoding: record.response.contentEncoding,
    requestStartedAt: record.request.startedAt,
    receivedAt: record.request.receivedAt,
    requestElapsedMs: record.request.elapsedMs,
    serviceDate: record.response.serviceDate,
    carrierStartedAt: record.carrierStartedAt,
    carrierElapsedMs: record.carrierElapsedAtAdmissionMs,
  };
  const replayed = admitGccJobEnvelope(capture);
  assert.deepEqual(record, replayed, "Job-clock source/window replay differs");
  return replayed;
}

export async function afterGccJobAdmission(capture, execute) {
  assert.equal(typeof capture, "function");
  assert.equal(typeof execute, "function");
  const admitted = admitGccJobEnvelope(await capture());
  return execute(admitted);
}

export function remainingGccObservationMs(admitted, started, now) {
  finite(started, "Carrier monotonic start");
  finite(now, "Carrier monotonic current clock");
  assert.ok(
    now >= started && now - started >= admitted.carrierElapsedAtAdmissionMs,
    "Carrier monotonic admission clock changed",
  );
  const remaining = Math.floor(
    started + admitted.observationSeconds * 1000 - now,
  );
  assert.ok(
    remaining >= gccJobEnvelopePolicy.minimumUsefulObservationSeconds * 1000,
    "Insufficient useful GCC envelope immediately before original execution",
  );
  return remaining;
}
