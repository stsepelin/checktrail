import assert from "node:assert/strict";
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
import { Buffer } from "node:buffer";
import process from "node:process";
import {
  CHECKSTYLE_SHA256,
  CHECKSTYLE_VERSION,
} from "../dist/src/checkstyle.js";
const repository = await realpath(
  fileURLToPath(new URL("../", import.meta.url)),
);
const directory = path.join(repository, ".checktrail/jvm-review-tools");
await mkdir(directory, { recursive: true });
assert.equal(
  await realpath(directory),
  directory,
  "Tool preparation cannot traverse symbolic links",
);
const filename = `checkstyle-${CHECKSTYLE_VERSION}-all.jar`;
const target = path.join(directory, filename);
const expectedBytes = 14731429;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const verify = (bytes) => {
  assert.equal(bytes.length, expectedBytes);
  assert.equal(digest(bytes), CHECKSTYLE_SHA256);
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
  const signal = globalThis.AbortSignal.timeout(60000);
  let address = new URL(
    `https://github.com/checkstyle/checkstyle/releases/download/checkstyle-${CHECKSTYLE_VERSION}/${filename}`,
  );
  let response;
  for (let hop = 0; hop < 4; hop++) {
    assert.equal(address.protocol, "https:");
    assert.equal(address.username, "");
    assert.equal(address.password, "");
    assert.equal(address.hash, "");
    assert.ok(
      [
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
      ].includes(address.hostname),
    );
    response = await globalThis.fetch(address, {
      redirect: "manual",
      signal,
      headers: { Accept: "application/octet-stream" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get("location");
      await response.body?.cancel();
      assert.ok(next, "Tool redirect requires a Location");
      address = new URL(next, address);
      response = undefined;
      continue;
    }
    assert.equal(response.status, 200);
    break;
  }
  assert.ok(response?.body, "Tool download exhausted its redirect limit");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    assert.ok(
      bytes <= expectedBytes,
      "Tool download exceeds its declared size",
    );
    chunks.push(Buffer.from(chunk));
  }
  const payload = Buffer.concat(chunks);
  verify(payload);
  const staging = path.join(directory, `.checkstyle-${randomUUID()}.part`);
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
    sha256: CHECKSTYLE_SHA256,
    cached,
    publisherSignatureVerified: false,
  }) + "\n",
);
