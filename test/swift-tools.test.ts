import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { validate, createPlan } from "../src/engine.js";
import { swiftToolsFixture, swiftToolsNative } from "./swift-tools-fixture.js";
import {
  swiftToolsEvidence,
  swiftToolsPacketSchema,
} from "../src/swift-tools-evidence.js";
import { mavenHash } from "../src/maven.js";
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
test(
  "native Swift build and XCTest bind complete compiler scope and two callbacks across support files with regression and repair",
  swiftToolsNative,
  async (t) => {
    const { root } = await swiftToolsFixture(t, ["swift.build", "swift.test"]);
    const passed = await run(root);
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.deepEqual(passed.checks[1]!.tests, {
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
    });
    assert.equal(passed.sourceChanged, false);
    const file = path.join(root, "Sources/OriginalQuantity/Quantity.swift"),
      original = await readFile(file, "utf8");
    const broken = original.replace("value + 1", "value");
    assert.notEqual(broken, original);
    await writeFile(file, broken);
    const failed = await run(root);
    assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
    assert.equal(failed.checks[0]!.status, "passed");
    assert.deepEqual(failed.checks[1]!.tests, {
      total: 2,
      passed: 0,
      failed: 2,
      skipped: 0,
    });
    assert.equal(failed.checks[1]!.findings?.length, 2);
    assert.deepEqual(
      failed.checks[1]!.findings?.map((f) => f.line).sort(),
      [4, 5],
    );
    assert.ok(
      failed.checks[1]!.findings!.every(
        (f) => f.file === "Tests/OriginalQuantityTests/QuantityTests.swift",
      ),
    );
    await writeFile(file, original);
    assert.equal((await run(root)).outcome, "passed");
    await writeFile(file, original.replace("value + 1", '"wrong type"'));
    const compileError = await run(root);
    assert.equal(
      compileError.outcome,
      "failed",
      JSON.stringify(compileError.checks),
    );
    assert.ok(
      compileError.checks.every(
        (c) =>
          c.status === "failed" &&
          c.findings?.some(
            (f) =>
              f.file === "Sources/OriginalQuantity/Quantity.swift" &&
              f.line === 1 &&
              f.level === "error",
          ),
      ),
    );
  },
);
test(
  "native SwiftLint explicit rules reconcile every source and expose forced unwrap diagnostics with literal near miss and repair",
  swiftToolsNative,
  async (t) => {
    const { root } = await swiftToolsFixture(t, ["swift.swiftlint"]);
    await writeFile(
      path.join(root, ".swiftlint.yml"),
      "excluded: [Sources, Tests]\n",
    );
    const passed = await run(root);
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    const check = (await createPlan(root)).plan.checks[0]!,
      process = passed.checks[0]!.processes[0]!,
      packet = swiftToolsPacketSchema.parse(JSON.parse(process.stdout));
    const progress = (edit: (stderr: string) => string) => {
      const changed = structuredClone(packet),
        row = changed.receipts.find((r) => r.phase === "swiftlint")!;
      row.stderr = edit(row.stderr);
      row.stderrSha256 = mavenHash(row.stderr);
      return swiftToolsEvidence(check, [
        { ...process, stdout: JSON.stringify(changed) },
      ]).status;
    };
    // Concurrent SwiftLint visits allocate unique counters before queuing output.
    assert.equal(
      progress((text) => {
        const lines = text.trimEnd().split("\n"),
          visits = lines.filter((line) => line.startsWith("Linting '"));
        assert.equal(visits.length, 3);
        visits.reverse();
        return (
          lines
            .map((line) =>
              line.startsWith("Linting '") ? visits.shift()! : line,
            )
            .join("\n") + "\n"
        );
      }),
      "passed",
      "Complete concurrent lint progress may arrive out of order",
    );
    assert.equal(
      progress((text) => text.replace(/\([0-9]+\/3\)/g, "(1/3)")),
      "inconclusive",
      "Duplicate native progress counters cannot prove participation",
    );
    assert.equal(
      progress((text) => text.replace(/\([0-9]+\/3\)/, "(4/3)")),
      "inconclusive",
    );
    assert.equal(
      progress((text) =>
        text
          .split("\n")
          .filter((line) => !line.startsWith("Linting 'TestSupport.swift'"))
          .join("\n"),
      ),
      "inconclusive",
    );
    assert.equal(
      progress((text) => text.replace(/\([0-9]+\/3\)/, "(1/4)")),
      "inconclusive",
    );
    const file = path.join(root, "Sources/OriginalQuantity/Quantity.swift"),
      original = await readFile(file, "utf8");
    await writeFile(
      file,
      original +
        "public func originalUnwrap(_ value: Int?) -> Int { value! }\n",
    );
    const failed = await run(root);
    assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
    assert.deepEqual(
      failed.checks[0]!.findings?.map((f) => ({
        rule: f.ruleId,
        file: f.file,
        line: f.line,
      })),
      [
        {
          rule: "swift.swiftlint.force_unwrapping",
          file: "Sources/OriginalQuantity/Quantity.swift",
          line: 3,
        },
      ],
    );
    await writeFile(
      file,
      original +
        "// public func originalUnwrap(_ value: Int?) -> Int { value! }\n",
    );
    assert.equal((await run(root)).outcome, "passed");
  },
);
test(
  "native Swift evidence rejects forged runtime source scope commands compiler callbacks counters and artifact identities",
  swiftToolsNative,
  async (t) => {
    const { root } = await swiftToolsFixture(t, ["swift.test"]),
      plan = (await createPlan(root)).plan,
      report = await run(root),
      check = plan.checks[0]!,
      result = report.checks[0]!.processes[0]!;
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    const original = swiftToolsPacketSchema.parse(JSON.parse(result.stdout));
    const reject = (edit: (packet: typeof original) => void) => {
      const packet = structuredClone(original);
      edit(packet);
      assert.equal(
        swiftToolsEvidence(check, [
          { ...result, stdout: JSON.stringify(packet) },
        ]).status,
        "inconclusive",
      );
    };
    const data = (
      packet: typeof original,
      phase: string,
      edit: (text: string) => string,
    ) => {
      const row = packet.receipts.find((r) => r.phase === phase)!;
      row.stdout = edit(row.stdout);
      row.stdoutSha256 = mavenHash(row.stdout);
    };
    reject((p) => {
      p.inputSha256 = "0".repeat(64);
    });
    reject((p) => {
      p.optionsSha256 = "0".repeat(64);
    });
    reject((p) => {
      p.tools[0]!.afterSha256 = "0".repeat(64);
    });
    reject((p) => {
      p.receipts[0]!.stdoutSha256 = "0".repeat(64);
    });
    reject((p) => {
      p.receipts[0]!.args.push("--filter");
    });
    reject((p) => {
      p.receipts.at(-1)!.exitCode = 1;
    });
    reject((p) => data(p, "swift-version", (s) => s.replace("6.2.3", "6.2.4")));
    reject((p) =>
      data(p, "describe", (s) => {
        const d = JSON.parse(s);
        d.targets[0].sources = [];
        return JSON.stringify(d);
      }),
    );
    reject((p) =>
      data(p, "manifest", (s) => {
        const d = JSON.parse(s);
        d.targets[0].exclude = ["Quantity.swift"];
        return JSON.stringify(d);
      }),
    );
    reject((p) =>
      data(p, "build", (s) =>
        s
          .split("\n")
          .filter((l) => !l.includes("-primary-file"))
          .join("\n"),
      ),
    );
    reject((p) =>
      data(p, "list", (s) =>
        s
          .split("\n")
          .filter((l) => !l.endsWith("/testZeroBoundary"))
          .join("\n"),
      ),
    );
    reject((p) =>
      data(p, "ast:Tests/OriginalQuantityTests/QuantityTests.swift", (s) =>
        s.replace('"testZeroBoundary()"', '"renamedBoundary()"'),
      ),
    );
    reject((p) =>
      data(p, "test", (s) =>
        s.replace(" Executed 2 tests", " Executed 0 tests"),
      ),
    );
    reject((p) =>
      data(p, "test", (s) =>
        s.replace("testZeroBoundary' passed", "testZeroBoundary' skipped"),
      ),
    );
    reject((p) => {
      p.receipts.push(p.receipts.at(-1)!);
    });
  },
);
