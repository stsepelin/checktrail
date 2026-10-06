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
  "native Ruby RuboCop inspects exact files catches source diagnostics and leaves literal near misses clean",
  native,
  async (t) => {
    const { root } = await rubyToolsFixture(t, ["ruby.rubocop"]);
    await writeFile(
      path.join(root, ".rubocop.yml"),
      'AllCops:\n  Exclude:\n    - "**/*"\n',
    );
    const passed = await run(root);
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.equal(passed.sourceChanged, false);
    assert.equal(passed.checks[0]!.findings, undefined);
    const source = path.join(root, "lib/quantity.rb"),
      original = await readFile(source, "utf8");
    const broken = original.replace(
      "value + 1",
      "unused_original = 42\n    value + 1",
    );
    assert.notEqual(broken, original);
    await writeFile(source, broken);
    const failed = await run(root);
    assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
    assert.ok(
      failed.checks[0]!.findings?.some(
        (f) =>
          f.ruleId === "ruby.rubocop.Lint/UselessAssignment" &&
          f.file === "lib/quantity.rb" &&
          f.line === 5,
      ),
    );
    await writeFile(
      source,
      original + "\n# unused_original = 42 is literal prose\n",
    );
    assert.equal((await run(root)).outcome, "passed");
  },
);
