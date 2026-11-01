import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { observeConsumerWitnessDataInputs } from "./consumer-witness-fixture.js";
const {
  dataConsumerRoles,
  dataConsumerStages,
  dataConsumerArgs,
  dataConsumerClass,
  normalizeDataInputs,
  inspectDataInputs,
  inspectDataWitness,
  inspectDataAttempt,
  requireDataAttemptBinding,
} = await import(
  new URL("../../scripts/consumer-witness-data.mjs", import.meta.url).href
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
const physical = (text: string) => ({
  bytes: Buffer.byteLength(text),
  sha256: hash(text),
  base64: Buffer.from(text).toString("base64"),
});
const output = (text: string) => ({
  profile: "bounded-physical-process-output-v1",
  stdout: physical(text),
  stderr: physical(""),
  observedBytes: Buffer.byteLength(text),
  completeForObservedStreams: true,
});
const directory = () => {
  const files = ["dist/index.js", "dist/parse.js", "package.json"].map(
    (path) => ({ path, bytes: 32, sha256: sha("a") }),
  );
  return {
    profile: "bounded-consumer-directory-v1",
    directorySha256: sha("d"),
    files,
    bytes: 96,
    manifestSha256: hash(JSON.stringify(files)),
  };
};
/** Synthetic metadata controls only; this factory does not invoke Terraform or certify a runtime. */
function sample(family: "hcl" | "yaml", variant = "broken", origin = "source") {
  const paths =
    family === "hcl"
      ? ["policy/rules.tf", "main.tf"]
      : ["policy.yaml", "extra.yaml"];
  const sources = Object.fromEntries(
    paths.map((path) => [path, [...Buffer.from("synthetic:" + path)]]),
  );
  const before = paths.map((path) => ({
    path,
    bytes: sources[path]!.length,
    sha256: hash(Buffer.from(sources[path]!)),
  }));
  const inputs = {
    profile: "consumer-data-inputs-v1",
    family,
    tool: { bytes: 32, sha256: sha("2") },
    package: {
      name: "yaml",
      version: "2.9.1",
      entry: "dist/index.js",
      importUrlSha256: sha("e"),
      inventory: directory(),
    },
  };
  const results =
    variant === "broken"
      ? [true, true, true, false, true, true, false]
      : variant === "fixed"
        ? [true, false, false, false, true, true, false]
        : [true, false, false, false, false, true, false];
  const plans = dataConsumerRoles.map((role: string) => ({
    bytes: 32,
    sha256: hash("synthetic-plan:" + role),
  }));
  const text = JSON.stringify({
    Modules: [
      { Key: "", Source: "", Dir: "." },
      { Key: "policy", Source: "./policy", Dir: "policy" },
    ],
  });
  const moduleMap = {
    text,
    bytes: Buffer.byteLength(text),
    sha256: hash(text),
  };
  const show = (index: number) =>
    JSON.stringify({
      terraform_version: "1.16.5",
      variables: { role: { value: dataConsumerRoles[index] } },
      planned_values: { outputs: { result: { value: results[index] } } },
    });
  const native = JSON.stringify({
    roles: results,
    aliases: { resultIsRules: true, mirrorIsRules: true },
    sources,
    moduleUrlSha256: inputs.package.importUrlSha256,
  });
  const row = {
    schemaVersion: 1,
    profile: "native-data-consumer-witness-observation-v1",
    family,
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
      ...inputs.tool,
      name: family === "hcl" ? "terraform" : "node",
      afterSha256: inputs.tool.sha256,
    },
    invocation: {
      commandSha256: sha("f"),
      argvSha256:
        family === "hcl"
          ? hash(JSON.stringify(dataConsumerArgs("hcl-show-6")))
          : sha("3"),
      executableSha256: inputs.tool.sha256,
      executableAfterSha256: inputs.tool.sha256,
      exitCode: 0,
      errorCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      truncated: false,
      cleanupComplete: true,
    },
    compiler: null,
    jvm: null,
    managed: null,
    output: output(family === "hcl" ? show(6) : native),
    data: {
      inputs,
      inputsAfterSha256: hash(JSON.stringify(inputs)),
      evidenceClass: dataConsumerClass(family),
      roles: dataConsumerRoles,
      results,
      plans: family === "hcl" ? plans : [],
      moduleMap: family === "hcl" ? moduleMap : null,
      sourceBinding:
        family === "hcl"
          ? "controller-filesystem-and-native-plan"
          : "native-data-source-byte-echo",
      fullImpactFallback: true,
      applicationSemanticsVerified: false,
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
      nodeExecutableSha256: inputs.tool.sha256,
    },
    nativeInvoked: true,
    hostAttestationPerformed: false,
    gateAComplete: false,
  };
  const records = dataConsumerStages(family).map((stage: string) => {
    const index = Number(stage.at(-1)),
      init = stage === "hcl-init",
      plan = stage.startsWith("hcl-plan-");
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
      before,
      after: row.after,
      commandSha256: row.invocation.commandSha256,
      argvSha256:
        family === "hcl"
          ? hash(JSON.stringify(dataConsumerArgs(stage)))
          : row.invocation.argvSha256,
      executableSha256: inputs.tool.sha256,
      executableAfterSha256: inputs.tool.sha256,
      identityError: null,
      jvm: null,
      managed: null,
      data: {
        inputsBefore: inputs,
        inputsAfterSha256: hash(JSON.stringify(inputs)),
        args: family === "hcl" ? dataConsumerArgs(stage) : [],
        cwd: ".",
        planBefore:
          init || (plan && index === 0)
            ? null
            : (plans[plan ? index - 1 : index] ?? null),
        planAfter: init ? null : (plans[index] ?? null),
        moduleMap: family === "hcl" ? moduleMap : null,
      },
      output:
        family === "hcl" && !init && !plan
          ? output(show(index))
          : family === "yaml"
            ? row.output
            : output("synthetic native diagnostics"),
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
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    const record = {
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
  });
  return { row, records };
}
function refresh(record: ReturnType<typeof sample>["records"][number]) {
  const bytes = Buffer.from(JSON.stringify(record.value) + "\n");
  record.bytes = bytes.length;
  record.sha256 = hash(bytes);
}
test("synthetic data witnesses retain all seven original roles and each actual command without asserting application semantics", () => {
  for (const family of ["hcl", "yaml"] as const)
    for (const variant of ["broken", "fixed", "near-miss"]) {
      const { row, records } = sample(family, variant);
      inspectDataWitness(row);
      for (const record of records) {
        inspectDataAttempt(record.value);
        requireDataAttemptBinding(row, record.value);
      }
      const inspected = inspectConsumerAttemptRecords(records),
        used = new Set();
      requireConsumerWitnessAttempts(row, inspected.records, used);
      assert.equal(used.size, family === "hcl" ? 15 : 1);
      const scope = structuredClone(row);
      scope.data.applicationSemanticsVerified = true;
      assert.throws(() => inspectDataWitness(scope));
      const role = structuredClone(row);
      role.data.results[6] = !role.data.results[6];
      assert.throws(() => inspectDataWitness(role), /original variant/);
    }
});
test("synthetic Terraform attempts reject omitted commands failed runs altered plans wrong roles module drift and unexpected resources", () => {
  const { row, records } = sample("hcl");
  for (const mutate of [
    (value: (typeof records)[number]["value"]) => {
      value.data.planAfter = { bytes: 32, sha256: sha("f") };
    },
    (value: (typeof records)[number]["value"]) => {
      value.data.args[5] = "role=other";
    },
    (value: (typeof records)[number]["value"]) => {
      value.data.moduleMap = { text: "{}", bytes: 2, sha256: hash("{}") };
    },
    (value: (typeof records)[number]["value"]) => {
      value.data.inputsAfterSha256 = sha("f");
    },
  ]) {
    const value = structuredClone(records[1]!.value);
    mutate(value);
    assert.throws(() => {
      inspectDataAttempt(value);
      requireDataAttemptBinding(row, value);
    });
  }
  const badRole = structuredClone(records[2]!.value);
  badRole.output = output(
    JSON.stringify({
      terraform_version: "1.16.5",
      variables: { role: { value: "other" } },
      planned_values: { outputs: { result: { value: true } } },
    }),
  );
  assert.throws(() => requireDataAttemptBinding(row, badRole), /role/);
  const resource = structuredClone(records[2]!.value);
  resource.output = output(
    JSON.stringify({
      ...JSON.parse(
        Buffer.from(resource.output.stdout.base64, "base64").toString(),
      ),
      resource_changes: [{ address: "unexpected" }],
    }),
  );
  assert.throws(() => requireDataAttemptBinding(row, resource), /resources/);
  const missing = structuredClone(row);
  missing.attempts.splice(7, 1);
  assert.throws(
    () =>
      requireConsumerWitnessAttempts(
        missing,
        inspectConsumerAttemptRecords(records).records,
        new Set(),
      ),
    /stage inventory/,
  );
  const failed = structuredClone(records);
  failed[7]!.value.result.exitCode = 1;
  failed[7]!.value.state = "failed";
  refresh(failed[7]!);
  const failedRow = structuredClone(row);
  Object.assign(failedRow.attempts[7]!, {
    bytes: failed[7]!.bytes,
    sha256: failed[7]!.sha256,
  });
  assert.throws(
    () =>
      requireConsumerWitnessAttempts(
        failedRow,
        inspectConsumerAttemptRecords(failed).records,
        new Set(),
      ),
    /Failed or unavailable/,
  );
});
test("synthetic YAML witnesses bind alias identities actual raw source parser URI and complete package content", () => {
  const { row, records } = sample("yaml");
  for (const mode of ["alias", "source", "uri"]) {
    const changed = structuredClone(row),
      native = JSON.parse(
        Buffer.from(changed.output.stdout.base64, "base64").toString(),
      );
    if (mode === "alias") native.aliases.mirrorIsRules = false;
    if (mode === "source") native.sources["extra.yaml"][0]++;
    if (mode === "uri") native.moduleUrlSha256 = sha("f");
    changed.output = output(JSON.stringify(native));
    assert.throws(() => inspectDataWitness(changed), mode);
  }
  const drift = structuredClone(records[0]!.value);
  drift.data.inputsAfterSha256 = sha("f");
  assert.throws(() => requireDataAttemptBinding(row, drift), /changed/);
  const invalid = structuredClone(row.data.inputs);
  invalid.package.inventory.files.pop();
  assert.throws(() => inspectDataInputs(invalid, "yaml"));
  const installed = structuredClone(row.data.inputs);
  installed.package.importUrlSha256 = sha("f");
  installed.package.inventory.directorySha256 = sha("c");
  assert.deepEqual(
    normalizeDataInputs(installed),
    normalizeDataInputs(row.data.inputs),
  );
  installed.package.inventory.files[0]!.sha256 = sha("b");
  installed.package.inventory.manifestSha256 = hash(
    JSON.stringify(installed.package.inventory.files),
  );
  assert.notDeepEqual(
    normalizeDataInputs(installed),
    normalizeDataInputs(row.data.inputs),
  );
});
test("synthetic source and fresh data packets reconcile all finite roles but cannot fill unexecuted families or controller bindings", async () => {
  const read = async (name: string) =>
    JSON.parse(
      await readFile(new URL("../../" + name, import.meta.url), "utf8"),
    );
  const manifest = await read("docs/gate-a-consumer-witnesses.v1.json"),
    inventory = await read("docs/gate-a-profiles.v1.json"),
    profiles = await read("scripts/required-native-tests.json");
  for (const family of manifest.families)
    if (["hcl", "yaml"].includes(family.id)) {
      family.collectorImplementation = "prepared";
      family.sourcePaths =
        family.id === "hcl"
          ? ["policy/rules.tf", "main.tf"]
          : ["policy.yaml", "extra.yaml"];
    }
  const samples = (["hcl", "yaml"] as const).flatMap((family) =>
    ["source", "installed"].flatMap((origin) =>
      ["broken", "fixed", "near-miss"].map((variant) =>
        sample(family, variant, origin),
      ),
    ),
  );
  const report = inspectConsumerWitnesses(
    manifest,
    inventory,
    profiles,
    samples.map((item) => item.row),
    [],
    samples.flatMap((item) => item.records),
  );
  assert.equal(report.requiredFamilies, 19);
  assert.equal(report.complete, false);
  assert.deepEqual(report.issues, []);
  for (const family of ["hcl", "yaml"]) {
    const row = report.families.find(
      (row: { family: string }) => row.family === family,
    );
    assert.equal(row.observedWitnesses, 6);
    assert.equal(row.unqualified.length, 6);
    assert.equal(row.complete, false);
    assert.equal(row.requiredRoleCount, 7);
    assert.equal(row.requiredProcessCountPerWitness, family === "hcl" ? 15 : 1);
    assert.equal(row.applicationSemanticsVerified, false);
    assert.equal(row.fullImpactFallback, true);
  }
});
test("YAML input observer inventories the actual installed parser package while leaving native qualification unclaimed", async () => {
  const value = await observeConsumerWitnessDataInputs("yaml");
  inspectDataInputs(value, "yaml");
  assert.ok("package" in value);
  assert.ok(value.package.inventory.files.length > 1);
  assert.equal(value.package.name, "yaml");
});
