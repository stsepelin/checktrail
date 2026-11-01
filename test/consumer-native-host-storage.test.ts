import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtemp,
  realpath,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  chmod,
  link,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ensureWindowsTaskAccess } from "../src/windows-task-access.js";
const {
  createConsumerCaptureRegistry,
  registerConsumerCaptureNamespace,
  finishConsumerCaptureRegistration,
  decodeConsumerCaptureRegistry,
  readConsumerCaptureRegistry,
} = await import(
  new URL("../../scripts/consumer-native-capture-registry.mjs", import.meta.url)
    .href
);
const { acquireConsumerHostCapture, releaseConsumerHostCapture } = await import(
  new URL("../../scripts/consumer-native-host-storage.mjs", import.meta.url)
    .href
);
const { reconcileConsumerNativeJournals } = await import(
  new URL(
    "../../scripts/consumer-native-acceptance-journals.mjs",
    import.meta.url,
  ).href
);
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function fixture(
  state: "collected-retained" | "failed-retained" = "collected-retained",
) {
  const parent = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "checktrail-synthetic-host-copy-")),
    ),
    namespace = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "checktrail-consumer-witness-")),
    ),
    destination = path.join(parent, "destination");
  if (process.platform === "win32") {
    ensureWindowsTaskAccess(parent, "directory", true);
    ensureWindowsTaskAccess(namespace, "directory", true);
  }
  await mkdir(destination, { mode: 0o700 });
  if (process.platform === "win32")
    ensureWindowsTaskAccess(destination, "directory", true);
  const context = {
      attemptId: randomUUID(),
      scopeId: "synthetic:host-custody-only",
      captureKind: "native-consumer",
      sourceFrameSha256: "c".repeat(64),
    },
    registry = await createConsumerCaptureRegistry(parent, context),
    name = "attempt-" + randomUUID() + ".json",
    bytes = Buffer.from(
      JSON.stringify({
        family: "php",
        syntheticStorageOnly: true,
        nativeQualification: false,
        exitCode: 7,
      }) + "\n",
    ),
    previous = process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY;
  async function stored(file: string, data: Buffer) {
    const fd = await open(file, "wx", 0o600);
    try {
      if (process.platform === "win32")
        ensureWindowsTaskAccess(file, "file", true);
      await fd.writeFile(data);
      await fd.sync();
    } finally {
      await fd.close();
    }
  }
  try {
    process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY = registry.path;
    const token = await registerConsumerCaptureNamespace(
      namespace,
      "native-consumer",
    );
    await stored(path.join(namespace, name), bytes);
    await stored(
      path.join(namespace, "controller.json"),
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          state:
            state === "failed-retained"
              ? "failed-incomplete"
              : "collected-scoped",
          gateAComplete: false,
        }) + "\n",
      ),
    );
    await finishConsumerCaptureRegistration(token, state);
    return {
      parent,
      namespace,
      destination,
      context,
      registry,
      name,
      bytes,
      async cleanup() {
        await rm(namespace, { recursive: true, force: true });
        await rm(parent, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(namespace, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    throw error;
  } finally {
    if (previous === undefined)
      delete process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY;
    else process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY = previous;
  }
}
test("host native custody validates actual registered files before copying and preserves transported native identities without pretending the copy has the original inode", async () => {
  const f = await fixture();
  try {
    const acquired = await acquireConsumerHostCapture(
      f.registry.path,
      f.destination,
      f.context,
    );
    assert.equal(acquired.descriptor.physicalAcquisitionComplete, true);
    assert.equal(acquired.descriptor.nativeSemanticsValidated, false);
    assert.equal(acquired.descriptor.hostAttestationPerformed, false);
    assert.equal(acquired.descriptor.gateAComplete, false);
    assert.equal(acquired.descriptor.originalNamespacesRetained, true);
    const copiedRegistry = path.join(
        acquired.directory,
        "capture-registry.jsonl",
      ),
      registryBytes = await readFile(copiedRegistry);
    assert.equal(hash(registryBytes), acquired.descriptor.registry.sha256);
    assert.deepEqual(
      decodeConsumerCaptureRegistry(registryBytes).context,
      f.context,
    );
    await assert.rejects(readConsumerCaptureRegistry(copiedRegistry));
    const raw = acquired.transport.namespaces[0]!.files.find(
      (file: { name: string }) => file.name === f.name,
    )!;
    assert.deepEqual(raw.bytes, f.bytes);
    assert.deepEqual(await readFile(path.join(f.namespace, f.name)), f.bytes);
    const copy = await readFile(
      path.join(
        acquired.directory,
        "namespace-" + acquired.transport.namespaces[0]!.registrationId,
        f.name,
      ),
    );
    assert.deepEqual(copy, f.bytes);
    assert.equal(
      acquired.descriptor.files.find(
        (file: { name: string }) => file.name === f.name,
      ).sha256,
      hash(f.bytes),
    );
    const journals = reconcileConsumerNativeJournals(
      [acquired.transport],
      f.context,
    );
    assert.equal(journals.logicalStorageBindingsComplete, true);
    assert.equal(journals.nativeSemanticsValidated, false);
    await assert.rejects(
      releaseConsumerHostCapture({ ...acquired }),
      /foreign or already released/,
    );
    const report = await releaseConsumerHostCapture(acquired);
    assert.equal(report.durableCopyPreserved, true);
    assert.equal(report.removedRegistrations.length, 1);
    await assert.rejects(readdir(f.namespace), { code: "ENOENT" });
    assert.deepEqual(
      await readFile(
        path.join(
          acquired.directory,
          "namespace-" + acquired.transport.namespaces[0]!.registrationId,
          f.name,
        ),
      ),
      f.bytes,
    );
    await assert.rejects(
      releaseConsumerHostCapture(acquired),
      /foreign or already released/,
    );
  } finally {
    await f.cleanup();
  }
});
test("host native custody refuses foreign contexts and unsafe source records before any destination copy exists then accepts the restored near miss", async () => {
  const f = await fixture();
  try {
    const harness = await realpath(
        fileURLToPath(new URL("../../", import.meta.url)),
      ),
      ignored = path.join(harness, ".checktrail");
    await mkdir(ignored, { recursive: true });
    assert.equal(await realpath(ignored), ignored);
    const sourceDestination = path.join(
      ignored,
      "synthetic-host-copy-" + randomUUID(),
    );
    await mkdir(sourceDestination, { mode: 0o700 });
    if (process.platform === "win32")
      ensureWindowsTaskAccess(sourceDestination, "directory", true);
    try {
      await assert.rejects(
        acquireConsumerHostCapture(
          f.registry.path,
          sourceDestination,
          f.context,
        ),
        /outside the source harness/,
      );
      assert.deepEqual(await readdir(sourceDestination), []);
    } finally {
      await rm(sourceDestination, { recursive: true, force: true });
    }

    await assert.rejects(
      acquireConsumerHostCapture(f.registry.path, f.destination, {
        ...f.context,
        scopeId: "synthetic:foreign",
      }),
      /another attempt/,
    );
    assert.deepEqual(await readdir(f.destination), []);
    const original = path.join(f.namespace, f.name),
      linked = path.join(f.namespace, "extra-synthetic-hardlink");
    if (process.platform === "win32") await link(original, linked);
    else await chmod(original, 0o644);
    await assert.rejects(
      acquireConsumerHostCapture(f.registry.path, f.destination, f.context),
      /bounded private regular file/,
    );
    assert.deepEqual(await readdir(f.destination), []);
    if (process.platform === "win32") await unlink(linked);
    else await chmod(original, 0o600);
    const acquired = await acquireConsumerHostCapture(
      f.registry.path,
      f.destination,
      f.context,
    );
    assert.equal(acquired.descriptor.physicalAcquisitionComplete, true);
    assert.equal(acquired.transport.namespaces[0]!.files.length, 2);
  } finally {
    await f.cleanup();
  }
});
test("host native custody retains failed raw diagnostics while logical successful acceptance still refuses their terminal state", async () => {
  const f = await fixture("failed-retained");
  try {
    const acquired = await acquireConsumerHostCapture(
      f.registry.path,
      f.destination,
      f.context,
    );
    assert.equal(acquired.descriptor.registrations[0].state, "failed-retained");
    assert.equal(acquired.descriptor.nativeSemanticsValidated, false);
    assert.deepEqual(
      acquired.transport.namespaces[0]!.files.find(
        (file: { name: string }) => file.name === f.name,
      ).bytes,
      f.bytes,
    );
    await assert.rejects(
      releaseConsumerHostCapture(acquired),
      /Failed or unfinished/,
    );
    assert.deepEqual(await readFile(path.join(f.namespace, f.name)), f.bytes);
    assert.throws(
      () => reconcileConsumerNativeJournals([acquired.transport], f.context),
      /Unfinished, failed or removed/,
    );
  } finally {
    await f.cleanup();
  }
});
test("host native custody validates every registered sibling before writing any output and retains both namespaces in the valid multi-namespace case", async () => {
  const f = await fixture(),
    second = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "checktrail-consumer-witness-")),
    ),
    previous = process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY;
  try {
    if (process.platform === "win32")
      ensureWindowsTaskAccess(second, "directory", true);
    process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY = f.registry.path;
    const token = await registerConsumerCaptureNamespace(
      second,
      "native-consumer",
    );
    async function store(name: string, bytes: Buffer) {
      const filename = path.join(second, name),
        fd = await open(filename, "wx", 0o600);
      try {
        if (process.platform === "win32")
          ensureWindowsTaskAccess(filename, "file", true);
        await fd.writeFile(bytes);
        await fd.sync();
      } finally {
        await fd.close();
      }
    }
    const name = "attempt-" + randomUUID() + ".json",
      filename = path.join(second, name);
    await store(
      name,
      Buffer.from(
        JSON.stringify({
          family: "php",
          syntheticSibling: true,
          nativeQualification: false,
        }) + "\n",
      ),
    );
    await store(
      "controller.json",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          state: "collected-scoped",
          gateAComplete: false,
        }) + "\n",
      ),
    );
    await finishConsumerCaptureRegistration(token, "collected-retained");
    const linked = path.join(second, "synthetic-second-link");
    await link(filename, linked);
    await assert.rejects(
      acquireConsumerHostCapture(f.registry.path, f.destination, f.context),
      /bounded private regular file/,
    );
    assert.deepEqual(await readdir(f.destination), []);
    assert.deepEqual(await readFile(path.join(f.namespace, f.name)), f.bytes);
    await unlink(linked);
    const acquired = await acquireConsumerHostCapture(
      f.registry.path,
      f.destination,
      f.context,
    );
    assert.equal(acquired.transport.namespaces.length, 2);
    assert.equal(acquired.descriptor.registrations.length, 2);
    assert.equal(acquired.descriptor.files.length, 4);
    assert.equal(
      reconcileConsumerNativeJournals([acquired.transport], f.context)
        .namespaces.length,
      2,
    );
    const originalSecond = await readFile(filename);
    await writeFile(filename, Buffer.from("changed"));
    await assert.rejects(releaseConsumerHostCapture(acquired));
    assert.deepEqual(await readFile(path.join(f.namespace, f.name)), f.bytes);
    assert.deepEqual(await readFile(filename), Buffer.from("changed"));
    await writeFile(filename, originalSecond);
    const released = await releaseConsumerHostCapture(acquired);
    assert.equal(released.removedRegistrations.length, 2);
    await assert.rejects(readdir(f.namespace), { code: "ENOENT" });
    await assert.rejects(readdir(second), { code: "ENOENT" });
  } finally {
    if (previous === undefined)
      delete process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY;
    else process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY = previous;
    await rm(second, { recursive: true, force: true });
    await f.cleanup();
  }
});
