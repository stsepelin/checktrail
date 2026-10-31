// Read selected source bytes as data. No archive member is extracted or imported.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { setTimeout, clearTimeout } from "node:timers";
import { readPinnedFile } from "./emsdk-metadata-file.mjs";
import { TextDecoder } from "node:util";
import { digest, relativePath, objectId } from "./emsdk-metadata-values.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });
function field(bytes) {
  const at = bytes.indexOf(0),
    end = at < 0 ? bytes.length : at;
  if (at >= 0)
    assert.ok(
      bytes.subarray(at).every((byte) => byte === 0),
      "Nonzero bytes after tar string terminator",
    );
  return decoder.decode(bytes.subarray(0, end));
}
function octal(bytes) {
  const value = bytes.toString("ascii");
  assert.match(value, /^[0-7]+[\0 ]*$/u, "Unsupported tar number encoding");
  const number = Number.parseInt(value, 8);
  assert.ok(Number.isSafeInteger(number));
  return number;
}
function safeMember(name, expectedRoot) {
  assert.ok(name.length > 0 && name.length <= 4096);
  assert.ok(
    [...name].every(
      (character) =>
        character !== "\\" &&
        character.codePointAt(0) >= 32 &&
        character.codePointAt(0) !== 127,
    ),
    "Unsafe tar member path",
  );
  assert.ok(
    !name.startsWith("/") && !name.includes(":"),
    "Absolute tar member path",
  );
  const parts = name.replace(/\/$/u, "").split("/");
  assert.ok(
    parts.every((part) => part !== "" && part !== "." && part !== ".."),
    "Tar traversal or empty component",
  );
  assert.equal(parts[0], expectedRoot, "Wrong source archive root");
  return parts.slice(1).join("/");
}
function pax(bytes) {
  const values = new Map();
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(32, at);
    assert.ok(space > at && space - at <= 8);
    const text = bytes.subarray(at, space).toString("ascii");
    assert.match(text, /^[1-9][0-9]*$/u);
    const size = Number(text);
    assert.ok(
      Number.isSafeInteger(size) &&
        at + size <= bytes.length &&
        at + size > space + 1,
    );
    const record = bytes.subarray(space + 1, at + size);
    assert.equal(record.at(-1), 10);
    const equal = record.indexOf(61);
    assert.ok(equal > 0);
    const key = decoder.decode(record.subarray(0, equal)),
      value = decoder.decode(record.subarray(equal + 1, -1));
    assert.ok(!values.has(key), "Duplicate PAX key");
    values.set(key, value);
    at += size;
  }
  return values;
}

// Exported for inert synthetic archive controls; production uses readPinnedArchive.
export async function parseArchiveMetadata(
  compressed,
  {
    expectedRoot,
    sourceCommit,
    selectedPaths,
    maximumSelectedFileBytes,
    maximumInflatedBytes = 268435456,
    maximumEntries = 65536,
    deadline = performance.now() + 30000,
  },
) {
  relativePath(expectedRoot);
  assert.ok(!expectedRoot.includes("/"));
  objectId(sourceCommit);
  assert.ok(Number.isFinite(deadline));
  deadline = Math.min(deadline, performance.now() + 30000);
  for (const [value, cap] of [
    [maximumSelectedFileBytes, 4194304],
    [maximumInflatedBytes, 268435456],
    [maximumEntries, 65536],
  ])
    assert.ok(
      Number.isSafeInteger(value) && value > 0 && value <= cap,
      "Archive metadata budget cannot increase",
    );
  assert.ok(Buffer.isBuffer(compressed) && compressed.length <= 67108864);
  assert.ok(
    Array.isArray(selectedPaths) &&
      selectedPaths.length > 0 &&
      selectedPaths.length <= 32,
  );
  for (const file of selectedPaths) relativePath(file);
  const selected = new Set(selectedPaths);
  assert.equal(selected.size, selectedPaths.length);
  const found = new Map(),
    names = new Set();
  let pending = Buffer.alloc(0),
    current,
    globalSeen = false,
    pendingPax,
    zeros = 0,
    ended = false,
    entries = 0,
    inflated = 0;
  function complete() {
    if (current.pax) {
      const values = pax(Buffer.concat(current.parts));
      if (current.pax === "global") {
        assert.equal(globalSeen, false, "Duplicate global PAX metadata");
        assert.deepEqual(
          [...values],
          [["comment", sourceCommit]],
          "Only the original commit comment is allowed in global PAX metadata",
        );
        globalSeen = true;
      } else {
        assert.equal(pendingPax, undefined, "Overlapping local PAX records");
        assert.ok(
          [...values.keys()].every((key) => ["path", "linkpath"].includes(key)),
          "Unsupported local PAX override",
        );
        pendingPax = values;
      }
    } else if (current.selected)
      found.set(current.relative, Buffer.concat(current.parts));
    current = undefined;
  }
  function push(chunk) {
    assert.ok(
      performance.now() < deadline,
      "Archive metadata deadline exhausted",
    );
    inflated += chunk.length;
    assert.ok(
      inflated <= maximumInflatedBytes,
      "Inflated metadata archive limit exceeded",
    );
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (ended) {
        assert.ok(
          pending.every((byte) => byte === 0),
          "Nonzero data after tar terminator",
        );
        pending = Buffer.alloc(0);
        return;
      }
      if (current) {
        if (current.remaining) {
          const take = Math.min(current.remaining, pending.length);
          if (!take) return;
          if (current.selected || current.pax)
            current.parts.push(Buffer.from(pending.subarray(0, take)));
          pending = pending.subarray(take);
          current.remaining -= take;
          if (current.remaining) return;
        }
        if (pending.length < current.padding) return;
        assert.ok(
          pending.subarray(0, current.padding).every((byte) => byte === 0),
          "Nonzero tar member padding",
        );
        pending = pending.subarray(current.padding);
        complete();
        continue;
      }
      if (pending.length < 512) return;
      const header = pending.subarray(0, 512);
      pending = pending.subarray(512);
      if (header.every((byte) => byte === 0)) {
        zeros++;
        if (zeros === 2) ended = true;
        continue;
      }
      assert.equal(zeros, 0, "Single tar zero block before a member");
      assert.ok(++entries <= maximumEntries, "Tar entry limit exceeded");
      const checksum = octal(header.subarray(148, 156));
      const sum = header.reduce(
        (total, byte, index) =>
          total + (index >= 148 && index < 156 ? 32 : byte),
        0,
      );
      assert.equal(sum, checksum, "Tar header checksum mismatch");
      assert.equal(
        header.subarray(257, 263).toString("ascii"),
        "ustar\0",
        "Unsupported tar header format",
      );
      const prefix = field(header.subarray(345, 500));
      let name = (prefix ? prefix + "/" : "") + field(header.subarray(0, 100));
      const size = octal(header.subarray(124, 136)),
        type = header[156];
      assert.ok(size <= maximumInflatedBytes, "Tar member exceeds phase bound");
      const isPax = type === 103 || type === 120;
      if (!isPax && pendingPax) {
        name = pendingPax.get("path") ?? name;
        pendingPax = undefined;
      }
      if (isPax) {
        assert.ok(size <= 65536, "PAX metadata size bound exceeded");
        if (type === 103) assert.equal(name, "pax_global_header");
        else safeMember(name, expectedRoot);
      } else {
        const relative = safeMember(name, expectedRoot);
        assert.ok(!names.has(name), "Duplicate source archive member");
        names.add(name);
        assert.ok(
          [0, 48, 49, 50, 53].includes(type),
          "Unsupported source archive member type",
        );
        if ([49, 50, 53].includes(type))
          assert.equal(size, 0, "Links and directories must have no data body");
        if (selected.has(relative)) {
          assert.ok(
            type === 0 || type === 48,
            "Selected metadata cannot follow an archive link or directory",
          );
          assert.ok(
            size <= maximumSelectedFileBytes,
            "Selected archive metadata limit exceeded",
          );
        }
        current = {
          relative,
          selected: selected.has(relative),
          remaining: size,
          padding: (512 - (size % 512)) % 512,
          parts: [],
        };
      }
      if (isPax)
        current = {
          pax: type === 103 ? "global" : "local",
          remaining: size,
          padding: (512 - (size % 512)) % 512,
          parts: [],
        };
    }
  }
  const remaining = Math.floor(deadline - performance.now());
  assert.ok(remaining > 0, "Archive metadata deadline exhausted");
  const input = Readable.from([compressed]),
    gunzip = createGunzip();
  const timer = setTimeout(
    () => gunzip.destroy(new Error("Archive metadata deadline exhausted")),
    remaining,
  );
  input.pipe(gunzip);
  try {
    for await (const chunk of gunzip) push(chunk);
    assert.ok(
      ended && !current && pending.length === 0 && pendingPax === undefined,
      "Truncated metadata tar stream",
    );
    assert.deepEqual(
      [...found.keys()].sort(),
      [...selected].sort(),
      "Selected original metadata is missing",
    );
    return {
      files: [...found].map(([file, bytes]) => ({
        file,
        bytes,
        sha256: digest(bytes),
      })),
      observedInflatedBytes: inflated,
      observedEntries: entries,
      upstreamCodeExecuted: false,
    };
  } finally {
    clearTimeout(timer);
    input.destroy();
    gunzip.destroy();
  }
}

export async function readPinnedArchive({ archive, metadata, deadline }) {
  // The caller must supply localArchiveMetadata from validateCatalog's copied pin.
  assert.equal(
    metadata.sourceCommit,
    "09f52557f0d48b65b8c724853ed8f4e8bf80e669",
  );
  assert.equal(metadata.bytes, 34344232);
  assert.equal(
    metadata.sha256,
    "f34167d75a3ae556d0a8cf4803c4e78c347e6f39d3afcc93cb201201afa3e2e3",
  );
  assert.deepEqual(metadata.selectedPaths, [
    "bootstrap.py",
    "tools/install.py",
    "package-lock.json",
    "package.json",
    "LICENSE",
  ]);
  assert.equal(metadata.maximumSelectedFileBytes, 4194304);
  assert.equal(metadata.executeContents, false);
  const readDeadline = Math.min(
    deadline ?? performance.now() + 30000,
    performance.now() + 30000,
  );
  const bytes = readPinnedFile(archive, {
    bytes: metadata.bytes,
    sha256: metadata.sha256,
    deadline: readDeadline,
  });
  const result = await parseArchiveMetadata(bytes, {
    expectedRoot: "emscripten-" + metadata.sourceCommit,
    sourceCommit: metadata.sourceCommit,
    selectedPaths: metadata.selectedPaths,
    maximumSelectedFileBytes: metadata.maximumSelectedFileBytes,
    deadline: readDeadline,
  });
  return {
    ...result,
    archive: { bytes: metadata.bytes, sha256: metadata.sha256 },
    sourceCommit: metadata.sourceCommit,
    sourceCheckoutOrGitHistoryVerified: false,
  };
}
