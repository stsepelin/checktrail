import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { requestGradleDistribution } from "./request-gradle-distribution.mjs";
import { gradleDistributionFiles } from "../dist/src/gradle-distribution.js";
import { verifyMavenTree } from "../dist/src/maven.js";
const cache = path.resolve(".checktrail/gradle-review-tools"),
  destination = path.join(cache, "gradle-9.8.0"),
  sha256 = "bafd5ce9cfaea0fbccfdc8439a1ac42fbd4cd9c89dc9a988228d8a2639a58e6c";
await mkdir(path.dirname(cache), { recursive: true });
assert.equal(await realpath(path.dirname(cache)), path.dirname(cache));
await mkdir(cache, { recursive: true });
assert.equal(await realpath(cache), cache);
const exists = await lstat(destination).then(
  () => true,
  (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  },
);
if (exists) {
  await verifyMavenTree(destination, gradleDistributionFiles);
  process.stdout.write(
    JSON.stringify({
      version: "9.8.0",
      sha256,
      cacheHit: true,
      publisherSignatureVerified: false,
    }) + "\n",
  );
} else {
  const temporary = await mkdtemp(path.join(cache, ".prepare-"));
  try {
    const { response, attempts, redirects } = await requestGradleDistribution();
    const archive = path.join(temporary, "gradle.zip"),
      file = await open(archive, "wx", 0o600),
      digest = createHash("sha256");
    let total = 0;
    try {
      for await (const chunk of response.body) {
        total += chunk.length;
        assert.ok(total <= 151611662);
        digest.update(chunk);
        await file.writeFile(chunk);
      }
    } finally {
      await file.close();
    }
    assert.equal(total, 151611662);
    assert.equal(digest.digest("hex"), sha256);
    // Only the exact pinned upstream archive reaches the extractor.
    execFileSync("unzip", ["-q", archive, "-d", temporary], { stdio: "pipe" });
    const extracted = path.join(temporary, "gradle-9.8.0");
    await verifyMavenTree(extracted, gradleDistributionFiles);
    await rename(extracted, destination);
    process.stdout.write(
      JSON.stringify({
        version: "9.8.0",
        sha256,
        bytes: total,
        cacheHit: false,
        attempts,
        redirects,
        publisherSignatureVerified: false,
      }) + "\n",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
