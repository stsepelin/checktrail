import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { mavenRepositorySchema, verifyMavenTree } from "../dist/src/maven.js";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  cache = path.join(repository, ".checktrail"),
  destination = path.join(cache, "gradle-dependencies");
await mkdir(cache, { recursive: true });
assert.equal(await realpath(cache), cache);
await assert.rejects(lstat(destination), { code: "ENOENT" });
const pins = mavenRepositorySchema.parse(
    JSON.parse(
      await readFile(
        new URL("./gradle-fixture-dependencies.json", import.meta.url),
        "utf8",
      ),
    ),
  ),
  temporary = await mkdtemp(path.join(cache, ".gradle-dependencies-"));
try {
  const artifacts = path.join(temporary, "artifacts");
  await mkdir(artifacts);
  for (const pin of pins.files) {
    const response = await globalThis.fetch(
      "https://repo.maven.apache.org/maven2/" + pin.path,
      { redirect: "error", signal: globalThis.AbortSignal.timeout(30000) },
    );
    assert.equal(response.status, 200);
    assert.ok(response.body);
    let total = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      total += chunk.length;
      assert.ok(total <= pin.bytes);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.length, pin.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.sha256);
    const target = path.join(artifacts, pin.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  }
  await verifyMavenTree(artifacts, pins.files);
  const data = JSON.stringify(pins, null, 2) + "\n";
  await writeFile(path.join(temporary, "repository.json"), data, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, destination);
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      repositorySha256: createHash("sha256").update(data).digest("hex"),
      files: pins.files.length,
      bytes: pins.files.reduce((sum, pin) => sum + pin.bytes, 0),
      preparationNetworkAllowed: true,
      projectCodeExecuted: false,
      publisherSignaturesVerified: false,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
