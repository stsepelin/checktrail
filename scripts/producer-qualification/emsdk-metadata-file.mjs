// Bounded local data reads. Production archive identities remain fixed by its caller.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { digest } from "./emsdk-metadata-values.mjs";

const maximumFileBytes = 67108864;
const identity = (value) => [
  value.dev,
  value.ino,
  value.size,
  value.uid,
  value.mode,
  value.mtimeNs,
  value.ctimeNs,
];

export function readExactDescriptor(
  fd,
  { bytes, deadline, now = () => performance.now() },
) {
  assert.ok(
    Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= maximumFileBytes,
    "Pinned file read bound exceeded",
  );
  assert.ok(Number.isFinite(deadline));
  const checkDeadline = () =>
    assert.ok(now() < deadline, "Pinned file read deadline exhausted");
  checkDeadline();
  const before = fs.fstatSync(fd, { bigint: true });
  assert.ok(before.isFile(), "Pinned input must be a regular file");
  assert.equal(before.size, BigInt(bytes), "Pinned file initial size mismatch");
  const chunk = Buffer.alloc(Math.min(65536, bytes + 1));
  const pieces = [];
  let count = 0;
  for (;;) {
    checkDeadline();
    // Once exactly bytes have been consumed, read one byte solely to detect growth.
    const requested = Math.min(chunk.length, bytes - count + 1);
    const length = fs.readSync(fd, chunk, 0, requested, count);
    checkDeadline();
    assert.ok(
      Number.isSafeInteger(length) && length >= 0 && length <= requested,
    );
    if (length === 0) break;
    count += length;
    assert.ok(count <= bytes, "Pinned file exceeded expected byte bound");
    pieces.push(Buffer.from(chunk.subarray(0, length)));
  }
  assert.equal(count, bytes, "Pinned file was truncated during bounded read");
  assert.deepEqual(
    identity(fs.fstatSync(fd, { bigint: true })),
    identity(before),
    "Pinned file identity changed during bounded read",
  );
  checkDeadline();
  return Buffer.concat(pieces, count);
}

export function readPinnedFile(file, { bytes, sha256, deadline }) {
  assert.equal(path.resolve(file), file);
  assert.equal(
    fs.realpathSync(file),
    file,
    "Pinned file path cannot use symlink aliases",
  );
  assert.match(sha256, /^[0-9a-f]{64}$/u);
  assert.ok(
    Number.isFinite(deadline) && performance.now() < deadline,
    "Pinned file read deadline exhausted",
  );
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    assert.deepEqual(
      identity(fs.lstatSync(file, { bigint: true })),
      identity(before),
      "Pinned file path identity differs",
    );
    if (process.getuid) assert.equal(before.uid, BigInt(process.getuid()));
    const body = readExactDescriptor(fd, { bytes, deadline });
    assert.equal(digest(body), sha256, "Original source archive hash mismatch");
    assert.equal(
      fs.realpathSync(file),
      file,
      "Pinned file path changed during bounded read",
    );
    assert.deepEqual(
      identity(fs.lstatSync(file, { bigint: true })),
      identity(before),
      "Pinned file path changed during bounded read",
    );
    assert.ok(
      performance.now() < deadline,
      "Pinned file read deadline exhausted",
    );
    return body;
  } finally {
    fs.closeSync(fd);
  }
}
