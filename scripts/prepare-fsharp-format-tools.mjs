import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import console from "node:console";
import { TextDecoder } from "node:util";
import {
  lstat,
  readFile,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
  realpath,
} from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { mavenHash } from "../dist/src/maven.js";
import {
  fantomasPackagePin,
  fsharpFormatterPins,
} from "../dist/src/fsharp-format-pins.js";
const repository = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
assert.ok(
  args.length === 2 && args[0] === "--archive",
  "Pass --archive PATH for the already downloaded exact NuGet package",
);
const archive = path.resolve(args[1]),
  output = path.join(repository, ".checktrail/fsharp-format-tools");
const info = await lstat(archive);
assert.ok(
  info.isFile() &&
    !info.isSymbolicLink() &&
    (await realpath(archive)) === archive &&
    info.size === fantomasPackagePin.bytes,
  "Canonical pinned archive required",
);
const bytes = await readFile(archive);
assert.equal(bytes.length, fantomasPackagePin.bytes);
assert.equal(mavenHash(bytes), fantomasPackagePin.sha256);
let end = -1;
for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
  if (
    bytes.readUInt32LE(i) === 0x06054b50 &&
    i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
  ) {
    end = i;
    break;
  }
assert.ok(
  end >= 0 &&
    bytes.readUInt16LE(end + 4) === 0 &&
    bytes.readUInt16LE(end + 6) === 0,
);
const count = bytes.readUInt16LE(end + 10),
  offset = bytes.readUInt32LE(end + 16),
  size = bytes.readUInt32LE(end + 12);
assert.ok(
  count > 0 &&
    count <= 128 &&
    bytes.readUInt16LE(end + 8) === count &&
    offset + size === end,
);
let cursor = offset;
const names = new Set(),
  selected = new Map();
for (let i = 0; i < count; i++) {
  assert.ok(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50);
  const n = bytes.readUInt16LE(cursor + 28),
    next =
      cursor +
      46 +
      n +
      bytes.readUInt16LE(cursor + 30) +
      bytes.readUInt16LE(cursor + 32);
  assert.ok(next <= end);
  const encoded = bytes.subarray(cursor + 46, cursor + 46 + n),
    name = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
  assert.ok(
    name &&
      !names.has(name) &&
      !/[\\\0\r\n]/.test(name) &&
      !name.startsWith("/") &&
      !name.split("/").some((p) => p === ".." || p === "."),
  );
  names.add(name);
  const pin = fsharpFormatterPins.find(
    (p) => name === "tools/net10.0/any/" + p.file,
  );
  if (pin) {
    const method = bytes.readUInt16LE(cursor + 10),
      compressed = bytes.readUInt32LE(cursor + 20),
      expanded = bytes.readUInt32LE(cursor + 24),
      local = bytes.readUInt32LE(cursor + 42);
    assert.ok(
      !(bytes.readUInt16LE(cursor + 8) & 1) &&
        [0, 8].includes(method) &&
        expanded === pin.bytes &&
        compressed <= pin.bytes &&
        local + 30 < offset &&
        bytes.readUInt32LE(local) === 0x04034b50,
    );
    const localName = bytes.readUInt16LE(local + 26),
      data = local + 30 + localName + bytes.readUInt16LE(local + 28);
    assert.ok(
      bytes.subarray(local + 30, local + 30 + localName).equals(encoded) &&
        bytes.readUInt16LE(local + 8) === method &&
        data + compressed <= offset,
    );
    const compressedBytes = bytes.subarray(data, data + compressed),
      payload =
        method === 8
          ? inflateRawSync(compressedBytes, { maxOutputLength: pin.bytes + 1 })
          : compressedBytes;
    assert.equal(payload.length, pin.bytes);
    assert.equal(mavenHash(payload), pin.sha256);
    selected.set(pin.file, payload);
  }
  cursor = next;
}
assert.equal(cursor, end);
assert.equal(selected.size, fsharpFormatterPins.length);
// Validate and expand every payload before creating any of the advertised outputs.
try {
  const existing = await lstat(output);
  assert.ok(
    existing.isDirectory() &&
      !existing.isSymbolicLink() &&
      (await realpath(output)) === output,
  );
  assert.deepEqual(
    (await readdir(output)).sort(),
    fsharpFormatterPins.map((p) => p.file).sort(),
  );
  for (const pin of fsharpFormatterPins) {
    const file = path.join(output, pin.file),
      stat = await lstat(file);
    assert.ok(
      stat.isFile() && !stat.isSymbolicLink() && stat.size === pin.bytes,
    );
    assert.equal(mavenHash(await readFile(file)), pin.sha256);
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  // A missing existing payload does not authorize replacement of a partial tree.
  assert.equal(
    await lstat(output).then(
      () => true,
      (e) => {
        if (e.code !== "ENOENT") throw e;
        return false;
      },
    ),
    false,
    "Refuse partially prepared formatter trees",
  );
  await mkdir(path.dirname(output), { recursive: true });
  const parent = path.dirname(output),
    parentStat = await lstat(parent);
  assert.ok(
    parentStat.isDirectory() &&
      !parentStat.isSymbolicLink() &&
      (await realpath(parent)) === parent,
    "Canonical owned cache parent required",
  );
  const staged = await mkdtemp(
    path.join(path.dirname(output), ".fsharp-format-pending-"),
  );
  try {
    for (const [name, payload] of selected)
      await writeFile(path.join(staged, name), payload, {
        flag: "wx",
        mode: 0o644,
      });
    await rename(staged, output);
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify({
    profile: "fantomas-core-default-v1",
    package: fantomasPackagePin,
    selected: fsharpFormatterPins,
    complete: true,
    limit:
      "Selected formatter components; not complete SDK/container/license provenance.",
  }),
);
