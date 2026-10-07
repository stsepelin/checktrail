import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { validate, createPlan } from "../src/engine.js";
import { cppToolsFixture, cppToolsNative } from "./cpp-tools-fixture.js";
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
test("C/C++ planning is data only and rejects undeclared CMake commands and missing source scope", async (t) => {
  const { root } = await cppToolsFixture(t, ["cpp.build"]);
  const initial = await createPlan(root);
  assert.equal(initial.plan.checks[0]!.unavailableReason, undefined);
  await writeFile(
    path.join(root, "CMakeLists.txt"),
    "execute_process(COMMAND deliberately-must-not-run)\n",
  );
  const invalid = await createPlan(root);
  assert.ok(invalid.plan.checks[0]!.unavailableReason);
  assert.deepEqual(invalid.plan.checks[0]!.commands, []);
});
test(
  "native C/C++ build and CTest bind generated headers and both linked callbacks with regression and repair",
  cppToolsNative,
  async (t) => {
    const { root } = await cppToolsFixture(t, ["cpp.build", "cpp.ctest"]);
    const passed = await run(root);
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.deepEqual(passed.checks[1]!.tests, {
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
    });
    assert.equal(passed.sourceChanged, false);
    const file = path.join(root, "src/range.c"),
      original = await readFile(file, "utf8");
    const broken = original.replace("value + ORIGINAL_STEP", "value");
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
    assert.ok(
      failed.checks[1]!.findings!.every(
        (f) =>
          f.file === "CMakeLists.txt" &&
          f.message.includes("does not identify its failing assertion"),
      ),
    );
    await writeFile(file, original);
    assert.equal((await run(root)).outcome, "passed");
    await writeFile(
      file,
      original.replace("value + ORIGINAL_STEP", '"wrong type"'),
    );
    const compiler = await run(root);
    assert.equal(compiler.outcome, "failed", JSON.stringify(compiler.checks));
    assert.ok(
      compiler.checks.every(
        (c) =>
          c.status === "failed" &&
          c.findings?.some(
            (f) =>
              f.file === "src/range.c" && f.line === 3 && f.level === "error",
          ),
      ),
    );
  },
);
test(
  "native clang-format checks every declared source and header and detects replacement XML despite exit zero",
  cppToolsNative,
  async (t) => {
    const { root } = await cppToolsFixture(t, ["cpp.clang-format"]);
    const passed = await run(root);
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    const file = path.join(root, "src/range.c"),
      original = await readFile(file, "utf8");
    await writeFile(
      file,
      original.replace("value + ORIGINAL_STEP", "value+ORIGINAL_STEP"),
    );
    const failed = await run(root);
    assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
    assert.ok(
      failed.checks[0]!.findings?.some(
        (f) => f.file === "src/range.c" && f.line === 3,
      ),
    );
    await writeFile(file, original);
    assert.equal((await run(root)).outcome, "passed");
  },
);
test(
  "native clang-tidy binds compiled units and exposes use after move with a valid repair",
  cppToolsNative,
  async (t) => {
    const { root } = await cppToolsFixture(t, ["cpp.clang-tidy"]);
    const file = path.join(root, "src/range.cpp"),
      original = await readFile(file, "utf8");
    const appendix =
      "\n#include <utility>\nstruct OriginalValue { unsigned size() const { return 3; } };\nunsigned original_moved_size() { OriginalValue text;OriginalValue moved=std::move(text);return text.size(); }\n";
    await writeFile(file, original + appendix);
    const failed = await run(root);
    assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
    assert.ok(
      failed.checks[0]!.findings?.some(
        (f) =>
          f.ruleId === "clang-tidy/bugprone-use-after-move" &&
          f.file === "src/range.cpp" &&
          f.line === 7,
      ),
    );
    await writeFile(
      file,
      original +
        appendix.replace(
          "return text.size();",
          "text=OriginalValue{};return text.size();",
        ),
    );
    assert.equal((await run(root)).outcome, "passed");
  },
);

test(
  "native clang-tidy selected division rule detects its defect and accepts a nonzero repair",
  cppToolsNative,
  async (t) => {
    const { root } = await cppToolsFixture(t, ["cpp.clang-tidy"]);
    const file = path.join(root, "src/range.c"),
      original = await readFile(file, "utf8");
    const appendix =
      "\nint original_divided(void) { int denominator = 0; return 7 / denominator; }\n";
    await writeFile(file, original + appendix);
    const failed = await run(root);
    assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
    assert.ok(
      failed.checks[0]!.findings?.some(
        (f) =>
          f.ruleId === "clang-tidy/clang-analyzer-core.DivideZero" &&
          f.file === "src/range.c" &&
          f.line === 5,
      ),
    );
    await writeFile(
      file,
      original + appendix.replace("denominator = 0", "denominator = 2"),
    );
    assert.equal((await run(root)).outcome, "passed");
  },
);
