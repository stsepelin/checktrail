import assert from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { detektConfigSchema } from "../src/detekt.js";
import { detektEvidence } from "../src/detekt-evidence.js";
import { detektArtifacts } from "../src/detekt-artifacts.js";
import { detektConfiguration } from "../src/detekt-configuration.js";
import { captureProcessOutput } from "../src/process-output.js";
import { fixture } from "./helpers.js";
import {
  detektFixture,
  nativeOptions,
  detektPolicy,
  detektConfig,
  brokenKotlin,
  fixedKotlin,
  nearMissKotlin,
} from "./detekt-fixture.js";

test("detekt planning is inert explicit and unavailable without pinned prerequisites", async (t) => {
  const root = await fixture(t, {
    "checktrail.json": detektPolicy,
    "checktrail.detekt.json": JSON.stringify(detektConfig),
    "Original.kt": brokenKotlin,
    "build.gradle.kts": 'throw Exception("never execute")',
  });
  const check = (await createPlan(root)).plan.checks[0]!;
  assert.equal(check.id, "jvm.detekt");
  assert.ok(check.unavailableReason);
  assert.equal(check.commands.length, 0);
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
  await rm(path.join(root, "checktrail.json"));
  assert.deepEqual(
    (await createPlan(root)).plan.checks.map((c) => c.id),
    ["jvm.javac"],
  );
});
test("detekt policy rejects alternate plugins baselines rules versions and unsafe artifact paths", async (t) => {
  const input = { ...detektConfig };
  assert.equal(detektConfigSchema.safeParse(input).success, true);
  for (const patch of [
    { baseline: "baseline.xml" },
    { plugins: ["custom.jar"] },
    { rules: "rules.yml" },
    { sha256: "0".repeat(64) },
    { profile: "whole-program" },
    { jar: "../outside.jar" },
    { jar: "a\\b.jar" },
  ])
    assert.equal(
      detektConfigSchema.safeParse({ ...input, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
  assert.throws(() => detektConfiguration(Buffer.from("not a pinned ZIP")), {
    message: "The pinned detekt JAR bytes disagree",
  });
  const root = await fixture(t, {
    "checktrail.json": detektPolicy,
    "checktrail.detekt.json": JSON.stringify(input),
    "Original.kt": fixedKotlin,
  });
  assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
});
test(
  "native detekt catches broken repairs and near misses across every selected source without executing Kotlin",
  nativeOptions,
  async (t) => {
    const root = await detektFixture(t, {
      "Original.kt": brokenKotlin,
      "NeverRun.kts":
        'java.nio.file.Files.writeString(java.nio.file.Path.of("executed"), "must not run")\n',
    });
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.equal(report.sourceChanged, false);
    assert.equal(report.checks[0]!.findingsComplete, true);
    assert.deepEqual(
      report.checks[0]!.findings!.map((f) => [f.ruleId, f.file, f.line]),
      [["detekt/style/MagicNumber", "Original.kt", 1]],
    );
    assert.equal(
      report.checks[0]!.tools!.find((tool) => tool.name === "detekt")!.version,
      detektArtifacts.version,
    );
    const data = JSON.parse(report.checks[0]!.processes[0]!.stdout);
    assert.equal(data.sources.length, 3);
    assert.equal(data.native.sources.length, 3);
    assert.deepEqual(data.native.rules, detektArtifacts.rules);
    assert.deepEqual(
      data.sources.map((s: { file: string }) => path.basename(s.file)).sort(),
      ["Another with spaces.kt", "NeverRun.kts", "Original.kt"],
    );
    await assert.rejects(access(path.join(root, "executed")), {
      code: "ENOENT",
    });
    assert.equal(
      await readFile(path.join(root, "Original.kt"), "utf8"),
      brokenKotlin,
    );
    await writeFile(
      path.join(root, "Original.kt"),
      fixedKotlin.replaceAll("\n", "\r\n"),
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, true);
    await writeFile(path.join(root, "Original.kt"), nearMissKotlin);
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findings!.length, 0);
  },
);
test(
  "native detekt rejects missing reordered duplicated stale suppressed skipped rule source lifecycle and raw output evidence",
  nativeOptions,
  async (t) => {
    const root = await detektFixture(t),
      check = (await createPlan(root)).plan.checks[0]!,
      report = await validate(root, { trusted: true }),
      process = report.checks[0]!.processes[0]!;
    assert.equal(
      detektEvidence(check, [process], root).status,
      "passed",
      JSON.stringify(report.checks),
    );
    const good = JSON.parse(process.stdout);
    const mutations: [string, (data: typeof good) => void][] = [
      ["request", (d) => (d.requestDigest = "0".repeat(64))],
      ["configuration", (d) => (d.configurationSha256 = "0".repeat(64))],
      ["version", (d) => (d.detekt = "2.0.0-alpha.5")],
      ["no receipt", (d) => (d.native = null)],
      ["missing source", (d) => d.sources.pop()],
      ["missing after", (d) => d.after.pop()],
      ["foreign original", (d) => (d.sources[0].file = "/foreign.kt")],
      ["duplicate original", (d) => (d.sources[0] = d.sources[1])],
      ["swapped source", (d) => d.sources.reverse()],
      ["physical source", (d) => (d.sources[0].sha256 = "0".repeat(64))],
      [
        "coherent forged physical identity",
        (d) => {
          const hash = "0".repeat(64);
          d.sources[0].sha256 = hash;
          d.after[0].sha256 = hash;
          d.native.sources[0].physicalBefore = hash;
          d.native.sources[0].physicalAfter = hash;
        },
      ],
      [
        "coherent forged PSI identity",
        (d) => {
          const hash = "0".repeat(64);
          d.sources[0].canonicalSha256 = hash;
          d.native.sources[0].psiSha256 = hash;
        },
      ],
      [
        "canonical source",
        (d) => (d.sources[0].canonicalSha256 = "0".repeat(64)),
      ],
      ["source size", (d) => d.sources[0].bytes++],
      ["changed source", (d) => (d.after[0].sha256 = "0".repeat(64))],
      ["missing participation", (d) => d.native.sources.pop()],
      ["foreign snapshot", (d) => (d.native.sources[0].file = "/foreign.kt")],
      [
        "snapshot before",
        (d) => (d.native.sources[0].physicalBefore = "0".repeat(64)),
      ],
      [
        "snapshot after",
        (d) => (d.native.sources[0].physicalAfter = "0".repeat(64)),
      ],
      ["PSI source", (d) => (d.native.sources[0].psiSha256 = "0".repeat(64))],
      ["syntax", (d) => d.native.sources[0].syntaxErrors++],
      [
        "exclusion",
        (d) => d.native.sources[0].excluded.push("style/MagicNumber"),
      ],
      [
        "suppression",
        (d) => d.native.sources[0].suppressed.push("style/MagicNumber"),
      ],
      ["missing plan", (d) => d.native.rules.pop()],
      ["foreign plan", (d) => (d.native.rules[0].id = "ForeignRule")],
      [
        "inactive rule",
        (d) =>
          (d.native.rules.find(
            (r: { id: string }) => r.id === "MagicNumber",
          ).active = false),
      ],
      ["rule order", (d) => d.native.rules.reverse()],
      [
        "notification",
        (d) =>
          d.native.notifications.push({
            level: "Warning",
            message: "unfinished",
          }),
      ],
      ["missing finish", (d) => d.native.events.pop()],
      ["missing file finish", (d) => d.native.events.splice(2, 1)],
      ["duplicate event", (d) => (d.native.events[2] = d.native.events[1])],
      ["foreign event", (d) => (d.native.events[1].file = "/foreign.kt")],
      [
        "out of order finish",
        (d) => {
          const e = d.native.events[1];
          d.native.events[1] = d.native.events[2];
          d.native.events[2] = e;
        },
      ],
      ["native exit", (d) => (d.nativeExit = 2)],
      ["native signal", (d) => (d.nativeSignal = "SIGTERM")],
      ["native error", (d) => (d.nativeError = "ENOBUFS")],
      ["output digest", (d) => (d.nativeOutput.stderr.sha256 = "0".repeat(64))],
      ["output size", (d) => d.nativeOutput.stderr.bytes++],
      [
        "partial raw",
        (d) => (d.nativeOutput.completeForObservedStreams = false),
      ],
      ["unaccounted bytes", (d) => d.nativeOutput.observedBytes++],
      [
        "unexpected diagnostic",
        (d) => {
          const out = Buffer.from(d.nativeOutput.stdout.base64, "base64"),
            err = Buffer.concat([
              Buffer.from(d.nativeOutput.stderr.base64, "base64"),
              Buffer.from("unhandled tool failure\n"),
            ]);
          d.nativeOutput = captureProcessOutput(
            out,
            err,
            out.length + err.length,
            true,
          );
        },
      ],
    ];
    for (const [name, mutate] of mutations) {
      const changed = structuredClone(good);
      mutate(changed);
      const result = detektEvidence(
        check,
        [{ ...process, stdout: JSON.stringify(changed) }],
        root,
      );
      assert.equal(result.status, "inconclusive", name);
      assert.equal(result.findingsComplete, false, name);
    }
    for (const flags of [
      { cancelled: true },
      { timedOut: true },
      { truncated: true },
      { signal: "SIGTERM" },
      { errorCode: "EXECUTION_UNAVAILABLE" },
    ])
      assert.equal(
        detektEvidence(check, [{ ...process, ...flags }], root).status,
        "inconclusive",
      );
    assert.equal(
      detektEvidence({ ...check, scope: [] }, [process], root).status,
      "inconclusive",
    );
    assert.equal(
      detektEvidence(check, [process, process], root).status,
      "inconclusive",
    );
    await writeFile(path.join(root, "Original.kt"), nearMissKotlin);
    assert.equal(
      detektEvidence(check, [process], root).status,
      "inconclusive",
      "stale source on disk",
    );
  },
);
