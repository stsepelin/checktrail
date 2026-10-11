import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
export const nativeResourceCases = Object.freeze([
  Object.freeze({ id: "small", modules: 10, go: false, outputRepeats: 0 }),
  Object.freeze({
    id: "large",
    modules: 1000,
    go: false,
    outputRepeats: 40000,
  }),
  Object.freeze({ id: "polyglot", modules: 50, go: true, outputRepeats: 0 }),
]);
export const resourceHash = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export async function createNativeResourceFixture(directory, id) {
  const specification = nativeResourceCases.find((value) => value.id === id);
  assert.ok(specification, "Unknown native resource fixture");
  assert.deepEqual(
    await readdir(directory),
    [],
    "Resource fixture must be empty",
  );
  const javascript = specification.go ? "javascript/" : "";
  const files = {
    [javascript + "package.json"]:
      JSON.stringify({
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      }) + "\n",
  };
  const imports = [],
    values = [];
  for (let index = 0; index < specification.modules; index++) {
    const name = `value-${String(index).padStart(4, "0")}.js`;
    files[javascript + name] = `export const value = ${index};\n`;
    imports.push(`import {value as v${index}} from './${name}';`);
    values.push(`v${index}`);
  }
  const sum = (specification.modules * (specification.modules - 1)) / 2;
  files[javascript + "values.test.js"] =
    `import{test}from'node:test';import assert from'node:assert/strict';\n${imports.join("\n")}\ntest('sums every original resource fixture module',()=>{assert.equal([${values.join(",")}].reduce((n,v)=>n+v,0),${sum});${specification.outputRepeats ? `console.log('λ🚀'.repeat(${specification.outputRepeats}));` : ""}});\n`;
  const projects = [
    {
      path: specification.go ? "javascript" : ".",
      checks: ["javascript.node-test"],
    },
  ];
  if (specification.go) {
    files["native/go.mod"] =
      "module example.invalid/resource-fixture\n\ngo 1.27.1\n";
    files["native/value.go"] =
      "package resourcefixture\n\nfunc Sum(values []int) int {\n\ttotal := 0\n\tfor _, value := range values {\n\t\ttotal += value\n\t}\n\treturn total\n}\n";
    files["native/value_test.go"] =
      'package resourcefixture\n\nimport "testing"\n\nfunc TestSum(t *testing.T) {\n\tif got := Sum([]int{1, 2, 3}); got != 6 {\n\t\tt.Fatalf("sum = %d, expected 6", got)\n\t}\n}\n';
    projects.push({
      path: "native",
      checks: ["go.test"],
      environment: ["GOCACHE"],
    });
  }
  files["checktrail.json"] =
    JSON.stringify({ schemaVersion: 1, projects }) + "\n";
  let inputBytes = 0;
  for (const [relative, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, relative)), {
      recursive: true,
    });
    await writeFile(path.join(directory, relative), body, {
      flag: "wx",
      mode: 0o600,
    });
    inputBytes += Buffer.byteLength(body);
  }
  return {
    ...specification,
    files: Object.keys(files).length,
    inputBytes,
    projects: projects.length,
    checks: projects.length,
    executedTests: projects.length,
  };
}
export function summarizeResourceReport(report, expected) {
  assert.equal(report.sourceChanged, false, "Resource workload source changed");
  assert.equal(
    report.sourceError,
    false,
    "Resource workload source capture failed",
  );
  assert.equal(
    report.outcome,
    "passed",
    "Resource workload validation did not pass",
  );
  assert.equal(
    report.checks.length,
    expected.checks,
    "Resource workload check accounting differs",
  );
  let executedTests = 0,
    observedOutputBytes = 0,
    stdoutBytes = 0,
    stderrBytes = 0;
  for (const check of report.checks) {
    assert.equal(
      check.status,
      "passed",
      "Resource workload check was incomplete",
    );
    assert.ok(
      check.tests &&
        check.tests.passed === 1 &&
        check.tests.failed === 0 &&
        check.tests.skipped === 0,
      "Resource workload must execute its original non-skipped test",
    );
    executedTests += check.tests.passed;
    assert.ok(
      check.processes.length > 0,
      "Resource workload lacks physical process evidence",
    );
    for (const process of check.processes) {
      assert.ok(
        process.exitCode === 0 &&
          !process.signal &&
          !process.errorCode &&
          !process.timedOut &&
          !process.cancelled &&
          !process.truncated,
        "Resource workload process did not complete successfully",
      );
      const capture = process.capturedOutput;
      assert.ok(
        capture?.completeForObservedStreams,
        "Resource workload raw output is incomplete",
      );
      assert.equal(
        capture.observedBytes,
        capture.stdout.bytes + capture.stderr.bytes,
        "Resource workload physical output accounting differs",
      );
      assert.equal(
        process.outputBytes,
        capture.observedBytes,
        "Resource workload observed output differs",
      );
      for (const name of ["stdout", "stderr"]) {
        const stream = capture[name],
          bytes = Buffer.from(stream.base64, "base64");
        assert.equal(
          bytes.length,
          stream.bytes,
          "Resource workload raw output length differs",
        );
        assert.equal(
          bytes.toString("base64"),
          stream.base64,
          "Resource workload raw output encoding differs",
        );
        assert.equal(
          resourceHash(bytes),
          stream.sha256,
          "Resource workload raw output hash differs",
        );
      }
      stdoutBytes += capture.stdout.bytes;
      stderrBytes += capture.stderr.bytes;
      observedOutputBytes += capture.observedBytes;
    }
  }
  assert.equal(
    executedTests,
    expected.executedTests,
    "Resource workload test accounting differs",
  );
  return {
    checks: report.checks.length,
    executedTests,
    observedOutputBytes,
    stdoutBytes,
    stderrBytes,
    reportBytes: Buffer.byteLength(JSON.stringify(report)),
    reportSha256: resourceHash(Buffer.from(JSON.stringify(report))),
  };
}
export function resourceCounterDelta(before, after) {
  assert.equal(
    before.pid,
    after.pid,
    "Resource snapshots must belong to the same worker",
  );
  assert.equal(
    before.children.userCpuMicroseconds + before.children.systemCpuMicroseconds,
    0,
    "Fresh resource worker already reaped a child before collection",
  );
  assert.equal(
    before.children.peakRssKiB,
    0,
    "Fresh resource worker already has child RSS before collection",
  );
  const counters = {};
  for (const scope of ["self", "children"]) {
    const user =
        after[scope].userCpuMicroseconds - before[scope].userCpuMicroseconds,
      system =
        after[scope].systemCpuMicroseconds -
        before[scope].systemCpuMicroseconds;
    assert.ok(
      Number.isSafeInteger(user) &&
        user >= 0 &&
        Number.isSafeInteger(system) &&
        system >= 0,
      "Resource CPU counters went backwards",
    );
    counters[scope] = {
      userCpuMicroseconds: user,
      systemCpuMicroseconds: system,
      peakRssKiB: after[scope].peakRssKiB,
    };
  }
  return {
    ...counters,
    summedProcessTreeRss: false,
    unreapedDescendantCoverage: "unverified",
  };
}
