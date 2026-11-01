import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { decodeConsumerCaptureRegistry } from "./consumer-native-capture-registry.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (bytes) =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const kinds = ["native-consumer", "selected-clang-producer-consumer"];
function contextIdentity(context) {
  assert.deepEqual(
    Object.keys(context).sort(),
    ["attemptId", "captureKind", "scopeId", "sourceFrameSha256"].sort(),
  );
  assert.match(
    context.attemptId,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  assert.ok(
    typeof context.scopeId === "string" &&
      context.scopeId.length > 0 &&
      Buffer.byteLength(context.scopeId) <= 512,
  );
  assert.ok(kinds.includes(context.captureKind));
  assert.match(context.sourceFrameSha256, /^[a-f0-9]{64}$/);
}
/** Logical reconciliation of already-retained bytes; physical acquisition remains the caller's separate obligation. */
export function reconcileConsumerNativeJournals(transports, expectedContext) {
  contextIdentity(expectedContext);
  assert.ok(
    Array.isArray(transports) &&
      transports.length > 0 &&
      transports.length <= 128,
  );
  const registries = [],
    namespaces = [],
    registryIds = new Set(),
    registrationIds = new Set();
  let bytes = 0,
    count = 0;
  for (const transport of transports) {
    assert.ok(
      Buffer.isBuffer(transport.registryBytes) &&
        transport.registryBytes.length <= 1048576,
    );
    const registry = decodeConsumerCaptureRegistry(transport.registryBytes);
    assert.deepEqual(
      registry.context,
      expectedContext,
      "Retained journal belongs to another attempt, scope or current source",
    );
    assert.equal(
      registryIds.has(registry.registryId),
      false,
      "Duplicate native capture registry",
    );
    registryIds.add(registry.registryId);
    assert.ok(
      Array.isArray(transport.namespaces) &&
        transport.namespaces.length === registry.registrations.length,
      "Missing or extra retained namespace",
    );
    const supplied = new Map();
    for (const namespace of transport.namespaces) {
      assert.equal(
        supplied.has(namespace.registrationId),
        false,
        "Duplicate retained namespace materialization",
      );
      supplied.set(namespace.registrationId, namespace);
    }
    for (const registration of registry.registrations) {
      assert.equal(
        registration.state,
        "collected-retained",
        "Unfinished, failed or removed native namespace cannot qualify a successful controller",
      );
      assert.equal(registration.captureKind, expectedContext.captureKind);
      assert.equal(
        registrationIds.has(registration.id),
        false,
        "Reused native capture registration",
      );
      registrationIds.add(registration.id);
      const retained = supplied.get(registration.id);
      assert.ok(
        retained,
        "Registered native namespace materialization is missing",
      );
      assert.ok(
        Array.isArray(retained.files) &&
          retained.files.length > 1 &&
          retained.files.length <= 513,
      );
      const names = new Set(),
        files = [];
      let checkpoint = null;
      for (const file of retained.files) {
        assert.equal(typeof file.name, "string");
        assert.equal(
          names.has(file.name),
          false,
          "Duplicate retained native filename",
        );
        names.add(file.name);
        assert.ok(
          file.name === "controller.json" ||
            /^(?:(?:go|python|php|rust|ruby|c|cpp|java|kotlin|scala|csharp|fsharp|vb|hcl|yaml|swift|javascript|typescript|shared-json)-(?:broken|fixed|near-miss)-(?:canonical|caller-change|restored|repeat)|attempt)-[a-f0-9-]{36}\.json$/.test(
              file.name,
            ),
          "Foreign retained native filename",
        );
        assert.ok(Buffer.isBuffer(file.bytes));
        const maximum =
          expectedContext.captureKind === "selected-clang-producer-consumer"
            ? 32 * 1048576
            : 2097152;
        assert.ok(file.bytes.length > 0 && file.bytes.length <= maximum);
        bytes += file.bytes.length;
        count++;
        assert.ok(
          bytes <= 512 * 1048576 && count <= 4096,
          "Retained native journal aggregate exceeds bound",
        );
        const value = json(file.bytes);
        assert.equal(
          Buffer.from(JSON.stringify(value) + "\n").equals(file.bytes),
          true,
          "Retained native JSON framing is noncanonical",
        );
        const observed = {
          file: file.name,
          bytes: file.bytes.length,
          sha256: hash(file.bytes),
          value,
        };
        if (file.name === "controller.json") {
          assert.equal(value.schemaVersion, 1);
          assert.ok(
            [
              "collected-scoped",
              "collected-qualified-family",
              "collected-unqualified",
            ].includes(value.state),
            "Controller namespace checkpoint is not terminal collected",
          );
          assert.equal(value.gateAComplete, false);
          checkpoint = {
            bytes: observed.bytes,
            sha256: observed.sha256,
            state: value.state,
          };
        } else files.push(observed);
      }
      assert.ok(
        checkpoint,
        "Retained namespace has no collected controller checkpoint",
      );
      namespaces.push({
        registrationId: registration.id,
        registryId: registry.registryId,
        checkpoint,
        files,
      });
    }
    registries.push({
      registryId: registry.registryId,
      bytes: transport.registryBytes.length,
      sha256: hash(transport.registryBytes),
      namespaces: registry.registrations.length,
    });
  }
  assert.ok(namespaces.length > 0, "No native witness namespace was retained");
  return {
    schemaVersion: 1,
    profile: "retained-native-consumer-journal-reconciliation-v1",
    context: { ...expectedContext },
    registries,
    namespaces,
    bytes,
    files: count,
    logicalStorageBindingsComplete: true,
    physicalAcquisitionVerified: false,
    nativeSemanticsValidated: false,
    hostAttestationPerformed: false,
    gateAComplete: false,
  };
}
/** Every collection observation and actual attempt must be exactly the bytes in the handed-off namespace set. */
export function requireConsumerNativeJournalCollection(collection, journals) {
  assert.equal(
    journals.profile,
    "retained-native-consumer-journal-reconciliation-v1",
  );
  assert.equal(journals.logicalStorageBindingsComplete, true);
  assert.equal(journals.nativeSemanticsValidated, false);
  assert.ok(
    Array.isArray(collection.observations) &&
      collection.observations.length > 0,
  );
  assert.ok(
    Array.isArray(collection.attemptRecords) &&
      collection.attemptRecords.length > 0,
  );
  const stored = new Map(),
    claimed = new Set();
  for (const namespace of journals.namespaces)
    for (const file of namespace.files) {
      assert.equal(
        stored.has(file.file),
        false,
        "Native witness or attempt filename reused across namespaces",
      );
      stored.set(file.file, {
        ...file,
        registrationId: namespace.registrationId,
        registryId: namespace.registryId,
      });
    }
  const observations = [],
    attempts = [];
  function match(file, value) {
    assert.equal(
      claimed.has(file),
      false,
      "Native collection reuses a retained file",
    );
    const physical = stored.get(file);
    assert.ok(physical, "Native collection file missing from retained journal");
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    assert.equal(
      physical.bytes,
      bytes.length,
      "Retained native JSON byte count differs",
    );
    assert.equal(
      physical.sha256,
      hash(bytes),
      "Retained native JSON bytes differ",
    );
    assert.deepEqual(physical.value, value);
    claimed.add(file);
    return {
      file,
      bytes: physical.bytes,
      sha256: physical.sha256,
      registrationId: physical.registrationId,
      registryId: physical.registryId,
    };
  }
  for (const row of collection.observations) {
    const file =
      [row.family, row.variant, row.phase, row.witnessId].join("-") + ".json";
    observations.push(match(file, row));
  }
  for (const record of collection.attemptRecords) {
    assert.equal(record.file, "attempt-" + record.value.attemptId + ".json");
    const physical = match(record.file, record.value);
    assert.equal(record.bytes, physical.bytes);
    assert.equal(record.sha256, physical.sha256);
    attempts.push(physical);
  }
  assert.deepEqual(
    [...claimed].sort(),
    [...stored.keys()].sort(),
    "Retained native journal has unmatched observations or attempts",
  );
  return {
    profile: "native-consumer-exact-journal-linkage-v1",
    observations,
    attempts,
    manifestSha256: hash(JSON.stringify({ observations, attempts })),
    logicalStorageBindingsComplete: true,
    physicalAcquisitionVerified: false,
    nativeSemanticsValidated: false,
    hostAttestationPerformed: false,
    gateAComplete: false,
  };
}
