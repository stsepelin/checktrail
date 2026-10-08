import assert from "node:assert/strict";
import { access, writeFile, mkdir, symlink } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { createPlan, validate } from "../src/engine.js";
import {
  kotlinFixture,
  nativeOptions,
  fixedKotlin,
  kotlinConfig,
} from "./kotlin-fixture.js";
test(
  "native Kotlin observes exact resolved file function expression type import alias and typealias suppressions",
  nativeOptions,
  async (t) => {
    const root = await kotlinFixture(t);
    const cases = [
      '@file:Suppress("UNSAFE_CALL")\nfun originalLength(value:String?):Int=value.length\n',
      '@Suppress("UNSAFE_CALL")\nfun originalLength(value:String?):Int=value.length\n',
      'fun originalLength(value:String?):Int { @Suppress("UNUSED_EXPRESSION") "discarded";return value?.length ?: 0 }\n',
      'fun originalLength(value:String?):@Suppress("UNUSED") Int=value?.length ?: 0\n',
      '@file:Quiet("UNSAFE_CALL")\nimport kotlin.Suppress as Quiet\nfun originalLength(value:String?):Int=value.length\n',
      'typealias OriginalQuiet=kotlin.Suppress\n@OriginalQuiet("UNSAFE_CALL")\nfun originalLength(value:String?):Int=value.length\n',
    ];
    for (const source of cases) {
      await writeFile(path.join(root, "Original.kt"), source);
      const report = await validate(root, { trusted: true });
      assert.equal(
        report.checks[0]!.status,
        "inconclusive",
        JSON.stringify(report.checks),
      );
      assert.equal(report.checks[0]!.findingsComplete, false);
      const data = JSON.parse(report.checks[0]!.processes[0]!.stdout);
      assert.ok(
        data.native.sources.some((s: { annotations: string[] }) =>
          s.annotations.includes("kotlin.Suppress"),
        ),
      );
    }
  },
);
test(
  "native Kotlin retains partial syntax failures empty files and unexecuted initializers without inventing complete diagnostics",
  nativeOptions,
  async (t) => {
    const root = await kotlinFixture(t, {
      "Original.kt": "fun originalLength(\n",
    });
    let report = await validate(root, { trusted: true });
    assert.equal(
      report.checks[0]!.status,
      "failed",
      JSON.stringify(report.checks),
    );
    assert.equal(report.checks[0]!.findingsComplete, false);
    assert.ok(report.checks[0]!.findings!.some((f) => f.level === "error"));
    await writeFile(
      path.join(root, "Original.kt"),
      'object NeverRun { init { java.nio.file.Files.writeString(java.nio.file.Path.of("executed"),"never execute") } }\n' +
        fixedKotlin,
    );
    await writeFile(path.join(root, "Empty.kt"), "");
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, true);
    await assert.rejects(access(path.join(root, "executed")), {
      code: "ENOENT",
    });
    await writeFile(path.join(root, "Original.kt"), Buffer.from([255]));
    report = await validate(root, { trusted: true });
    assert.notEqual(report.outcome, "passed");
    assert.equal(report.checks[0]!.findingsComplete, false);
  },
);
test(
  "native Kotlin rejects changed artifacts bounded source escapes and unsupported mixed source scope",
  nativeOptions,
  async (t) => {
    const root = await kotlinFixture(t);
    await writeFile(path.join(root, "Other.java"), "class Other {}");
    let check = (await createPlan(root)).plan.checks[0]!;
    assert.equal(check.commands.length, 0);
    assert.match(check.unavailableReason!, /Mixed JVM/);
    const separate = await kotlinFixture(t);
    await writeFile(
      path.join(separate, kotlinConfig.archive),
      Buffer.from("not the pinned compiler"),
    );
    check = (await createPlan(separate)).plan.checks[0]!;
    assert.equal(check.commands.length, 0);
    assert.ok(check.unavailableReason);
    const large = await kotlinFixture(t);
    await writeFile(
      path.join(large, "Original.kt"),
      " ".repeat(1024 * 1024 + 1),
    );
    const report = await validate(large, { trusted: true });
    assert.notEqual(report.outcome, "passed");
    assert.equal(report.checks[0]!.findingsComplete, false);
    const linked = await kotlinFixture(t);
    await mkdir(path.join(linked, "outside"));
    await writeFile(path.join(linked, "outside/Real.kt"), fixedKotlin);
    await symlink("outside/Real.kt", path.join(linked, "Linked.kt"));
    const plan = (await createPlan(linked)).plan;
    assert.ok(plan.checks.every((c) => !c.scope.includes("Linked.kt")));
  },
);
