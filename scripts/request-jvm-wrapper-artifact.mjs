import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { requestPinnedArtifactBytes } from "./request-pinned-artifact.mjs";

const apachePaths = [
  "/maven/maven-3/3.10.0/binaries/apache-maven-3.10.0-bin.zip",
  "/maven/maven-3/3.10.0/binaries/apache-maven-3.10.0-bin.zip.asc",
  "/maven/KEYS",
];
const centralPaths = [
  "/maven2/org/apache/maven/wrapper/maven-wrapper/3.3.4/maven-wrapper-3.3.4.jar",
  "/maven2/org/apache/maven/wrapper/maven-wrapper/3.3.4/maven-wrapper-3.3.4.jar.asc",
  "/maven2/org/apache/maven/wrapper/maven-wrapper-distribution/3.3.4/maven-wrapper-distribution-3.3.4-bin.zip",
  "/maven2/org/apache/maven/wrapper/maven-wrapper-distribution/3.3.4/maven-wrapper-distribution-3.3.4-bin.zip.asc",
];
const admitted = new Map([
  ...apachePaths.map((suffix) => [
    "https://downloads.apache.org" + suffix,
    [
      "https://dlcdn.apache.org" + suffix,
      "https://archive.apache.org/dist" + suffix,
    ],
  ]),
  ...centralPaths.map((suffix) => [
    "https://repo.maven.apache.org" + suffix,
    undefined,
  ]),
]);

// Operator preparation only. Alternate delivery must retain the caller's exact byte and digest pins.
export async function requestJvmWrapperArtifact(
  pin,
  {
    fetchImpl = globalThis.fetch,
    signal = globalThis.AbortSignal.timeout(60000),
    ...options
  } = {},
) {
  assert.ok(
    admitted.has(pin.url),
    "JVM wrapper artifact is outside the exact setup URL inventory",
  );
  assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  const bytes = await requestPinnedArtifactBytes(
    {
      asset: pin.url,
      bytes: pin.bytes,
      fallbackAssets: admitted.get(pin.url),
    },
    {
      ...options,
      signal,
      // Missing or moved pinned assets fail; only admitted transport/5xx failures retry.
      retryNotFound: false,
      fetchImpl: (asset, request) =>
        fetchImpl(asset, { ...request, redirect: "error" }),
    },
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    pin.sha256,
    "JVM wrapper artifact digest",
  );
  return bytes;
}
