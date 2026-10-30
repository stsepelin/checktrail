import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  inspectConsumerAttemptRecords,
  requireConsumerWitnessAttempts,
} from "./consumer-witness-attempts.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const families = Object.freeze([
  "javascript",
  "typescript",
  "python",
  "go",
  "php",
  "rust",
  "java",
  "kotlin",
  "scala",
  "csharp",
  "fsharp",
  "vb",
  "ruby",
  "swift",
  "c",
  "cpp",
  "hcl",
  "yaml",
  "shared-json",
]);
const variants = Object.freeze(["broken", "fixed", "near-miss"]);
const sourcePaths = Object.freeze({
  go: ["policy/policy.go", "consumer/consumer.go"],
  python: ["pkg/policy.py", "pkg/consumer.py"],
  php: ["policy/policy.php", "consumer/consumer.php"],
  rust: ["src/policy.rs", "src/consumer.rs", "src/lib.rs"],
});
/** Selected declarations are checked against the inventory, never treated as executions. */
export function selectConsumerWitnessRequirements(
  manifest,
  inventory,
  profiles,
) {
  assert.equal(manifest?.schemaVersion, 1);
  assert.equal(manifest.profile, "selected-native-consumer-witnesses-v1");
  assert.equal(manifest.inventoryScopeSha256, inventory.scopeSha256);
  assert.deepEqual(
    manifest.families.map((row) => row.id),
    families,
  );
  for (const flag of [
    "gateAComplete",
    "qualityAssessed",
    "inferenceInvoked",
    "fieldEvaluationExecuted",
  ])
    assert.equal(manifest[flag], false);
  return manifest.families.map((row) => {
    const id =
      row.id === "javascript" || row.id === "shared-json"
        ? "consumer-impact"
        : row.id === "typescript"
          ? "javascript-extensions"
          : "context-" + row.id;
    assert.equal(row.profile, id);
    const found = inventory.extensionProfiles.filter(
      (profile) => profile.id === id,
    );
    assert.equal(found.length, 1);
    const profile = found[0];
    assert.equal(row.runtime, profile.runtime);
    assert.equal(row.acceptanceFile, profile.acceptanceFile);
    const expected = variants.map((id) => {
      const cases = profile.acceptanceCases.filter((entry) => entry.id === id);
      assert.equal(cases.length, 1);
      const item = { id, name: cases[0].name };
      assert.ok(
        profiles[row.profile].some(
          (entry) =>
            entry.file === row.acceptanceFile && entry.name === item.name,
        ),
      );
      return item;
    });
    assert.deepEqual(row.cases, expected);
    assert.ok(["prepared", "pending"].includes(row.collectorImplementation));
    assert.equal(row.nativeAcceptance, "pending");
    assert.deepEqual(row.sourcePaths, sourcePaths[row.id] ?? null);
    return { ...row, cases: expected };
  });
}
const fileDescriptor = (value) => {
  assert.ok(
    value && typeof value.path === "string" && value.path.length <= 512,
  );
  assert.ok(
    !value.path.startsWith("/") &&
      !/[\\\0:]/.test(value.path) &&
      value.path
        .split("/")
        .every((part) => part && part !== "." && part !== ".."),
  );
  assert.ok(
    Number.isSafeInteger(value.bytes) &&
      value.bytes >= 0 &&
      value.bytes <= 1048576,
  );
  assert.ok(sha(value.sha256));
};
function stream(value) {
  assert.ok(
    value &&
      typeof value.base64 === "string" &&
      value.base64.length <= 4 * Math.ceil(65536 / 3),
  );
  assert.ok(
    Number.isSafeInteger(value.bytes) &&
      value.bytes >= 0 &&
      value.bytes <= 65536,
  );
  assert.ok(sha(value.sha256));
  const bytes = Buffer.from(value.base64, "base64");
  assert.equal(bytes.toString("base64"), value.base64);
  assert.equal(bytes.length, value.bytes);
  assert.equal(hash(bytes), value.sha256);
  return bytes;
}
/** Reconcile retained native output; never infer a reached consumer from a passed callback name. */
export function inspectConsumerWitnesses(
  manifest,
  inventory,
  profiles,
  observations,
  bindings = [],
  attemptRecords = [],
) {
  const required = selectConsumerWitnessRequirements(
    manifest,
    inventory,
    profiles,
  );
  assert.ok(Array.isArray(observations) && observations.length <= 512);
  assert.ok(Array.isArray(bindings) && bindings.length <= 256);
  const expected = new Map(required.map((row) => [row.id, row]));
  const attempts = inspectConsumerAttemptRecords(attemptRecords);
  const usedAttempts = new Set();
  const incompleteAttemptFamilies = new Set();
  const reached = new Map();
  const duplicates = new Set();
  const issues = new Set();
  let retainedBytes = 0;
  for (const row of observations) {
    assert.equal(row?.schemaVersion, 1);
    assert.equal(row.profile, "original-consumer-witness-observation-v1");
    const selected = expected.get(row.family);
    assert.ok(selected, "Foreign consumer witness family");
    assert.ok(
      Object.hasOwn(sourcePaths, row.family),
      "Consumer family collector remains pending",
    );
    assert.ok(
      variants.includes(row.variant),
      "Foreign consumer witness variant",
    );
    assert.ok(["source", "installed"].includes(row.origin));
    assert.ok(
      ["canonical", "caller-change", "restored", "repeat"].includes(row.phase),
    );
    requireConsumerWitnessAttempts(row, attempts.records, usedAttempts);
    assert.equal(row.nativeInvoked, true);
    assert.equal(row.hostAttestationPerformed, false);
    assert.equal(row.gateAComplete, false);
    assert.ok(
      Array.isArray(row.before) &&
        row.before.length >= 2 &&
        row.before.length <= 32,
    );
    assert.deepEqual(
      row.after,
      row.before,
      "Consumer witness source changed during execution",
    );
    assert.deepEqual(
      row.before.map((file) => file.path),
      sourcePaths[row.family],
    );
    assert.ok(row.tool && sha(row.tool.sha256));
    assert.equal(row.tool.afterSha256, row.tool.sha256);
    const names = new Set();
    for (const file of row.before) {
      fileDescriptor(file);
      assert.equal(names.has(file.path), false);
      names.add(file.path);
    }
    const invocation = row.invocation;
    assert.ok(invocation && sha(invocation.executableSha256));
    assert.ok(sha(invocation.argvSha256));
    assert.equal(invocation.executableAfterSha256, invocation.executableSha256);
    assert.equal(invocation.exitCode, 0);
    assert.equal(invocation.errorCode, null);
    assert.equal(invocation.signal, null);
    assert.equal(invocation.timedOut, false);
    assert.equal(invocation.cancelled, false);
    assert.equal(invocation.truncated, false);
    assert.equal(invocation.cleanupComplete, true);
    const output = row.output;
    assert.equal(output?.profile, "bounded-physical-process-output-v1");
    assert.equal(output.completeForObservedStreams, true);
    const stdout = stream(output.stdout),
      stderr = stream(output.stderr);
    assert.equal(output.observedBytes, stdout.length + stderr.length);
    assert.equal(stderr.length, 0);
    retainedBytes += stdout.length + stderr.length;
    assert.ok(
      retainedBytes <= 16 * 1048576,
      "Consumer witness aggregate output bound exceeded",
    );
    assert.ok(sha(row.runtime.nodeExecutableSha256));
    assert.ok(
      typeof row.runtime.platform === "string" &&
        typeof row.runtime.architecture === "string" &&
        typeof row.runtime.node === "string",
    );
    // Output proof is computed from the actual witness response and independently
    // source-bound by each finite collector; an arbitrary caller label is not proof.
    assert.ok(
      row.nativeResult &&
        Array.isArray(row.nativeResult.consumers) &&
        row.nativeResult.consumers.length === 2 &&
        row.nativeResult.consumers.every((v) => typeof v === "boolean"),
    );
    const native = JSON.parse(stdout.toString("utf8"));
    const consumers =
      row.family === "go" ? native.answers?.slice(-2) : native.consumers;
    assert.deepEqual(consumers, row.nativeResult.consumers);
    const expectedConsumers =
      row.phase === "caller-change"
        ? [false, true]
        : row.variant === "broken"
          ? [true, true]
          : row.family === "rust" && row.variant === "near-miss"
            ? [false, false]
            : [false, true];
    assert.deepEqual(
      consumers,
      expectedConsumers,
      "Native consumer result differs from its original variant",
    );
    const expectedCases =
      row.variant === "broken"
        ? [true, true, true, false]
        : [true, false, false, false];
    const actualCases =
      row.family === "go"
        ? native.answers.slice(0, 4)
        : row.family === "python"
          ? native.cases?.map((item) => item.actual)
          : native.cases;
    assert.deepEqual(
      actualCases,
      expectedCases,
      "Native producer result differs from its original variant",
    );
    const source = row.nativeResult.sources;
    assert.ok(source && typeof source === "object");
    assert.deepEqual(
      Object.keys(source).sort(),
      row.before.map((file) => file.path).sort(),
    );
    assert.deepEqual(
      Object.keys(native.sources).sort(),
      row.before
        .map((file) =>
          row.family === "python" ? file.path.split("/").at(-1) : file.path,
        )
        .sort(),
    );
    for (const file of row.before) {
      const raw =
        native.sources?.[
          row.family === "python" ? file.path.split("/").at(-1) : file.path
        ];
      const actual = row.family === "rust" ? hash(Buffer.from(raw)) : raw;
      assert.equal(
        actual,
        file.sha256,
        "Physical native source observation differs",
      );
      assert.equal(
        source[file.path],
        actual,
        "Derived native source identity differs",
      );
    }
    if (row.family === "rust") {
      assert.ok(
        row.compiler,
        "Rust consumer lacks its reached compiler observation",
      );
      assert.ok(sha(row.compiler.argvSha256));
      assert.equal(row.compiler.exitCode, 0);
      assert.equal(row.compiler.signal, null);
      assert.equal(row.compiler.errorCode, null);
      assert.equal(row.compiler.timedOut, false);
      assert.equal(row.compiler.cancelled, false);
      assert.equal(row.compiler.truncated, false);
      assert.equal(row.compiler.cleanupComplete, true);
      assert.equal(row.compiler.executableSha256, row.tool.sha256);
      assert.equal(row.compiler.executableAfterSha256, row.tool.afterSha256);
      const compiled = row.compiler.output;
      assert.equal(compiled?.completeForObservedStreams, true);
      const compiledOut = stream(compiled.stdout),
        compiledErr = stream(compiled.stderr);
      assert.equal(
        compiled.observedBytes,
        compiledOut.length + compiledErr.length,
      );
      retainedBytes += compiledOut.length + compiledErr.length;
      assert.ok(retainedBytes <= 16 * 1048576);
    } else assert.equal(row.compiler, null);
    if (row.phase !== "canonical") continue;
    const address = JSON.stringify([row.family, row.variant, row.origin]);
    if (reached.has(address)) {
      issues.add("duplicate-canonical-witness");
      duplicates.add(row.family);
    } else reached.set(address, row);
  }
  for (const binding of bindings) {
    assert.ok(expected.has(binding.family), "Foreign native controller family");
    assert.ok(variants.includes(binding.variant));
    assert.ok(["source", "installed"].includes(binding.origin));
    if (
      !reached.has(
        JSON.stringify([binding.family, binding.variant, binding.origin]),
      )
    )
      issues.add("unmatched-controller-binding");
  }
  for (const [id, item] of attempts.records) {
    if (!usedAttempts.has(id)) {
      issues.add(
        item.value.state === "passed"
          ? "unmatched-consumer-attempt"
          : "failed-or-unavailable-consumer-attempt",
      );
      incompleteAttemptFamilies.add(item.value.family);
    }
  }
  const reports = required.map((family) => {
    const missing = [];
    const unqualified = [];
    for (const variant of variants)
      for (const origin of ["source", "installed"]) {
        const address = JSON.stringify([family.id, variant, origin]);
        const row = reached.get(address);
        if (!row) {
          missing.push({ variant, origin });
          continue;
        }
        const linked = bindings.filter(
          (binding) =>
            binding.family === family.id &&
            binding.variant === variant &&
            binding.origin === origin,
        );
        if (linked.length !== 1) {
          unqualified.push({
            variant,
            origin,
            reason: "missing-or-duplicate-controller-binding",
          });
          continue;
        }
        const binding = linked[0];
        // These are observations from the trusted native controller, not host
        // attestations. Neither a version label nor an environment slot can fill them.
        const observed = row.runtime;
        const declared = inventory.runtimeProfiles.find(
          (runtime) => runtime.id === binding.slot,
        );
        if (
          !declared ||
          (family.runtime !== "engine-matrix" &&
            family.runtime !== binding.slot) ||
          !isDeepStrictEqual(
            [observed.node, observed.platform, observed.architecture],
            [declared.node, declared.platform, declared.architecture],
          )
        ) {
          unqualified.push({ variant, origin, reason: "unselected-runtime" });
          continue;
        }
        if (binding.toolVersionMatched !== true) {
          unqualified.push({
            variant,
            origin,
            reason: "unselected-tool-version",
          });
          continue;
        }
        const image = binding.runtimeImage;
        if (
          !image ||
          (image.kind === "oci-image-observation"
            ? !/^sha256:[a-f0-9]{64}$/.test(image.id ?? "") ||
              !sha(image.definitionSha256)
            : image.kind === "hosted-runner-metadata"
              ? image.imageOS !== "ubuntu24" ||
                !/^20[0-9]{6}\.[0-9]+\.[0-9]+$/.test(
                  image.imageVersion ?? "",
                ) ||
                !sha(image.distributionSha256) ||
                image.metadataAttested !== false
              : true)
        ) {
          unqualified.push({
            variant,
            origin,
            reason: "native-image-unobserved",
          });
          continue;
        }
        for (const key of [
          "engineSha256",
          "harnessSha256",
          "requirementsSha256",
          "acceptanceSha256",
          "toolInputsSha256",
          "packageManifestSha256",
        ])
          assert.ok(
            sha(binding[key]),
            "Missing native controller identity: " + key,
          );
        assert.equal(
          binding.observationSha256,
          hash(JSON.stringify(row)),
          "Foreign witness controller binding",
        );
        for (const field of [
          "engineSha256",
          "harnessSha256",
          "requirementsSha256",
          "acceptanceSha256",
          "packageManifestSha256",
        ])
          assert.equal(
            binding[field],
            row.code?.[field],
            "Source/installed witness code binding differs: " + field,
          );
        assert.equal(row.code.installedOutsidePackage, origin === "installed");
        assert.equal(
          binding.toolExecutableSha256,
          row.tool.sha256,
          "Native tool observation differs",
        );
        assert.equal(binding.complete, true);
        assert.equal(binding.skipped, false);
        assert.equal(binding.installedOutsidePackage, origin === "installed");
        assert.equal(binding.hostAttestationPerformed, false);
      }
    return {
      family: family.id,
      profile: family.profile,
      requiredWitnesses: variants.length * 2,
      observedWitnesses: variants.length * 2 - missing.length,
      missing,
      unqualified,
      complete:
        missing.length === 0 &&
        unqualified.length === 0 &&
        !duplicates.has(family.id) &&
        !incompleteAttemptFamilies.has(family.id),
    };
  });
  // Source and installed execution must use the identical declared tool/engine/harness.
  for (const family of required)
    for (const variant of variants) {
      const pair = bindings.filter(
        (binding) =>
          binding.family === family.id && binding.variant === variant,
      );
      if (pair.length === 2)
        for (const key of [
          "slot",
          "engineSha256",
          "harnessSha256",
          "requirementsSha256",
          "acceptanceSha256",
          "toolInputsSha256",
          "packageManifestSha256",
        ])
          if (pair[0][key] !== pair[1][key])
            issues.add("source-installed-identity-mismatch");
    }
  return {
    schemaVersion: 1,
    profile: "selected-native-consumer-witnesses-v1",
    inventoryScopeSha256: manifest.inventoryScopeSha256,
    requiredFamilies: required.length,
    observedFamilies: reports.filter((row) => row.observedWitnesses > 0).length,
    complete: reports.every((row) => row.complete) && issues.size === 0,
    observations: observations.length,
    retainedBytes,
    attemptRecords: attempts.records.size,
    retainedAttemptBytes: attempts.retainedBytes,
    families: reports,
    issues: [...issues].sort(),
    nativeHostAttestationPerformed: false,
    qualityAssessed: false,
    gateAComplete: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  };
}

/** A final native controller must refuse observations that remain unqualified. */
export function requireQualifiedConsumerWitnessFamily(coverage, family) {
  assert.deepEqual(
    coverage.issues,
    [],
    "Consumer witness reconciliation issues remain",
  );
  const matches = coverage.families.filter((row) => row.family === family);
  assert.equal(
    matches.length,
    1,
    "Missing or duplicate consumer family report",
  );
  const current = matches[0];
  assert.equal(current.observedWitnesses, 6);
  assert.deepEqual(current.missing, []);
  assert.deepEqual(current.unqualified, []);
  assert.equal(
    current.complete,
    true,
    "Required source and installed consumer witnesses remain incomplete",
  );
  return current;
}

/** Bind a trusted per-tool controller's observed inputs to each reached witness. */
export function bindConsumerWitnessController(collection, expected) {
  assert.equal(collection?.profile, "native-consumer-witness-collection-v1");
  assert.equal(collection.family, expected.family);
  const attempts = inspectConsumerAttemptRecords(collection.attemptRecords);
  const usedAttempts = new Set();
  for (const row of collection.observations)
    requireConsumerWitnessAttempts(row, attempts.records, usedAttempts);
  assert.equal(
    usedAttempts.size,
    attempts.records.size,
    "Unmatched or failed consumer attempts leave collection incomplete",
  );
  assert.equal(collection.evidence.complete, true);
  assert.equal(collection.evidence.required, 9);
  assert.equal(collection.evidence.passed, 9);
  assert.deepEqual(collection.evidence.problems, []);
  assert.equal(collection.evidence.ledger.schemaVersion, 1);
  assert.equal(collection.evidence.ledger.terminalEventCount, 9);
  assert.equal(collection.evidence.ledger.events.length, 9);
  const files = collection.evidence.ledger.files;
  assert.equal(files.length, 1);
  assert.ok(
    typeof files[0].id === "string" &&
      files[0].id.length > 0 &&
      files[0].id.length <= 64,
    "Missing consumer acceptance file identity",
  );
  assert.equal(files[0].stable, true);
  assert.deepEqual(files[0].before, {
    state: "present",
    sha256: expected.acceptanceSha256,
  });
  assert.deepEqual(files[0].after, files[0].before);
  assert.equal(collection.evidence.ledger.truncated, false);
  const events = new Map();
  for (const event of collection.evidence.ledger.events) {
    assert.equal(event.fileId, files[0].id);
    assert.equal(event.outcome, "passed");
    assert.equal(event.required, true);
    assert.equal(event.nameTruncated, false);
    assert.equal(event.kind, "test");
    assert.ok(
      Number.isFinite(event.durationMs) && event.durationMs >= 0,
      "Invalid consumer terminal duration",
    );
    assert.equal(events.has(event.name), false);
    assert.ok(
      Number.isSafeInteger(event.sequence) &&
        event.sequence >= 1 &&
        event.sequence <= 9,
    );
    events.set(event.name, event);
  }
  assert.equal(
    new Set([...events.values()].map((event) => event.sequence)).size,
    9,
  );
  assert.deepEqual(
    collection.evidence.ledger.cases
      .map((item) => [item.name, item.outcome])
      .sort(),
    expected.requirements.map((item) => [item.name, "passed"]).sort(),
  );
  for (const item of collection.evidence.ledger.cases) {
    assert.equal(item.fileId, files[0].id);
    assert.ok(events.has(item.name));
    assert.deepEqual(item.terminalSequences, [events.get(item.name).sequence]);
  }
  assert.equal(collection.compiledEngine.treeSha256, expected.engineSha256);
  assert.equal(collection.compiledEngine.beforeAfterByteIdentitiesMatch, true);
  assert.deepEqual(collection.observedTool, expected.tool);
  assert.equal(expected.runtime.hostAttestationPerformed, false);
  assert.ok(sha(expected.toolInputsSha256));
  const candidate =
    expected.toolVersionMatched === true &&
    expected.runtime.node === "22.23.2" &&
    expected.runtime.platform === "linux" &&
    expected.runtime.architecture === "arm64"
      ? "native-linux-arm64-node22"
      : null;
  return collection.observations
    .filter((row) => row.phase === "canonical")
    .map((row) => {
      assert.equal(row.family, expected.family);
      for (const field of [
        "engineSha256",
        "harnessSha256",
        "requirementsSha256",
        "acceptanceSha256",
        "packageManifestSha256",
      ])
        assert.equal(
          row.code?.[field],
          expected[field],
          "Foreign source/installed consumer " + field,
        );
      assert.equal(
        row.code.installedOutsidePackage,
        row.origin === "installed",
      );
      assert.equal(row.tool.sha256, expected.tool.sha256);
      for (const field of [
        "node",
        "platform",
        "architecture",
        "nodeExecutableSha256",
        "distributionSha256",
      ])
        assert.equal(
          row.runtime[field],
          expected.runtime[field],
          "Native consumer runtime differs: " + field,
        );
      return {
        family: row.family,
        variant: row.variant,
        origin: row.origin,
        slot: candidate,
        engineSha256: expected.engineSha256,
        harnessSha256: expected.harnessSha256,
        requirementsSha256: expected.requirementsSha256,
        acceptanceSha256: expected.acceptanceSha256,
        packageManifestSha256: expected.packageManifestSha256,
        toolInputsSha256: expected.toolInputsSha256,
        toolExecutableSha256: expected.tool.sha256,
        toolVersionMatched: expected.toolVersionMatched,
        observationSha256: hash(JSON.stringify(row)),
        runtimeImage: expected.runtimeImage,
        complete: true,
        skipped: false,
        installedOutsidePackage: row.code.installedOutsidePackage,
        hostAttestationPerformed: false,
      };
    });
}
