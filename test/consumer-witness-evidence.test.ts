import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  writeFile,
  realpath,
  readdir,
  symlink,
  rename,
} from "node:fs/promises";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  beginConsumerWitness,
  recordConsumerWitnessAttempt,
  finishConsumerWitness,
} from "./consumer-witness-fixture.js";
import { runProcess } from "../src/runner.js";
import { fixture } from "./helpers.js";
const { captureConsumerWitnessController } = await import(
  new URL("../../scripts/consumer-witness-controller.mjs", import.meta.url).href
);
const {
  selectConsumerWitnessRequirements,
  inspectConsumerWitnesses,
  bindConsumerWitnessController,
  requireQualifiedConsumerWitnessFamily,
} = await import(
  new URL("../../scripts/consumer-witness-evidence.mjs", import.meta.url).href
);
const { inspectConsumerAttemptRecords } = await import(
  new URL("../../scripts/consumer-witness-attempts.mjs", import.meta.url).href
);
const manifest = JSON.parse(
  await readFile(
    new URL("../../docs/gate-a-consumer-witnesses.v1.json", import.meta.url),
    "utf8",
  ),
);
const inventory = JSON.parse(
  await readFile(
    new URL("../../docs/gate-a-profiles.v1.json", import.meta.url),
    "utf8",
  ),
);
const profiles = JSON.parse(
  await readFile(
    new URL("../../scripts/required-native-tests.json", import.meta.url),
    "utf8",
  ),
);
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const hex = (c: string) => c.repeat(64);
const paths = {
  go: ["policy/policy.go", "consumer/consumer.go"],
  python: ["pkg/policy.py", "pkg/consumer.py"],
  php: ["policy/policy.php", "consumer/consumer.php"],
  rust: ["src/policy.rs", "src/consumer.rs", "src/lib.rs"],
  ruby: ["src/policy/Policy.rb", "src/consumer/Consumer.rb"],
};
type Family = keyof typeof paths;
const retainedAttempts = new Map<
  string,
  {
    file: string;
    bytes: number;
    sha256: string;
    value: Record<string, unknown>;
  }[]
>();
const output = (bytes: Buffer) => ({
  base64: bytes.toString("base64"),
  bytes: bytes.length,
  sha256: hash(bytes),
});
/** Deliberately synthetic packet controls, never evidence of an actual Go/Python/PHP/Rust run. */
function packet(family: Family = "go", variant = "broken", origin = "source") {
  const before = paths[family].map((path) => ({
    path,
    bytes: Buffer.byteLength("Original synthetic source:" + path),
    sha256: hash("Original synthetic source:" + path),
  }));
  const consumers =
    family === "ruby"
      ? variant === "broken"
        ? [true, true, true]
        : variant === "near-miss"
          ? [false, false, false]
          : [false, true, false]
      : variant === "broken"
        ? [true, true]
        : family === "rust" && variant === "near-miss"
          ? [false, false]
          : [false, true];
  const sources = Object.fromEntries(
    before.map((file) => [
      family === "python" ? file.path.split("/").at(-1)! : file.path,
      family === "rust" || family === "ruby"
        ? [...Buffer.from("Original synthetic source:" + file.path)]
        : file.sha256,
    ]),
  );
  const cases =
    variant === "broken"
      ? [true, true, true, false]
      : [true, false, false, false];
  const body =
    family === "go"
      ? { answers: [...cases, ...consumers], sources }
      : {
          consumers,
          sources,
          cases:
            family === "python" ? cases.map((actual) => ({ actual })) : cases,
        };
  const stdout = Buffer.from(JSON.stringify(body));
  const stream = {
    profile: "bounded-physical-process-output-v1",
    stdout: output(stdout),
    stderr: output(Buffer.alloc(0)),
    observedBytes: stdout.length,
    completeForObservedStreams: true,
  };
  const row = {
    schemaVersion: 1,
    profile: "original-consumer-witness-observation-v1",
    witnessId: randomUUID(),
    attempts: [] as {
      stage: string;
      attemptId: string;
      file: string;
      bytes: number;
      sha256: string;
    }[],
    family,
    variant,
    origin,
    phase: "canonical",
    before,
    after: structuredClone(before),
    tool: { name: family, sha256: hex("1"), afterSha256: hex("1") },
    invocation: {
      commandSha256: hex("e"),
      executableSha256: hex("2"),
      argvSha256: hex("3"),
      executableAfterSha256: hex("2"),
      exitCode: 0,
      signal: null,
      errorCode: null,
      timedOut: false,
      cancelled: false,
      truncated: false,
      cleanupComplete: true,
    },
    output: stream,
    compiler:
      family === "rust"
        ? {
            commandSha256: hex("e"),
            argvSha256: hex("3"),
            executableSha256: hex("1"),
            executableAfterSha256: hex("1"),
            exitCode: 0,
            signal: null,
            errorCode: null,
            timedOut: false,
            cancelled: false,
            truncated: false,
            cleanupComplete: true,
            output: {
              ...stream,
              stdout: output(Buffer.alloc(0)),
              observedBytes: 0,
            },
          }
        : null,
    nativeResult: {
      consumers,
      sources: Object.fromEntries(
        before.map((file) => [file.path, file.sha256]),
      ),
    },
    code: {
      engineSha256: hex("5"),
      harnessSha256: hex("6"),
      requirementsSha256: hex("7"),
      acceptanceSha256: hex("8"),
      packageManifestSha256: hex("a"),
      installedOutsidePackage: origin === "installed",
    },
    runtime: {
      distributionSha256: hex("b"),
      node: "22.23.2",
      platform: "linux",
      architecture: "arm64",
      nodeExecutableSha256: hex("4"),
    },
    nativeInvoked: true,
    hostAttestationPerformed: false,
    gateAComplete: false,
  };
  const records = [];
  for (const stage of family === "rust"
    ? ["compiler", "consumer"]
    : ["consumer"]) {
    const invocation = stage === "compiler" ? row.compiler! : row.invocation;
    const value = {
      schemaVersion: 1,
      profile: "consumer-process-result-observation-v1",
      attemptId: randomUUID(),
      witnessId: row.witnessId,
      family,
      variant,
      origin,
      phase: row.phase,
      stage,
      before: row.before,
      after: row.after,
      commandSha256: invocation.commandSha256,
      argvSha256: invocation.argvSha256,
      executableSha256: invocation.executableSha256,
      executableAfterSha256: invocation.executableAfterSha256,
      identityError: null,
      output: stage === "compiler" ? row.compiler!.output : row.output,
      outputState: "complete",
      decodedDiagnostics: null,
      result: {
        exitCode: 0,
        signal: null,
        errorCode: null,
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        truncated: false,
      },
      processStartAcknowledgementRetained: false,
      nativeTerminalObserved: true,
      state: "passed",
      cleanupComplete: true,
      gateAComplete: false,
    };
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    const descriptor = {
      file: "attempt-" + value.attemptId + ".json",
      bytes: bytes.length,
      sha256: hash(bytes),
      value,
    };
    records.push(descriptor);
    row.attempts.push({
      stage,
      attemptId: value.attemptId,
      file: descriptor.file,
      bytes: descriptor.bytes,
      sha256: descriptor.sha256,
    });
  }
  retainedAttempts.set(row.witnessId, records);
  return row;
}
function binding(row: ReturnType<typeof packet>) {
  return {
    family: row.family,
    variant: row.variant,
    origin: row.origin,
    slot: "native-linux-arm64-node22",
    engineSha256: hex("5"),
    harnessSha256: hex("6"),
    requirementsSha256: hex("7"),
    acceptanceSha256: hex("8"),
    toolInputsSha256: hex("9"),
    toolExecutableSha256: row.tool.sha256,
    toolVersionMatched: true,
    runtimeImage: {
      kind: "oci-image-observation",
      id: "sha256:" + hex("c"),
      definitionSha256: hex("d"),
    },
    packageManifestSha256: hex("a"),
    observationSha256: hash(JSON.stringify(row)),
    complete: true,
    skipped: false,
    installedOutsidePackage: row.origin === "installed",
    hostAttestationPerformed: false,
  };
}
const inspect = (
  rows: ReturnType<typeof packet>[],
  bindings: ReturnType<typeof binding>[] = [],
) =>
  inspectConsumerWitnesses(manifest, inventory, profiles, rows, bindings, [
    ...new Map(
      rows.flatMap((row) =>
        (retainedAttempts.get(row.witnessId) ?? []).map(
          (item) => [item.file, item] as const,
        ),
      ),
    ).values(),
  ]);
test("consumer witness requirements retain every selected family and its frozen native runtime without promoting declarations", () => {
  const selected = selectConsumerWitnessRequirements(
    manifest,
    inventory,
    profiles,
  );
  assert.equal(selected.length, 19);
  assert.ok(
    selected.every(
      (row: { nativeAcceptance: string }) => row.nativeAcceptance === "pending",
    ),
  );
  for (const mode of [
    "missing",
    "duplicate",
    "callback",
    "runtime",
    "source",
    "acceptance",
    "promotion",
  ]) {
    const changed = structuredClone(manifest);
    if (mode === "missing") changed.families.pop();
    if (mode === "duplicate") changed.families[1] = changed.families[0];
    if (mode === "callback") changed.families[0].cases[0].name += " foreign";
    if (mode === "runtime") changed.families[0].runtime = "other";
    if (mode === "source")
      changed.families.find(
        (row: { id: string }) => row.id === "go",
      ).sourcePaths = ["other.go", "consumer.go"];
    if (mode === "acceptance") changed.families[0].nativeAcceptance = "passed";
    if (mode === "promotion") changed.gateAComplete = true;
    assert.throws(
      () => selectConsumerWitnessRequirements(changed, inventory, profiles),
      mode,
    );
  }
});
test("synthetic consumer witness reconciliation keeps all unobserved families pending and unbound native observations unqualified", () => {
  const empty = inspect([]);
  assert.equal(empty.complete, false);
  assert.equal(empty.requiredFamilies, 19);
  assert.equal(empty.observedFamilies, 0);
  const row = packet();
  const partial = inspect([row]);
  const go = partial.families.find(
    (r: { family: string }) => r.family === "go",
  );
  assert.equal(go.observedWitnesses, 1);
  assert.equal(go.missing.length, 5);
  assert.equal(go.unqualified.length, 1);
  assert.equal(go.complete, false);
  const rows: ReturnType<typeof packet>[] = [];
  for (const family of Object.keys(paths) as Family[])
    for (const variant of ["broken", "fixed", "near-miss"])
      for (const origin of ["source", "installed"])
        rows.push(packet(family, variant, origin));
  const result = inspect(rows, rows.map(binding));
  assert.equal(result.observedFamilies, Object.keys(paths).length);
  assert.equal(
    result.families.filter((r: { complete: boolean }) => r.complete).length,
    Object.keys(paths).length,
  );
  assert.equal(
    result.families.filter(
      (r: { observedWitnesses: number }) => r.observedWitnesses === 0,
    ).length,
    19 - Object.keys(paths).length,
  );
  assert.equal(result.complete, false);
  assert.equal(result.gateAComplete, false);
  assert.equal(result.qualityAssessed, false);
  assert.equal(result.nativeHostAttestationPerformed, false);
});
test("synthetic consumer witnesses reject mismatched physical streams source bytes invocation cleanup and false derived labels", () => {
  const before = packet();
  const changes: [string, (p: typeof before) => void][] = [
    ["never-native", (p) => (p.nativeInvoked = false)],
    ["changed-source", (p) => (p.after[0]!.sha256 = hex("b"))],
    [
      "foreign-source",
      (p) => {
        p.before[0]!.path = "foreign.go";
        p.after[0]!.path = "foreign.go";
      },
    ],
    [
      "coherent-source-change",
      (p) => {
        p.before[0]!.sha256 = hex("b");
        p.after[0]!.sha256 = hex("b");
        p.nativeResult.sources[p.before[0]!.path] = hex("b");
      },
    ],
    ["encoded-output", (p) => (p.output.stdout.base64 += " ")],
    ["digest-output", (p) => (p.output.stdout.sha256 = hex("b"))],
    ["unknown-output", (p) => (p.output.completeForObservedStreams = false)],
    ["bytes-output", (p) => p.output.observedBytes++],
    ["failure", (p) => (p.invocation.exitCode = 1)],
    ["timeout", (p) => (p.invocation.timedOut = true)],
    ["cancel", (p) => (p.invocation.cancelled = true)],
    ["truncated", (p) => (p.invocation.truncated = true)],
    ["cleanup", (p) => (p.invocation.cleanupComplete = false)],
    ["tool-change", (p) => (p.tool.afterSha256 = hex("b"))],
    [
      "executable-change",
      (p) => (p.invocation.executableAfterSha256 = hex("b")),
    ],
    ["derived-consumer", (p) => (p.nativeResult.consumers = [false, false])],
  ];
  for (const [name, change] of changes) {
    const changed = structuredClone(before);
    change(changed);
    assert.throws(() => inspect([changed]), name);
  }
  const rust = packet("rust");
  rust.compiler = null;
  assert.throws(() => inspect([rust]));
  assert.equal(inspect([before]).observedFamilies, 1);
});
test("synthetic native controller bindings cannot hide missing skipped duplicate foreign or mismatched source and installed evidence", () => {
  const source = packet(),
    installed = packet("go", "broken", "installed");
  const rows = [source, installed],
    bindings = rows.map(binding);
  const paired = inspect(rows, bindings);
  assert.deepEqual(paired.issues, []);
  for (const mode of [
    "foreign-observation",
    "foreign-tool",
    "skip",
    "incomplete",
    "engine-diff",
  ]) {
    const changed = structuredClone(bindings);
    if (mode === "foreign-observation")
      changed[0]!.observationSha256 = hex("c");
    if (mode === "foreign-tool") changed[0]!.toolExecutableSha256 = hex("c");
    if (mode === "skip") changed[0]!.skipped = true;
    if (mode === "incomplete") changed[0]!.complete = false;
    if (mode === "engine-diff") {
      changed[1]!.engineSha256 = hex("c");
      assert.throws(
        () => inspect(rows, changed),
        "An incoherent engine binding is rejected before comparison",
      );
      const differentRuntime = structuredClone(rows);
      differentRuntime[1]!.code.engineSha256 = hex("c");
      changed[1]!.observationSha256 = hash(JSON.stringify(differentRuntime[1]));
      assert.ok(
        inspect(differentRuntime, changed).issues.includes(
          "source-installed-identity-mismatch",
        ),
      );
    } else assert.throws(() => inspect(rows, changed), mode);
  }
  assert.ok(
    inspect([source, packet()], []).issues.includes(
      "duplicate-canonical-witness",
    ),
  );
  assert.ok(
    inspect([], bindings).issues.includes("unmatched-controller-binding"),
  );
  const duplicateObservation = inspect([...rows, packet()], bindings);
  assert.equal(
    duplicateObservation.families.find(
      (r: { family: string }) => r.family === "go",
    ).complete,
    false,
  );
  assert.ok(
    duplicateObservation.issues.includes("duplicate-canonical-witness"),
  );
  const duplicate = inspect(rows, [...bindings, bindings[0]!]);
  assert.ok(
    duplicate.families.find((r: { family: string }) => r.family === "go")
      .unqualified.length > 0,
  );
  const unselected = structuredClone(source);
  unselected.runtime.node = "26.12.0";
  assert.equal(
    inspect([unselected], [binding(unselected)]).families.find(
      (r: { family: string }) => r.family === "go",
    ).unqualified[0].reason,
    "unselected-runtime",
  );
});
test("synthetic Ruby consumer witnesses bind native source bytes and every alias result across source and installed variants", () => {
  const rows = ["broken", "fixed", "near-miss"].flatMap((variant) =>
    ["source", "installed"].map((origin) => packet("ruby", variant, origin)),
  );
  const result = inspect(rows, rows.map(binding));
  assert.equal(
    requireQualifiedConsumerWitnessFamily(result, "ruby").complete,
    true,
  );
  assert.equal(result.complete, false);
  assert.deepEqual(rows[0]!.nativeResult.consumers, [true, true, true]);
  assert.deepEqual(rows[2]!.nativeResult.consumers, [false, true, false]);
  assert.deepEqual(rows[4]!.nativeResult.consumers, [false, false, false]);
  for (const mode of ["alias", "source-bytes", "source-length"]) {
    const row = packet("ruby", "near-miss");
    const body = JSON.parse(
      Buffer.from(row.output.stdout.base64, "base64").toString(),
    );
    if (mode === "alias") {
      body.consumers[2] = true;
      row.nativeResult.consumers[2] = true;
    }
    if (mode === "source-bytes") body.sources[paths.ruby[0]!][0] ^= 1;
    if (mode === "source-length") body.sources[paths.ruby[0]!].push(32);
    const stdout = Buffer.from(JSON.stringify(body));
    row.output.stdout = output(stdout);
    row.output.observedBytes = stdout.length;
    const attempts = retainedAttempts.get(row.witnessId)!;
    for (const [index, attempt] of attempts.entries()) {
      attempt.value.output = row.output;
      const bytes = Buffer.from(JSON.stringify(attempt.value) + "\n");
      attempt.bytes = bytes.length;
      attempt.sha256 = hash(bytes);
      row.attempts[index]!.bytes = attempt.bytes;
      row.attempts[index]!.sha256 = attempt.sha256;
    }
    assert.throws(
      () => inspect([row]),
      mode === "alias"
        ? /Native consumer result differs/
        : /Physical native source/,
    );
  }
});
test("final native consumer controllers refuse unqualified families even when all six observations exist", () => {
  const rows = ["broken", "fixed", "near-miss"].flatMap((variant) =>
    ["source", "installed"].map((origin) => packet("go", variant, origin)),
  );
  const qualified = inspect(rows, rows.map(binding));
  assert.equal(
    qualified.complete,
    false,
    "Other required families remain pending",
  );
  assert.equal(
    requireQualifiedConsumerWitnessFamily(qualified, "go").complete,
    true,
  );
  const unbound = inspect(rows);
  assert.equal(
    unbound.families.find((row: { family: string }) => row.family === "go")
      .observedWitnesses,
    6,
  );
  assert.throws(() => requireQualifiedConsumerWitnessFamily(unbound, "go"));
  for (const mode of [
    "incomplete",
    "missing",
    "unqualified",
    "reconciliation",
    "absent",
    "duplicate",
  ]) {
    const changed = structuredClone(qualified);
    const current = changed.families.find(
      (row: { family: string }) => row.family === "go",
    );
    if (mode === "incomplete") current.complete = false;
    if (mode === "missing")
      current.missing.push({ variant: "fixed", origin: "installed" });
    if (mode === "unqualified")
      current.unqualified.push({
        variant: "fixed",
        origin: "installed",
        reason: "unselected-runtime",
      });
    if (mode === "reconciliation")
      changed.issues.push("source-installed-identity-mismatch");
    if (mode === "absent")
      changed.families = changed.families.filter(
        (row: { family: string }) => row.family !== "go",
      );
    if (mode === "duplicate") changed.families.push(current);
    assert.throws(
      () => requireQualifiedConsumerWitnessFamily(changed, "go"),
      mode,
    );
  }
});
test("optional consumer witness capture stays inert without an operator namespace", async () => {
  const previous = process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR;
  try {
    delete process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR;
    assert.equal(
      await beginConsumerWitness(
        "/original-unread-nonexistent-source",
        "go",
        "broken",
      ),
      null,
    );
  } finally {
    if (previous === undefined)
      delete process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR;
    else process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR = previous;
  }
});

test("consumer witness controller refuses missing unknown or extra family arguments before capture or execution", () => {
  const script = fileURLToPath(
    new URL(
      "../../scripts/verify-consumer-witness-profile.mjs",
      import.meta.url,
    ),
  );
  for (const args of [[], ["foreign"], ["go"], ["context-go", "extra"]]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 65536,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /AssertionError/);
  }
});

test("synthetic consumer controller binding requires actual source installed code tools runtime and terminal identities", () => {
  const row = packet();
  const wanted = profiles["context-go"];
  const events = wanted.map((item: { name: string }, index: number) => ({
    sequence: index + 1,
    fileId: "file-1",
    name: item.name,
    outcome: "passed",
    required: true,
    nameTruncated: false,
    kind: "test",
    durationMs: 1,
  }));
  const evidence = {
    complete: true,
    required: 9,
    passed: 9,
    problems: [],
    ledger: {
      schemaVersion: 1,
      files: [
        {
          id: "file-1",
          stable: true,
          before: { state: "present", sha256: hex("8") },
          after: { state: "present", sha256: hex("8") },
        },
      ],
      truncated: false,
      terminalEventCount: 9,
      events,
      cases: events.map((event: { name: string; sequence: number }) => ({
        fileId: "file-1",
        name: event.name,
        outcome: "passed",
        terminalSequences: [event.sequence],
      })),
    },
  };
  const collection = {
    profile: "native-consumer-witness-collection-v1",
    family: "go",
    evidence,
    observations: [row],
    attemptRecords: retainedAttempts.get(row.witnessId),
    compiledEngine: {
      treeSha256: hex("5"),
      beforeAfterByteIdentitiesMatch: true,
    },
    observedTool: { sha256: hex("1"), bytes: 1 },
  };
  const expected = {
    family: "go",
    requirements: wanted,
    ...row.code,
    toolVersionMatched: true,
    tool: collection.observedTool,
    toolInputsSha256: hex("9"),
    runtime: { ...row.runtime, hostAttestationPerformed: false },
    runtimeImage: {
      kind: "oci-image-observation",
      id: "sha256:" + hex("c"),
      definitionSha256: hex("d"),
    },
  };
  const received = bindConsumerWitnessController(collection, expected);
  assert.equal(received.length, 1);
  assert.equal(received[0].slot, "native-linux-arm64-node22");
  for (const field of [
    "engineSha256",
    "harnessSha256",
    "requirementsSha256",
    "acceptanceSha256",
    "packageManifestSha256",
  ] as const) {
    const changed = structuredClone(collection);
    changed.observations[0]!.code[field] = hex("f");
    assert.throws(
      () => bindConsumerWitnessController(changed, expected),
      field,
    );
  }
  for (const mode of [
    "foreign-event",
    "changed-file",
    "changed-tool",
    "fake-installed",
    "foreign-runtime",
    "file-id",
    "duration",
  ]) {
    const changed = structuredClone(collection);
    if (mode === "foreign-event")
      changed.evidence.ledger.events[0]!.fileId = "other";
    if (mode === "changed-file")
      changed.evidence.ledger.files[0]!.before.sha256 = hex("f");
    if (mode === "changed-tool") changed.observedTool.sha256 = hex("f");
    if (mode === "fake-installed")
      changed.observations[0]!.origin = "installed";
    if (mode === "foreign-runtime")
      changed.observations[0]!.runtime.node = "26.12.0";
    if (mode === "file-id") changed.evidence.ledger.files[0]!.id = "";
    if (mode === "duration") changed.evidence.ledger.events[0]!.durationMs = -1;
    assert.throws(() => bindConsumerWitnessController(changed, expected), mode);
  }
  assert.equal(
    bindConsumerWitnessController(collection, {
      ...expected,
      toolVersionMatched: false,
    })[0].slot,
    null,
  );
});

test("consumer controller code identity binds selected requirements equally from source and a reduced installed manifest", async (t) => {
  const packageText = JSON.stringify({
    name: "original-synthetic-controller",
    version: "1.0.0",
  });
  const common = {
    "package.json": packageText,
    "dist/src/original.js": "export const original = 1;\n",
    "dist/test/consumer-witness-fixture.js":
      "Original synthetic helper bytes\n",
    "scripts/compiled-engine-evidence.mjs":
      "Original synthetic engine observer bytes\n",
    "scripts/consumer-witness-attempts.mjs":
      "Original synthetic attempt observer bytes\n",
    "dist/test/gate-context-go.test.js":
      "Original synthetic acceptance bytes\n",
    "docs/gate-a-profiles.v1.json": JSON.stringify(inventory),
    ".github/workflows/ci.yml":
      "jobs:\n  go-workspaces-arm64:\n    steps:\n      - uses: actions/setup-python@original-synthetic-pin\n        with:\n          python-version: '3.13.5'\n",
  };
  const source = await fixture(t, {
    ...common,
    "scripts/required-native-tests.json": JSON.stringify(profiles),
  });
  const installed = await fixture(t, {
    ...common,
    "scripts/required-native-tests.json": JSON.stringify({
      "context-go": profiles["context-go"],
    }),
  });
  const image = {
    kind: "hosted-runner-metadata",
    imageOS: "ubuntu24",
    imageVersion: "20261021.113.1",
  };
  const runtime = {
    distributionSha256: hex("b"),
    toolVersion: "go version go" + inventory.toolVersions.go + " linux/arm64",
  };
  const tool = { bytes: 1, sha256: hex("1") };
  const first = await captureConsumerWitnessController(
    source,
    "go",
    image,
    runtime,
    tool,
  );
  const second = await captureConsumerWitnessController(
    installed,
    "go",
    image,
    runtime,
    tool,
  );
  for (const key of [
    "engineSha256",
    "harnessSha256",
    "requirementsSha256",
    "acceptanceSha256",
    "packageManifestSha256",
  ]) {
    assert.equal(first[key], second[key], key);
  }
  const changed = structuredClone(profiles["context-go"]);
  changed[0].name += " altered";
  await writeFile(
    path.join(installed, "scripts/required-native-tests.json"),
    JSON.stringify({ "context-go": changed }),
  );
  const changedRequirements = await captureConsumerWitnessController(
    installed,
    "go",
    image,
    runtime,
    tool,
  );
  assert.notEqual(
    changedRequirements.requirementsSha256,
    first.requirementsSha256,
  );
  assert.equal(changedRequirements.harnessSha256, first.harnessSha256);
  await writeFile(
    path.join(installed, "dist/test/consumer-witness-fixture.js"),
    "Altered synthetic helper bytes\n",
  );
  const changedHelper = await captureConsumerWitnessController(
    installed,
    "go",
    image,
    runtime,
    tool,
  );
  assert.notEqual(changedHelper.harnessSha256, first.harnessSha256);
});

test("consumer controller captures a container family without depending on unrelated hosted Python setup", async (t) => {
  const root = await fixture(t, {
    "package.json": JSON.stringify({
      name: "original-synthetic-controller",
      version: "1.0.0",
    }),
    "dist/src/original.js": "export const original = 1;\n",
    "dist/test/consumer-witness-fixture.js":
      "Original synthetic helper bytes\n",
    "dist/test/gate-context-php.test.js":
      "Original synthetic acceptance bytes\n",
    "dist/test/gate-context-ruby.test.js":
      "Original synthetic Ruby acceptance bytes\n",
    "scripts/compiled-engine-evidence.mjs":
      "Original synthetic engine observer bytes\n",
    "scripts/consumer-witness-attempts.mjs":
      "Original synthetic attempt observer bytes\n",
    "scripts/required-native-tests.json": JSON.stringify({
      "context-php": profiles["context-php"],
      "context-ruby": profiles["context-ruby"],
    }),
    "scripts/php-context-tools.Dockerfile":
      "Original synthetic pinned Dockerfile bytes\n",
    "scripts/ruby-context-tools.Dockerfile":
      "Original synthetic pinned Dockerfile bytes\n",
    "docs/gate-a-profiles.v1.json": JSON.stringify(inventory),
  });
  const runtimeImage = {
    kind: "oci-image-observation",
    id: "sha256:" + hex("c"),
  };
  const tool = { bytes: 1, sha256: hex("1") };
  for (const family of ["php", "ruby"]) {
    const runtime = {
      toolVersion:
        family === "php"
          ? inventory.toolVersions.php
          : "ruby " +
            inventory.toolVersions.ruby +
            " (original synthetic version)",
    };
    const received = await captureConsumerWitnessController(
      root,
      family,
      runtimeImage,
      runtime,
      tool,
    );
    assert.equal(received.toolVersionMatched, true);
    assert.equal(received.runtimeImage.id, runtimeImage.id);
    assert.equal(received.runtimeImage.kind, "oci-image-observation");
    assert.equal(
      received.runtimeImage.definitionSha256,
      hash("Original synthetic pinned Dockerfile bytes\n"),
    );
    const wrongTool = await captureConsumerWitnessController(
      root,
      family,
      runtimeImage,
      {
        toolVersion:
          family === "php"
            ? inventory.toolVersions.php + ".adjacent"
            : "ruby " +
              inventory.toolVersions.ruby +
              ".adjacent (original synthetic version)",
      },
      tool,
    );
    assert.equal(wrongTool.toolVersionMatched, false);
  }
});

test("consumer witness attempt bindings reject missing altered duplicate reused and failed retained records", () => {
  const row = packet();
  const records = retainedAttempts.get(row.witnessId)!;
  const verify = (attempts: typeof records) =>
    inspectConsumerWitnesses(
      manifest,
      inventory,
      profiles,
      [row],
      [],
      attempts,
    );
  assert.equal(verify(records).observations, 1);
  assert.throws(() => verify([]), /Missing private consumer attempt/);
  const altered = structuredClone(records);
  altered[0]!.sha256 = hex("f");
  assert.throws(() => verify(altered), /digest differs/);
  assert.throws(
    () => verify([...records, ...records]),
    /Duplicate consumer attempt/,
  );
  assert.throws(
    () =>
      inspectConsumerWitnesses(
        manifest,
        inventory,
        profiles,
        [row, row],
        [],
        records,
      ),
    /reused by multiple witnesses/,
  );
  const failed = structuredClone(records);
  const result = failed[0]!.value.result as { exitCode: number };
  result.exitCode = 7;
  failed[0]!.value.state = "failed";
  const bytes = Buffer.from(JSON.stringify(failed[0]!.value) + "\n");
  failed[0]!.bytes = bytes.length;
  failed[0]!.sha256 = hash(bytes);
  const changed = structuredClone(row);
  changed.attempts[0]!.bytes = bytes.length;
  changed.attempts[0]!.sha256 = hash(bytes);
  assert.throws(
    () =>
      inspectConsumerWitnesses(
        manifest,
        inventory,
        profiles,
        [changed],
        [],
        failed,
      ),
    /Failed or unavailable native attempt/,
  );
  const incomplete = inspectConsumerWitnesses(
    manifest,
    inventory,
    profiles,
    [],
    [],
    failed,
  );
  assert.deepEqual(incomplete.issues, [
    "failed-or-unavailable-consumer-attempt",
  ]);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.attemptRecords, 1);
});

test(
  "controlled failed native Node results remain physically retained before assertions and storage failures stay incomplete",
  {
    skip:
      process.platform === "win32"
        ? "POSIX selected consumer capture storage is unavailable on Windows"
        : false,
  },
  async (t) => {
    const root = await fixture(t, {
      "policy/policy.go": "Original synthetic source\n",
      "consumer/consumer.go": "Original synthetic caller\n",
    });
    const destination = await realpath(await fixture(t, {}));
    const binaries = await fixture(t, {});
    // This is an actual Node process exposed under a synthetic fixture tool name.
    // It is deliberately not a native Go witness or evidence of family qualification.
    await symlink(process.execPath, path.join(binaries, "go"));
    const previousPath = process.env.PATH;
    const previousDestination = process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR;
    let capture: Awaited<ReturnType<typeof beginConsumerWitness>>;
    try {
      process.env.PATH = binaries + path.delimiter + (previousPath ?? "");
      process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR = destination;
      capture = await beginConsumerWitness(root, "go", "broken");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousDestination === undefined)
        delete process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR;
      else process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR = previousDestination;
    }
    assert.ok(capture);
    const result = await runProcess(
      root,
      {
        executable: process.execPath,
        args: [
          "-e",
          "process.stdout.write('original-failed-node');process.stderr.write('original-node-diagnostic');process.exitCode=7",
        ],
        cwd: ".",
      },
      { timeoutMs: 10000, maxOutputBytes: 65536, captureRawOutput: true },
    );
    await recordConsumerWitnessAttempt(capture, result);
    assert.equal(result.exitCode, 7);
    const files = await readdir(destination);
    assert.equal(files.length, 1);
    const bytes = await readFile(path.join(destination, files[0]!));
    const records = [
      {
        file: files[0],
        bytes: bytes.length,
        sha256: hash(bytes),
        value: JSON.parse(bytes.toString("utf8")),
      },
    ];
    const observed = inspectConsumerAttemptRecords(records)
      .records.values()
      .next().value!.value;
    assert.equal(observed.state, "failed");
    assert.equal(observed.processStartAcknowledgementRetained, false);
    assert.equal(observed.nativeTerminalObserved, true);
    assert.equal(observed.cleanupComplete, true);
    assert.equal(
      Buffer.from(observed.output.stdout.base64, "base64").toString(),
      "original-failed-node",
    );
    assert.equal(
      Buffer.from(observed.output.stderr.base64, "base64").toString(),
      "original-node-diagnostic",
    );
    assert.equal(
      (await recordConsumerWitnessAttempt(capture, result))!.reference.file,
      files[0],
    );
    assert.equal((await readdir(destination)).length, 1);
    await assert.rejects(() => finishConsumerWitness(capture, result));
    assert.equal(
      (await readdir(destination)).length,
      1,
      "Failure assertion retains its raw attempt",
    );
    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await runProcess(root, result.command, {
      timeoutMs: 10000,
      maxOutputBytes: 65536,
      captureRawOutput: true,
      signal: aborted.signal,
    });
    const retainedCancelled = await recordConsumerWitnessAttempt(
      capture,
      cancelled,
    );
    assert.ok(retainedCancelled);
    const cancelledValue = retainedCancelled.value as {
      state: string;
      nativeTerminalObserved: boolean;
      output: unknown;
    };
    assert.equal(cancelledValue.state, "not-started");
    assert.equal(cancelledValue.nativeTerminalObserved, false);
    assert.equal(cancelledValue.output, null);
    await rename(destination, destination + "-moved");
    try {
      const additional = { ...result };
      await assert.rejects(() =>
        recordConsumerWitnessAttempt(capture, additional),
      );
      assert.ok(capture.storageFailure);
    } finally {
      await rename(destination + "-moved", destination);
    }
    await assert.rejects(
      () => recordConsumerWitnessAttempt(capture, { ...result }),
      /Earlier consumer capture storage failure/,
    );
    assert.equal((await readdir(destination)).length, 2);
  },
);
