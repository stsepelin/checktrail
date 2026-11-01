// One direct service observation; no fetch occurs when this module is imported.
import assert from "node:assert/strict";
import https from "node:https";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
import { performance } from "node:perf_hooks";
import { gccJobEnvelopePolicy, githubGccJobsUrl } from "./gcc-job-envelope.mjs";

export function githubGccContextFromEnvironment(environment) {
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
  })) {
    assert.equal(
      environment[key],
      value,
      "Unknown GitHub carrier environment: " + key,
    );
  }
  return {
    repository: environment.GITHUB_REPOSITORY,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
    jobName: environment.GITHUB_JOB,
    headSha: environment.GITHUB_SHA,
  };
}

export async function captureGithubGccJobClock(context, options) {
  const {
    carrierStartedAt,
    carrierMonotonicStarted,
    token,
    request = https.request,
    monotonic = () => performance.now(),
    utc = () => new Date().toISOString(),
    startTimer = setTimeout,
    stopTimer = clearTimeout,
  } = options;
  const selectedContext = Object.freeze({ ...context });
  const url = githubGccJobsUrl(selectedContext);
  assert.equal(typeof token, "string");
  assert.ok(
    token.length > 0 && token.length <= 4096 && !/[\r\n]/u.test(token),
    "A bounded operator GitHub token is required",
  );
  assert.ok(Number.isFinite(carrierMonotonicStarted));
  const start = monotonic(),
    requestStartedAt = utc();
  assert.ok(Number.isFinite(start) && start >= carrierMonotonicStarted);
  const maximum = gccJobEnvelopePolicy.maximumResponseBytes;
  return new Promise((resolve, reject) => {
    let req,
      response,
      timer,
      ended = false,
      complete = false;
    let observed = 0,
      retained = 0;
    const chunks = [];
    const snapshot = () => ({
      context: selectedContext,
      url,
      carrierStartedAt,
      carrierElapsedMs: monotonic() - carrierMonotonicStarted,
      requestStartedAt,
      receivedAt: utc(),
      requestElapsedMs: monotonic() - start,
      httpStatus: response?.statusCode ?? null,
      serviceDate: response?.headers.date ?? null,
      contentType: response?.headers["content-type"] ?? null,
      contentEncoding: response?.headers["content-encoding"] ?? null,
      requestId: response?.headers["x-github-request-id"] ?? null,
      responseBytes: Buffer.concat(chunks, retained),
      responseComplete: complete,
      observedResponseBytes: observed,
      retainedResponseBytes: retained,
      observedUnretainedBytes: observed - retained,
      unreadResponseRemainderMagnitudeKnown: complete,
      requestAuthenticationHeadersRetained: false,
    });
    const finish = (error) => {
      if (ended) return;
      ended = true;
      if (timer) stopTimer(timer);
      const capture = snapshot();
      if (error) {
        error.jobClockCapture = capture;
        try {
          response?.destroy();
        } catch (secondary) {
          error.responseCloseFailure = String(secondary);
        }
        try {
          req?.destroy();
        } catch (secondary) {
          error.requestCloseFailure = String(secondary);
        }
        reject(error);
      } else resolve(capture);
    };
    try {
      req = request(
        url,
        {
          method: "GET",
          headers: {
            Accept: "application/vnd.github+json",
            "Accept-Encoding": "identity",
            "User-Agent": "checktrail-original-gcc-job-clock",
            "Cache-Control": "no-cache",
            "X-GitHub-Api-Version": "2026-03-10",
            Authorization: "Bearer " + token,
          },
          agent: false,
        },
        (incoming) => {
          response = incoming;
          response.on("data", (part) => {
            if (ended) return;
            try {
              assert.ok(
                Buffer.isBuffer(part),
                "Raw job-clock response must be bytes",
              );
              observed += part.length;
              const accepted = part.subarray(
                0,
                Math.max(0, maximum - retained),
              );
              if (accepted.length) {
                chunks.push(Buffer.from(accepted));
                retained += accepted.length;
              }
              assert.ok(
                observed <= maximum,
                "Job-clock observed response byte cap exceeded",
              );
            } catch (error) {
              finish(error);
            }
          });
          response.once("aborted", () =>
            finish(new Error("Job-clock response aborted")),
          );
          response.once("error", finish);
          response.once("end", () => {
            if (!ended) {
              complete = true;
              finish();
            }
          });
          response.once("close", () => {
            if (!complete && !ended)
              finish(new Error("Job-clock response closed before EOF"));
          });
        },
      );
      if (ended) {
        req.destroy();
        return;
      }
      req.once("error", finish);
      timer = startTimer(
        () => finish(new Error("Job-clock global request deadline")),
        gccJobEnvelopePolicy.maximumRequestMs,
      );
      req.end();
    } catch (error) {
      finish(error);
    }
  });
}

export async function captureAndRetainGithubGccJobClock(
  context,
  options,
  retain,
) {
  assert.equal(typeof retain, "function");
  let capture;
  try {
    capture = await captureGithubGccJobClock(context, options);
  } catch (primary) {
    if (primary.jobClockCapture) {
      try {
        await retain(primary.jobClockCapture);
      } catch (secondary) {
        primary.retentionFailure = String(secondary);
      }
    }
    throw primary;
  }
  await retain(capture);
  return capture;
}
