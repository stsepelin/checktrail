import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { validate } from "../src/engine.js";
import { rubyToolsFixture } from "./ruby-tools-fixture.js";
const available =
  !!process.env.CHECKTRAIL_RUBY_TOOLS_CACHE &&
  /^ruby 4\.0\.7 /.test(
    spawnSync("ruby", ["--disable-gems", "--version"], { encoding: "utf8" })
      .stdout || "",
  );
const native = {
  skip: available
    ? false
    : "Pinned Ruby runtime and dependency cache not selected",
  timeout: 600000,
};
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
test(
  "native Ruby RSpec and Minitest register scale boundaries bind callbacks and expose production regressions with repair",
  native,
  async (t) => {
    for (const mode of ["rspec", "minitest"]) {
      const { root } = await rubyToolsFixture(t, [`ruby.${mode}`]);
      const passed = await run(root);
      assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
      assert.deepEqual(passed.checks[0]!.tests, {
        total: 2,
        passed: 2,
        failed: 0,
        skipped: 0,
      });
      const source = path.join(root, "lib/quantity.rb"),
        original = await readFile(source, "utf8");
      const broken = original.replace("value + 1", "value");
      assert.notEqual(broken, original);
      await writeFile(source, broken);
      const failed = await run(root);
      assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
      assert.deepEqual(failed.checks[0]!.tests, {
        total: 2,
        passed: 0,
        failed: 2,
        skipped: 0,
      });
      const expected =
        mode === "rspec" ? "spec/quantity_spec.rb" : "test/quantity_test.rb";
      assert.equal(failed.checks[0]!.findings?.length, 2);
      assert.ok(
        failed.checks[0]!.findings!.every(
          (f) => f.file === expected && f.line! > 0,
        ),
      );
      await writeFile(source, original);
      assert.equal((await run(root)).outcome, "passed");
    }
  },
);
