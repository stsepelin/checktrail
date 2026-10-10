import assert from "node:assert/strict";
import {
  spotbugsReplay,
  spotbugsFaults,
} from "./spotbugs-extension-evidence-fixture.js";
import path from "node:path";
import type { z } from "zod";
import { spotbugsExtensionsEvidence } from "../src/spotbugs-extensions-evidence.js";
import { access, writeFile, readFile } from "node:fs/promises";
import { test } from "node:test";
import { identifyTool, toolsFor } from "../src/tool-versions.js";
import { runProcess } from "../src/runner.js";
import { createPlan, validate } from "../src/engine.js";
import { nativeOptions, javaConfig } from "./spotbugs-fixture.js";
import {
  analyzerFixture,
  originalAnalyzerSource,
  originalAnalyzerGenerator,
} from "./spotbugs-extensions-fixture.js";
import { spotbugsExtensionsEvidenceSchema } from "../src/spotbugs-extensions-contract.js";
test(
  "Native analyzer retains nested and generated source-bound plugin findings with fresh library and JPMS witnesses",
  nativeOptions,
  async (t) => {
    const f = await analyzerFixture(t, true),
      plan = (await createPlan(f.root)).plan;
    assert.equal(
      plan.checks[0]!.commands.length,
      1,
      plan.checks[0]!.unavailableReason ??
        "Expected native analyzer invocation",
    );
    await assert.rejects(access(f.marker));
    const tool = (await toolsFor(f.root, plan.checks[0]!)).find(
      (tool) => tool.name === "spotbugs",
    )!;
    const version = await identifyTool(f.root, tool, (command) =>
      runProcess(f.root, command, { timeoutMs: 30000 }),
    );
    assert.equal(version.status, "identified", JSON.stringify(version));
    assert.equal(version.version, "4.10.4");
    await assert.rejects(access(f.marker));
    await assert.rejects(
      validate(f.root, { trusted: false }),
      /operator trust/,
    );
    await assert.rejects(access(f.marker));
    const result = (
      await validate(f.root, { trusted: true, timeoutMs: 120000 })
    ).checks[0]!;
    assert.equal(result.status, "failed", JSON.stringify(result));
    assert.equal(result.findingsComplete, true);
    assert.deepEqual(
      result.findings
        ?.filter(
          (f) =>
            f.ruleId ===
            "spotbugs/checktrail.synthetic.rules.v1/CHECKTRAIL_UNSAFE_VALUE",
        )
        .map((f) => f.file)
        .sort(),
      [
        "application/src/main/java/demo/Original.java",
        "generators/OriginalGenerator.java",
      ],
    );
    await access(f.marker);
    const packet = spotbugsExtensionsEvidenceSchema.parse(
      JSON.parse(result.processes[0]!.stdout),
    );
    assert.equal(packet.modules.length, 2);
    assert.equal(packet.generated.length, 1);
    assert.equal(packet.analysis!.stats.length, 3);
    assert.ok(
      packet.analysis!.stats.every((c) => !c.name.startsWith("provider.")),
    );
    await assert.rejects(
      access(
        path.join(f.root, "application/src/main/java/demo/Generated.java"),
      ),
    );
    await writeFile(
      path.join(f.root, "application/src/main/java/demo/Original.java"),
      originalAnalyzerSource(false),
    );
    await writeFile(
      path.join(f.root, "generators/OriginalGenerator.java"),
      originalAnalyzerGenerator(false),
    );
    const fixed = (await validate(f.root, { trusted: true, timeoutMs: 120000 }))
      .checks[0]!;
    assert.equal(fixed.status, "passed", JSON.stringify(fixed));
    assert.equal(fixed.findingsComplete, true);
    assert.deepEqual(fixed.findings, []);
    assert.equal(
      await readFile(
        path.join(f.root, "application/src/main/java/demo/Original.java"),
        "utf8",
      ),
      originalAnalyzerSource(false),
    );
  },
);
test(
  "Native analyzer accepts exact overload and identifier near misses with complete fresh class accounting",
  nativeOptions,
  async (t) => {
    const f = await analyzerFixture(t, false, true),
      result = (await validate(f.root, { trusted: true, timeoutMs: 120000 }))
        .checks[0]!;
    assert.equal(result.status, "passed", JSON.stringify(result));
    assert.equal(result.findingsComplete, true);
    assert.deepEqual(result.findings, []);
  },
);

test(
  "Native analyzer rejects coherent module class provider pass and physical identity faults",
  nativeOptions,
  async (t) => {
    const f = await analyzerFixture(t, true),
      check = (await createPlan(f.root)).plan.checks[0]!,
      result = (await validate(f.root, { trusted: true, timeoutMs: 120000 }))
        .checks[0]!;
    assert.equal(result.status, "failed");
    assert.equal(result.findingsComplete, true);
    const process = result.processes[0]!,
      good = spotbugsExtensionsEvidenceSchema.parse(JSON.parse(process.stdout));
    type Packet = z.infer<typeof spotbugsExtensionsEvidenceSchema>;
    const reconcile = (d: Packet) =>
      spotbugsReplay(check, process, f.root, good, d);
    assert.equal(
      reconcile(structuredClone(good)).status,
      "failed",
      "A coherent untouched receipt must retain native defects",
    );
    for (const [name, mutate] of spotbugsFaults) {
      const changed = structuredClone(good);
      mutate(changed);
      const evidence = reconcile(changed);
      assert.equal(evidence.status, "inconclusive", name);
      assert.equal(evidence.findingsComplete, false, name);
    }
    const missing = structuredClone(good);
    missing.analysis = null;
    assert.equal(reconcile(missing).status, "inconclusive");
    await writeFile(
      path.join(f.root, "application/src/main/java/demo/Original.java"),
      originalAnalyzerSource(false),
    );
    assert.equal(
      spotbugsExtensionsEvidence(check, [process], f.root).status,
      "inconclusive",
      "Current source invalidates an otherwise complete native receipt",
    );
  },
);

test(
  "Native analyzer preserves source compiler errors and strict warning policy without complete bytecode claims",
  nativeOptions,
  async (t) => {
    const f = await analyzerFixture(t);
    const file = path.join(
      f.root,
      "application/src/main/java/demo/Original.java",
    );
    await writeFile(
      file,
      originalAnalyzerSource(false).replace(
        "Generated.result()",
        "missingValue",
      ),
    );
    const broken = (
      await validate(f.root, { trusted: true, timeoutMs: 120000 })
    ).checks[0]!;
    assert.equal(
      broken.status,
      "failed",
      JSON.stringify({ status: broken.status, reason: broken.reason }),
    );
    assert.equal(broken.findingsComplete, false);
    assert.ok(
      broken.findings?.some(
        (f) =>
          f.file === "application/src/main/java/demo/Original.java" &&
          f.level === "error" &&
          f.ruleId === "javac/compiler.err.cant.resolve.location",
      ),
    );
    await writeFile(
      file,
      originalAnalyzerSource(false).replace("public Original(){} ", ""),
    );
    await writeFile(
      path.join(f.root, "checktrail.java.json"),
      JSON.stringify({ ...javaConfig, warningsAsErrors: true }),
    );
    const strict = (
      await validate(f.root, { trusted: true, timeoutMs: 120000 })
    ).checks[0]!;
    assert.equal(
      strict.status,
      "failed",
      JSON.stringify({ status: strict.status, reason: strict.reason }),
    );
    assert.equal(strict.findingsComplete, false);
    assert.equal(
      strict.findings?.filter(
        (f) => f.ruleId === "javac/compiler.err.warnings.and.werror",
      ).length,
      1,
    );
    assert.ok(
      strict.findings?.some(
        (f) =>
          f.ruleId === "javac/compiler.warn.missing-explicit-ctor" &&
          f.file === "application/src/main/java/demo/Original.java" &&
          f.line === 1,
      ),
    );
    assert.ok(
      strict.findings?.every((f) => f.line === undefined || f.line > 0),
    );
    await writeFile(
      path.join(f.root, "checktrail.java.json"),
      JSON.stringify(javaConfig),
    );
    const warning = (
      await validate(f.root, { trusted: true, timeoutMs: 120000 })
    ).checks[0]!;
    assert.equal(warning.status, "passed");
    assert.equal(warning.findingsComplete, true);
    assert.equal(
      warning.findings?.filter(
        (f) => f.ruleId === "javac/compiler.warn.missing-explicit-ctor",
      ).length,
      1,
    );
  },
);
