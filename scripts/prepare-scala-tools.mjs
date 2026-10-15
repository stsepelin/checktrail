import assert from "node:assert/strict";
import { requestScalaArchive } from "./request-scala-archive.mjs";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { scalaArtifacts } from "../dist/src/scala-artifacts.js";
const SCALA_SHA256 = scalaArtifacts.archiveSha256;
const SCALA_VERSION = scalaArtifacts.version;
const repository = await realpath(
  fileURLToPath(new URL("../", import.meta.url)),
);
const directory = path.join(repository, ".checktrail/scala-tools");
await mkdir(directory, { recursive: true });
assert.equal(
  await realpath(directory),
  directory,
  "Tool preparation cannot traverse symbolic links",
);
const filename = `scala3-${SCALA_VERSION}.zip`;
const target = path.join(directory, filename);
const expectedBytes = scalaArtifacts.archiveBytes;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const verify = (bytes) => {
  assert.equal(bytes.length, expectedBytes);
  assert.equal(digest(bytes), SCALA_SHA256);
};
const verifyCached = async () => {
  const metadata = await lstat(target);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
  assert.equal(metadata.size, expectedBytes);
  assert.equal(await realpath(target), target);
  verify(await readFile(target));
};
let cached = false;
try {
  await verifyCached();
  cached = true;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!cached) {
  const payload = await requestScalaArchive(
    {
      url: `https://github.com/scala/scala3/releases/download/${SCALA_VERSION}/${filename}`,
      bytes: expectedBytes,
      sha256: SCALA_SHA256,
    },
    {
      onRetry: ({ attempt, waitMs }) =>
        process.stderr.write(
          JSON.stringify({
            artifact: filename,
            deliveryRetry: attempt,
            waitMs,
          }) + "\n",
        ),
    },
  );
  verify(payload);
  const staging = path.join(directory, `.scala-${randomUUID()}.part`);
  try {
    await writeFile(staging, payload, { flag: "wx", mode: 0o600 });
    try {
      await link(staging, target);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await verifyCached();
    }
  } finally {
    await rm(staging, { force: true });
  }
}
process.stdout.write(
  JSON.stringify({
    artifact: filename,
    bytes: expectedBytes,
    sha256: SCALA_SHA256,
    cached,
    publisherSignatureVerified: false,
  }) + "\n",
);
