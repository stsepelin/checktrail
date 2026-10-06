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
async function fixture(t: Parameters<typeof swiftToolsFixture>[0]) {
  const { root, config } = await swiftToolsFixture(t, ["swift.test"]);
  config.tests.framework = "swift-testing";
  await writeFile(
    path.join(root, "checktrail.swift-tools.json"),
    JSON.stringify(config),
  );
  const source = `import Testing\n@testable import OriginalQuantity\n@Test(arguments: [(-1, 0), (2, 3)]) func originalBoundaries(input: Int, expected: Int) { #expect(nextQuantity(input) == expected) }\n@Test func originalSingle() { #expect(nextQuantity(-1) == originalExpectedZero()) }\n`;
  const file = path.join(
    root,
    "Tests/OriginalQuantityTests/QuantityTests.swift",
  );
  await writeFile(file, source);
  return { root, file, source };
}
test(
  "native Swift Testing binds macro source methods and parameter cases with regression repair disabled and empty-case accounting",
  swiftToolsNative,
  async (t) => {
    const { root, file, source } = await fixture(t);
    const passed = await run(root);
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.deepEqual(passed.checks[0]!.tests, {
      total: 3,
      passed: 3,
      failed: 0,
      skipped: 0,
    });
    const production = path.join(
        root,
        "Sources/OriginalQuantity/Quantity.swift",
      ),
      original = await readFile(production, "utf8");
    await writeFile(production, original.replace("value + 1", "value"));
    const failed = await run(root);
    assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
    assert.deepEqual(failed.checks[0]!.tests, {
      total: 3,
      passed: 0,
      failed: 3,
      skipped: 0,
    });
    assert.equal(failed.checks[0]!.findings?.length, 3);
    assert.ok(
      failed.checks[0]!.findings!.every(
        (f) =>
          f.file === "Tests/OriginalQuantityTests/QuantityTests.swift" &&
          [3, 4].includes(f.line!),
      ),
    );
    await writeFile(production, original);
    assert.equal((await run(root)).outcome, "passed");
    await writeFile(
      file,
      source +
        '@Test(.disabled("original disabled")) func originalDisabled() { #expect(nextQuantity(2) == 3) }\n',
    );
    const skipped = await run(root);
    assert.equal(skipped.outcome, "incomplete", JSON.stringify(skipped.checks));
    assert.deepEqual(skipped.checks[0]!.tests, {
      total: 4,
      passed: 3,
      failed: 0,
      skipped: 1,
    });
    await writeFile(
      file,
      source.replace("[(-1, 0), (2, 3)]", "[(Int, Int)]()"),
    );
    assert.equal((await run(root)).outcome, "incomplete");
    await writeFile(
      file,
      '#sourceLocation(file: "original-virtual.swift", line: 100)\n' + source,
    );
    assert.equal((await run(root)).outcome, "incomplete");
  },
);
test(
  "native Swift Testing event source IDs case lifecycles XML methods and issues cannot be forged into passing evidence",
  swiftToolsNative,
  async (t) => {
    const { root } = await fixture(t),
      check = (await createPlan(root)).plan.checks[0]!,
      report = await run(root),
      process = report.checks[0]!.processes[0]!;
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    const original = swiftToolsPacketSchema.parse(JSON.parse(process.stdout));
    const reject = (edit: (p: typeof original) => void) => {
      const packet = structuredClone(original);
      edit(packet);
      assert.equal(
        swiftToolsEvidence(check, [
          { ...process, stdout: JSON.stringify(packet) },
        ]).status,
        "inconclusive",
      );
    };
    const stream = (
      p: typeof original,
      edit: (rows: Record<string, unknown>[]) => void,
    ) => {
      const artifact = p.artifacts.find((a) => a.path === "events.jsonl")!,
        rows = artifact.text
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line));
      edit(rows);
      artifact.text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
      artifact.sha256 = mavenHash(artifact.text);
    };
    reject((p) => {
      p.artifacts[0]!.sha256 = "0".repeat(64);
    });
    reject((p) =>
      stream(p, (rows) => {
        const r = rows.find((r) => r.kind === "test")!.payload as {
          sourceLocation: { column: number };
        };
        r.sourceLocation.column++;
      }),
    );
    reject((p) =>
      stream(p, (rows) => {
        const r = rows.find((r) => r.kind === "test")!.payload as {
          _testCases: unknown[];
        };
        r._testCases = [];
      }),
    );
    reject((p) =>
      stream(p, (rows) => {
        const index = rows.findIndex(
          (r) => (r.payload as { kind: string }).kind === "testCaseEnded",
        );
        rows.splice(index, 1);
      }),
    );
    reject((p) =>
      stream(p, (rows) => {
        const index = rows.findIndex(
          (r) => (r.payload as { kind: string }).kind === "testCaseStarted",
        );
        rows.splice(index, 1);
      }),
    );
    reject((p) =>
      stream(p, (rows) => {
        rows.pop();
      }),
    );
    reject((p) => {
      const artifact = p.artifacts.find((a) => a.path === "results.xml")!;
      artifact.text = artifact.text.replace('tests="2"', 'tests="3"');
      artifact.sha256 = mavenHash(artifact.text);
    });
    reject((p) => {
      const row = p.receipts.find(
        (r) =>
          r.phase === "ast:Tests/OriginalQuantityTests/QuantityTests.swift",
      )!;
      row.stdout = row.stdout.replace(
        'macro="Testing.(file).Test(',
        'macro="Testing.(file).TestNearMiss(',
      );
      row.stdoutSha256 = mavenHash(row.stdout);
    });
  },
);
