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

// Operator setup only. The caller must verify the pinned digest before use.
export async function requestPinnedArtifactBytes(
  { asset, bytes },
  {
    fetchImpl = globalThis.fetch,
    signal = globalThis.AbortSignal.timeout(120000),
    delayImpl = (ms) => setTimeout(ms, undefined, { signal }),
    onRetry = () => {},
  } = {},
) {
  assert.equal(new URL(asset).protocol, "https:");
  assert.ok(
    Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 128 * 1024 * 1024,
  );
  const waits = [1000, 3000];
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    let response, downloaded;
    try {
      try {
        response = await fetchImpl(asset, { signal });
        signal.throwIfAborted();
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
        !transientCodes.has(error?.code ?? error?.cause?.code) ||
        attempt > waits.length
      )
        throw error;
      await onRetry({ attempt, waitMs: waits[attempt - 1] });
      await delayImpl(waits[attempt - 1]);
      continue;
    }
    // A complete but incorrect response is an integrity failure, not a retry.
    assert.equal(downloaded.length, bytes, "Pinned artifact byte count");
    return downloaded;
  }
}
