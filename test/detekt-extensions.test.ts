import assert from "node:assert/strict";
import { detektHash } from "../src/detekt-configuration.js";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import {
  detektExtensionsEvidence,
  detektExtensionsEvidenceSchema,
} from "../src/detekt-extensions-evidence.js";
import { captureProcessOutput } from "../src/process-output.js";
import type { ProcessResult } from "../src/types.js";
import type { z } from "zod";
import {
  fullDetektFixture as original,
  fullDetektOptions as options,
} from "./detekt-extensions-fixture.js";

test(
  "full detekt resolves source types and retains source-bound native rule findings",
  options,
  async (t) => {
    const source =
      'fun originalNormalize(value: String): String = value?.trim() ?: ""\n';
    const root = await original(t, source);
    const check = (await createPlan(root)).plan.checks[0]!;
    assert.equal(check.commands.length, 1);
    assert.ok(
      check.commands[0]!.args[0]!.endsWith("detekt-extensions-runner.js"),
    );
    const report = await validate(root, { trusted: true, timeoutMs: 120000 });
    const result = report.checks[0]!;
    assert.equal(result.status, "failed", JSON.stringify(result));
    assert.equal(result.findingsComplete, true, JSON.stringify(result));
    assert.ok(
      result.findings?.some(
        (f) =>
          f.ruleId.endsWith("/UnnecessarySafeCall") &&
          f.file === "Original.kt" &&
          f.line === 1,
      ),
      JSON.stringify(result.findings),
    );
    assert.ok(
      result.findings?.some(
        (f) =>
          f.ruleId === "kotlin/UNNECESSARY_SAFE_CALL" &&
          f.file === "Original.kt" &&
          f.line === 1,
      ),
    );
    assert.equal(
      await readFile(path.join(root, "Original.kt"), "utf8"),
      source,
    );
    await assert.rejects(access(path.join(root, "OriginalKt.class")));
    await writeFile(
      path.join(root, "Original.kt"),
      "fun originalNormalize(value: String): String = value.trim()\n",
    );
    const fixed = (await validate(root, { trusted: true, timeoutMs: 120000 }))
      .checks[0]!;
    assert.equal(fixed.status, "passed", JSON.stringify(fixed));
    assert.equal(fixed.findingsComplete, true);
  },
);
test(
  "full detekt preserves compiler errors without claiming complete rule coverage",
  options,
  async (t) => {
    const root = await original(
      t,
      "fun originalNormalize(value: String): UnknownType = unknownValue\n",
    );
    const result = (await validate(root, { trusted: true, timeoutMs: 120000 }))
      .checks[0]!;
    assert.equal(result.status, "failed", JSON.stringify(result));
    assert.equal(result.findingsComplete, false);
    assert.equal(
      result.findings?.filter(
        (f) =>
          f.ruleId === "kotlin/UNRESOLVED_REFERENCE" &&
          f.file === "Original.kt" &&
          f.line === 1 &&
          f.level === "error",
      ).length,
      2,
      JSON.stringify(result.findings),
    );
  },
);

test(
  "full detekt accepts nullable and annotation near misses but refuses resolved suppression aliases",
  options,
  async (t) => {
    const root = await original(
      t,
      '@SuppressAdditional("UNNECESSARY_SAFE_CALL")\nfun originalNormalize(value: String?): String? = value?.trim()\n',
    );
    await writeFile(
      path.join(root, "SuppressAdditional.kt"),
      "annotation class SuppressAdditional(val rule: String)\n",
    );
    const valid = (await validate(root, { trusted: true, timeoutMs: 120000 }))
      .checks[0]!;
    assert.equal(valid.status, "passed", JSON.stringify(valid));
    assert.equal(valid.findingsComplete, true);
    await writeFile(
      path.join(root, "Original.kt"),
      'import kotlin.Suppress as PolicySilence\n@PolicySilence("UNNECESSARY_SAFE_CALL")\nfun originalNormalize(value: String): String = value?.trim() ?: ""\n',
    );
    const hidden = (await validate(root, { trusted: true, timeoutMs: 120000 }))
      .checks[0]!;
    assert.equal(hidden.status, "inconclusive", JSON.stringify(hidden));
    assert.equal(hidden.findingsComplete, false);
  },
);
test(
  "full detekt rejects coherent type prerequisite provenance participation and freshness faults",
  options,
  async (t) => {
    const root = await original(
      t,
      "fun originalNormalize(value: String): String = value.trim()\n",
    );
    const check = (await createPlan(root)).plan.checks[0]!;
    const result = (await validate(root, { trusted: true, timeoutMs: 120000 }))
      .checks[0]!;
    assert.equal(result.status, "passed", JSON.stringify(result));
    const process = result.processes[0]!;
    const good = detektExtensionsEvidenceSchema.parse(
      JSON.parse(process.stdout),
    );
    type Packet = z.infer<typeof detektExtensionsEvidenceSchema>;
    const faults: Array<[string, (packet: Packet) => void]> = [
      [
        "native rule origin",
        (d) => {
          d.native!.rules[0]!.origin = "file:/unselected.jar";
        },
      ],
      [
        "native rule class",
        (d) => {
          d.native!.rules[0]!.className = "original.UnselectedRule";
        },
      ],
      [
        "analysis API rule marker",
        (d) => {
          d.native!.rules.find(
            (r) => r.requiresAnalysisApi,
          )!.requiresAnalysisApi = false;
        },
      ],
      [
        "missing type participation",
        (d) => {
          d.native!.typed.pop();
        },
      ],
      [
        "foreign type source",
        (d) => {
          d.native!.typed[0]!.file = "/foreign.kt";
        },
      ],
      [
        "missing declaration resolution",
        (d) => {
          d.native!.typed[0]!.symbols.pop();
        },
      ],
      [
        "non-source symbol",
        (d) => {
          d.native!.typed[0]!.symbols[0] = "LIBRARY";
        },
      ],
      [
        "unknown annotation",
        (d) => {
          d.native!.typed[0]!.unknownAnnotations = 1;
        },
      ],
      [
        "resolved suppression",
        (d) => {
          d.native!.typed[0]!.annotations.push("kotlin.Suppress");
        },
      ],
      [
        "missing SDK root",
        (d) => {
          for (const source of d.native!.typed) source.sdk.pop();
        },
      ],
      [
        "duplicate classpath root",
        (d) => {
          d.native!.typed[0]!.roots.push(d.native!.typed[0]!.roots[0]!);
        },
      ],
      [
        "missing classpath root",
        (d) => {
          d.native!.typed[0]!.roots[0] = "/unselected.jar";
        },
      ],
      [
        "coherent classpath declaration",
        (d) => {
          const old = d.classPath[0]!;
          d.classPath[0] = "/unselected.jar";
          for (const source of d.native!.typed)
            source.roots = source.roots.map((r) =>
              r === old ? "/unselected.jar" : r,
            );
        },
      ],
      [
        "coherent original hash",
        (d) => {
          d.sources[0]!.sha256 = "0".repeat(64);
          d.after[0]!.sha256 = "0".repeat(64);
          d.native!.sources[0]!.physicalBefore = "0".repeat(64);
          d.native!.sources[0]!.physicalAfter = "0".repeat(64);
        },
      ],
      [
        "coherent PSI hash",
        (d) => {
          d.sources[0]!.canonicalSha256 = "0".repeat(64);
          d.native!.sources[0]!.psiSha256 = "0".repeat(64);
        },
      ],
      [
        "native invocation raw hash",
        (d) => {
          d.invocations[2]!.stdoutSha256 = "0".repeat(64);
        },
      ],
    ];
    for (const [name, mutate] of faults) {
      const d = structuredClone(good);
      mutate(d);
      const stdout = JSON.stringify(d);
      const bytes =
        Buffer.byteLength(stdout) + Buffer.byteLength(process.stderr);
      const changed: ProcessResult = {
        ...process,
        stdout,
        outputBytes: bytes,
        capturedOutput: captureProcessOutput(
          Buffer.from(stdout),
          Buffer.from(process.stderr),
          bytes,
          true,
        ),
      };
      const parsed = detektExtensionsEvidence(check, [changed], root);
      assert.equal(parsed.status, "inconclusive", name);
      assert.equal(parsed.findingsComplete, false, name);
    }
    const displaced = structuredClone(good),
      foreignJar = "file:/unselected.jar";
    displaced.native!.rules.forEach((rule) => {
      rule.origin = foreignJar;
    });
    displaced.warningJarUrl = foreignJar;
    const nativeCall = displaced.invocations[2]!;
    nativeCall.stderr = nativeCall.stderr.replaceAll(
      good.warningJarUrl,
      foreignJar,
    );
    nativeCall.stderrBytes = Buffer.byteLength(nativeCall.stderr);
    nativeCall.stderrSha256 = detektHash(nativeCall.stderr);
    displaced.nativeOutput = captureProcessOutput(
      Buffer.from(nativeCall.stdout),
      Buffer.from(nativeCall.stderr),
      nativeCall.stdoutBytes + nativeCall.stderrBytes,
      true,
    );
    const displacedStderr = process.stderr.replaceAll(
      good.warningJarUrl,
      foreignJar,
    );
    displaced.mirrored = captureProcessOutput(
      Buffer.alloc(0),
      Buffer.from(displacedStderr),
      Buffer.byteLength(displacedStderr),
      true,
    );
    const displacedStdout = JSON.stringify(displaced),
      displacedBytes =
        Buffer.byteLength(displacedStdout) + Buffer.byteLength(displacedStderr);
    assert.equal(
      detektExtensionsEvidence(
        check,
        [
          {
            ...process,
            stdout: displacedStdout,
            stderr: displacedStderr,
            outputBytes: displacedBytes,
            capturedOutput: captureProcessOutput(
              Buffer.from(displacedStdout),
              Buffer.from(displacedStderr),
              displacedBytes,
              true,
            ),
          },
        ],
        root,
      ).status,
      "inconclusive",
      "Coherent foreign rule origins and warning captures cannot replace the selected staged JAR",
    );
    await writeFile(
      path.join(root, "Original.kt"),
      "fun originalNormalize(value: String): String = value.uppercase()\n",
    );
    assert.equal(
      detektExtensionsEvidence(check, [process], root).status,
      "inconclusive",
      "Current source must still match",
    );
  },
);
