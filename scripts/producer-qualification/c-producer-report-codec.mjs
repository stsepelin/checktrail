import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";

export const cReportEncodingPolicySha256 =
  "94fb95987b59c470fde94071220e41f5eed3071acf481e187bebaa6a4d499e46";
const policyPath = path.join(
  path.dirname(realpathSync(fileURLToPath(import.meta.url))),
  "c-report-encoding.v1.json",
);
const policyFd = openSync(
  policyPath,
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
);
let policyBytes;
try {
  const before = fstatSync(policyFd, { bigint: true });
  assert.ok(
    before.isFile() && before.size > 0n && before.size <= 16384n,
    "Unbounded C report encoding policy",
  );
  const raw = Buffer.alloc(16385);
  let count = 0;
  while (count < raw.length) {
    const read = readSync(policyFd, raw, count, raw.length - count, null);
    if (!read) break;
    count += read;
  }
  const after = fstatSync(policyFd, { bigint: true });
  assert.ok(
    ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
      (key) => before[key] === after[key],
    ) && BigInt(count) === before.size,
    "C report encoding policy changed",
  );
  policyBytes = raw.subarray(0, count);
} finally {
  closeSync(policyFd);
}
const hash = (raw) => createHash("sha256").update(raw).digest("hex");
assert.equal(
  hash(policyBytes),
  cReportEncodingPolicySha256,
  "C report encoding policy differs",
);
const freeze = (value) => {
  for (const child of Object.values(value))
    if (child && typeof child === "object") freeze(child);
  return Object.freeze(value);
};
export const cReportEncodingPolicy = freeze(
  JSON.parse(policyBytes.toString("utf8")),
);
const limits = cReportEncodingPolicy.limits;
const header = Buffer.from(cReportEncodingPolicy.compression.headerHex, "hex");
const emptySha256 = hash(Buffer.alloc(0));
const integer = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function plain(value) {
  assert.ok(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    "C report metadata must be a plain object",
  );
  for (const property of Object.values(Object.getOwnPropertyDescriptors(value)))
    assert.ok(
      "value" in property && property.enumerable,
      "C report metadata accessor/hidden property refused",
    );
}
function relative(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 32768 ||
    value.includes("\\") ||
    value.includes("\0")
  )
    return false;
  const parts = value.split("/");
  return (
    parts.length <= limits.pathDepth &&
    parts.every((part) => part && part !== "." && part !== "..")
  );
}
function validatePin(pin, ordinal = null, semantic = false) {
  plain(pin);
  const keys = ["file", "bytes", "sha256", "chunks"];
  const allowed = semantic
    ? [
        ...keys,
        "configuration",
        "format",
        "counts",
        "totalLines",
        "otherLines",
        "outcomesInterpreted",
        "log",
      ]
    : keys;
  assert.ok(
    keys.every((key) => Object.hasOwn(pin, key)) &&
      Object.keys(pin).every((key) => allowed.includes(key)),
    "Unknown or missing C report logical pin fields",
  );
  assert.ok(
    relative(pin.file) &&
      integer(pin.bytes, 0, limits.decodedFileBytes) &&
      sha(pin.sha256),
    "Invalid C report logical identity/decoded file bound",
  );
  assert.ok(
    Array.isArray(pin.chunks) && pin.chunks.length <= limits.chunkCount,
    "C report chunk inventory exceeds bound",
  );
  assert.equal(
    pin.chunks.length,
    Math.ceil(pin.bytes / limits.decodedChunkBytes),
    "Omitted or extra C report chunks",
  );
  let offset = 0;
  const names = new Set();
  for (const chunk of pin.chunks) {
    plain(chunk);
    assert.deepEqual(
      Object.keys(chunk).sort(),
      [
        "file",
        "offset",
        "bytes",
        "sha256",
        "decodedBytes",
        "decodedSha256",
      ].sort(),
      "Unknown or missing C report chunk fields",
    );
    assert.ok(
      typeof chunk.file === "string" &&
        /^encoded\/[0-9]{8}\.gz$/u.test(chunk.file) &&
        !names.has(chunk.file),
      "Unsafe or duplicate C report chunk identity",
    );
    if (ordinal !== null) {
      assert.equal(
        chunk.file,
        "encoded/" + String(ordinal).padStart(8, "0") + ".gz",
        "Reordered or omitted C report physical chunks",
      );
      ordinal++;
    }
    names.add(chunk.file);
    const expected = Math.min(limits.decodedChunkBytes, pin.bytes - offset);
    assert.ok(
      integer(chunk.offset, 0, limits.decodedFileBytes) &&
        chunk.offset === offset &&
        integer(chunk.decodedBytes, 1, limits.decodedChunkBytes) &&
        chunk.decodedBytes === expected,
      "C report decoded chunk offset/length differs",
    );
    assert.ok(
      integer(chunk.bytes, 20, limits.storedMemberBytes) &&
        sha(chunk.sha256) &&
        sha(chunk.decodedSha256),
      "C report stored member identity/bound differs",
    );
    offset += expected;
  }
  assert.equal(offset, pin.bytes, "C report decoded length differs");
  if (!pin.chunks.length)
    assert.equal(pin.sha256, emptySha256, "Empty C report hash differs");
  return ordinal;
}

export function validateCReportTransport(value) {
  plain(value);
  assert.equal(
    value.schemaVersion,
    3,
    "New C report transport schema required",
  );
  plain(value.encoding);
  assert.deepEqual(
    value.encoding,
    { id: cReportEncodingPolicy.id, sha256: cReportEncodingPolicySha256 },
    "Closed C report encoding policy differs",
  );
  assert.ok(
    Array.isArray(value.reports) && value.reports.length <= limits.reportCount,
    "C report inventory exceeds bound",
  );
  const files = [],
    chunkFiles = [],
    names = new Set();
  let ordinal = 0,
    decodedBytes = 0,
    storedBytes = 0;
  for (const report of value.reports) {
    plain(report);
    const pins = [
      report,
      ...(Object.hasOwn(report, "log") ? [report.log] : []),
    ];
    for (let index = 0; index < pins.length; index++) {
      const pin = pins[index];
      ordinal = validatePin(pin, ordinal, index === 0);
      assert.ok(!names.has(pin.file), "Duplicate C report logical path");
      names.add(pin.file);
      files.push(pin);
      chunkFiles.push(...pin.chunks);
      decodedBytes += pin.bytes;
      for (const chunk of pin.chunks) storedBytes += chunk.bytes;
      assert.ok(
        files.length <= limits.logicalFileCount && ordinal <= limits.chunkCount,
        "C report physical/logical inventory exceeds bound",
      );
      assert.ok(
        decodedBytes <= limits.decodedFamilyBytes &&
          storedBytes <= limits.storedFamilyBytes,
        "C report family decoded/stored byte ceiling exceeded",
      );
    }
  }
  assert.ok(
    integer(value.retainedBytes, 0, limits.decodedFamilyBytes) &&
      value.retainedBytes === decodedBytes,
    "C report retained decoded byte total differs",
  );
  assert.ok(
    integer(value.storedBytes, 0, limits.storedFamilyBytes) &&
      value.storedBytes === storedBytes,
    "C report stored byte total differs",
  );
  return { files, chunkFiles, decodedBytes, storedBytes };
}

const crcTable = new Uint32Array(256);
for (let value = 0; value < 256; value++) {
  let crc = value;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  crcTable[value] = crc >>> 0;
}
const crc32 = (raw) => {
  let crc = 0xffffffff;
  for (const byte of raw) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
};
export function encodeCReportChunk(raw) {
  assert.ok(
    Buffer.isBuffer(raw) &&
      raw.length > 0 &&
      raw.length <= limits.decodedChunkBytes,
    "C report encoder decoded chunk bound exceeded",
  );
  const compressed = deflateRawSync(raw, {
    level: 6,
    windowBits: 15,
    memLevel: 8,
    strategy: 0,
  });
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(raw), 0);
  trailer.writeUInt32LE(raw.length, 4);
  const encoded = Buffer.concat([header, compressed, trailer]);
  assert.ok(
    encoded.length <= limits.storedMemberBytes,
    "C report encoder stored member bound exceeded",
  );
  return encoded;
}
export function decodeCReportChunk(encoded, chunk) {
  plain(chunk);
  assert.ok(
    Buffer.isBuffer(encoded) &&
      integer(chunk.bytes, 20, limits.storedMemberBytes) &&
      encoded.length === chunk.bytes &&
      sha(chunk.sha256) &&
      hash(encoded) === chunk.sha256,
    "C report stored chunk bytes/hash differ",
  );
  assert.ok(
    integer(chunk.decodedBytes, 1, limits.decodedChunkBytes) &&
      sha(chunk.decodedSha256),
    "C report decoded chunk bound/identity differs",
  );
  assert.ok(
    encoded.subarray(0, 10).equals(header) && encoded.length >= 20,
    "C report fixed gzip header differs",
  );
  const compressed = encoded.subarray(10, -8);
  let inflated;
  try {
    inflated = inflateRawSync(compressed, {
      maxOutputLength: chunk.decodedBytes + 1,
      info: true,
    });
  } catch (error) {
    throw new Error("Invalid C report gzip deflate stream", { cause: error });
  }
  const raw = inflated.buffer;
  assert.ok(
    raw.length === chunk.decodedBytes &&
      inflated.engine.bytesWritten === compressed.length,
    "C report gzip decoded length/trailing stream differs",
  );
  assert.ok(
    encoded.readUInt32LE(encoded.length - 8) === crc32(raw) &&
      encoded.readUInt32LE(encoded.length - 4) === raw.length,
    "C report gzip trailer differs",
  );
  assert.equal(
    hash(raw),
    chunk.decodedSha256,
    "C report decoded chunk hash differs",
  );
  return raw;
}
export async function* iterateCReportFile(pin, readChunk) {
  validatePin(pin, null, true);
  const digest = createHash("sha256");
  let size = 0;
  for (const chunk of pin.chunks) {
    const encoded = await readChunk(chunk.file, chunk.bytes);
    const raw = decodeCReportChunk(encoded, chunk);
    digest.update(raw);
    size += raw.length;
    assert.ok(size <= pin.bytes, "C report decoded file ceiling exceeded");
    yield raw;
  }
  assert.ok(
    size === pin.bytes && digest.digest("hex") === pin.sha256,
    "C report whole original bytes/hash differ",
  );
}
