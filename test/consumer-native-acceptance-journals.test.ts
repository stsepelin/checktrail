import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtemp,
  realpath,
  readFile,
  readdir,
  open,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensureWindowsTaskAccess } from "../src/windows-task-access.js";
const {
  createConsumerCaptureRegistry,
  registerConsumerCaptureNamespace,
  finishConsumerCaptureRegistration,
} = await import(
  new URL("../../scripts/consumer-native-capture-registry.mjs", import.meta.url)
    .href
);
const {
  reconcileConsumerNativeJournals,
  requireConsumerNativeJournalCollection,
} = await import(
  new URL(
    "../../scripts/consumer-native-acceptance-journals.mjs",
    import.meta.url,
  ).href
);
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function fixture(
  state: "collected-retained" | "failed-retained" | null = "collected-retained",
) {
  const parent = await realpath(
      await mkdtemp(
        path.join(os.tmpdir(), "checktrail-synthetic-journal-registry-"),
      ),
    ),
    namespace = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "checktrail-consumer-witness-")),
    );
  if (process.platform === "win32") {
    ensureWindowsTaskAccess(parent, "directory", true);
    ensureWindowsTaskAccess(namespace, "directory", true);
  }
  const context = {
      attemptId: randomUUID(),
      scopeId: "synthetic:journal-linkage-only",
      captureKind: "native-consumer",
      sourceFrameSha256: "a".repeat(64),
    },
    registry = await createConsumerCaptureRegistry(parent, context),
    previous = process.env.CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY;
  const row = {
      family: "php",
      variant: "fixed",
      phase: "canonical",
      witnessId: randomUUID(),
      syntheticStorageOnly: true,
      nativeQualification: false,
    },
    value = {
      attemptId: randomUUID(),
      witnessId: row.witnessId,
      profile: "synthetic-storage-only",
      result: { exitCode: 7 },
      nativeQualification: false,
    },
    attemptBytes = Buffer.from(JSON.stringify(value) + "\n"),
    attempt = {
      file: "attempt-" + value.attemptId + ".json",
      bytes: attemptBytes.length,
      sha256: hash(attemptBytes),
      value,
    };
  async function store(name: string, bytes: Buffer) {
    const file = path.join(namespace, name),
      fd = await open(file, "wx", 0o600);
    try {
      if (process.platform === "win32")
        ensureWindowsTaskAccess(file, "file", true);
      await fd.writeFile(bytes);
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
    await store(
      [row.family, row.variant, row.phase, row.witnessId].join("-") + ".json",
      Buffer.from(JSON.stringify(row) + "\n"),
    );
    await store(attempt.file, attemptBytes);
    await store(
      "controller.json",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          state: "collected-scoped",
          gateAComplete: false,
          inferenceInvoked: false,
          fieldEvaluationExecuted: false,
        }) + "\n",
      ),
    );
    if (state !== null) await finishConsumerCaptureRegistration(token, state);
    const registryBytes = await readFile(registry.path),
      decoded = JSON.parse(registryBytes.toString("utf8").split("\n")[1]!);
    const transport = {
      registryBytes,
      namespaces: [
        {
          registrationId: decoded.id,
          files: await Promise.all(
            (await readdir(namespace)).sort().map(async (name) => ({
              name,
              bytes: await readFile(path.join(namespace, name)),
            })),
          ),
        },
      ],
    };
    return {
      context,
      transport,
      collection: { observations: [row], attemptRecords: [attempt] },
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
type Transport = Awaited<ReturnType<typeof fixture>>["transport"];
const copy = (transport: Transport): Transport => ({
  registryBytes: Buffer.from(transport.registryBytes),
  namespaces: transport.namespaces.map((namespace) => ({
    ...namespace,
    files: namespace.files.map((file) => ({
      ...file,
      bytes: Buffer.from(file.bytes),
    })),
  })),
});
test("native journal linkage binds every real retained file and preserves expected failed process data while leaving physical and semantic qualification separate", async () => {
  const f = await fixture();
  try {
    const journals = reconcileConsumerNativeJournals([f.transport], f.context),
      linkage = requireConsumerNativeJournalCollection(f.collection, journals);
    assert.equal(journals.logicalStorageBindingsComplete, true);
    assert.equal(journals.physicalAcquisitionVerified, false);
    assert.equal(journals.nativeSemanticsValidated, false);
    assert.equal(linkage.observations.length, 1);
    assert.equal(linkage.attempts.length, 1);
    assert.equal(
      linkage.attempts[0].sha256,
      f.collection.attemptRecords[0]!.sha256,
    );
    assert.equal(f.collection.attemptRecords[0]!.value.result.exitCode, 7);
    assert.equal(linkage.physicalAcquisitionVerified, false);
    assert.equal(linkage.nativeSemanticsValidated, false);
    assert.equal(linkage.hostAttestationPerformed, false);
    assert.equal(linkage.gateAComplete, false);
    assert.equal(JSON.stringify(linkage).includes(os.tmpdir()), false);
  } finally {
    await f.cleanup();
  }
});
test("native journal reconciliation refuses stale foreign duplicate absent and nonterminal handoffs instead of trusting registry labels", async () => {
  const f = await fixture();
  try {
    for (const field of [
      "attemptId",
      "scopeId",
      "sourceFrameSha256",
    ] as const) {
      const changed = {
        ...f.context,
        [field]:
          field === "attemptId"
            ? randomUUID()
            : field === "sourceFrameSha256"
              ? "b".repeat(64)
              : "synthetic:foreign",
      };
      assert.throws(
        () => reconcileConsumerNativeJournals([f.transport], changed),
        /another attempt/,
      );
    }
    assert.throws(
      () =>
        reconcileConsumerNativeJournals([f.transport, f.transport], f.context),
      /Duplicate native capture registry/,
    );
    const missing = copy(f.transport);
    missing.namespaces = [];
    assert.throws(
      () => reconcileConsumerNativeJournals([missing], f.context),
      /Missing or extra/,
    );
    const wrong = copy(f.transport);
    wrong.namespaces[0]!.registrationId = randomUUID();
    assert.throws(
      () => reconcileConsumerNativeJournals([wrong], f.context),
      /materialization is missing/,
    );
    const duplicate = copy(f.transport);
    duplicate.namespaces[0]!.files.push(duplicate.namespaces[0]!.files[0]!);
    assert.throws(
      () => reconcileConsumerNativeJournals([duplicate], f.context),
      /Duplicate retained native filename/,
    );
    const noCheckpoint = copy(f.transport);
    noCheckpoint.namespaces[0]!.files =
      noCheckpoint.namespaces[0]!.files.filter(
        (file) => file.name !== "controller.json",
      );
    assert.throws(
      () => reconcileConsumerNativeJournals([noCheckpoint], f.context),
      /no collected controller checkpoint/,
    );
    const running = copy(f.transport),
      checkpoint = running.namespaces[0]!.files.find(
        (file) => file.name === "controller.json",
      )!;
    checkpoint.bytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        state: "running",
        gateAComplete: false,
      }) + "\n",
    );
    assert.throws(
      () => reconcileConsumerNativeJournals([running], f.context),
      /not terminal collected/,
    );
    const noncanonical = copy(f.transport),
      first = noncanonical.namespaces[0]!.files[0]!;
    first.bytes = Buffer.from(first.bytes.toString("utf8").trimEnd());
    assert.throws(
      () => reconcileConsumerNativeJournals([noncanonical], f.context),
      /noncanonical/,
    );
    const duplicateKeys = copy(f.transport),
      duplicateCheckpoint = duplicateKeys.namespaces[0]!.files.find(
        (file) => file.name === "controller.json",
      )!;
    duplicateCheckpoint.bytes = Buffer.from(
      '{"schemaVersion":1,"state":"running","state":"collected-scoped","gateAComplete":false}\n',
    );
    assert.throws(
      () => reconcileConsumerNativeJournals([duplicateKeys], f.context),
      /noncanonical/,
    );
    const foreign = copy(f.transport);
    foreign.namespaces[0]!.files[0]!.name = "../foreign.json";
    assert.throws(
      () => reconcileConsumerNativeJournals([foreign], f.context),
      /Foreign retained native filename/,
    );
  } finally {
    await f.cleanup();
  }
  for (const state of [null, "failed-retained"] as const) {
    const pending = await fixture(state);
    try {
      assert.throws(
        () =>
          reconcileConsumerNativeJournals([pending.transport], pending.context),
        /Unfinished, failed or removed/,
      );
    } finally {
      await pending.cleanup();
    }
  }
});
test("native collection linkage refuses modified omitted duplicate reused and extra raw observations even when packet summaries still look complete", async () => {
  const f = await fixture();
  try {
    const journals = reconcileConsumerNativeJournals([f.transport], f.context);
    const altered = structuredClone(f.collection);
    altered.observations[0]!.nativeQualification = true;
    assert.throws(
      () => requireConsumerNativeJournalCollection(altered, journals),
      /Retained native JSON/,
    );
    const wrongHash = structuredClone(f.collection);
    wrongHash.attemptRecords[0]!.sha256 = "f".repeat(64);
    assert.throws(() =>
      requireConsumerNativeJournalCollection(wrongHash, journals),
    );
    const missing = structuredClone(f.collection);
    missing.attemptRecords = [];
    assert.throws(() =>
      requireConsumerNativeJournalCollection(missing, journals),
    );
    const duplicate = structuredClone(f.collection);
    duplicate.observations.push(duplicate.observations[0]!);
    assert.throws(
      () => requireConsumerNativeJournalCollection(duplicate, journals),
      /reuses a retained file/,
    );
    const absent = structuredClone(f.collection);
    absent.observations[0]!.witnessId = randomUUID();
    assert.throws(
      () => requireConsumerNativeJournalCollection(absent, journals),
      /missing from retained journal/,
    );
    const extra = copy(f.transport),
      record = extra.namespaces[0]!.files.find((file) =>
        file.name.startsWith("attempt-"),
      )!,
      value = JSON.parse(record.bytes.toString("utf8"));
    value.attemptId = randomUUID();
    extra.namespaces[0]!.files.push({
      name: "attempt-" + value.attemptId + ".json",
      bytes: Buffer.from(JSON.stringify(value) + "\n"),
    });
    assert.throws(
      () =>
        requireConsumerNativeJournalCollection(
          f.collection,
          reconcileConsumerNativeJournals([extra], f.context),
        ),
      /unmatched observations or attempts/,
    );
    const reused = structuredClone(journals);
    reused.namespaces.push(structuredClone(reused.namespaces[0]));
    assert.throws(
      () => requireConsumerNativeJournalCollection(f.collection, reused),
      /reused across namespaces/,
    );
  } finally {
    await f.cleanup();
  }
});
