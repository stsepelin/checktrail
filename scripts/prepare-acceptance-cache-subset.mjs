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
import { URL } from "node:url";
import process from "node:process";
assert.equal(
  process.argv.length,
  4,
  "Pass prepared npm cache and new owned destination",
);
const source = await realpath(process.argv[2]),
  destination = path.resolve(process.argv[3]);
assert.notEqual(source, destination);
assert.equal(
  await realpath(path.dirname(destination)),
  path.dirname(destination),
);
await assert.rejects(lstat(destination), { code: "ENOENT" });
const lock = JSON.parse(
  await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
);
assert.equal(lock.lockfileVersion, 3);
const entries = new Map();
for (const [name, entry] of Object.entries(lock.packages)) {
  if (!name || entry.dev) continue;
  assert.ok(name.startsWith("node_modules/") && !entry.link && !entry.inBundle);
  assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
  assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  const digest = Buffer.from(entry.integrity.slice(7), "base64").toString(
    "hex",
  );
  assert.equal(digest.length, 128);
  entries.set(digest, {
    integrity: entry.integrity,
    file: path.join(
      "_cacache/content-v2/sha512",
      digest.slice(0, 2),
      digest.slice(2, 4),
      digest.slice(4),
    ),
  });
}
// Validate all locked registry content before creating any cache output. No registry metadata or historical local package tarballs are needed.
const prepared = [];
for (const entry of entries.values()) {
  const file = path.join(source, entry.file),
    stat = await lstat(file);
  assert.ok(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size > 0 &&
      stat.size <= 64 * 1048576,
  );
  assert.equal(await realpath(file), file);
  const bytes = await readFile(file);
  assert.equal(bytes.length, stat.size);
  assert.equal(
    "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    entry.integrity,
  );
  prepared.push({ ...entry, bytes });
}
assert.ok(prepared.length > 0);
const temporary = await mkdtemp(
  path.join(path.dirname(destination), "locked-cache-"),
);
let published = false;
try {
  for (const entry of prepared) {
    const file = path.join(temporary, entry.file);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, entry.bytes, { flag: "wx" });
  }
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  await rename(temporary, destination);
  published = true;
  process.stdout.write(
    JSON.stringify({
      lockedRegistryTarballs: prepared.length,
      bytes: prepared.reduce((n, e) => n + e.bytes.length, 0),
      lockSha256: createHash("sha256")
        .update(
          await readFile(new URL("../package-lock.json", import.meta.url)),
        )
        .digest("hex"),
      registryMetadataCopied: false,
      historicalLocalPackageTarballsCopied: false,
    }) + "\n",
  );
} finally {
  if (!published) await rm(temporary, { recursive: true, force: true });
}
