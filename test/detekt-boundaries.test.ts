import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { detektEvidence } from "../src/detekt-evidence.js";
import {
  detektFixture,
  nativeOptions,
  brokenKotlin,
  fixedKotlin,
  nearMissKotlin,
} from "./detekt-fixture.js";

test(
  "native detekt accounts exact file function and family suppressions without treating identifier prefixes as suppression",
  nativeOptions,
  async (t) => {
    const root = await detektFixture(t, {
      "Original.kt": '@file:Suppress("MagicNumberAdditional")\n' + brokenKotlin,
    });
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, true);
    assert.deepEqual(
      report.checks[0]!.findings!.map((f) => f.ruleId),
      ["detekt/style/MagicNumber"],
    );
    for (const source of [
      '@file:Suppress("detekt:MagicNumber")\n' + brokenKotlin,
      '@Suppress("style:MagicNumber")\n' + brokenKotlin,
      '@file:Suppress("ALL")\n' + fixedKotlin,
    ]) {
      await writeFile(path.join(root, "Original.kt"), source);
      report = await validate(root, { trusted: true });
      assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
      assert.equal(report.checks[0]!.status, "inconclusive");
      assert.equal(report.checks[0]!.findingsComplete, false);
      const native = JSON.parse(report.checks[0]!.processes[0]!.stdout).native;
      const observed = native.sources.find((s: { file: string }) =>
        s.file.endsWith("/Original.kt"),
      );
      assert.ok(observed.suppressed.includes("style/MagicNumber"));
      assert.equal(native.findings.length, 0);
    }
  },
);
test(
  "native detekt analyzes files beneath default test exclusions and binds same-named Kotlin files to their correct source",
  nativeOptions,
  async (t) => {
    const root = await detektFixture(t, {
      "Original.kt": nearMissKotlin,
      "src/test/kotlin/Original.kt":
        "fun testDecision(value: Int): Int = value + 42\n",
    });
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, true);
    assert.deepEqual(
      report.checks[0]!.findings!.map((f) => [f.ruleId, f.file, f.line]),
      [["detekt/style/MagicNumber", "src/test/kotlin/Original.kt", 1]],
    );
    const data = JSON.parse(report.checks[0]!.processes[0]!.stdout);
    assert.equal(data.sources.length, 3);
    assert.ok(
      data.native.sources.every(
        (s: { excluded: unknown[] }) => s.excluded.length === 0,
      ),
    );
  },
);
test(
  "native detekt rejects malformed syntax invalid source bytes and empty selected scope while retaining native failure output",
  nativeOptions,
  async (t) => {
    const root = await detektFixture(t, {
      "Original.kt": "fun originalDecision(: Int =\n",
    });
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, false);
    const data = JSON.parse(report.checks[0]!.processes[0]!.stdout);
    assert.equal(data.nativeExit, 1);
    assert.equal(data.native, null);
    assert.ok(data.nativeOutput.stderr.bytes > 0);
    assert.equal(data.nativeOutput.completeForObservedStreams, true);
    await writeFile(path.join(root, "Original.kt"), Buffer.from([0xff, 0xfe]));
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, false);
    await rm(path.join(root, "Original.kt"));
    await rm(path.join(root, "Another with spaces.kt"));
    const check = (await createPlan(root)).plan.checks[0]!;
    assert.equal(check.commands.length, 0);
    assert.match(check.unavailableReason!, /No Kotlin source/);
  },
);
test(
  "native detekt rejects foreign rule severity suppression address and raw console findings",
  nativeOptions,
  async (t) => {
    const root = await detektFixture(t, { "Original.kt": brokenKotlin }),
      check = (await createPlan(root)).plan.checks[0]!,
      report = await validate(root, { trusted: true }),
      process = report.checks[0]!.processes[0]!;
    assert.equal(
      detektEvidence(check, [process], root).status,
      "failed",
      JSON.stringify(report.checks),
    );
    const good = JSON.parse(process.stdout);
    assert.equal(good.native.findings.length, 1);
    const mutations: [string, (data: typeof good) => void][] = [
      ["foreign source", (d) => (d.native.findings[0].file = "foreign.kt")],
      [
        "foreign rule",
        (d) => (d.native.findings[0].id = "MagicNumberAdditional"),
      ],
      ["foreign set", (d) => (d.native.findings[0].set = "other")],
      ["severity", (d) => (d.native.findings[0].severity = "Warning")],
      ["line", (d) => (d.native.findings[0].line = 10000)],
      ["column", (d) => (d.native.findings[0].column = 10000)],
      [
        "suppressed issue",
        (d) => d.native.findings[0].suppressionReasons.push("hidden"),
      ],
      ["missing issue", (d) => (d.native.findings = [])],
      ["wrong exit", (d) => (d.nativeExit = 0)],
      ["message", (d) => (d.native.findings[0].message = "forged")],
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
    assert.equal(
      await readFile(path.join(root, "Original.kt"), "utf8"),
      brokenKotlin,
    );
  },
);
