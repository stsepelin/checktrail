import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { validate } from "../src/engine.js";
import { rubyToolsFixture } from "./ruby-tools-fixture.js";
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
export async function lifecycle(t: TestContext, mode: "rspec" | "minitest") {
  const { root } = await rubyToolsFixture(t, [`ruby.${mode}`]),
    file = path.join(
      root,
      mode === "rspec" ? "spec/quantity_spec.rb" : "test/quantity_test.rb",
    ),
    original = await readFile(file, "utf8");
  for (const [source, status] of [
    ["# no registered test\n", "incomplete"],
    [
      mode === "rspec"
        ? original.replace('it("advances', 'xit("advances')
        : original
            .replace(
              "assert_equal 0,",
              'skip "original pending"\n    assert_equal 0,',
            )
            .replace(
              "assert_equal 3,",
              'skip "original pending"\n    assert_equal 3,',
            ),
      "incomplete",
    ],
    [
      mode === "rspec"
        ? "RSpec.configure { |c| c.filter_run_including original_hidden: true }\n" +
          original
        : original.replace(
            "class OriginalQuantityTest < Minitest::Test",
            'class OriginalQuantityTest < Minitest::Test\n  def setup; raise "original setup error"; end',
          ),
      mode === "rspec" ? "incomplete" : "failed",
    ],
    [
      mode === "rspec"
        ? 'RSpec.configure { |c| c.before(:suite) { raise "original suite error" } }\n' +
          original
        : original.replace(
            "class OriginalQuantityTest < Minitest::Test",
            'class OriginalQuantityTest < Minitest::Test\n  def teardown; raise "original teardown error"; end',
          ),
      mode === "rspec" ? "incomplete" : "failed",
    ],
  ]) {
    await writeFile(file, source!);
    const report = await run(root);
    assert.equal(report.outcome, status, JSON.stringify(report.checks));
  }
  if (mode === "rspec") {
    await writeFile(
      file,
      'RSpec.configure { |c| c.before(:context) { raise "original context setup error" } }\n' +
        original,
    );
    const setup = await run(root);
    assert.equal(setup.outcome, "failed", JSON.stringify(setup.checks));
    assert.deepEqual(setup.checks[0]!.tests, {
      total: 2,
      passed: 0,
      failed: 2,
      skipped: 0,
    });
  }
  await writeFile(file, original);
  assert.equal((await run(root)).outcome, "passed");
  if (mode === "minitest") {
    const marker = path.join(root, ".checktrail/after-run");
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: ".",
            checks: ["ruby.minitest"],
            environment: ["CHECKTRAIL_RUBY_AFTER"],
          },
        ],
      }),
    );
    await writeFile(
      file,
      original +
        '\nMinitest.after_run { File.write(ENV.fetch("CHECKTRAIL_RUBY_AFTER"), "original native after-run hook") }\n',
    );
    const after = await validate(root, {
      trusted: true,
      timeoutMs: 120000,
      environment: { CHECKTRAIL_RUBY_AFTER: marker },
    });
    assert.equal(after.outcome, "passed", JSON.stringify(after.checks));
    assert.equal(
      await readFile(marker, "utf8"),
      "original native after-run hook",
    );
    await writeFile(
      file,
      original +
        '\nMinitest.after_run { raise "original after-run failure" }\n',
    );
    assert.equal((await run(root)).outcome, "incomplete");
  }
}
