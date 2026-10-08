import assert from "node:assert/strict";
import { access, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { kotlinConfigSchema } from "../src/kotlin.js";
import { kotlinLibraries } from "../src/kotlin-archive.js";
import { kotlinEvidence } from "../src/kotlin-evidence.js";
import { captureProcessOutput } from "../src/process-output.js";
import { fixture } from "./helpers.js";
import {
  kotlinFixture,
  nativeOptions,
  kotlinPolicy,
  kotlinConfig,
  brokenKotlin,
  fixedKotlin,
  nearMissKotlin,
} from "./kotlin-fixture.js";
test("Kotlin planning remains inert explicit and unavailable without pinned prerequisites", async (t) => {
  const root = await fixture(t, {
    "checktrail.json": kotlinPolicy,
    "checktrail.kotlin.json": JSON.stringify(kotlinConfig),
    "Original.kt": brokenKotlin,
    "build.gradle.kts": 'throw Exception("never execute")',
  });
  const check = (await createPlan(root)).plan.checks[0]!;
  assert.equal(check.id, "jvm.kotlin");
  assert.equal(check.commands.length, 0);
  assert.ok(check.unavailableReason);
  assert.deepEqual(check.scope, ["Original.kt"]);
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
  await rm(path.join(root, "checktrail.json"));
  assert.deepEqual(
    (await createPlan(root)).plan.checks.map((c) => c.id),
    ["jvm.javac"],
  );
});
test("Kotlin configuration rejects unpinned versions plugins scripting mixed profiles and unsafe paths", async (t) => {
  assert.equal(kotlinConfigSchema.safeParse(kotlinConfig).success, true);
  for (const patch of [
    { sha256: "0".repeat(64) },
    { archive: "../outside.zip" },
    { archive: "a\\b.zip" },
    { profile: "whole-project" },
    { jvmTarget: "8" },
    { plugins: ["custom.jar"] },
    { sourceRoots: ["src"] },
    { classPath: [{ path: "dependency.jar", sha256: "missing" }] },
  ])
    assert.equal(
      kotlinConfigSchema.safeParse({ ...kotlinConfig, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
  assert.throws(
    () => kotlinLibraries(Buffer.from("not a pinned archive")),
    /pinned Kotlin compiler archive bytes disagree/,
  );
  for (const files of [
    { "NeverRun.kts": 'error("never execute")' },
    { "Other.java": "class Other {}" },
    { "Other.scala": "object Other" },
  ]) {
    const root = await fixture(t, {
      "checktrail.json": kotlinPolicy,
      "checktrail.kotlin.json": JSON.stringify(kotlinConfig),
      "Original.kt": fixedKotlin,
      ...files,
    });
    const check = (await createPlan(root)).plan.checks[0]!;
    assert.equal(check.commands.length, 0);
    assert.match(check.unavailableReason!, /separate/);
  }
});
test(
  "native Kotlin catches nullable defects and accepts repairs exact near misses CRLF and BOM with complete source output bindings",
  nativeOptions,
  async (t) => {
    const root = await kotlinFixture(t, {
      "Original.kt": brokenKotlin,
      "build.gradle.kts": 'throw Exception("never execute")',
    });
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, false);
    assert.deepEqual(
      report.checks[0]!.findings!.map((f) => [f.ruleId, f.file, f.line]),
      [["kotlinc/UNSAFE_CALL", "Original.kt", 1]],
    );
    assert.equal(
      report.checks[0]!.tools!.find((tool) => tool.name === "kotlin")!.version,
      "2.4.10",
    );
    for (const source of [
      fixedKotlin,
      nearMissKotlin,
      fixedKotlin.replaceAll("\n", "\r\n"),
      "\ufeff" + fixedKotlin,
    ]) {
      await writeFile(path.join(root, "Original.kt"), source);
      report = await validate(root, { trusted: true });
      assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
      assert.equal(report.checks[0]!.findingsComplete, true);
      const data = JSON.parse(report.checks[0]!.processes[0]!.stdout);
      assert.equal(data.native.registrations, 1);
      assert.equal(data.native.irModules, 1);
      assert.equal(data.native.sources.length, 2);
      assert.equal(data.native.irFiles.length, 2);
      assert.ok(
        data.native.outputs.some(
          (o: { file: string }) => o.file === "META-INF/main.kotlin_module",
        ),
      );
    }
    await assert.rejects(access(path.join(root, "executed")), {
      code: "ENOENT",
    });
  },
);
test(
  "native Kotlin rejects coherent stale source missing frontend IR output diagnostics and raw evidence",
  nativeOptions,
  async (t) => {
    const root = await kotlinFixture(t),
      check = (await createPlan(root)).plan.checks[0]!,
      report = await validate(root, { trusted: true }),
      process = report.checks[0]!.processes[0]!;
    assert.equal(
      kotlinEvidence(check, [process], root).status,
      "passed",
      JSON.stringify(report.checks),
    );
    const good = JSON.parse(process.stdout);
    const changes: [string, (data: typeof good) => void][] = [
      ["request", (d) => (d.requestDigest = "0".repeat(64))],
      ["source order", (d) => d.sources.reverse()],
      ["source missing", (d) => d.sources.pop()],
      ["after missing", (d) => d.after.pop()],
      ["snapshot missing", (d) => d.snapshotAfter.pop()],
      ["version", (d) => (d.native.kotlin = "2.4.9")],
      ["receipt missing", (d) => (d.native = null)],
      ["registration", (d) => (d.native.registrations = 0)],
      ["foreign native source", (d) => d.native.unknownSources++],
      ["missing frontend", (d) => d.native.sources.pop()],
      ["frontend count", (d) => (d.native.sources[0].fileCallbacks = 0)],
      [
        "frontend identity",
        (d) => (d.native.sources[0].sha256 = "0".repeat(64)),
      ],
      ["frontend bytes", (d) => d.native.sources[0].bytes++],
      ["node count", (d) => d.native.firNodes++],
      ["unknown annotation", (d) => d.native.sources[0].unknownAnnotations++],
      [
        "suppression",
        (d) => d.native.sources[0].annotations.push("kotlin.Suppress"),
      ],
      ["missing IR module", (d) => (d.native.irModules = 0)],
      ["missing IR source", (d) => d.native.irFiles.pop()],
      [
        "duplicate IR source",
        (d) => (d.native.irFiles[0] = d.native.irFiles[1]),
      ],
      ["foreign IR source", (d) => (d.native.irFiles[0] = "/foreign.kt")],
      ["missing physical output", (d) => d.outputAfter.pop()],
      [
        "changed output bytes",
        (d) => (d.native.outputs[0].sha256 = "0".repeat(64)),
      ],
      ["class target", (d) => (d.native.outputs[0].classMajor = 69)],
      ["no output", (d) => (d.native.outputs = [])],
      ["missing output", (d) => d.native.outputs.pop()],
      [
        "foreign output source",
        (d) => (d.native.outputs[0].sources = ["/foreign.kt"]),
      ],
      [
        "output traversal",
        (d) => (d.native.outputs[0].file = "../foreign.class"),
      ],
      ["output digest", (d) => (d.native.outputs[0].sha256 = "invalid")],
      ["partial native", (d) => (d.native.exit = "INTERNAL_ERROR")],
      ["exit mismatch", (d) => (d.native.hasErrors = true)],
      [
        "unaccounted message",
        (d) =>
          d.native.messages.push({
            severity: "INFO",
            message: "incomplete",
            file: null,
            line: -1,
            column: -1,
            lineContent: null,
          }),
      ],
      ["native exit", (d) => (d.nativeExit = 2)],
      ["native signal", (d) => (d.nativeSignal = "SIGTERM")],
      ["native error", (d) => (d.nativeError = "ENOBUFS")],
      ["raw digest", (d) => (d.nativeOutput.stdout.sha256 = "0".repeat(64))],
      ["raw count", (d) => d.nativeOutput.observedBytes++],
      [
        "partial raw",
        (d) => (d.nativeOutput.completeForObservedStreams = false),
      ],
      [
        "coherent physical source",
        (d) => {
          const hash = "0".repeat(64);
          d.sources[0].sha256 = hash;
          d.after[0].sha256 = hash;
          d.snapshotAfter[0].sha256 = hash;
        },
      ],
      [
        "coherent native source",
        (d) => {
          const hash = "0".repeat(64);
          d.sources[0].nativeSha256 = hash;
          const observed = d.native.sources.find(
            (s: { file: string }) => s.file === d.sources[0].nativeFile,
          );
          observed.sha256 = hash;
        },
      ],
    ];
    for (const [name, mutate] of changes) {
      const changed = structuredClone(good);
      mutate(changed);
      if (changed.native) {
        const raw = Buffer.from(JSON.stringify(changed.native) + "\n"),
          err = Buffer.from(good.nativeOutput.stderr.base64, "base64");
        if (!name.startsWith("raw") && !name.startsWith("partial raw"))
          changed.nativeOutput = captureProcessOutput(
            raw,
            err,
            raw.length + err.length,
            true,
          );
      }
      const result = kotlinEvidence(
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
        kotlinEvidence(check, [{ ...process, ...flags }], root).status,
        "inconclusive",
      );
    assert.equal(
      kotlinEvidence(check, [process, process], root).status,
      "inconclusive",
    );
    assert.equal(
      kotlinEvidence({ ...check, scope: [] }, [process], root).status,
      "inconclusive",
    );
    await writeFile(path.join(root, "Original.kt"), nearMissKotlin);
    assert.equal(kotlinEvidence(check, [process], root).status, "inconclusive");
  },
);
