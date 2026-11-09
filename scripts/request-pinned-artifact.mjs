import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { URL } from "node:url";
import { setTimeout } from "node:timers/promises";

const transientCodes = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const transientStatuses = new Set([500, 502, 503, 504]);
export class PinnedArtifactHttpError extends Error {
  constructor(status) {
    super(`Pinned artifact HTTP ${status}`);
    this.status = status;
  }
}

// Fetch bodies and cancellation can remain pending after a transport signal aborts.
// Observe the same signal ourselves without adding or resetting any deadline.
function waitForRequest(action, signal) {
  let aborted;
  const result = new Promise((resolve, reject) => {
    aborted = () => reject(signal.reason);
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    try {
      Promise.resolve(action()).then(resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
  return result.finally(() => signal.removeEventListener("abort", aborted));
}

// Operator setup only. The caller must verify the pinned digest before use.
export async function requestPinnedArtifactBytes(
  { asset, bytes, fallbackAsset, fallbackAssets },
  {
    fetchImpl = globalThis.fetch,
    signal = globalThis.AbortSignal.timeout(120000),
    attemptTimeoutMs,
    delayImpl = (ms) => setTimeout(ms, undefined, { signal }),
    onRetry = () => {},
    onDiagnostic,
    retryNotFound = false,
    maxArtifactBytes = 128 * 1024 * 1024,
  } = {},
) {
  assert.equal(typeof retryNotFound, "boolean");
  assert.ok(onDiagnostic === undefined || typeof onDiagnostic === "function");
  assert.ok(
    attemptTimeoutMs === undefined ||
      (Number.isSafeInteger(attemptTimeoutMs) &&
        attemptTimeoutMs > 0 &&
        attemptTimeoutMs <= 120000),
    "Pinned artifact attempt timeout bound",
  );
  const primary = new URL(asset);
  assert.equal(primary.protocol, "https:");
  assert.ok(
    fallbackAssets === undefined ||
      (fallbackAsset === undefined &&
        Array.isArray(fallbackAssets) &&
        fallbackAssets.length > 0 &&
        fallbackAssets.length <= 2 &&
        fallbackAssets.every((value) => typeof value === "string") &&
        new Set(fallbackAssets).size === fallbackAssets.length &&
        !fallbackAssets.includes(asset)),
    "Pinned mirrors must be a unique bounded list without a legacy mirror",
  );
  for (const value of fallbackAssets ??
    (fallbackAsset === undefined ? [] : [fallbackAsset])) {
    const fallback = new URL(value);
    assert.equal(fallback.protocol, "https:");
    assert.equal(
      fallback.pathname.split("/").at(-1),
      primary.pathname.split("/").at(-1),
      "Pinned mirror must retain the exact artifact filename",
    );
    assert.equal(
      fallback.search,
      primary.search,
      "Pinned mirror must retain the exact artifact query",
    );
    assert.equal(
      fallback.username + fallback.password + fallback.hash,
      "",
      "Pinned mirror cannot contain credentials or a fragment",
    );
  }
  assert.ok(
    Number.isSafeInteger(maxArtifactBytes) &&
      maxArtifactBytes > 0 &&
      maxArtifactBytes <= 256 * 1024 * 1024,
    "Pinned artifact admission ceiling",
  );
  assert.ok(
    Number.isSafeInteger(bytes) && bytes > 0 && bytes <= maxArtifactBytes,
  );
  const mirrorAssets = [
    asset,
    ...(fallbackAssets ?? (fallbackAsset ? [fallbackAsset] : [])),
  ];
  const waits = [1000, 3000];
  let nextAsset = asset;
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    // Opt-in attempt deadlines leave time for mirrors without replacing the
    // caller's overall budget or cancellation reason.
    const attemptDeadline =
      attemptTimeoutMs === undefined
        ? undefined
        : globalThis.AbortSignal.timeout(attemptTimeoutMs);
    const requestSignal = attemptDeadline
      ? globalThis.AbortSignal.any([signal, attemptDeadline])
      : signal;
    const attemptAsset = nextAsset;
    let response, downloaded, reader;
    let ownedAttemptTimeout = false;
    // Observers cannot replace delivery failures or influence retry admission.
    const diagnostic = (phase, extra = {}, failure) => {
      if (onDiagnostic === undefined) return;
      try {
        const names = [
          "AbortError",
          "TimeoutError",
          "TypeError",
          "Error",
          "AssertionError",
          "PinnedArtifactHttpError",
        ];
        const code = failure?.code ?? failure?.cause?.code;
        const status = phase === "headers" ? response?.status : undefined;
        Promise.resolve(
          onDiagnostic({
            phase,
            attempt,
            mirrorIndex: mirrorAssets.indexOf(attemptAsset),
            overallAborted: signal.aborted === true,
            attemptAborted: attemptDeadline?.aborted === true,
            requestAborted: requestSignal.aborted === true,
            ...(status === undefined
              ? {}
              : {
                  httpStatus:
                    Number.isInteger(status) && status >= 100 && status <= 599
                      ? status
                      : null,
                }),
            ...(failure === undefined
              ? {}
              : {
                  errorName: names.includes(failure?.name)
                    ? failure.name
                    : "unclassified",
                  errorCode:
                    transientCodes.has(code) ||
                    code === "ERR_ASSERTION" ||
                    (Number.isInteger(code) && code >= 1 && code <= 30)
                      ? code
                      : null,
                  matchesRequestReason:
                    requestSignal.aborted && failure === requestSignal.reason,
                  matchesOverallReason:
                    signal.aborted && failure === signal.reason,
                }),
            ...extra,
          }),
        ).catch(() => {});
      } catch {
        // Diagnostics are observational.
      }
    };
    diagnostic("fetch-start");
    try {
      try {
        response = await fetchImpl(nextAsset, { signal: requestSignal });
        diagnostic("headers");
        requestSignal.throwIfAborted();
        if (
          transientStatuses.has(response.status) ||
          (retryNotFound && response.status === 404)
        )
          throw new PinnedArtifactHttpError(response.status);
        assert.equal(response.status, 200, "Pinned artifact HTTP response");
        assert.ok(response.body, "Pinned artifact response has no body");
        diagnostic("body-start");
        let count = 0;
        const chunks = [];
        reader = response.body.getReader();
        for (;;) {
          const { done, value } = await waitForRequest(
            () => reader.read(),
            requestSignal,
          );
          if (done) break;
          count += value.length;
          assert.ok(count <= bytes, "Pinned artifact byte limit");
          chunks.push(Buffer.from(value));
        }
        downloaded = Buffer.concat(chunks);
        diagnostic("body-complete", { receivedBytes: downloaded.length });
        // A complete but incorrect response is an integrity failure, not a retry.
        assert.equal(downloaded.length, bytes, "Pinned artifact byte count");
        requestSignal.throwIfAborted();
      } catch (error) {
        // Cleanup can outlive a failure and cross a deadline. Attribute the
        // failure before cleanup so it cannot turn an unrelated abort into retry.
        ownedAttemptTimeout =
          attemptDeadline?.aborted === true &&
          (error === attemptDeadline.reason ||
            (error instanceof globalThis.DOMException &&
              error.name === "AbortError"));
        diagnostic("failure-captured", { ownedAttemptTimeout }, error);
        throw error;
      } finally {
        // Releasing our reader also rejects an outstanding read, whose promise
        // is already observed. Cancel the actual body even when the signal has
        // expired; only waiting for cancellation is limited by that same signal.
        reader?.releaseLock();
        if (response?.body) {
          diagnostic("cleanup-start");
          let cleanupState = "pending";
          let cancellation;
          try {
            cancellation = response.body.cancel();
          } catch (error) {
            cancellation = Promise.reject(error);
          }
          const settled = Promise.resolve(cancellation).then(
            () => {
              cleanupState = "fulfilled";
            },
            () => {
              cleanupState = "rejected";
            },
          );
          await waitForRequest(() => settled, requestSignal).catch(() => {});
          // An immediately settled cancel still gets its terminal observation
          // when the request signal was already aborted before cleanup started.
          await Promise.resolve();
          diagnostic(
            cleanupState === "fulfilled"
              ? "cleanup-complete"
              : cleanupState === "rejected"
                ? "cleanup-failed"
                : "cleanup-pending",
            { cleanupSettled: cleanupState !== "pending" },
          );
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      if (
        (!ownedAttemptTimeout &&
          !(error instanceof PinnedArtifactHttpError) &&
          !transientCodes.has(error?.code ?? error?.cause?.code)) ||
        attempt > waits.length
      )
        throw error;
      // A lagging mirror can lack the exact revision still served by the primary.
      // Return there after an admitted mirror 404 within the same attempt budget.
      nextAsset = fallbackAssets
        ? (fallbackAssets[attempt - 1] ?? fallbackAssets.at(-1))
        : fallbackAsset &&
            nextAsset === fallbackAsset &&
            response?.status === 404
          ? asset
          : (fallbackAsset ?? asset);
      diagnostic("retry", {
        waitMs: waits[attempt - 1],
        nextMirrorIndex: mirrorAssets.indexOf(nextAsset),
      });
      await onRetry({ attempt, waitMs: waits[attempt - 1] });
      await delayImpl(waits[attempt - 1]);
      continue;
    }
    diagnostic("request-complete", { receivedBytes: downloaded.length });
    return downloaded;
  }
}

// Only fixed mirror labels and bounded scalar observations reach stderr.
export async function tracePinnedArtifactAcquisition(
  { artifact, artifactIndex = 0, centralMirror = false, mirrorIndexForAsset },
  acquire,
) {
  const policies = new Map([
    ["maven-distribution", [120000, 30000]],
    ["jvm-wrapper", [60000, 15000]],
    ["gradle-wrapper-distribution", [600000, undefined]],
  ]);
  assert.ok(policies.has(artifact), "Fixed acquisition diagnostic kind");
  assert.ok(
    Number.isSafeInteger(artifactIndex) &&
      artifactIndex >= 0 &&
      artifactIndex <= 255,
  );
  assert.equal(typeof centralMirror, "boolean");
  assert.equal(typeof acquire, "function");
  assert.ok(
    mirrorIndexForAsset === undefined ||
      typeof mirrorIndexForAsset === "function",
  );
  const [totalTimeoutMs, attemptTimeoutMs] = policies.get(artifact);
  const transportOnly = artifact === "gradle-wrapper-distribution";
  const signal = globalThis.AbortSignal.timeout(totalTimeoutMs);
  const started = performance.now(),
    wallStarted = Date.now();
  const labels = transportOnly
    ? [
        "gradle-services",
        "gradle-downloads",
        "github-release",
        "github-release-assets",
      ]
    : centralMirror
      ? ["maven-central"]
      : ["apache-primary", "apache-cdn", "apache-archive"];
  const phases = new Set([
    "download-start",
    "fetch-start",
    "headers",
    "body-start",
    "body-complete",
    "failure-captured",
    "cleanup-start",
    "cleanup-complete",
    "cleanup-failed",
    "cleanup-pending",
    "retry",
    "request-complete",
    "request-aborted",
    "overall-aborted",
    "download-complete",
    "download-failed",
    "file-close-start",
    "file-close-complete",
  ]);
  const errorNames = new Set([
    "AbortError",
    "TimeoutError",
    "TypeError",
    "Error",
    "AssertionError",
    "PinnedArtifactHttpError",
  ]);
  const fields = new Set([
    "attempt",
    "requestIndex",
    "waitMs",
    "httpStatus",
    "receivedBytes",
    "requestAborted",
    "attemptAborted",
    "ownedAttemptTimeout",
    "cleanupSettled",
    "matchesRequestReason",
    "matchesOverallReason",
  ]);
  const listeners = new Map();
  let records = 0,
    networkRequests = 0,
    lastRequestSignal,
    latestEvent = {},
    currentPhase = "download-start";
  const emit = (phase, event = {}) => {
    if (records++ > 48) return;
    try {
      if (records === 49) {
        process.stderr.write(
          JSON.stringify({
            artifact,
            artifactIndex,
            phase: "diagnostics-truncated",
            limit: 48,
          }) + "\n",
        );
        return;
      }
      const knownPhase = phases.has(phase) ? phase : "unrecognized-phase";
      const during = currentPhase;
      if (knownPhase !== "overall-aborted" && knownPhase !== "request-aborted")
        currentPhase = knownPhase;
      const safe = Object.fromEntries(
        Object.entries(event).filter(
          ([key, value]) =>
            fields.has(key) &&
            (typeof value === "boolean" ||
              (Number.isSafeInteger(value) && value >= 0)),
        ),
      );
      if (errorNames.has(event.errorName)) safe.errorName = event.errorName;
      if (
        transientCodes.has(event.errorCode) ||
        event.errorCode === "ERR_ASSERTION" ||
        (Number.isInteger(event.errorCode) &&
          event.errorCode >= 1 &&
          event.errorCode <= 30)
      )
        safe.errorCode = event.errorCode;
      process.stderr.write(
        JSON.stringify({
          artifact,
          artifactIndex,
          phase: knownPhase,
          during,
          elapsedMs: Math.max(0, Math.round(performance.now() - started)),
          wallElapsedMs: Math.max(0, Date.now() - wallStarted),
          ...(phase === "download-start"
            ? {
                node: process.version,
                undici: process.versions.undici ?? "unavailable",
                totalTimeoutMs,
                attemptTimeoutMs,
              }
            : {}),
          ...safe,
          requestIndex: networkRequests,
          attempt: safe.attempt ?? latestEvent.attempt,
          mirror:
            labels[event.mirrorIndex ?? latestEvent.mirrorIndex] ??
            "unrecognized",
          nextMirror:
            event.nextMirrorIndex === undefined
              ? undefined
              : (labels[event.nextMirrorIndex] ?? "unrecognized"),
          overallAborted: signal.aborted,
          requestAborted:
            safe.requestAborted ?? lastRequestSignal?.aborted ?? false,
        }) + "\n",
      );
    } catch {
      // Observations cannot replace the acquisition result.
    }
  };
  const abort = () => emit("overall-aborted");
  signal.addEventListener("abort", abort, { once: true });
  emit("download-start");
  try {
    const result = await acquire({
      signal,
      attemptTimeoutMs,
      onDiagnostic: (event) => {
        latestEvent = event;
        emit(event.phase, event);
        if (
          [
            "cleanup-complete",
            "cleanup-failed",
            "cleanup-pending",
            "retry",
            "request-complete",
          ].includes(event.phase)
        ) {
          const listener = listeners.get(event.attempt);
          if (listener) {
            listener.signal.removeEventListener("abort", listener.aborted);
            listeners.delete(event.attempt);
          }
        }
      },
      fetchImpl: (asset, options) => {
        // Requests are sequential. Retire the previous listener before a redirect.
        if (transportOnly) {
          for (const { signal: previous, aborted } of listeners.values())
            previous.removeEventListener("abort", aborted);
          listeners.clear();
        }
        let mirrorIndex = latestEvent.mirrorIndex;
        if (transportOnly) {
          // Labels are fixed here; the consumer can identify an admitted redirect.
          mirrorIndex = undefined;
          try {
            mirrorIndex = mirrorIndexForAsset?.(asset);
          } catch {
            /* Observational only. */
          }
        }
        const requestIndex = ++networkRequests;
        const metadata = {
          attempt: latestEvent.attempt,
          requestIndex,
          mirrorIndex,
        };
        if (transportOnly) latestEvent = metadata;
        lastRequestSignal = options.signal;
        const aborted = () =>
          emit("request-aborted", {
            ...metadata,
            requestAborted: true,
          });
        if (options.signal.aborted) aborted();
        else {
          options.signal.addEventListener("abort", aborted, { once: true });
          listeners.set(requestIndex, { signal: options.signal, aborted });
        }
        if (!transportOnly) return globalThis.fetch(asset, options);
        emit("fetch-start", metadata);
        return globalThis.fetch(asset, options).then(
          (response) => {
            emit("headers", { ...metadata, httpStatus: response.status });
            return response;
          },
          (error) => {
            try {
              emit("failure-captured", {
                ...metadata,
                errorName: error?.name,
                matchesRequestReason:
                  options.signal.aborted && error === options.signal.reason,
              });
            } catch {
              /* Observations cannot replace failures. */
            }
            throw error;
          },
        );
      },
      report: (phase, event = {}) => emit(phase, event),
    });
    emit("download-complete", { receivedBytes: result?.length });
    return result;
  } catch (error) {
    try {
      emit("download-failed", {
        errorName: error?.name,
        matchesOverallReason: signal.aborted && error === signal.reason,
        matchesRequestReason:
          lastRequestSignal?.aborted && error === lastRequestSignal.reason,
      });
    } catch {
      // An error's diagnostic properties are not part of delivery.
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    for (const { signal: requestSignal, aborted } of listeners.values())
      requestSignal.removeEventListener("abort", aborted);
  }
}

// Exact alternative delivery endpoints, resolved from the publishers' release
// metadata. Callers still verify their existing archive length and digest.
const authenticatedReleaseAssets = new Map([
  [
    "https://github.com/yannh/kubeconform/releases/download/v0.8.0/kubeconform-linux-arm64.tar.gz",
    "https://api.github.com/repos/yannh/kubeconform/releases/assets/438612685",
  ],
  [
    "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize/v5.8.2/kustomize_v5.8.2_linux_arm64.tar.gz",
    "https://api.github.com/repos/kubernetes-sigs/kustomize/releases/assets/600925223",
  ],
  [
    "https://github.com/scala/scala3/releases/download/3.9.0/scala3-3.9.0.zip",
    "https://api.github.com/repos/scala/scala3/releases/assets/530989006",
  ],
  [
    "https://github.com/scala/scala/releases/download/v2.13.18/scala-2.13.18.zip",
    "https://api.github.com/repos/scala/scala/releases/assets/317382229",
  ],
]);

/** Operator preparation only; the CI token is never sent to asset/CDN hosts. */
export function createPinnedGitHubFetch({
  fetchImpl = globalThis.fetch,
  token = process.env.CHECKTRAIL_GITHUB_ARTIFACT_TOKEN,
} = {}) {
  // Credentials are opaque. Check visible ASCII header safety without assuming
  // a GitHub prefix, encoding, decoded content, or fixed token length.
  if (token !== undefined && token !== "")
    assert.ok(
      typeof token === "string" && !/[^\x21-\x7e]/u.test(token),
      "Invalid pinned artifact credentials",
    );
  return async (asset, request) => {
    const endpoint = authenticatedReleaseAssets.get(String(asset));
    if (!token || !endpoint) return fetchImpl(asset, request);
    const signal = request?.signal;
    assert.ok(
      signal,
      "Authenticated artifact delivery requires a request deadline",
    );
    let address = new URL(endpoint);
    for (let hop = 0; hop < 4; hop++) {
      signal.throwIfAborted();
      const response = await fetchImpl(address.href, {
        ...request,
        redirect: "manual",
        headers:
          hop === 0
            ? {
                Accept: "application/octet-stream",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": "2026-03-10",
              }
            : { Accept: "application/octet-stream" },
      });
      if (signal.aborted) {
        const cancellation = Promise.resolve()
          .then(() => response.body?.cancel())
          .catch(() => {});
        await waitForRequest(() => cancellation, signal).catch(() => {});
        signal.throwIfAborted();
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const next = response.headers.get("location");
      const cancellation = Promise.resolve().then(() =>
        response.body?.cancel(),
      );
      cancellation.catch(() => {});
      await waitForRequest(() => cancellation, signal);
      assert.ok(next, "Pinned artifact redirect requires a Location");
      address = new URL(next, address);
      assert.ok(
        address.protocol === "https:" &&
          address.port === "" &&
          address.username + address.password + address.hash === "" &&
          [
            "release-assets.githubusercontent.com",
            "objects.githubusercontent.com",
          ].includes(address.hostname),
        "Unapproved pinned GitHub artifact redirect",
      );
    }
    assert.fail("Pinned GitHub artifact redirect limit");
  };
}
