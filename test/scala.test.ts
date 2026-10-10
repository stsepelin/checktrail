import assert from "node:assert/strict";
import { access, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { scalaConfigSchema } from "../src/scala.js";
import { scalaLibraries } from "../src/scala-archive.js";
import { scalaEvidence } from "../src/scala-evidence.js";
import { captureProcessOutput } from "../src/process-output.js";
import { fixture } from "./helpers.js";
import {
  scalaFixture,
  nativeOptions,
  scalaPolicy,
  scalaConfig,
  brokenScala,
  fixedScala,
  nearMissScala,
} from "./scala-fixture.js";
test("Scala planning remains inert explicit and unavailable without pinned prerequisites", async (t) => {
  const root = await fixture(t, {
    "checktrail.json": scalaPolicy,
    "checktrail.scala.json": JSON.stringify(scalaConfig),
    "Original.scala": brokenScala,
    "build.sbt": 'sys.error("never execute")',
  });
  const check = (await createPlan(root)).plan.checks[0]!;
  assert.equal(check.id, "jvm.scala");
  assert.equal(check.commands.length, 0);
  assert.ok(check.unavailableReason);
  assert.deepEqual(check.scope, ["Original.scala"]);
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
  await rm(path.join(root, "checktrail.json"));
  assert.deepEqual(
    (await createPlan(root)).plan.checks.map((c) => c.id),
    ["jvm.javac"],
  );
});
test("Scala configuration rejects unpinned versions plugins scripts mixed profiles and unsafe paths", async (t) => {
  assert.equal(scalaConfigSchema.safeParse(scalaConfig).success, true);
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
      scalaConfigSchema.safeParse({ ...scalaConfig, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
  assert.throws(
    () => scalaLibraries(Buffer.from("not pinned")),
    /pinned Scala compiler archive bytes disagree/,
  );
  for (const files of [
    { "NeverRun.sc": 'sys.error("never execute")' },
    { "Other.java": "class Other {}" },
    { "Other.kt": "class Other" },
  ]) {
    const root = await fixture(t, {
      "checktrail.json": scalaPolicy,
      "checktrail.scala.json": JSON.stringify(scalaConfig),
      "Original.scala": fixedScala,
      ...files,
    });
    const check = (await createPlan(root)).plan.checks[0]!;
    assert.equal(check.commands.length, 0);
    assert.match(check.unavailableReason!, /separate/);
  }
});
test(
  "native Scala catches type defects and accepts repairs exact near misses and CRLF with complete source output bindings",
  nativeOptions,
  async (t) => {
    const root = await scalaFixture(t, {
      "Original.scala": brokenScala,
      "build.sbt": 'sys.error("never execute")',
    });
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, false);
    assert.deepEqual(
      report.checks[0]!.findings!.map((f) => [f.ruleId, f.file, f.line]),
      [["scalac/TypeMismatchID", "Original.scala", 1]],
    );
    assert.equal(
      report.checks[0]!.tools!.find((tool) => tool.name === "scala")!.version,
      "3.9.0",
    );
    for (const source of [
      fixedScala,
      nearMissScala,
      fixedScala.replaceAll("\n", "\r\n"),
    ]) {
      await writeFile(path.join(root, "Original.scala"), source);
      report = await validate(root, { trusted: true });
      assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
      assert.equal(report.checks[0]!.findingsComplete, true);
      const d = JSON.parse(report.checks[0]!.processes[0]!.stdout);
      assert.equal(d.native.registrations, 1);
      assert.equal(d.native.completeStages, 1);
      assert.equal(d.native.sources.length, 2);
      assert.ok(
        d.native.sources.every((s: { compiled: number }) => s.compiled === 1),
      );
      assert.ok(
        d.native.outputs.some(
          (o: { file: string }) => o.file === "Original.tasty",
        ),
      );
    }
    await assert.rejects(access(path.join(root, "executed")), {
      code: "ENOENT",
    });
  },
);
test(
  "native Scala rejects coherent stale source missing typed backend output diagnostics and raw evidence",
  nativeOptions,
  async (t) => {
    const root = await scalaFixture(t),
      check = (await createPlan(root)).plan.checks[0]!,
      report = await validate(root, { trusted: true }),
      process = report.checks[0]!.processes[0]!;
    assert.equal(
      report.checks[0]!.status,
      "passed",
      JSON.stringify(report.checks),
    );
    assert.equal(
      scalaEvidence(check, [process], root).status,
      "passed",
      JSON.stringify(report.checks),
    );
    const good = JSON.parse(process.stdout);
    const changes: [string, (d: typeof good) => void][] = [
      ["request", (d) => (d.requestDigest = "0".repeat(64))],
      ["order", (d) => d.sources.reverse()],
      ["source missing", (d) => d.sources.pop()],
      ["after missing", (d) => d.after.pop()],
      ["snapshot missing", (d) => d.snapshotAfter.pop()],
      ["version", (d) => (d.native.scala = "3.8.0")],
      ["registration", (d) => (d.native.registrations = 0)],
      ["finish", (d) => (d.native.finishCalls = 0)],
      ["feature phase", (d) => (d.native.featureStages = 0)],
      ["feature source", (d) => (d.native.sources[0].featureVisits = 0)],
      ["unknown source", (d) => d.native.unknownSources++],
      ["phase order", (d) => d.native.phases.reverse()],
      ["native source", (d) => d.native.sources.pop()],
      ["frontend", (d) => (d.native.sources[0].frontend = 0)],
      ["native bytes", (d) => d.native.sources[0].bytes++],
      ["native digest", (d) => (d.native.sources[0].sha256 = "0".repeat(64))],
      ["nodes", (d) => d.native.nodes++],
      ["types", (d) => d.native.types++],
      ["unknown annotation", (d) => d.native.sources[0].unknownAnnotations++],
      [
        "nowarn",
        (d) => d.native.sources[0].annotations.push("scala.annotation.nowarn"),
      ],
      [
        "unchecked",
        (d) => d.native.sources[0].annotations.push("scala.unchecked"),
      ],
      ["inline", (d) => (d.native.sources[0].inline = true)],
      ["macro", (d) => (d.native.sources[0].macro = true)],
      ["staging", (d) => (d.native.sources[0].staging = true)],
      ["suspended", (d) => (d.native.sources[0].suspended = true)],
      ["backend", (d) => (d.native.completeStages = 0)],
      ["backend source", (d) => (d.native.sources[0].complete = 0)],
      ["compiled", (d) => (d.native.sources[0].compiled = 0)],
      ["output physical", (d) => d.outputAfter.pop()],
      ["output hash", (d) => (d.native.outputs[0].sha256 = "0".repeat(64))],
      [
        "target",
        (d) =>
          (d.native.outputs.find(
            (o: { classMajor: number | null }) => o.classMajor !== null,
          ).classMajor = 69),
      ],
      ["output source", (d) => (d.native.outputs[0].source = "/foreign.scala")],
      ["binary name", (d) => (d.native.outputs[0].binaryName = "Wrong")],
      [
        "output traversal",
        (d) => (d.native.outputs[0].file = "../foreign.class"),
      ],
      ["count", (d) => (d.native.errors = 1)],
      [
        "hidden warning",
        (d) => d.native.unreported.push({ category: "feature", count: 1 }),
      ],
      ["native exit", (d) => (d.nativeExit = 2)],
      ["native signal", (d) => (d.nativeSignal = "SIGTERM")],
      ["native error", (d) => (d.nativeError = "ENOBUFS")],
    ];
    for (const [name, change] of changes) {
      const d = structuredClone(good);
      change(d);
      d.nativeOutput = captureProcessOutput(
        Buffer.from(JSON.stringify(d.native) + "\n"),
        Buffer.alloc(0),
        Buffer.byteLength(JSON.stringify(d.native) + "\n"),
        true,
      );
      assert.equal(
        scalaEvidence(check, [{ ...process, stdout: JSON.stringify(d) }], root)
          .status,
        "inconclusive",
        name,
      );
    }
    for (const name of ["physical", "native"]) {
      const d = structuredClone(good);
      if (name === "physical") {
        d.sources[0].sha256 = "0".repeat(64);
        d.after[0].sha256 = d.sources[0].sha256;
        // Physical originals and staged compiler inputs have separate bindings.
        // Leave the genuinely compiled snapshot intact to isolate this guard.
      } else {
        d.sources[0].nativeSha256 = "0".repeat(64);
        d.native.sources.find(
          (s: { file: string }) => s.file === d.sources[0].nativeFile,
        ).sha256 = d.sources[0].nativeSha256;
        d.snapshotAfter[0].sha256 = d.sources[0].nativeSha256;
      }
      d.nativeOutput = captureProcessOutput(
        Buffer.from(JSON.stringify(d.native) + "\n"),
        Buffer.alloc(0),
        Buffer.byteLength(JSON.stringify(d.native) + "\n"),
        true,
      );
      assert.equal(
        scalaEvidence(check, [{ ...process, stdout: JSON.stringify(d) }], root)
          .status,
        "inconclusive",
        name,
      );
    }
    const raw = structuredClone(good);
    raw.nativeOutput.stdout.sha256 = "0".repeat(64);
    assert.equal(
      scalaEvidence(check, [{ ...process, stdout: JSON.stringify(raw) }], root)
        .status,
      "inconclusive",
      "physical raw integrity",
    );
    await writeFile(path.join(root, "Original.scala"), brokenScala);
    assert.equal(
      scalaEvidence(check, [process], root).status,
      "inconclusive",
      "source freshness",
    );
  },
);
