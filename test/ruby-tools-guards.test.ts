import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { validate, createPlan } from "../src/engine.js";
import { rubyToolsEvidence } from "../src/ruby-tools-evidence.js";
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
  timeout: 300000,
};
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
test(
  "native Ruby protected startup ignores host filters and refuses stale source and changed dependency archives",
  native,
  async (t) => {
    for (const mode of ["rubocop", "rspec", "minitest"]) {
      const { root, config } = await rubyToolsFixture(t, [`ruby.${mode}`]);
      const previous = new Map(
        [
          "RUBYOPT",
          "RUBYLIB",
          "SPEC_OPTS",
          "RUBOCOP_OPTS",
          "BUNDLE_WITHOUT",
          "BUNDLE_DISABLE_CHECKSUM_VALIDATION",
        ].map((k) => [k, process.env[k]]),
      );
      try {
        for (const key of previous.keys())
          process.env[key] =
            key === "BUNDLE_DISABLE_CHECKSUM_VALIDATION"
              ? "true"
              : "--original-invalid-option";
        const report = await run(root);
        assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
        if (mode !== "rubocop") {
          const file = path.join(
              root,
              mode === "rspec"
                ? "spec/quantity_spec.rb"
                : "test/quantity_test.rb",
            ),
            original = await readFile(file, "utf8");
          const gem = mode === "rspec" ? "rspec-core" : "minitest",
            entry =
              mode === "rspec" ? "lib/rspec/core/runner.rb" : "lib/minitest.rb";
          await writeFile(
            file,
            original +
              `\nat_exit { File.write(File.join(Gem.loaded_specs.fetch("${gem}").full_gem_path, "${entry}"), "original changed native tool bytes") }\n`,
          );
          try {
            const changed = await run(root);
            assert.equal(changed.outcome, "incomplete");
            assert.equal(
              changed.checks[0]!.processes[0]!.exitCode,
              2,
              "Collector must reject changed gem bytes before emitting evidence",
            );
            assert.equal(changed.checks[0]!.processes[0]!.stdout, "");
            assert.equal(changed.sourceChanged, false);
          } finally {
            await writeFile(file, original);
          }
        }
      } finally {
        for (const [key, value] of previous)
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
      }
      const plan = (await createPlan(root)).plan,
        command = plan.checks[0]!.commands[0]!;
      await writeFile(
        path.join(root, "lib/quantity.rb"),
        "# changed since planning\n",
      );
      const { runProcess } = await import("../src/runner.js");
      const result = await runProcess(root, command, { timeoutMs: 120000 });
      assert.equal(result.exitCode, 2);
      assert.equal(
        rubyToolsEvidence(plan.checks[0]!, [result]).status,
        "inconclusive",
      );
      const manifest = JSON.parse(
        await readFile(path.join(root, config.repositoryManifest), "utf8"),
      );
      await writeFile(
        path.join(root, config.repository, manifest.files[0].path),
        "altered archive",
      );
      const changed = (await createPlan(root)).plan.checks[0]!;
      assert.equal(changed.commands.length, 0);
      assert.ok(changed.unavailableReason);
    }
  },
);
