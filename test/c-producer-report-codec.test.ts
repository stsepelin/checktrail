import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const repository = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "../" : "../../", import.meta.url),
);
const codecDirectory = path.join(repository, "scripts/producer-qualification");
const codec = await import(
  pathToFileURL(path.join(codecDirectory, "c-producer-report-codec.mjs")).href
);
const limits = codec.cReportEncodingPolicy.limits;
const sha = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
const header = Buffer.from("1f8b08000000000000ff", "hex");
type Chunk = {
  file: string;
  offset: number;
  bytes: number;
  sha256: string;
  decodedBytes: number;
  decodedSha256: string;
};
type Pin = { file: string; bytes: number; sha256: string; chunks: Chunk[] };
type Report = Pin & { configuration: string; format: string; log?: Pin };
type Transport = {
  schemaVersion: number;
  encoding: { id: string; sha256: string };
  reports: Report[];
  retainedBytes: number;
  storedBytes: number;
};

function randomLooking(length: number) {
  const bytes = Buffer.alloc(length);
  let state = 0x12345678;
  for (let index = 0; index < bytes.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 255;
  }
  return bytes;
}
function pinChunk(
  encoded: Buffer,
  decoded: Buffer,
  ordinal = 0,
  offset = 0,
): Chunk {
  return {
    file: `encoded/${String(ordinal).padStart(8, "0")}.gz`,
    offset,
    bytes: encoded.length,
    sha256: sha(encoded),
    decodedBytes: decoded.length,
    decodedSha256: sha(decoded),
  };
}
function nativeGzip(raw: Buffer) {
  const encoded = zlib.gzipSync(raw, { level: 6 });
  assert.deepEqual(zlib.gunzipSync(encoded), raw);
  return Buffer.concat([header, encoded.subarray(10)]);
}
function family(entries: { file: string; body: Buffer; log?: Buffer }[]) {
  const physical = new Map<string, Buffer>();
  let ordinal = 0;
  const pin = (file: string, body: Buffer): Pin => {
    const chunks = [];
    for (
      let offset = 0;
      offset < body.length;
      offset += limits.decodedChunkBytes
    ) {
      const raw = body.subarray(offset, offset + limits.decodedChunkBytes);
      const encoded = codec.encodeCReportChunk(raw);
      const chunk = pinChunk(encoded, raw, ordinal++, offset);
      physical.set(chunk.file, encoded);
      chunks.push(chunk);
    }
    return { file, bytes: body.length, sha256: sha(body), chunks };
  };
  const reports = entries.map(({ file, body, log }) => ({
    ...pin(file, body),
    configuration: file.split("/")[0]!,
    format: "original-sum",
    ...(log === undefined
      ? {}
      : { log: pin(file.replace(/\.sum$/u, ".log"), log) }),
  }));
  const pins = reports.flatMap((report) => [
    report,
    ...(report.log ? [report.log] : []),
  ]);
  const value: Transport = {
    schemaVersion: 3,
    encoding: {
      id: codec.cReportEncodingPolicy.id,
      sha256: codec.cReportEncodingPolicySha256,
    },
    reports,
    retainedBytes: pins.reduce((sum, row) => sum + row.bytes, 0),
    storedBytes: [...physical.values()].reduce(
      (sum, body) => sum + body.length,
      0,
    ),
  };
  return { value, physical };
}

test("C report gzip chunks preserve binary bytes and interoperate with the native gzip implementation", () => {
  for (const raw of [
    Buffer.from([0, 255, 13, 10, 0, 128]),
    Buffer.from("PASS: α\r\nFAIL: β\n"),
    randomLooking(limits.decodedChunkBytes),
  ]) {
    const encoded = codec.encodeCReportChunk(raw);
    assert.deepEqual(encoded, codec.encodeCReportChunk(raw));
    assert.deepEqual(encoded.subarray(0, 10), header);
    assert.deepEqual(zlib.gunzipSync(encoded), raw);
    assert.deepEqual(
      codec.decodeCReportChunk(encoded, pinChunk(encoded, raw)),
      raw,
    );
    const independent = nativeGzip(raw);
    assert.deepEqual(
      codec.decodeCReportChunk(independent, pinChunk(independent, raw)),
      raw,
    );
  }
  assert.throws(
    () => codec.encodeCReportChunk(Buffer.alloc(0)),
    /decoded chunk bound/,
  );
  assert.throws(
    () => codec.encodeCReportChunk(Buffer.alloc(limits.decodedChunkBytes + 1)),
    /decoded chunk bound/,
  );
});

function malformedChunks() {
  const raw = Buffer.from("PASS: exact bytes\r\nFAIL: preserved\n");
  const encoded = nativeGzip(raw);
  const crc = Buffer.from(encoded);
  crc[crc.length - 8] = crc[crc.length - 8]! ^ 1;
  const size = Buffer.from(encoded);
  size.writeUInt32LE(raw.length + 1, size.length - 4);
  const changedHeader = Buffer.from(encoded);
  changedHeader[3] = 8;
  const truncated = Buffer.concat([
    encoded.subarray(0, encoded.length - 9),
    encoded.subarray(-8),
  ]);
  const extraDeflate = Buffer.concat([
    encoded.subarray(0, -8),
    Buffer.from([0]),
    encoded.subarray(-8),
  ]);
  const bomb = nativeGzip(Buffer.alloc(limits.decodedChunkBytes + 1, 97));
  return [
    { name: "CRC", encoded: crc, pin: pinChunk(crc, raw) },
    { name: "ISIZE", encoded: size, pin: pinChunk(size, raw) },
    {
      name: "header",
      encoded: changedHeader,
      pin: pinChunk(changedHeader, raw),
    },
    {
      name: "truncated deflate",
      encoded: truncated,
      pin: pinChunk(truncated, raw),
    },
    {
      name: "trailing deflate",
      encoded: extraDeflate,
      pin: pinChunk(extraDeflate, raw),
    },
    {
      name: "multiple gzip members",
      encoded: Buffer.concat([encoded, encoded]),
      pin: pinChunk(Buffer.concat([encoded, encoded]), raw),
    },
    {
      name: "decoded SHA",
      encoded,
      pin: { ...pinChunk(encoded, raw), decodedSha256: "0".repeat(64) },
    },
    {
      name: "decoded bomb",
      encoded: bomb,
      pin: { ...pinChunk(bomb, raw), decodedBytes: limits.decodedChunkBytes },
    },
  ];
}
test("C report decoders reject coherent stored hashes for corrupt, trailing, truncated and oversized gzip payloads", () => {
  for (const row of malformedChunks()) {
    assert.equal(sha(row.encoded), row.pin.sha256, row.name);
    assert.equal(row.encoded.length, row.pin.bytes, row.name);
    assert.throws(
      () => codec.decodeCReportChunk(row.encoded, row.pin),
      row.name,
    );
  }
});

test("C report decoder passes the declared decoded ceiling to the real native inflater", (t) => {
  const row = malformedChunks().find((value) => value.name === "decoded bomb")!;
  const original = zlib.inflateRawSync;
  const calls: Parameters<typeof zlib.inflateRawSync>[] = [];
  const replaced = t.mock.method(
    zlib,
    "inflateRawSync",
    (...args: Parameters<typeof zlib.inflateRawSync>) => {
      calls.push(args);
      return original(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.throws(() => codec.decodeCReportChunk(row.encoded, row.pin));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![1]?.maxOutputLength, row.pin.decodedBytes + 1);
  } finally {
    replaced.mock.restore();
    syncBuiltinESMExports();
  }
});

test("C report logical files drain every chunk, preserve empty logs and reject whole-file hash forgery", async () => {
  const bodies = [
    Buffer.concat([
      Buffer.alloc(limits.decodedChunkBytes, 65),
      Buffer.from("\r\nPASS: final\n"),
    ]),
    Buffer.from("FAIL: second\n"),
  ];
  const { value, physical } = family([
    { file: "build/a.sum", body: bodies[0]!, log: Buffer.alloc(0) },
    {
      file: "build-cross/b.sum",
      body: bodies[1]!,
      log: Buffer.from("associated log\n"),
    },
  ]);
  const transport = codec.validateCReportTransport(value);
  assert.equal(transport.files.length, 4);
  assert.equal(transport.chunkFiles.length, 4);
  const reads: string[] = [];
  const read = async (file: string, expected: number) => {
    reads.push(file);
    const raw = physical.get(file)!;
    assert.equal(raw.length, expected);
    return raw;
  };
  for (const [index, row] of value.reports.entries()) {
    const chunks = [];
    for await (const raw of codec.iterateCReportFile(row, read))
      chunks.push(raw);
    assert.deepEqual(Buffer.concat(chunks), bodies[index]);
    const logs = [];
    for await (const raw of codec.iterateCReportFile(row.log, read))
      logs.push(raw);
    assert.deepEqual(
      Buffer.concat(logs),
      index === 0 ? Buffer.alloc(0) : Buffer.from("associated log\n"),
    );
  }
  assert.deepEqual(
    reads,
    transport.chunkFiles.map((row: Chunk) => row.file),
  );
  for (const original of [value.reports[0]!, value.reports[1]!.log!]) {
    const forged = { ...structuredClone(original), sha256: "0".repeat(64) };
    const seen: string[] = [];
    await assert.rejects(async () => {
      for await (const raw of codec.iterateCReportFile(
        forged,
        async (file: string) => {
          seen.push(file);
          return physical.get(file);
        },
      ))
        assert.ok(raw.length > 0);
    }, /whole original bytes\/hash/);
    assert.deepEqual(
      seen,
      original.chunks.map((row) => row.file),
    );
  }
});

test("C report transport refuses missing, repeated, reordered and aliased chunk declarations", () => {
  const { value } = family([
    {
      file: "build/a.sum",
      body: Buffer.alloc(limits.decodedChunkBytes + 1),
      log: Buffer.from("log"),
    },
    { file: "build/b.sum", body: Buffer.from("PASS: second\n") },
  ]);
  codec.validateCReportTransport(value);
  const changes: ((v: Transport) => void)[] = [
    (v) => {
      v.reports[0]!.chunks.pop();
    },
    (v) => {
      v.reports[0]!.chunks.reverse();
    },
    (v) => {
      v.reports[0]!.chunks[1]!.file = v.reports[0]!.chunks[0]!.file;
    },
    (v) => {
      v.reports[0]!.chunks[1]!.offset--;
    },
    (v) => {
      v.reports[0]!.chunks[1]!.decodedBytes++;
    },
    (v) => {
      v.reports[0]!.chunks[0]!.file = "encoded/00000000.gz\n";
    },
    (v) => {
      v.reports[0]!.chunks[0]!.file = "encoded/../00000000.gz";
    },
    (v) => {
      v.reports[1]!.file = v.reports[0]!.file;
    },
    (v) => {
      v.retainedBytes++;
    },
    (v) => {
      v.storedBytes++;
    },
    (v) => {
      v.encoding.sha256 = "0".repeat(64);
    },
    (v) => {
      v.schemaVersion = 2;
    },
  ];
  for (const change of changes) {
    const altered = structuredClone(value);
    change(altered);
    assert.throws(() => codec.validateCReportTransport(altered));
  }
});

function declaredFamily(
  fileBytes: number[],
  encodedSizes?: number[],
): Transport {
  let ordinal = 0;
  const reports = fileBytes.map((bytes, index) => {
    const chunks: Chunk[] = [];
    for (let offset = 0; offset < bytes; offset += limits.decodedChunkBytes) {
      const number = ordinal++;
      chunks.push({
        file: `encoded/${String(number).padStart(8, "0")}.gz`,
        offset,
        bytes: encodedSizes?.[number] ?? 20,
        sha256: "a".repeat(64),
        decodedBytes: Math.min(limits.decodedChunkBytes, bytes - offset),
        decodedSha256: "b".repeat(64),
      });
    }
    return {
      file: `build/${index}.sum`,
      bytes,
      sha256: "c".repeat(64),
      chunks,
      configuration: "build",
      format: "original-sum",
    };
  });
  return {
    schemaVersion: 3,
    encoding: {
      id: codec.cReportEncodingPolicy.id,
      sha256: codec.cReportEncodingPolicySha256,
    },
    reports,
    retainedBytes: fileBytes.reduce((a, b) => a + b, 0),
    storedBytes: reports
      .flatMap((row) => row.chunks)
      .reduce((sum, row) => sum + row.bytes, 0),
  };
}
test("C report declared byte ceilings admit exact limits and reject one byte beyond each limit", () => {
  const decoded = declaredFamily(Array(4).fill(limits.decodedFileBytes));
  assert.equal(
    codec.validateCReportTransport(decoded).decodedBytes,
    limits.decodedFamilyBytes,
  );
  const overFamily = declaredFamily([
    ...Array(4).fill(limits.decodedFileBytes),
    1,
  ]);
  assert.throws(
    () => codec.validateCReportTransport(overFamily),
    /family decoded\/stored/,
  );
  const overFile = declaredFamily([limits.decodedFileBytes + 1]);
  assert.throws(
    () => codec.validateCReportTransport(overFile),
    /decoded file bound/,
  );
  const member = limits.storedMemberBytes;
  const stored = declaredFamily(
    [9 * limits.decodedChunkBytes],
    [...Array(7).fill(member), member - 20, 20],
  );
  assert.equal(
    codec.validateCReportTransport(stored).storedBytes,
    limits.storedFamilyBytes,
  );
  const overStored = structuredClone(stored);
  overStored.reports[0]!.chunks[7]!.bytes++;
  overStored.storedBytes++;
  assert.throws(
    () => codec.validateCReportTransport(overStored),
    /family decoded\/stored/,
  );
  const overMember = structuredClone(stored);
  overMember.reports[0]!.chunks[0]!.bytes++;
  overMember.storedBytes++;
  assert.throws(
    () => codec.validateCReportTransport(overMember),
    /stored member/,
  );
});

const python = ["python3", "python"].find(
  (command) =>
    spawnSync(
      command,
      [
        "-I",
        "-S",
        "-B",
        "-c",
        "import os,sys;sys.exit(0 if sys.version_info>=(3,8) and hasattr(os,'O_NOFOLLOW') else 1)",
      ],
      { timeout: 5000 },
    ).status === 0,
);
test(
  "C report JavaScript and Python codecs cross-decode native gzip and reject the same malformed streams",
  { skip: python ? false : "POSIX Python with O_NOFOLLOW unavailable" },
  () => {
    assert.ok(python);
    const raw = randomLooking(65555),
      encoded = codec.encodeCReportChunk(raw);
    const invalid = malformedChunks().map((row) => ({
      name: row.name,
      encoded: row.encoded.toString("base64"),
      pin: row.pin,
    }));
    const program = String.raw`
import base64,gzip,hashlib,importlib.util,json,sys
s=importlib.util.spec_from_file_location('codec',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
x=json.load(sys.stdin);raw=base64.b64decode(x['raw']);encoded=base64.b64decode(x['encoded'])
assert m.decode_gzip_chunk(encoded,x['pin'])==raw and gzip.decompress(encoded)==raw
native=gzip.compress(raw,compresslevel=6,mtime=0);native=bytes.fromhex('1f8b08000000000000ff')+native[10:]
def pin(body):return {**x['pin'],'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()}
assert m.decode_gzip_chunk(native,pin(native))==raw
out=m.encode_gzip_chunk(raw);assert gzip.decompress(out)==raw
refused=[]
for row in x['invalid']:
 try:m.decode_gzip_chunk(base64.b64decode(row['encoded']),row['pin'])
 except (RuntimeError,ValueError):refused.append(row['name'])
 else:raise AssertionError('Accepted malformed '+row['name'])
print(json.dumps({'encoded':base64.b64encode(out).decode(),'native':base64.b64encode(native).decode(),'refused':refused,'rawSha256':hashlib.sha256(raw).hexdigest()}))
`;
    const result = spawnSync(
      python,
      [
        "-I",
        "-S",
        "-B",
        "-c",
        program,
        path.join(codecDirectory, "c-producer-report-codec.py"),
      ],
      {
        input: JSON.stringify({
          raw: raw.toString("base64"),
          encoded: encoded.toString("base64"),
          pin: pinChunk(encoded, raw),
          invalid,
        }),
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 8 * 1024 ** 2,
      },
    );
    assert.equal(
      result.status,
      0,
      result.stderr ||
        result.error?.message ||
        "Python codec control returned nonzero",
    );
    const output = JSON.parse(result.stdout);
    assert.equal(output.rawSha256, sha(raw));
    assert.deepEqual(
      output.refused,
      invalid.map((row) => row.name),
    );
    for (const base64 of [output.encoded, output.native]) {
      const bytes = Buffer.from(base64, "base64");
      assert.deepEqual(
        codec.decodeCReportChunk(bytes, pinChunk(bytes, raw)),
        raw,
      );
      assert.deepEqual(zlib.gunzipSync(bytes), raw);
    }
  },
);
