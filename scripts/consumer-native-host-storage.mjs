import assert from "node:assert/strict";
import process from "node:process";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  realpath,
  open,
  readdir,
  mkdir,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { ensureWindowsTaskAccess } from "../dist/src/windows-task-access.js";
import {
  readConsumerCaptureRegistry,
  decodeConsumerCaptureRegistry,
} from "./consumer-native-capture-registry.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fields = ["dev", "ino", "size", "mtimeNs", "ctimeNs"];
function ownedMode(stat, mode) {
  return (
    process.platform === "win32" ||
    (stat.uid === BigInt(process.getuid()) &&
      (stat.mode & 0o777n) === BigInt(mode))
  );
}
async function directory(filename, created = false) {
  assert.ok(path.isAbsolute(filename));
  assert.equal(
    await realpath(filename),
    filename,
    "Host native storage crosses a linked path",
  );
  const stat = await lstat(filename, { bigint: true });
  assert.ok(
    stat.isDirectory() && !stat.isSymbolicLink() && ownedMode(stat, 0o700),
    "Host native storage requires a private owned directory",
  );
  if (process.platform === "win32")
    ensureWindowsTaskAccess(filename, "directory", created);
  return stat;
}
async function physical(filename, maximum) {
  assert.equal(
    await realpath(filename),
    filename,
    "Host native file crosses a linked path",
  );
  const linked = await lstat(filename, { bigint: true });
  assert.ok(
    linked.isFile() &&
      !linked.isSymbolicLink() &&
      linked.nlink === 1n &&
      ownedMode(linked, 0o600) &&
      linked.size <= BigInt(maximum),
    "Host native storage requires a bounded private regular file",
  );
  if (process.platform === "win32")
    ensureWindowsTaskAccess(filename, "file", false);
  const fd = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await fd.stat({ bigint: true });
    for (const field of fields) assert.equal(before[field], linked[field]);
    const parts = [];
    let count = 0;
    for (;;) {
      const chunk = Buffer.alloc(65536),
        { bytesRead } = await fd.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      count += bytesRead;
      assert.ok(count <= maximum);
      parts.push(chunk.subarray(0, bytesRead));
    }
    const after = await fd.stat({ bigint: true }),
      current = await lstat(filename, { bigint: true });
    for (const field of fields) {
      assert.equal(after[field], before[field]);
      assert.equal(current[field], before[field]);
    }
    assert.ok(
      current.isFile() &&
        !current.isSymbolicLink() &&
        current.nlink === 1n &&
        ownedMode(current, 0o600),
    );
    assert.equal(await realpath(filename), filename);
    assert.equal(BigInt(count), before.size);
    const bytes = Buffer.concat(parts, count);
    return { bytes, sha256: hash(bytes) };
  } finally {
    await fd.close();
  }
}
async function writePrivate(filename, bytes) {
  await directory(path.dirname(filename));
  const fd = await open(filename, "wx", 0o600);
  try {
    if (process.platform === "win32")
      ensureWindowsTaskAccess(filename, "file", true);
    await fd.writeFile(bytes);
    await fd.sync();
  } finally {
    await fd.close();
  }
  const copied = await physical(filename, bytes.length);
  assert.equal(copied.bytes.length, bytes.length);
  assert.equal(copied.sha256, hash(bytes));
  return { bytes: bytes.length, sha256: copied.sha256 };
}
/** Export only explicit default namespaces in a physically verified registry. Never scan system temporary storage. */
export async function acquireConsumerHostCapture(
  registryPath,
  parent,
  expectedContext,
) {
  assert.ok(
    process.platform !== "win32" ||
      process.env.CHECKTRAIL_CONSUMER_CAPTURE_ROOT === undefined,
    "Operator POSIX capture parent is unsupported on Windows",
  );
  const harness = await realpath(
      fileURLToPath(new URL("../", import.meta.url)),
    ),
    relative = path.relative(harness, parent);
  assert.ok(
    path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(".." + path.sep),
    "Host native copies stay outside the source harness",
  );
  const parentBefore = await directory(parent),
    registry = await readConsumerCaptureRegistry(registryPath);
  assert.deepEqual(
    registry.context,
    expectedContext,
    "Host native registry belongs to another attempt, scope or source",
  );
  const original = await physical(registryPath, 1048576);
  assert.equal(original.bytes.length, registry.file.bytes);
  assert.equal(original.sha256, registry.file.sha256);
  const selected = decodeConsumerCaptureRegistry(original.bytes),
    namespaces = [];
  let total = original.bytes.length,
    rawBytes = 0;
  const perFile =
      expectedContext.captureKind === "selected-clang-producer-consumer"
        ? 32 * 1048576
        : 2097152,
    aggregate =
      expectedContext.captureKind === "selected-clang-producer-consumer"
        ? 256 * 1048576
        : 32 * 1048576;
  // Validate and read every original input before creating any copy. Failed and incomplete namespaces remain diagnostics, never successful qualification.
  for (const registration of selected.registrations) {
    if (registration.state === "collected-removed") {
      namespaces.push({
        registrationId: registration.id,
        state: registration.state,
        files: [],
      });
      continue;
    }
    const before = await directory(registration.path),
      names = (await readdir(registration.path)).sort(),
      files = [];
    assert.ok(names.length <= 513);
    for (const name of names) {
      assert.ok(
        name.length > 0 &&
          !/[\\/:]/.test(name) &&
          !name.includes("\0") &&
          name !== "." &&
          name !== "..",
      );
      const value = await physical(
        path.join(registration.path, name),
        name === "controller.json" ? 16384 : perFile,
      );
      total += value.bytes.length;
      if (name !== "controller.json") rawBytes += value.bytes.length;
      assert.ok(
        rawBytes <= aggregate,
        "Host native capture aggregate exceeds bound",
      );
      assert.ok(
        total <= aggregate + 1048576 + selected.registrations.length * 16384,
      );
      files.push({ name, bytes: value.bytes });
    }
    assert.deepEqual(
      (await readdir(registration.path)).sort(),
      names,
      "Host native namespace file set changed during acquisition",
    );
    const after = await directory(registration.path);
    for (const field of ["dev", "ino", "birthtimeNs", "mtimeNs", "ctimeNs"])
      assert.equal(after[field], before[field]);
    namespaces.push({
      registrationId: registration.id,
      state: registration.state,
      files,
    });
  }
  const afterRegistry = await readConsumerCaptureRegistry(registryPath);
  assert.equal(
    afterRegistry.file.sha256,
    registry.file.sha256,
    "Host native registry changed during acquisition",
  );
  assert.equal(afterRegistry.file.bytes, registry.file.bytes);
  const staging = path.join(parent, ".host-capture-pending-" + randomUUID());
  await mkdir(staging, { mode: 0o700 });
  await directory(staging, true);
  try {
    await writePrivate(
      path.join(staging, "capture-registry.jsonl"),
      original.bytes,
    );
    const manifest = [];
    for (const namespace of namespaces) {
      const destination = path.join(
        staging,
        "namespace-" + namespace.registrationId,
      );
      await mkdir(destination, { mode: 0o700 });
      await directory(destination, true);
      for (const file of namespace.files) {
        const stored = await writePrivate(
          path.join(destination, file.name),
          file.bytes,
        );
        manifest.push({
          registrationId: namespace.registrationId,
          name: file.name,
          ...stored,
        });
      }
    }
    const descriptor = {
      schemaVersion: 1,
      profile: "physically-acquired-native-host-capture-v1",
      context: { ...expectedContext },
      registry: { bytes: original.bytes.length, sha256: original.sha256 },
      registrations: selected.registrations.map((registration) => ({
        id: registration.id,
        state: registration.state,
      })),
      files: manifest,
      bytes: total,
      originalNamespacesRetained: true,
      physicalAcquisitionComplete: true,
      nativeSemanticsValidated: false,
      hostAttestationPerformed: false,
      gateAComplete: false,
    };
    await writePrivate(
      path.join(staging, "acquisition.json"),
      Buffer.from(JSON.stringify(descriptor) + "\n"),
    );
    const current = await directory(parent);
    for (const field of ["dev", "ino", "birthtimeNs"])
      assert.equal(current[field], parentBefore[field]);
    const destination = path.join(parent, "host-capture-" + randomUUID());
    await rename(staging, destination);
    await directory(destination);
    return {
      directory: destination,
      descriptor,
      transport: {
        registryBytes: original.bytes,
        namespaces: namespaces.map(({ registrationId, files }) => ({
          registrationId,
          files,
        })),
      },
    };
  } catch (error) {
    process.stderr.write(
      "Incomplete host native copy retained at " + staging + "\n",
    );
    throw error;
  }
}
