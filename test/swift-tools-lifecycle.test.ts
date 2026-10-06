import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { validate, createPlan } from "../src/engine.js";
import { runProcess } from "../src/runner.js";
import { swiftToolsFixture, swiftToolsNative } from "./swift-tools-fixture.js";
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
test(
  "native Swift XCTest empty skipped setup and teardown cases preserve complete lifecycle accounting",
  swiftToolsNative,
  async (t) => {
    const { root } = await swiftToolsFixture(t, ["swift.test"]),
      file = path.join(root, "Tests/OriginalQuantityTests/QuantityTests.swift"),
      original = await readFile(file, "utf8");
    await writeFile(
      file,
      "import XCTest\n@testable import OriginalQuantity\nfinal class OriginalQuantityTests: XCTestCase {}\n",
    );
    assert.equal((await run(root)).outcome, "incomplete");
    await writeFile(
      file,
      original.replace(
        "func testZeroBoundary() {",
        'func testZeroBoundary() throws { try XCTSkipIf(true, "original skip");',
      ),
    );
    const skipped = await run(root);
    assert.equal(skipped.outcome, "incomplete");
    assert.deepEqual(skipped.checks[0]!.tests, {
      total: 2,
      passed: 1,
      failed: 0,
      skipped: 1,
    });
    for (const hook of ["setUp", "tearDown"]) {
      await writeFile(
        file,
        original.replace(
          "final class OriginalQuantityTests: XCTestCase {",
          `final class OriginalQuantityTests: XCTestCase {\n    override func ${hook}() { XCTFail("original lifecycle failure") }`,
        ),
      );
      const failed = await run(root);
      assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
      assert.deepEqual(failed.checks[0]!.tests, {
        total: 2,
        passed: 0,
        failed: 2,
        skipped: 0,
      });
      assert.equal(failed.checks[0]!.findings?.length, 2);
      assert.ok(failed.checks[0]!.findings!.every((f) => f.line === 4));
    }
    await writeFile(file, original);
    assert.equal((await run(root)).outcome, "passed");
  },
);
test(
  "native Swift protects startup filters and refuses stale copied source omitted manifest scope and unaudited inline suppression",
  swiftToolsNative,
  async (t) => {
    const { root } = await swiftToolsFixture(t, ["swift.test"]),
      protectedKeys = [
        "SWIFT_EXEC",
        "SWIFTPM_BUILD_DIR",
        "SDKROOT",
        "DEVELOPER_DIR",
        "SWIFT_TEST_FILTER",
        "SWIFT_TESTING_DISABLE",
      ],
      previous = new Map(protectedKeys.map((k) => [k, process.env[k]]));
    try {
      for (const key of protectedKeys)
        process.env[key] = "--original-invalid-option";
      const passed = await run(root);
      assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
      assert.deepEqual(passed.checks[0]!.tests, {
        total: 2,
        passed: 2,
        failed: 0,
        skipped: 0,
      });
    } finally {
      for (const [key, value] of previous)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    const plan = (await createPlan(root)).plan,
      source = path.join(root, "Sources/OriginalQuantity/Quantity.swift"),
      original = await readFile(source, "utf8");
    await writeFile(source, original + "// changed after planning\n");
    const stale = await runProcess(root, plan.checks[0]!.commands[0]!, {
      timeoutMs: 120000,
    });
    assert.equal(stale.exitCode, 2);
    assert.equal(stale.stdout, "");
    assert.match(stale.stderr, /Swift source changed/);
    await writeFile(source, original);
    const testFile = path.join(
        root,
        "Tests/OriginalQuantityTests/QuantityTests.swift",
      ),
      body = await readFile(testFile, "utf8");
    await writeFile(
      testFile,
      "import Foundation\n" +
        body.replace(
          "func testZeroBoundary() {",
          'func testZeroBoundary() { try! "original changed copied source".write(toFile: #filePath, atomically: true, encoding: .utf8);',
        ),
    );
    const copied = await run(root);
    assert.equal(copied.outcome, "incomplete");
    assert.equal(copied.sourceChanged, false);
    assert.match(
      copied.checks[0]!.processes[0]!.stderr,
      /Swift source changed/,
    );
    await writeFile(testFile, body);
    const manifest = path.join(root, "Package.swift"),
      text = await readFile(manifest, "utf8");
    await writeFile(
      manifest,
      text.replace(
        '.target(name: "OriginalQuantity")',
        '.target(name: "OriginalQuantity", exclude: ["Quantity.swift"])',
      ),
    );
    const omitted = await run(root);
    assert.equal(omitted.outcome, "incomplete");
    assert.equal(omitted.checks[0]!.processes[0]!.stdout, "");
    await writeFile(manifest, text);
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["swift.swiftlint"] }],
      }),
    );
    await writeFile(
      source,
      original + "// swiftlint:disable force_unwrapping\n",
    );
    const suppressed = await run(root);
    assert.equal(suppressed.outcome, "incomplete");
    assert.match(
      suppressed.checks[0]!.processes[0]!.stderr,
      /Swift inline lint directives/,
    );
  },
);
