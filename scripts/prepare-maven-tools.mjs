import process from "node:process";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { mavenDistributionFiles } from "../dist/src/maven-distribution.js";
import { verifyMavenTree } from "../dist/src/maven.js";
const cache = path.resolve(".checktrail/maven-review-tools"),
  destination = path.join(cache, "apache-maven-3.10.0");
const sha256 =
  "a46cc51bc74fa23fd267c7a0b9132b146dcf526da60d31aa5174e565632e9e0e";
const url =
  "https://downloads.apache.org/maven/maven-3/3.10.0/binaries/apache-maven-3.10.0-bin.tar.gz";
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
    const response = await globalThis.fetch(url, {
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200);
    let total = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      total += chunk.length;
      assert.ok(total <= 9979885);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.length, 9979885);
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
