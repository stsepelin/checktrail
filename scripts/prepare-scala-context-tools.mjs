import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { scalaLibraries, scalaHash } from "../dist/src/scala-archive.js";
const repository = await realpath(
    fileURLToPath(new URL("../", import.meta.url)),
  ),
  directory = path.join(repository, ".checktrail/scala-tools"),
  target = path.join(directory, "lib");
assert.equal(
  await realpath(directory),
  directory,
  "Tool preparation cannot traverse symbolic links",
);
const archive = path.join(directory, "scala3-3.9.0.zip"),
  metadata = await lstat(archive);
assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
assert.equal(await realpath(archive), archive);
// Verify the entire archive and every selected library before creating any output.
const libraries = scalaLibraries(await readFile(archive));
async function verify() {
  const metadata = await lstat(target);
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
  assert.equal(await realpath(target), target);
  assert.deepEqual(
    (await readdir(target)).sort(),
    [...libraries.keys()].sort(),
  );
  for (const [name, bytes] of libraries) {
    const file = path.join(target, name),
      stat = await lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(await realpath(file), file);
    assert.deepEqual(await readFile(file), bytes);
  }
}
let cached = false;
try {
  await verify();
  cached = true;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  try {
    await lstat(target);
    throw Error("Existing Scala context library directory is incomplete", {
      cause: error,
    });
  } catch (absent) {
    if (absent.code !== "ENOENT") throw absent;
  }
}
if (!cached) {
  const staging = path.join(directory, ".context-lib-" + randomUUID());
  try {
    await mkdir(staging);
    for (const [name, bytes] of libraries)
      await writeFile(path.join(staging, name), bytes, {
        flag: "wx",
        mode: 0o444,
      });
    await rename(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await verify();
}
process.stdout.write(
  JSON.stringify({
    cached,
    libraries: [...libraries].map(([name, bytes]) => ({
      name,
      bytes: bytes.length,
      sha256: scalaHash(bytes),
    })),
    publisherSignatureVerified: false,
  }) + "\n",
);
