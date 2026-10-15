import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";

test("native benchmark profile admission keeps the full callback file within a bounded cumulative allowance and preserves incomplete refusal", async (t) => {
  const root = await fixture(t, {
    "observe.mjs": `import {registerHooks} from 'node:module';
const target=process.argv[2];
const stub="export async function runRequiredTests(required,options){return{complete:false,observed:{kind:'single',required,options}};}export async function runRequiredProfiles(profiles,selection,options){return{complete:false,observed:{kind:'batch',selection,required:selection.flatMap(name=>profiles[name]),options}};}";
registerHooks({resolve(specifier,context,next){if(context.parentURL===target&&specifier==='./required-test-evidence.mjs')return{url:'data:text/javascript,'+encodeURIComponent(stub),shortCircuit:true};return next(specifier,context);}});
process.argv=[process.execPath,target,...process.argv.slice(3)];
await import(target);`,
  });
  const target = new URL(
    "../../scripts/verify-required-native-tests.mjs",
    import.meta.url,
  ).href;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const selections = [
    ["review-benchmark"],
    ["review-benchmark-judging"],
    ["review-benchmark-scoring"],
    ["review-claim-probability"],
    ["review", "review-benchmark", "review-benchmark-judging"],
    ["review"],
    ["review-benchmark-multi"],
    ["--full-suite", "review-benchmark"],
  ];
  for (const selection of selections) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "observe.mjs"), target, ...selection],
      { env, encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.error, undefined);
    // The harness double always refuses acceptance; the real dispatcher must keep it failed.
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout) as {
      complete: boolean;
      timeoutMs: number;
      observed: {
        kind: string;
        selection?: string[];
        required: { file: string; name: string }[];
        options: {
          timeoutMs: number;
          isolatedCaseWorkers?: number;
          additionalFiles?: unknown[];
        };
      };
    };
    const fullSuite = selection[0] === "--full-suite";
    const budget = fullSuite
      ? 600000
      : selection[0] === "review" && selection.length === 1
        ? 120000
        : 300000;
    assert.equal(report.timeoutMs, budget, JSON.stringify(selection));
    assert.equal(report.observed.options.timeoutMs, budget);
    assert.equal(report.complete, false);
    assert.equal(
      report.observed.kind,
      selection.length === 1 ? "single" : "batch",
    );
    assert.ok(report.observed.required.length > 0);
    if (
      selection.length === 1 &&
      selection[0] !== "review" &&
      selection[0] !== "review-benchmark-multi"
    ) {
      assert.deepEqual(
        [...new Set(report.observed.required.map((item) => item.file))].sort(),
        selection[0] === "review-claim-probability"
          ? [
              "dist/test/review-benchmark.test.js",
              "dist/test/review-claim-probability.test.js",
            ]
          : ["dist/test/review-benchmark.test.js"],
      );
      assert.equal(report.observed.options.isolatedCaseWorkers, 0);
    }
    if (report.observed.kind === "batch") {
      assert.deepEqual(
        report.observed.selection,
        fullSuite ? selection.slice(1) : selection,
      );
      assert.ok(report.observed.options.additionalFiles);
      assert.equal(
        report.observed.options.additionalFiles.length > 0,
        fullSuite,
      );
    }
  }
});
