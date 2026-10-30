import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
const {
  inspectSwiftInputs,
  inspectSwiftWitness,
  inspectSwiftAttempt,
  requireSwiftAttemptBinding,
  swiftCommandBindings,
} = await import(
  new URL("../../scripts/consumer-witness-swift.mjs", import.meta.url).href
);
const { inspectConsumerAttemptRecords, requireConsumerWitnessAttempts } =
  await import(
    new URL("../../scripts/consumer-witness-attempts.mjs", import.meta.url).href
  );
const { inspectConsumerWitnesses } = await import(
  new URL("../../scripts/consumer-witness-evidence.mjs", import.meta.url).href
);
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const sha = (value: string) => value.repeat(64);
const stream = (text: string) => ({
  base64: Buffer.from(text).toString("base64"),
  bytes: Buffer.byteLength(text),
  sha256: hash(text),
});
const output = (text: string) => ({
  profile: "bounded-physical-process-output-v1",
  stdout: stream(text),
  stderr: stream(""),
  observedBytes: Buffer.byteLength(text),
  completeForObservedStreams: true,
});
const directory = (names: string[]) => {
  const files = names.sort().map((path) => ({
    path,
    bytes: 32,
    sha256: path === "Witness" ? sha("9") : sha("a"),
  }));
  return {
    profile: "bounded-consumer-directory-v1",
    directorySha256: hash("/synthetic/out"),
    files,
    bytes: files.length * 32,
    manifestSha256: hash(JSON.stringify(files)),
  };
};
/** Deliberately synthetic controls; no Swift compiler or executable is run by this factory. */
function sample(variant = "broken", origin = "source") {
  const inputs = {
    profile: "consumer-swift-inputs-v1",
    scope: "observed-driver-and-frontend",
    otherDependenciesAttested: false,
    driver: { bytes: 32, sha256: sha("2") },
    frontend: { bytes: 64, sha256: sha("3") },
  };
  const seed = directory([]),
    produced = directory([
      "libPolicy.so",
      "Policy.swiftmodule",
      "Policy.swiftdoc",
    ]),
    generated = directory([
      ...produced.files.map((file) => file.path),
      "Witness",
    ]),
    main = { bytes: 64, sha256: sha("4") };
  const swift = {
    inputs,
    inputsAfterSha256: hash(JSON.stringify(inputs)),
    seed,
    produced,
    generated,
    main,
  };
  const paths = ["src/policy/Policy.swift", "src/consumer/Consumer.swift"],
    source = Object.fromEntries(
      paths.map((path) => [path, [...Buffer.from("synthetic:" + path)]]),
    ),
    before = paths.map((path) => ({
      path,
      bytes: source[path]!.length,
      sha256: hash(Buffer.from(source[path]!)),
    }));
  const consumers =
      variant === "broken"
        ? [true, true, true]
        : variant === "fixed"
          ? [false, true, false]
          : [false, false, false],
    cases =
      variant === "broken"
        ? [true, true, true, false]
        : [true, false, false, false];
  const terminal = {
    exitCode: 0,
    errorCode: null,
    signal: null,
    timedOut: false,
    cancelled: false,
    truncated: false,
    cleanupComplete: true,
  };
  const invocation = {
    ...terminal,
    commandSha256: sha("f"),
    argvSha256: sha("e"),
    executableSha256: sha("9"),
    executableAfterSha256: sha("9"),
  };
  const compiler = {
    ...invocation,
    executableSha256: inputs.driver.sha256,
    executableAfterSha256: inputs.driver.sha256,
    output: output(""),
  };
  const row = {
    schemaVersion: 1,
    profile: "original-consumer-witness-observation-v1",
    family: "swift",
    variant,
    origin,
    phase: "canonical",
    witnessId: randomUUID(),
    attempts: [] as {
      stage: string;
      attemptId: string;
      file: string;
      bytes: number;
      sha256: string;
    }[],
    before,
    after: structuredClone(before),
    tool: {
      name: "swiftc",
      ...inputs.driver,
      afterSha256: inputs.driver.sha256,
    },
    invocation,
    compiler,
    compilerLink: structuredClone(compiler),
    swift,
    jvm: null,
    managed: null,
    output: output(JSON.stringify({ cases, consumers, sources: source })),
    nativeResult: {
      consumers,
      sources: Object.fromEntries(
        before.map((file) => [file.path, file.sha256]),
      ),
    },
    code: {
      engineSha256: sha("5"),
      harnessSha256: sha("6"),
      requirementsSha256: sha("7"),
      acceptanceSha256: sha("8"),
      packageManifestSha256: sha("a"),
      installedOutsidePackage: origin === "installed",
    },
    runtime: {
      node: "22.23.2",
      platform: "linux",
      architecture: "arm64",
      nodeExecutableSha256: sha("b"),
    },
    nativeInvoked: true,
    hostAttestationPerformed: false,
    gateAComplete: false,
  };
  const args = {
    compiler: [
      "-emit-module-path",
      "/synthetic/out/Policy.swiftmodule",
      "-o",
      "/synthetic/out/libPolicy.so",
      "src/policy/Policy.swift",
    ],
    "compiler-link": [
      "-I",
      "/synthetic/out",
      "-L",
      "/synthetic/out",
      "-lPolicy",
      "-o",
      "/synthetic/out/Witness",
      "src/consumer/Consumer.swift",
      "main.swift",
    ],
    consumer: [],
  };
  const records = (["compiler", "compiler-link", "consumer"] as const).map(
    (stage) => {
      const ran =
        stage === "compiler"
          ? row.compiler
          : stage === "compiler-link"
            ? row.compilerLink
            : row.invocation;
      const value = {
        schemaVersion: 1,
        profile: "consumer-process-result-observation-v1",
        attemptId: randomUUID(),
        witnessId: row.witnessId,
        family: row.family,
        variant,
        origin,
        phase: row.phase,
        stage,
        before,
        after: row.after,
        commandSha256: ran.commandSha256,
        argvSha256: ran.argvSha256,
        executableSha256: ran.executableSha256,
        executableAfterSha256: ran.executableAfterSha256,
        identityError: null,
        jvm: null,
        managed: null,
        swift: {
          inputsBefore: inputs,
          inputsAfterSha256: swift.inputsAfterSha256,
          generatedBefore: structuredClone(
            stage === "compiler"
              ? seed
              : stage === "compiler-link"
                ? produced
                : generated,
          ),
          generatedAfter: structuredClone(
            stage === "compiler" ? produced : generated,
          ),
          main: stage === "compiler" ? null : main,
          command: swiftCommandBindings(
            args[stage],
            "/synthetic",
            stage === "consumer" ? { LD_LIBRARY_PATH: "/synthetic/out" } : {},
          ),
        },
        output: stage === "consumer" ? row.output : row.compiler.output,
        outputState: "complete",
        decodedDiagnostics: null,
        result: {
          exitCode: 0,
          errorCode: null,
          signal: null,
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
      const bytes = Buffer.from(JSON.stringify(value) + "\n"),
        record = {
          file: "attempt-" + value.attemptId + ".json",
          bytes: bytes.length,
          sha256: hash(bytes),
          value,
        };
      row.attempts.push({
        stage,
        attemptId: value.attemptId,
        file: record.file,
        bytes: record.bytes,
        sha256: record.sha256,
      });
      return record;
    },
  );
  return { row, records };
}
test("synthetic Swift producer linker and consumer attempts bind every produced file and preserve three consumer results", () => {
  for (const variant of ["broken", "fixed", "near-miss"]) {
    const { row, records } = sample(variant);
    inspectSwiftWitness(row);
    for (const record of records) {
      inspectSwiftAttempt(record.value);
      requireSwiftAttemptBinding(row, record.value);
    }
    const used = new Set();
    requireConsumerWitnessAttempts(
      row,
      inspectConsumerAttemptRecords(records).records,
      used,
    );
    assert.equal(used.size, 3);
  }
});
test("synthetic Swift witnesses reject missing link attempts changed producer libraries runtime outputs generated main and unobserved dependency claims", () => {
  const { row, records } = sample();
  const missing = structuredClone(row);
  missing.attempts.splice(1, 1);
  assert.throws(
    () =>
      requireConsumerWitnessAttempts(
        missing,
        inspectConsumerAttemptRecords(records).records,
        new Set(),
      ),
    /stage inventory/,
  );
  const noLink = structuredClone(row);
  Reflect.deleteProperty(noLink, "compilerLink");
  assert.throws(() => inspectSwiftWitness(noLink), /link compiler/);
  const library = structuredClone(row);
  library.swift.generated.files.find(
    (file) => file.path === "libPolicy.so",
  )!.sha256 = sha("c");
  library.swift.generated.manifestSha256 = hash(
    JSON.stringify(library.swift.generated.files),
  );
  assert.throws(() => inspectSwiftWitness(library), /changed during link/);
  const runtime = structuredClone(records[2]!.value);
  runtime.swift.generatedAfter.files.find(
    (file) => file.path === "Witness",
  )!.sha256 = sha("c");
  runtime.swift.generatedAfter.manifestSha256 = hash(
    JSON.stringify(runtime.swift.generatedAfter.files),
  );
  assert.throws(
    () => requireSwiftAttemptBinding(row, runtime),
    /changed during consumer/,
  );
  const main = structuredClone(records[1]!.value);
  assert.ok(main.swift.main);
  main.swift.main.sha256 = sha("c");
  assert.throws(() => requireSwiftAttemptBinding(row, main));
  const changed = structuredClone(records[1]!.value);
  changed.swift.inputsAfterSha256 = sha("c");
  assert.throws(
    () => requireSwiftAttemptBinding(row, changed),
    /inputs changed/,
  );
  const claims = structuredClone(row.swift.inputs);
  claims.otherDependenciesAttested = true;
  assert.throws(() => inspectSwiftInputs(claims));
});
test("Swift command bindings require the actual policy module library source order and runtime search directory", () => {
  const { row, records } = sample();
  for (const mutate of [
    (value: (typeof records)[number]["value"]) => {
      value.swift.command.imports = sha("f");
    },
    (value: (typeof records)[number]["value"]) => {
      value.swift.command.libraries = sha("f");
    },
    (value: (typeof records)[number]["value"]) => {
      value.swift.command.policyLibrary = false;
    },
    (value: (typeof records)[number]["value"]) => {
      value.swift.command.sources.reverse();
    },
  ]) {
    const value = structuredClone(records[1]!.value);
    mutate(value);
    assert.throws(() => requireSwiftAttemptBinding(row, value));
  }
  const search = structuredClone(records[2]!.value);
  search.swift.command.runtimeLibraryPath = sha("f");
  assert.throws(() => requireSwiftAttemptBinding(row, search));
  const adjacent = swiftCommandBindings(
    ["-Ignored", "out", "-Library", "out", "-lPolicyExtra"],
    "/synthetic",
    {},
  );
  assert.equal(adjacent.imports, null);
  assert.equal(adjacent.libraries, null);
  assert.equal(adjacent.policyLibrary, false);
});
test("synthetic Swift source and fresh packets retain the complete three-stage inventory without promoting pending runtime qualification", async () => {
  const read = async (name: string) =>
    JSON.parse(
      await readFile(new URL("../../" + name, import.meta.url), "utf8"),
    );
  const manifest = await read("docs/gate-a-consumer-witnesses.v1.json"),
    inventory = await read("docs/gate-a-profiles.v1.json"),
    profiles = await read("scripts/required-native-tests.json");
  const swift = manifest.families.find(
    (row: { id: string }) => row.id === "swift",
  );
  swift.collectorImplementation = "prepared";
  swift.sourcePaths = [
    "src/policy/Policy.swift",
    "src/consumer/Consumer.swift",
  ];
  const samples = ["source", "installed"].flatMap((origin) =>
    ["broken", "fixed", "near-miss"].map((variant) => sample(variant, origin)),
  );
  const report = inspectConsumerWitnesses(
    manifest,
    inventory,
    profiles,
    samples.map((item) => item.row),
    [],
    samples.flatMap((item) => item.records),
  );
  assert.equal(report.complete, false);
  assert.equal(report.requiredFamilies, 19);
  assert.equal(report.attemptRecords, 18);
  assert.deepEqual(report.issues, []);
  const family = report.families.find(
    (row: { family: string }) => row.family === "swift",
  );
  assert.equal(family.observedWitnesses, 6);
  assert.equal(family.unqualified.length, 6);
  assert.equal(family.complete, false);
});
