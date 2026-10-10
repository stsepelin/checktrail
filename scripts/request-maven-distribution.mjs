import { requestPinnedArtifactBytes } from "./request-pinned-artifact.mjs";
export const mavenDistributionPin = Object.freeze({
  asset:
    "https://downloads.apache.org/maven/maven-3/3.10.0/binaries/apache-maven-3.10.0-bin.tar.gz",
  bytes: 9979885,
  sha256: "a46cc51bc74fa23fd267c7a0b9132b146dcf526da60d31aa5174e565632e9e0e",
});
// Operator preparation only; the installer still verifies the archive and complete extracted tree.
export function requestMavenDistribution({
  fetchImpl = globalThis.fetch,
  ...options
} = {}) {
  return requestPinnedArtifactBytes(mavenDistributionPin, {
    ...options,
    fetchImpl: (asset, request) =>
      fetchImpl(asset, { ...request, redirect: "error" }),
  });
}
