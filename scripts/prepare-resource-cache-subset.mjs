// Copy only SRI-verified public registry bytes from both selected release graphs.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
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
import { URL } from "node:url";
assert.equal(
  process.argv.length,
  4,
  "Expected prepared cache and a new owned destination",
);
const source = await realpath(process.argv[2]),
  destination = path.resolve(process.argv[3]);
assert.notEqual(source, destination);
assert.equal(
  await realpath(path.dirname(destination)),
  path.dirname(destination),
);
await assert.rejects(lstat(destination), { code: "ENOENT" });
const entries = new Map(),
  locks = [];
let total = 0;
for (const input of [
  new URL("../package-lock.json", import.meta.url),
  new URL("./release-readiness-tools/package-lock.json", import.meta.url),
]) {
  const bytes = await readFile(input);
  assert.ok(bytes.length <= 2 * 1048576);
  locks.push(createHash("sha256").update(bytes).digest("hex"));
  const lock = JSON.parse(bytes);
  assert.equal(lock.lockfileVersion, 3);
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name || entry.dev) continue;
    assert.ok(
      name.startsWith("node_modules/") && !entry.link && !entry.inBundle,
    );
    if (name === "node_modules/@stsepelin/checktrail") {
      assert.equal(entry.resolved, "file:baseline.tgz");
      continue;
    }
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    const hex = Buffer.from(entry.integrity.slice(7), "base64").toString("hex");
    assert.equal(hex.length, 128);
    entries.set(hex, {
      integrity: entry.integrity,
      file: path.join(
        "_cacache/content-v2/sha512",
        hex.slice(0, 2),
        hex.slice(2, 4),
        hex.slice(4),
      ),
    });
  }
}
assert.ok(entries.size > 0 && entries.size <= 256);
const selected = [];
for (const entry of entries.values()) {
  const file = path.join(source, entry.file),
    before = await lstat(file);
  assert.ok(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.size > 0 &&
      before.size <= 64 * 1048576,
  );
  assert.equal(await realpath(file), file);
  const bytes = await readFile(file),
    after = await lstat(file);
  assert.equal(bytes.length, before.size);
  for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"])
    assert.equal(before[key], after[key]);
  assert.equal(
    "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    entry.integrity,
  );
  total += bytes.length;
  assert.ok(total <= 128 * 1048576);
  selected.push({ ...entry, bytes });
}
const staging = await mkdtemp(
  path.join(path.dirname(destination), "resource-public-cache-"),
);
let published = false;
try {
  for (const entry of selected) {
    const file = path.join(staging, entry.file);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, entry.bytes, { flag: "wx" });
  }
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  await rename(staging, destination);
  published = true;
  process.stdout.write(
    JSON.stringify({
      lockedRegistryTarballs: selected.length,
      bytes: total,
      lockSha256: locks,
      registryMetadataCopied: false,
      historicalLocalPackageTarballsCopied: false,
    }) + "\n",
  );
} finally {
  if (!published) await rm(staging, { recursive: true, force: true });
}
