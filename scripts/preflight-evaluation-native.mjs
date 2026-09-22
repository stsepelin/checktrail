import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { configSchema, createGateway } from "./agent-evaluation-gateway.mjs";
import {
  executionProfileSchema,
  nativeComplete,
  nativeEvidenceSchema,
} from "./agent-evaluation-protocol.mjs";

const inputSchema = z.strictObject({
  gateway: configSchema.omit({ audit: true, binding: true }),
  profile: executionProfileSchema,
  nativeEvidence: nativeEvidenceSchema,
});
const hash = (value) => createHash("sha256").update(value).digest("hex");
const encode = (value) => JSON.stringify(value, null, 2) + "\n";
const records = (text) => text.trimEnd().split("\n").map(JSON.parse);

export function summarizeNativePreflight(auditText, expected) {
  const events = records(auditText);
  let previous = null;
  const chainVerified =
    auditText.endsWith("\n") &&
    events.every((event, index) => {
      const { sha256, ...content } = event;
      const valid =
        event.sequence === index + 1 &&
        event.previous === previous &&
        sha256 === hash(JSON.stringify(content) + "\n");
      previous = sha256;
      return valid;
    });
  const start = events[0];
  assert.equal(start.type, "start");
  assert.deepEqual(start.profile, expected.profile);
  const calls = events.filter((event) => event.type === "call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "evaluation_native");
  const results = events.filter((event) => event.type === "result");
  assert.equal(results.length, 1);
  assert.equal(results[0].tool, "evaluation_native");
  const result = results[0].result;
  const end = events.at(-1);
  const filesValid =
    Array.isArray(start.files) &&
    start.files.length > 0 &&
    new Set(start.files.map((file) => file.file)).size === start.files.length &&
    start.files.every(
      (file) =>
        configSchema.shape.files.element.safeParse(file.file).success &&
        /^[a-f0-9]{64}$/.test(file.sha256) &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes >= 0,
    ) &&
    expected.nativeEvidence.scope.every((file) =>
      start.files.some((source) => source.file === file),
    ) &&
    (!expected.gateway ||
      isDeepStrictEqual(
        start.files.map((file) => file.file).sort(),
        [...expected.gateway.files].sort(),
      ));
  const auditVerified =
    chainVerified &&
    filesValid &&
    isDeepStrictEqual(
      events.map((event) => event.type),
      ["start", "call", "result", "end"],
    ) &&
    start.auditVersion === 2 &&
    start.binding === null &&
    start.treatment === false &&
    start.integrityScope === "mounted-trees-per-execution" &&
    start.image === expected.profile.image &&
    start.runtimeSha256 === expected.profile.runtimeSha256 &&
    start.dependenciesSha256 === expected.profile.dependenciesSha256 &&
    start.budget?.timeoutMs === expected.profile.timeoutMs &&
    start.budget?.maxOutputBytes === expected.profile.maxOutputBytes &&
    Number.isSafeInteger(start.budget?.maxCalls) &&
    start.budget.maxCalls >= 1 &&
    (!expected.gateway ||
      start.budget.maxCalls === expected.gateway.maxCalls) &&
    /^[a-f0-9]{64}$/.test(start.gatewaySha256) &&
    /^[a-f0-9]{64}$/.test(start.workerSha256) &&
    isDeepStrictEqual(calls[0].arguments, {}) &&
    results[0].attempt ===
      `evidence-${calls[0].sequence}-${calls[0].sha256.slice(0, 12)}` &&
    end.integrityScope === "completed-execution-calls" &&
    end.calls === 1;
  const identity = {
    runtimeSha256: null,
    dependenciesSha256: expected.profile.dependenciesSha256,
  };
  const cleanupCompleted =
    end.type === "end" &&
    end.cleanupCompleted === true &&
    end.sourceSnapshotRemoved === true;
  const integrityVerified =
    result.ok === true &&
    result.value?.integrity?.verified === true &&
    result.value.integrity.scope === "mounted-trees-per-execution" &&
    ["expected", "before", "after"].every((key) =>
      isDeepStrictEqual(result.value.integrity[key], identity),
    ) &&
    end.executionAttempts === 1 &&
    end.verifiedExecutions === 1 &&
    end.integrityFailures === 0;
  const nativeEvidenceComplete =
    result.ok === true && nativeComplete(result.value, expected);
  return {
    schemaVersion: 1,
    kind: "native-profile-preflight",
    modelInference: false,
    ready:
      auditVerified &&
      cleanupCompleted &&
      integrityVerified &&
      nativeEvidenceComplete,
    auditVerified,
    nativeEvidenceComplete,
    cleanupCompleted,
    integrityVerified,
    profile: start.profile,
    nativeEvidence: expected.nativeEvidence,
    files: start.files,
    auditSha256: hash(auditText),
    gatewaySha256: start.gatewaySha256,
    workerSha256: start.workerSha256,
    exitCode: result.value?.exitCode ?? null,
    stdoutSha256: result.value ? hash(result.value.stdout) : null,
    stderrSha256: result.value ? hash(result.value.stderr) : null,
  };
}

export async function preflightNativeProfile(input, destination, options = {}) {
  assert.equal(
    options.trustExecution,
    true,
    "Explicit execution trust required",
  );
  const config = inputSchema.parse(input);
  assert.equal(
    config.gateway.treatment,
    false,
    "Native-only preflight required",
  );
  await fs.mkdir(destination);
  const directory = await fs.realpath(destination);
  const audit = path.join(directory, "gateway-audit.jsonl");
  await fs.writeFile(path.join(directory, "input.json"), encode(config), {
    flag: "wx",
    mode: 0o600,
  });
  const gateway = await createGateway({ ...config.gateway, audit });
  try {
    const start = records(await fs.readFile(audit, "utf8"))[0];
    assert.deepEqual(
      start.profile,
      config.profile,
      "Execution profile mismatch",
    );
    await gateway.call("evaluation_native", {});
  } finally {
    await gateway.close();
  }
  const summary = summarizeNativePreflight(
    await fs.readFile(audit, "utf8"),
    config,
  );
  await fs.writeFile(path.join(directory, "preflight.json"), encode(summary), {
    flag: "wx",
    mode: 0o600,
  });
  return summary;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [input, destination, trust, ...extra] = process.argv.slice(2);
  assert.ok(
    input && destination && trust === "--trust-execution" && !extra.length,
    "Usage: preflight-evaluation-native.mjs CONFIG.json NEW_OUTPUT_DIR --trust-execution",
  );
  const result = await preflightNativeProfile(
    JSON.parse(await fs.readFile(input, "utf8")),
    destination,
    { trustExecution: true },
  );
  process.stdout.write(encode(result));
  if (!result.ready) process.exitCode = 1;
}
