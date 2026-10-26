import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
const environments = Object.freeze({
  tasks: {
    receipt: "CHECKTRAIL_TASKS_INSTALL_RECEIPT",
    slot: "CHECKTRAIL_TASKS_RUNTIME_SLOT",
  },
  lifecycle: {
    receipt: "CHECKTRAIL_LIFECYCLE_INSTALL_RECEIPT",
    slot: "CHECKTRAIL_LIFECYCLE_RUNTIME_SLOT",
  },
});
const active = new Set(),
  maximum = 4 * 1048576;
function selection(kind) {
  assert.ok(
    Object.hasOwn(environments, kind),
    "Unknown runtime installation capture",
  );
  return environments[kind];
}
const same = (a, b) =>
  ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
    (key) => a[key] === b[key],
  );
async function protect(file, kind, created) {
  if (process.platform === "win32") {
    const { ensureWindowsTaskAccess } =
      await import("../dist/src/windows-task-access.js");
    ensureWindowsTaskAccess(file, kind, created);
  }
}
async function readReceipt(file) {
  const named = await lstat(file, { bigint: true });
  assert.ok(
    named.isFile() && !named.isSymbolicLink(),
    "Runtime installation receipt must be regular",
  );
  assert.ok(
    named.size > 0n && named.size <= BigInt(maximum),
    "Runtime installation receipt byte bound",
  );
  await protect(file, "file", false);
  const handle = await open(
    file,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    assert.ok(
      opened.isFile() && same(named, opened),
      "Runtime installation receipt identity changed",
    );
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const next = await handle.read(bytes, count, bytes.length - count, null);
      if (!next.bytesRead) break;
      count += next.bytesRead;
    }
    assert.equal(
      BigInt(count),
      opened.size,
      "Runtime installation receipt size changed",
    );
    assert.ok(
      same(opened, await handle.stat({ bigint: true })) &&
        same(opened, await lstat(file, { bigint: true })),
      "Runtime installation receipt changed while reading",
    );
    const result = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, count),
      ),
    );
    assert.ok(
      result && typeof result === "object" && !Array.isArray(result),
      "Runtime installation receipt must be an object",
    );
    return result;
  } finally {
    await handle.close();
  }
}
/** Internal acceptance bookkeeping; it grants no project execution or host trust. */
export async function withRuntimeInstallationCapture(
  kind,
  { installed, slot },
  operation,
) {
  const names = selection(kind);
  assert.equal(typeof installed, "boolean");
  assert.ok(slot === null || typeof slot === "string");
  assert.ok(
    !active.has(kind),
    "Concurrent runtime installation capture is unavailable",
  );
  active.add(kind);
  const previous = Object.fromEntries(
    Object.values(names).map((name) => [name, process.env[name]]),
  );
  let temporary;
  try {
    if (!installed) {
      temporary = await realpath(
        await mkdtemp(
          path.join(tmpdir(), `checktrail-${kind}-runtime-install-`),
        ),
      );
      await protect(temporary, "directory", true);
      process.env[names.receipt] = path.join(temporary, "installed.json");
      if (slot === null) delete process.env[names.slot];
      else process.env[names.slot] = slot;
    }
    return await operation({
      read: () => {
        assert.ok(
          temporary,
          "Installed callback cannot create another installation capture",
        );
        return readReceipt(path.join(temporary, "installed.json"));
      },
    });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      if (temporary)
        await rm(temporary, {
          recursive: true,
          force: true,
          maxRetries: process.platform === "win32" ? 30 : 0,
          retryDelay: 100,
        });
    } finally {
      active.delete(kind);
    }
  }
}
export async function writeRuntimeInstallation(kind, receipt) {
  const names = selection(kind),
    file = process.env[names.receipt];
  if (file === undefined) return false;
  assert.ok(
    path.isAbsolute(file) && path.basename(file) === "installed.json",
    "Runtime installation capture path is invalid",
  );
  const bytes = Buffer.from(JSON.stringify(receipt) + "\n");
  assert.ok(
    bytes.length > 0 && bytes.length <= maximum,
    "Runtime installation receipt byte bound",
  );
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  return true;
}
