import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { validate, createPlan } from "../src/engine.js";
import {
  rubyToolsEvidence,
  rubyToolsPacketSchema,
} from "../src/ruby-tools-evidence.js";
import { mavenHash } from "../src/maven.js";
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
  validate(root, {
    trusted: true,
    timeoutMs: 120000,
  });

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

test(
  "native Ruby artifact runtime entry point settings scope compiler and result mutations cannot yield pass",
  native,
  async (t) => {
    for (const mode of ["rubocop", "rspec", "minitest"]) {
      const { root } = await rubyToolsFixture(t, [`ruby.${mode}`]),
        plan = (await createPlan(root)).plan,
        report = await run(root),
        check = plan.checks[0]!,
        process = report.checks[0]!.processes[0]!;
      assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
      const original = rubyToolsPacketSchema.parse(JSON.parse(process.stdout));
      const reject = (edit: (p: typeof original) => void) => {
        const packet = structuredClone(original);
        edit(packet);
        const result = rubyToolsEvidence(check, [
          { ...process, stdout: JSON.stringify(packet) },
        ]);
        assert.equal(result.status, "inconclusive", JSON.stringify(result));
      };
      reject((p) => {
        p.dataSha256 = "0".repeat(64);
      });
      reject((p) => {
        p.installedArtifacts.sha256 = "0".repeat(64);
      });
      reject((p) => {
        p.installedArtifactsAfter.sha256 = "0".repeat(64);
      });
      reject((p) => {
        p.installedArtifacts.entries.push(p.installedArtifacts.entries[0]!);
      });
      reject((p) => {
        p.metadataSha256 = "0".repeat(64);
      });
      reject((p) => {
        p.inputSha256 = "0".repeat(64);
      });
      reject((p) => {
        p.observerSha256 = "0".repeat(64);
      });
      reject((p) => {
        p.optionsSha256 = "0".repeat(64);
      });
      reject((p) => {
        p.receipts[0]!.exitCode = 1;
      });
      reject((p) => {
        p.receipts[1]!.phase = "other";
      });
      const meta = (
        p: typeof original,
        edit: (v: Record<string, unknown>) => void,
      ) => {
        const value = JSON.parse(p.metadata);
        edit(value);
        p.metadata = JSON.stringify(value);
        p.metadataSha256 = mavenHash(p.metadata);
      };
      reject((p) =>
        meta(p, (v) => {
          v.ruby = "4.0.8";
        }),
      );
      reject((p) =>
        meta(p, (v) => {
          v.toolFile = "/foreign/native.rb";
        }),
      );
      reject((p) =>
        meta(p, (v) => {
          v.toolVersion = "9.0.0";
        }),
      );
      reject((p) =>
        meta(p, (v) => {
          v.toolFileSha256 = "0".repeat(64);
        }),
      );
      reject((p) =>
        meta(p, (v) => {
          (v.compiled as { sha256: string }[])[0]!.sha256 = "0".repeat(64);
        }),
      );
      reject((p) =>
        meta(p, (v) => {
          v.compiled = [];
        }),
      );
      if (mode !== "rubocop") {
        const data = (
          p: typeof original,
          edit: (v: Record<string, unknown>) => void,
        ) => {
          const value = JSON.parse(p.data);
          edit(value);
          p.data = JSON.stringify(value);
          p.dataSha256 = mavenHash(p.data);
        };
        reject((p) =>
          data(p, (v) => {
            v.started = [];
          }),
        );
        reject((p) =>
          data(p, (v) => {
            v.results = [];
          }),
        );
        reject((p) =>
          data(p, (v) => {
            const rows = v.rows as { id: string }[];
            rows.push(rows[0]!);
          }),
        );
        reject((p) =>
          data(p, (v) => {
            const results = v.results as { file: string }[];
            results[0]!.file = "spec/absent.rb";
          }),
        );
        reject((p) =>
          data(p, (v) => {
            (v.summary as { total: number }).total = 3;
          }),
        );
        reject((p) =>
          data(p, (v) => {
            (v.summary as { outsideErrors: number }).outsideErrors = 1;
          }),
        );
      }
    }
  },
);
