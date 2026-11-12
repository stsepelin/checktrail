// Shared CI metadata transport only; no consumer, SDK, project or dependency imports.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, realpath, open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function requireNativeCIPrivateMode(stat, mode) {
  // The new native producer runs on Linux. Existing Windows consumer custody
  // retains its original positive ACL implementation and is not routed here.
  assert.notEqual(
    process.platform,
    "win32",
    "Private POSIX metadata storage is unavailable on Windows",
  );
  assert.equal(stat.uid, BigInt(process.getuid()));
  assert.equal(stat.mode & 0o777n, BigInt(mode));
}
export async function requireNativeCIArtifactDirectory(filename) {
  assert.equal(await realpath(filename), filename);
  const stat = await lstat(filename);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
}
async function readPhysical(filename, privateFile = false) {
  assert.equal(await realpath(filename), filename);
  const before = await lstat(filename, { bigint: true });
  assert.ok(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1n &&
      before.size > 0n &&
      before.size <= 1048576n,
  );
  if (privateFile) requireNativeCIPrivateMode(before, 0o600);
  const fd = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const initial = await fd.stat({ bigint: true });
    for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"])
      assert.equal(initial[field], before[field]);
    const parts = [];
    let total = 0;
    for (;;) {
      const bytes = Buffer.alloc(65536),
        read = await fd.read(bytes, 0, bytes.length, null);
      if (!read.bytesRead) break;
      total += read.bytesRead;
      assert.ok(total <= 1048576);
      parts.push(bytes.subarray(0, read.bytesRead));
    }
    const after = await fd.stat({ bigint: true }),
      linked = await lstat(filename, { bigint: true });
    for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
      assert.equal(after[field], before[field]);
      assert.equal(linked[field], before[field]);
    }
    if (privateFile) {
      requireNativeCIPrivateMode(after, 0o600);
      requireNativeCIPrivateMode(linked, 0o600);
    }
    assert.equal(BigInt(total), before.size);
    assert.equal(await realpath(filename), filename);
    const bytes = Buffer.concat(parts, total);
    return { bytes, sha256: hash(bytes) };
  } finally {
    await fd.close();
  }
}

export async function readNativeCIArtifact(filename) {
  return JSON.parse((await readPhysical(filename)).bytes.toString("utf8"));
}
export async function requireNativeCIPrivateDirectory(filename) {
  await requireNativeCIArtifactDirectory(filename);
  requireNativeCIPrivateMode(await lstat(filename, { bigint: true }), 0o700);
}
export async function readNativeCIPrivateFile(filename) {
  await requireNativeCIPrivateDirectory(path.dirname(filename));
  return readPhysical(filename, true);
}
/** Exact bounded private metadata write: exclusive 0600, fsync, physical reread. */
export async function writeNativeCIPrivateFile(filename, bytes) {
  assert.ok(
    Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 1048576,
  );
  await requireNativeCIPrivateDirectory(path.dirname(filename));
  const fd = await open(filename, "wx", 0o600);
  try {
    await fd.writeFile(bytes);
    await fd.sync();
  } finally {
    await fd.close();
  }
  const copied = await readNativeCIPrivateFile(filename);
  assert.equal(copied.bytes.length, bytes.length);
  assert.equal(copied.sha256, hash(bytes));
  return { bytes: bytes.length, sha256: copied.sha256 };
}
