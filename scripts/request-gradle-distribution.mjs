import assert from "node:assert/strict";
import { URL } from "node:url";
import { setTimeout } from "node:timers/promises";
const distributionPath = "/distributions/gradle-9.8.0-bin.zip";
const githubPath =
  "/gradle/gradle-distributions/releases/download/v9.8.0/gradle-9.8.0-bin.zip";
function validate(url) {
  assert.equal(url.protocol, "https:");
  assert.equal(url.username + url.password + url.hash, "");
  assert.equal(url.port, "");
  assert.ok(
    [
      "services.gradle.org",
      "downloads.gradle.org",
      "github.com",
      "release-assets.githubusercontent.com",
    ].includes(url.hostname),
    "Gradle distribution redirect host is outside the pinned allowlist",
  );
  if (url.hostname === "github.com") assert.equal(url.pathname, githubPath);
  if (["services.gradle.org", "downloads.gradle.org"].includes(url.hostname))
    assert.equal(url.pathname, distributionPath);
}
/** Setup only. The caller must still verify the exact archive bytes/digest before extraction. */
export async function requestGradleDistribution({
  fetchImpl = globalThis.fetch,
  signal = globalThis.AbortSignal.timeout(120000),
  delayImpl = (ms) => setTimeout(ms, undefined, { signal }),
} = {}) {
  let lastFailure;
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal.throwIfAborted();
    let url = new URL("https://services.gradle.org" + distributionPath);
    for (let hop = 0; hop < 5; hop++) {
      validate(url); // Boundary failures are never retried as network failures.
      let response;
      try {
        response = await fetchImpl(url, {
          redirect: "manual",
          signal,
          headers: { "cache-control": "no-cache" },
        });
      } catch (error) {
        if (signal.aborted) throw error;
        lastFailure = new Error(
          "Gradle distribution request failed at " +
            url.hostname +
            " (attempt " +
            attempt +
            "/3)",
          { cause: error },
        );
        break;
      }
      if (response.status === 200) {
        assert.ok(response.body, "Gradle distribution response has no body");
        return { response, attempts: attempt, redirects: hop };
      }
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        lastFailure = new Error(
          "Gradle distribution request returned HTTP " +
            response.status +
            " from " +
            url.hostname +
            " (attempt " +
            attempt +
            "/3)",
        );
        break;
      }
      assert.ok(location, "Gradle distribution redirect has no location");
      url = new URL(location, url);
      if (hop === 4)
        lastFailure = new Error(
          "Gradle distribution redirect limit reached (attempt " +
            attempt +
            "/3)",
        );
    }
    if (attempt < 3) await delayImpl(attempt * 500);
  }
  throw lastFailure;
}
