import process from "node:process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { mavenDistributionFiles } from "../dist/src/maven-distribution.js";
import { verifyMavenTree } from "../dist/src/maven.js";
import {
  mavenDistributionPin,
  requestMavenDistribution,
} from "./request-maven-distribution.mjs";
const cache = path.resolve(".checktrail/maven-review-tools"),
  destination = path.join(cache, "apache-maven-3.10.0");
const { sha256 } = mavenDistributionPin;
const parent = path.dirname(cache);
await mkdir(parent, { recursive: false }).catch((error) => {
  if (error.code !== "EEXIST") throw error;
});
assert.equal(await (await import("node:fs/promises")).realpath(parent), parent);
await mkdir(cache, { recursive: true });
assert.equal(await (await import("node:fs/promises")).realpath(cache), cache);
const exists = await lstat(destination).then(
  () => true,
  (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  },
);
if (exists) {
  await verifyMavenTree(destination, mavenDistributionFiles);
  process.stdout.write(
    JSON.stringify({
      version: "3.10.0",
      sha256,
      cacheHit: true,
      publisherSignatureVerified: false,
    }) + "\n",
  );
} else {
  const temporary = await mkdtemp(path.join(cache, ".prepare-"));
  try {
    const bytes = await requestMavenDistribution();
    assert.equal(bytes.length, mavenDistributionPin.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
    const archive = path.join(temporary, "maven.tar.gz");
    await writeFile(archive, bytes, { flag: "wx", mode: 0o600 });
    // Only the exact pinned Apache artifact reaches tar; verify the extracted inventory before publishing.
    execFileSync("tar", ["-xzf", archive, "-C", temporary], { stdio: "pipe" });
    const extracted = path.join(temporary, "apache-maven-3.10.0");
    await verifyMavenTree(extracted, mavenDistributionFiles);
    await rename(extracted, destination);
    process.stdout.write(
      JSON.stringify({
        version: "3.10.0",
        sha256,
        cacheHit: false,
        publisherSignatureVerified: false,
      }) + "\n",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
