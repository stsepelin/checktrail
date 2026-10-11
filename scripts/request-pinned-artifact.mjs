import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
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
class TransientArtifactResponseError extends Error {}

// Operator setup only. The caller must verify the pinned digest before use.
export async function requestPinnedArtifactBytes(
  { asset, bytes, fallbackAsset, fallbackAssets },
  {
    fetchImpl = globalThis.fetch,
    signal = globalThis.AbortSignal.timeout(120000),
    delayImpl = (ms) => setTimeout(ms, undefined, { signal }),
    onRetry = () => {},
    retryNotFound = false,
  } = {},
) {
  assert.equal(typeof retryNotFound, "boolean");
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
    Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 128 * 1024 * 1024,
  );
  const waits = [1000, 3000];
  let nextAsset = asset;
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    let response, downloaded;
    try {
      try {
        response = await fetchImpl(nextAsset, { signal });
        signal.throwIfAborted();
        if (
          transientStatuses.has(response.status) ||
          (retryNotFound && response.status === 404)
        )
          throw new TransientArtifactResponseError(
            `Pinned artifact HTTP ${response.status}`,
          );
        assert.equal(response.status, 200, "Pinned artifact HTTP response");
        assert.ok(response.body, "Pinned artifact response has no body");
        let count = 0;
        const chunks = [];
        for await (const chunk of response.body) {
          count += chunk.length;
          assert.ok(count <= bytes, "Pinned artifact byte limit");
          chunks.push(Buffer.from(chunk));
        }
        signal.throwIfAborted();
        downloaded = Buffer.concat(chunks);
      } finally {
        await response?.body?.cancel().catch(() => {});
      }
    } catch (error) {
      signal.throwIfAborted();
      if (
        (!(error instanceof TransientArtifactResponseError) &&
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
      await onRetry({ attempt, waitMs: waits[attempt - 1] });
      await delayImpl(waits[attempt - 1]);
      continue;
    }
    // A complete but incorrect response is an integrity failure, not a retry.
    assert.equal(downloaded.length, bytes, "Pinned artifact byte count");
    return downloaded;
  }
}
