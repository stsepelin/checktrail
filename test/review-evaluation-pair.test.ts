import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  inspectReviewEvaluationPair as inspect,
  reviewEvaluationArmConfigurationSchema,
  type ReviewEvaluationArmConfiguration,
} from "../src/index.js";
import { reviewEvaluationProtocolSchema } from "../src/review-evaluation-protocol.js";
import { protocolFixture } from "./review-evaluation-protocol-fixture.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture() {
  const { protocol } = protocolFixture();
  const baseline: ReviewEvaluationArmConfiguration = {
    schemaVersion: 1,
    profile: "prospective-review-arm-configuration-v1",
    role: "priorWorkflow",
    host: {
      client: "codex",
      clientVersion: "1.2.3",
      executableSha256: sha("synthetic client"),
      requestedModel: "synthetic-model",
      reasoningEffort: "max",
      settingsSha256: sha("synthetic settings"),
    },
    context: {
      taskSha256: sha("authored review task"),
      repositoryInstructionsSha256: sha("authored instructions"),
    },
    native: {
      toolsSha256: protocol.implementation.nativeToolsSha256,
      environmentSha256: protocol.implementation.environmentSha256,
    },
    budgets: structuredClone(protocol.budgets),
    isolation: {
      session: "fresh-per-arm",
      sharedHistory: false,
      sharedOutputs: false,
    },
    treatment: { checktrailEnabled: false },
  };
  const verifier: ReviewEvaluationArmConfiguration = {
    ...structuredClone(baseline),
    role: "verifier",
    treatment: {
      checktrailEnabled: true,
      engineArtifactsSha256: protocol.implementation.engineArtifactsSha256,
      usageInstructionsSha256: sha("authored tool usage"),
    },
  };
  const bind = (
    priorWorkflow = JSON.stringify(baseline),
    checked = JSON.stringify(verifier),
  ) => {
    protocol.priorWorkflow.configurationSha256 = sha(priorWorkflow);
    protocol.verifierConfigurationSha256 = sha(checked);
    return {
      input: {
        protocol: structuredClone(protocol),
        configurations: { priorWorkflow, verifier: checked },
      },
      pin: sha(JSON.stringify(reviewEvaluationProtocolSchema.parse(protocol))),
    };
  };
  const report = () => {
    const { input, pin } = bind();
    return inspect(input, pin);
  };
  return { protocol, baseline, verifier, bind, report };
}

test("evaluation pair admits matched settings with only the declared treatment and never certifies effective hosts or trials", () => {
  const f = fixture();
  for (const client of ["codex", "claude-code"] as const) {
    f.baseline.host.client = client;
    f.verifier.host.client = client;
    const report = f.report();
    assert.equal(report.declaredSettingsMatched, true);
    assert.deepEqual(report.issues, []);
    for (const [key, value] of Object.entries(report))
      if (
        key.endsWith("Verified") ||
        key.endsWith("Executed") ||
        key === "protocolFrozen" ||
        key === "gateAClosed" ||
        key === "qualityAssessed"
      )
        assert.equal(value, false, key);
  }
  const { input, pin } = f.bind(
    JSON.stringify(f.baseline, null, 2),
    JSON.stringify({ ...f.verifier, host: { ...f.verifier.host } }, null, 4),
  );
  assert.equal(inspect(input, pin).declaredSettingsMatched, true);
  assert.equal(
    reviewEvaluationArmConfigurationSchema.parse(f.baseline).role,
    "priorWorkflow",
  );
});

test("evaluation pair checks every shared host context native and budget field even when altered bytes are repinned", () => {
  const original = fixture();
  for (const group of ["host", "context", "native", "budgets"] as const) {
    for (const field of Object.keys(original.verifier[group])) {
      const f = fixture();
      const values = f.verifier[group] as Record<string, unknown>;
      const old = values[field];
      values[field] =
        typeof old === "number"
          ? old + 1
          : field === "client"
            ? "claude-code"
            : field.endsWith("Sha256")
              ? sha("different " + field)
              : "different";
      const report = f.report();
      assert.equal(report.declaredSettingsMatched, false, group + "." + field);
      assert.ok(
        report.issues.includes(
          (group + "-mismatch") as (typeof report.issues)[number],
        ),
        group + "." + field,
      );
    }
  }
  for (const field of Object.keys(original.baseline.budgets)) {
    const f = fixture();
    const baseline = f.baseline.budgets as unknown as Record<string, number>;
    const verifier = f.verifier.budgets as unknown as Record<string, number>;
    baseline[field]!++;
    verifier[field]!++;
    const report = f.report();
    assert.deepEqual(report.issues, ["budget-binding"], field);
  }
  for (const field of ["toolsSha256", "environmentSha256"] as const) {
    const f = fixture();
    f.baseline.native[field] = f.verifier.native[field] =
      sha("foreign runtime");
    assert.deepEqual(f.report().issues, ["native-binding"]);
  }
  const f = fixture();
  assert.equal(f.verifier.treatment.checktrailEnabled, true);
  if (f.verifier.treatment.checktrailEnabled)
    f.verifier.treatment.engineArtifactsSha256 = sha("foreign engine");
  assert.deepEqual(f.report().issues, ["engine-binding"]);
});

test("evaluation pair rejects baseline tool exposure role swaps resumed sessions and unrecognized configuration fields", () => {
  for (const role of ["baseline", "verifier"] as const) {
    for (const change of [
      (arm: Record<string, unknown>) => {
        arm.role = role === "baseline" ? "verifier" : "priorWorkflow";
      },
      (arm: Record<string, unknown>) => {
        arm.treatment =
          role === "baseline"
            ? {
                checktrailEnabled: true,
                engineArtifactsSha256: sha("engine"),
                usageInstructionsSha256: sha("usage"),
              }
            : { checktrailEnabled: false };
      },
      (arm: Record<string, unknown>) => {
        arm.isolation = {
          session: "resume",
          sharedHistory: false,
          sharedOutputs: false,
        };
      },
      (arm: Record<string, unknown>) => {
        arm.isolation = {
          session: "fresh-per-arm",
          sharedHistory: true,
          sharedOutputs: false,
        };
      },
      (arm: Record<string, unknown>) => {
        arm.isolation = {
          session: "fresh-per-arm",
          sharedHistory: false,
          sharedOutputs: true,
        };
      },
      (arm: Record<string, unknown>) => {
        arm.hiddenInstruction = "PRIVATE_SENTINEL";
      },
      (arm: Record<string, unknown>) => {
        arm.treatment = {
          ...(arm.treatment as object),
          extraServer: "PRIVATE_SENTINEL",
        };
      },
    ]) {
      const f = fixture();
      change(f[role] as unknown as Record<string, unknown>);
      const report = f.report();
      assert.equal(report.declaredSettingsMatched, false);
      assert.ok(
        report.issues.includes(
          role === "baseline"
            ? "baseline-configuration"
            : "verifier-configuration",
        ),
      );
      assert.ok(!JSON.stringify(report).includes("PRIVATE_SENTINEL"));
    }
  }
});

test("evaluation pair binds exact bytes and protocol while malformed empty oversized and foreign baseline inputs remain incomplete", () => {
  const f = fixture();
  const { input, pin } = f.bind();
  assert.deepEqual(inspect(input, sha("wrong protocol")).issues, [
    "protocol-binding",
  ]);
  for (const role of ["priorWorkflow", "verifier"] as const) {
    const changed = structuredClone(input);
    changed.configurations[role] += " ";
    assert.deepEqual(inspect(changed, pin).issues, [
      role === "priorWorkflow" ? "baseline-digest" : "verifier-digest",
    ]);
  }
  for (const text of [
    "",
    "{}",
    "null",
    "not JSON",
    "[]",
    JSON.stringify({ payload: "é".repeat(600000) }),
  ]) {
    const g = fixture();
    const bound = g.bind(text);
    const report = inspect(bound.input, bound.pin);
    assert.equal(report.declaredSettingsMatched, false);
    assert.ok(report.issues.includes("baseline-configuration"));
  }
  const exact = fixture();
  const raw = JSON.stringify(exact.baseline);
  const edge = exact.bind(" ".repeat(1048576 - raw.length) + raw);
  assert.equal(inspect(edge.input, edge.pin).declaredSettingsMatched, true);
  const oversized = JSON.stringify({ payload: "é".repeat(600000) });
  const large = exact.bind(oversized);
  const originalParse = JSON.parse;
  let parsedOversized = false;
  try {
    JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
      if (args[0] === oversized) parsedOversized = true;
      return originalParse(...args);
    };
    assert.equal(
      inspect(large.input, large.pin).declaredSettingsMatched,
      false,
    );
  } finally {
    JSON.parse = originalParse;
  }
  assert.equal(
    parsedOversized,
    false,
    "Oversized UTF-8 must be refused before JSON parsing",
  );
  const g = fixture();
  g.protocol.priorWorkflow.kind = "previous-workflow";
  assert.deepEqual(g.report().issues, ["baseline-kind"]);
});

test("evaluation pair setup command reports matched mismatch and malformed input without exposing private settings", () => {
  const script = fileURLToPath(
    new URL("../../scripts/check-evaluation-pair.mjs", import.meta.url),
  );
  const f = fixture();
  f.baseline.host.requestedModel = f.verifier.host.requestedModel =
    "PRIVATE_SENTINEL";
  const bound = f.bind();
  const run = (
    input: unknown,
    pin = bound.pin,
    args = ["--expected-protocol-sha256", pin],
  ) =>
    spawnSync(process.execPath, [script, ...args], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 15000,
    });
  const ok = run(bound.input);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).declaredSettingsMatched, true);
  assert.ok(!ok.stdout.includes("PRIVATE_SENTINEL"));
  f.verifier.host.reasoningEffort = "low";
  const mismatch = f.bind();
  const bad = run(mismatch.input, mismatch.pin);
  assert.equal(bad.status, 2, bad.stderr);
  assert.deepEqual(JSON.parse(bad.stdout).issues, ["host-mismatch"]);
  for (const [input, args] of [
    [{ secret: "PRIVATE_SENTINEL" }, ["--expected-protocol-sha256", bound.pin]],
    [bound.input, ["--unknown", "PRIVATE_SENTINEL"]],
  ] as const) {
    const invalid = run(input, bound.pin, [...args]);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
    assert.equal(invalid.stderr, "Evaluation pair invalid or unavailable\n");
  }
});
