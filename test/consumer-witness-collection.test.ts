import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  open,
  readFile,
  readdir,
  rm,
  link,
  chmod,
  mkdtemp,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { ensureWindowsTaskAccess } from "../src/windows-task-access.js";
const { collectConsumerWitnesses, readConsumerWitnessNamespace } = await import(
  new URL("../../scripts/consumer-witness-collection.mjs", import.meta.url).href
);
async function stored(namespace: string, name: string, value: unknown) {
  const filename = path.join(namespace, name),
    fd = await open(filename, "wx", 0o600);
  try {
    if (process.platform === "win32")
      ensureWindowsTaskAccess(filename, "file", true);
    await fd.writeFile(JSON.stringify(value) + "\n");
  } finally {
    await fd.close();
  }
  return filename;
}
test("controlled private collection verifies exact stored bytes and reconciles before cleanup while restoring independent environment", async () => {
  assert.equal(process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR, undefined);
  let namespace = "",
    qualified = false;
  const result = await collectConsumerWitnesses(
    async () => {
      namespace = process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR!;
      assert.ok(path.isAbsolute(namespace));
      const value = {
          family: "php",
          profile: "synthetic-storage-fixture-v1",
          notNativeQualification: true,
        },
        name = "attempt-" + randomUUID() + ".json";
      await stored(namespace, name, value);
      return { name, value };
    },
    async (
      operation: { name: string; value: unknown },
      capture: {
        attemptRecords: {
          file: string;
          bytes: number;
          sha256: string;
          value: unknown;
        }[];
      },
    ) => {
      qualified = true;
      assert.equal(capture.attemptRecords.length, 1);
      const record = capture.attemptRecords[0]!,
        bytes = await readFile(path.join(namespace, operation.name));
      assert.equal(record.file, operation.name);
      assert.equal(record.bytes, bytes.length);
      assert.equal(
        record.sha256,
        createHash("sha256").update(bytes).digest("hex"),
      );
      assert.deepEqual(record.value, operation.value);
      return { scope: "synthetic-storage-only", nativeQualification: false };
    },
  );
  assert.equal(qualified, true);
  assert.equal(result.nativeQualification, false);
  assert.equal(process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR, undefined);
  await assert.rejects(readdir(namespace), { code: "ENOENT" });
});
test("controlled failed scoped reconciliation retains original private observations without qualifying or leaking environment", async () => {
  let namespace = "";
  try {
    await assert.rejects(
      collectConsumerWitnesses(
        async () => {
          namespace = process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR!;
          await stored(namespace, "attempt-" + randomUUID() + ".json", {
            family: "php",
            synthetic: true,
          });
          return {};
        },
        async () => {
          throw Error("Original synthetic scoped refusal");
        },
      ),
      /Original synthetic scoped refusal/,
    );
    assert.equal(process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR, undefined);
    const captured = await readConsumerWitnessNamespace(namespace);
    assert.equal(captured.attemptRecords.length, 1);
    const checkpoint = JSON.parse(
      await readFile(path.join(namespace, "controller.json"), "utf8"),
    );
    assert.equal(checkpoint.state, "failed-incomplete");
    assert.equal(checkpoint.gateAComplete, false);
  } finally {
    if (namespace) await rm(namespace, { recursive: true, force: true });
  }
});
test("private collection refuses linked records permissive permissions and nested ownership instead of accepting an empty packet", async () => {
  let namespace = "";
  try {
    await assert.rejects(
      collectConsumerWitnesses(
        async () => {
          namespace = process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR!;
          const filename = await stored(
            namespace,
            "attempt-" + randomUUID() + ".json",
            { family: "php", synthetic: true },
          );
          if (process.platform === "win32")
            await link(
              filename,
              path.join(namespace, "attempt-" + randomUUID() + ".json"),
            );
          else await chmod(filename, 0o644);
          return {};
        },
        async () => ({ nativeQualification: false }),
      ),
    );
    assert.equal(process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR, undefined);
  } finally {
    if (namespace) await rm(namespace, { recursive: true, force: true });
  }
  namespace = "";
  try {
    await assert.rejects(
      collectConsumerWitnesses(
        async () => {
          namespace = process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR!;
          return {};
        },
        async () => undefined,
      ),
      /returned no packet/,
    );
  } finally {
    if (namespace) await rm(namespace, { recursive: true, force: true });
  }
  process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR = "synthetic-existing-namespace";
  try {
    await assert.rejects(
      collectConsumerWitnesses(
        async () => ({}),
        async () => ({}),
      ),
      /Nested consumer collection/,
    );
    assert.equal(
      process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR,
      "synthetic-existing-namespace",
    );
  } finally {
    delete process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR;
  }
});

test("selected Clang operator scope has separate bounded packet storage and cannot broaden ordinary consumer journals or admit foreign profiles", async () => {
  const result = await collectConsumerWitnesses(
    async () => {
      const namespace = process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR!;
      await stored(namespace, "attempt-" + randomUUID() + ".json", {
        family: "cpp",
        profile: "selected-clang-process-result-observation-v1",
        syntheticStorageOnly: true,
        data: "x".repeat(300000),
      });
      return namespace;
    },
    async (namespace: string, capture: { attemptRecords: unknown[] }) => {
      assert.equal(capture.attemptRecords.length, 1);
      await assert.rejects(
        readConsumerWitnessNamespace(namespace),
        /assert|false/i,
      );
      return { nativeQualification: false };
    },
    { scope: "selected-clang-producer-consumer" },
  );
  assert.equal(result.nativeQualification, false);
  await assert.rejects(
    collectConsumerWitnesses(
      async () => ({}),
      async () => ({}),
      { scope: "foreign" },
    ),
  );
  let namespace = "";
  try {
    await assert.rejects(
      collectConsumerWitnesses(
        async () => {
          namespace = process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR!;
          await stored(namespace, "attempt-" + randomUUID() + ".json", {
            family: "cpp",
            profile: "foreign-synthetic-packet",
          });
          return {};
        },
        async () => ({ nativeQualification: false }),
        { scope: "selected-clang-producer-consumer" },
      ),
    );
  } finally {
    if (namespace) await rm(namespace, { recursive: true, force: true });
  }
});

const { createConsumerCaptureRegistry, readConsumerCaptureRegistry } =
  await import(
    new URL(
      "../../scripts/consumer-native-capture-registry.mjs",
      import.meta.url,
    ).href
  );
test("registered collection journals namespace creation before the body and retains exact successful bytes for parent export", async () => {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "checktrail-storage-registry-")),
  );
  if (process.platform === "win32")
    ensureWindowsTaskAccess(directory, "directory", true);
  let namespace = "";
  const previous = process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY;
  try {
    const registry = await createConsumerCaptureRegistry(directory, {
      attemptId: randomUUID(),
      scopeId: "synthetic:storage-only",
      captureKind: "native-consumer",
      sourceFrameSha256: "a".repeat(64),
    });
    process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY = registry.path;
    const result = await collectConsumerWitnesses(
      async () => {
        namespace = process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR!;
        const running = await readConsumerCaptureRegistry(registry.path);
        assert.equal(running.registrations.length, 1);
        assert.equal(running.registrations[0].state, "created");
        assert.equal(running.registrations[0].path, namespace);
        await stored(namespace, "attempt-" + randomUUID() + ".json", {
          family: "php",
          syntheticStorageOnly: true,
        });
        return {};
      },
      async (_result: unknown, capture: { attemptRecords: unknown[] }) => {
        assert.equal(capture.attemptRecords.length, 1);
        return { nativeQualification: false };
      },
    );
    assert.equal(result.nativeQualification, false);
    assert.equal(
      (await readConsumerCaptureRegistry(registry.path)).registrations[0].state,
      "collected-retained",
    );
    assert.equal(
      (await readConsumerWitnessNamespace(namespace)).attemptRecords.length,
      1,
    );
    assert.equal(
      JSON.parse(
        await readFile(path.join(namespace, "controller.json"), "utf8"),
      ).state,
      "collected-scoped",
    );
  } finally {
    if (previous === undefined)
      delete process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY;
    else process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY = previous;
    if (namespace) await rm(namespace, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
test("registered collection preserves actual failed journals and terminal state without replacing the original error", async () => {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "checktrail-storage-registry-")),
  );
  if (process.platform === "win32")
    ensureWindowsTaskAccess(directory, "directory", true);
  const previous = process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY;
  let namespace = "";
  try {
    const registry = await createConsumerCaptureRegistry(directory, {
      attemptId: randomUUID(),
      scopeId: "synthetic:refused-storage",
      captureKind: "native-consumer",
      sourceFrameSha256: "b".repeat(64),
    });
    process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY = registry.path;
    await assert.rejects(
      collectConsumerWitnesses(
        async () => {
          namespace = process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR!;
          await stored(namespace, "attempt-" + randomUUID() + ".json", {
            family: "php",
            syntheticFailure: true,
          });
          throw Error("Original synthetic body failure");
        },
        async () => ({ nativeQualification: false }),
      ),
      /Original synthetic body failure/,
    );
    assert.equal(
      (await readConsumerCaptureRegistry(registry.path)).registrations[0].state,
      "failed-retained",
    );
    assert.equal(
      (await readConsumerWitnessNamespace(namespace)).attemptRecords.length,
      1,
    );
    await rm(namespace, { recursive: true, force: true });
    namespace = "";
  } finally {
    if (previous === undefined)
      delete process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY;
    else process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY = previous;
    if (namespace) await rm(namespace, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
