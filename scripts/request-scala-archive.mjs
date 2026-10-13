import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import { requestPinnedArtifactBytes } from "./request-pinned-artifact.mjs";
const admitted = new Set([
  "https://github.com/scala/scala3/releases/download/3.9.0/scala3-3.9.0.zip",
  "https://github.com/scala/scala/releases/download/v2.13.18/scala-2.13.18.zip",
]);
// Operator preparation only. Each retry starts at the same pinned release URL,
// so an expired/failed signed asset redirect is never reused across attempts.
export async function requestScalaArchive(
  pin,
  {
    fetchImpl = globalThis.fetch,
    signal = globalThis.AbortSignal.timeout(60000),
    ...options
  } = {},
) {
  assert.ok(
    admitted.has(pin.url),
    "Scala archive is outside the exact URL inventory",
  );
  assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  const bytes = await requestPinnedArtifactBytes(
    { asset: pin.url, bytes: pin.bytes },
    {
      ...options,
      signal,
      retryNotFound: false,
      maxArtifactBytes: 256 * 1024 * 1024,
      fetchImpl: async (asset, request) => {
        let address = new URL(asset);
        for (let hop = 0; hop < 4; hop++) {
          request.signal.throwIfAborted();
          assert.equal(address.protocol, "https:");
          assert.equal(address.port, "");
          assert.equal(address.username + address.password + address.hash, "");
          assert.ok(
            [
              "github.com",
              "release-assets.githubusercontent.com",
              "objects.githubusercontent.com",
            ].includes(address.hostname),
            "Unapproved Scala redirect host",
          );
          const response = await fetchImpl(address, {
            ...request,
            redirect: "manual",
            headers: { Accept: "application/octet-stream" },
          });
          if (request.signal.aborted) {
            await response.body?.cancel().catch(() => {});
            request.signal.throwIfAborted();
          }
          if (![301, 302, 303, 307, 308].includes(response.status))
            return response;
          const next = response.headers.get("location");
          await response.body?.cancel();
          assert.ok(next, "Tool redirect requires a Location");
          address = new URL(next, address);
        }
        assert.fail("Tool download exhausted its redirect limit");
      },
    },
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    pin.sha256,
    "Scala archive digest",
  );
  return bytes;
}
