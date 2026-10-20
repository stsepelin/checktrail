import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
/** Strict engine-owned observer format; never equate max RSS with summed tree RSS. */
export function parseNativeResourceReceipt(bytes, expected) {
  assert.ok(
    bytes instanceof Uint8Array &&
      bytes.byteLength > 0 &&
      bytes.byteLength <= 2048,
    "Native resource receipt bytes exceed bounds",
  );
  const text = Buffer.from(bytes).toString("utf8");
  assert.ok(
    Buffer.from(text).equals(Buffer.from(bytes)),
    "Native resource receipt is not valid UTF-8",
  );
  assert.match(
    text,
    /^\{"schemaVersion":1,"requestId":"[a-f0-9]{32}","observerPid":[0-9]+,"childPid":[0-9]+,"completed":true,"exitCode":(?:[0-9]+|null),"signal":(?:[0-9]+|null),"wallMicroseconds":[0-9]+,"userCpuMicroseconds":[0-9]+,"systemCpuMicroseconds":[0-9]+,"peakRssRaw":[0-9]+,"peakRssRawUnit":"(?:bytes|KiB)","peakRssKiB":[0-9]+\}\n$/,
    "Native resource receipt format is incomplete or malformed",
  );
  const value = JSON.parse(text);
  assert.equal(
    text,
    JSON.stringify(value) + "\n",
    "Native resource receipt encoding differs",
  );
  assert.equal(
    value.requestId,
    expected.requestId,
    "Native resource receipt request differs",
  );
  assert.ok(
    ["linux", "darwin"].includes(expected.platform),
    "Native resource receipt platform unavailable",
  );
  assert.ok(
    integer(value.observerPid) &&
      value.observerPid > 0 &&
      integer(value.childPid) &&
      value.childPid > 1 &&
      value.observerPid !== value.childPid,
    "Native resource receipt process identity invalid",
  );
  assert.ok(
    (value.exitCode !== null &&
      integer(value.exitCode) &&
      value.exitCode <= 255 &&
      value.signal === null) ||
      (value.exitCode === null &&
        integer(value.signal) &&
        value.signal > 0 &&
        value.signal <= 128),
    "Native resource receipt exit accounting differs",
  );
  assert.ok(
    integer(value.wallMicroseconds) &&
      value.wallMicroseconds <= 120000000 &&
      integer(value.userCpuMicroseconds) &&
      integer(value.systemCpuMicroseconds) &&
      integer(value.peakRssRaw) &&
      integer(value.peakRssKiB),
    "Native resource receipt counters invalid",
  );
  const unit = expected.platform === "darwin" ? "bytes" : "KiB";
  assert.equal(
    value.peakRssRawUnit,
    unit,
    "Native resource receipt RSS units differ",
  );
  assert.equal(
    value.peakRssKiB,
    unit === "bytes" ? Math.ceil(value.peakRssRaw / 1024) : value.peakRssRaw,
    "Native resource receipt RSS normalization differs",
  );
  return {
    ...value,
    scope: "wait4-reaped-child-kernel-counters",
    summedProcessTreeRss: false,
    descendantCoverage: "unverified",
  };
}
export async function readNativeResourceReceipt(file, expected) {
  assert.ok(
    ["linux", "darwin"].includes(process.platform),
    "Native resource receipt reader platform unavailable",
  );
  const canonical = path.resolve(file);
  assert.equal(
    await realpath(canonical),
    canonical,
    "Native resource receipt path must not follow symlinks",
  );
  const stat = await lstat(canonical);
  assert.ok(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o077) === 0 &&
      stat.size > 0 &&
      stat.size <= 2048,
    "Native resource receipt must be a bounded regular file",
  );
  const bytes = await readFile(canonical),
    after = await lstat(canonical);
  assert.ok(
    stat.dev === after.dev &&
      stat.ino === after.ino &&
      stat.size === after.size &&
      stat.mtimeMs === after.mtimeMs &&
      stat.ctimeMs === after.ctimeMs &&
      bytes.length === stat.size,
    "Native resource receipt changed during capture",
  );
  return parseNativeResourceReceipt(bytes, expected);
}
