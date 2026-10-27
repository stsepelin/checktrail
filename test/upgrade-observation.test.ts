import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";
const { observeUpgradeNode } = await import(
  new URL("../../scripts/package-upgrade-readiness.mjs", import.meta.url).href
);

test(
  "upgrade observer admits slow process startup before a complete native validation without extending the engine budget",
  { timeout: 90000 },
  async (t) => {
    const control = await fixture(t, {}),
      marker = path.join(control, "bodies.jsonl");
    const root = await fixture(t, {
      "package.json": JSON.stringify({
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      }),
      "checktrail.json": JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["javascript.node-test"] }],
      }),
      "values.test.js": `import{test}from'node:test';import assert from'node:assert/strict';import{appendFileSync}from'node:fs';for(const [name,value]of[['first',1],['second',2]])test(name,()=>{appendFileSync(${JSON.stringify(marker)},name+String.fromCharCode(10));assert.ok(value>0);});`,
    });
    const engine = new URL("../src/index.js", import.meta.url).href;
    const code = `import assert from'node:assert/strict';import{setTimeout as delay}from'node:timers/promises';process.stderr.write('Original upgrade startup reached\\n');await delay(31000);process.stderr.write('Original native validation reached\\n');const{validate}=await import(${JSON.stringify(engine)});const started=performance.now();const report=await validate(${JSON.stringify(root)},{trusted:true,timeoutMs:30000});assert.equal(report.outcome,'passed',JSON.stringify(report.checks.map(c=>({id:c.id,status:c.status,errors:c.processes.map(p=>p.errorCode??null)}))));process.stdout.write(JSON.stringify({outcome:report.outcome,tests:report.checks[0].tests,elapsedMs:performance.now()-started}));`;
    const report = JSON.parse(
      observeUpgradeNode(["--input-type=module", "-e", code], {
        cwd: control,
        phase: "original-upgrade",
        operation: "native validation",
      }),
    );
    assert.equal(report.outcome, "passed");
    assert.deepEqual(report.tests, {
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
    });
    assert.ok(report.elapsedMs < 30000);
    assert.deepEqual((await readFile(marker, "utf8")).trim().split("\n"), [
      "first",
      "second",
    ]);
  },
);

test("upgrade observation retains nonzero exit output byte limits and phase-specific failures", async (t) => {
  const root = await fixture(t, {});
  assert.throws(
    () =>
      observeUpgradeNode(
        [
          "-e",
          "process.stdout.write('original output');process.stderr.write('original error');process.exitCode=7;",
        ],
        { cwd: root, phase: "rollback", operation: "CLI run" },
      ),
    (error: unknown) => {
      const failure = error as Error & {
        status: number;
        signal: string | null;
        stdout: string;
        stderr: string;
      };
      assert.equal(failure.status, 7);
      assert.equal(failure.signal, null);
      assert.equal(failure.stdout, "original output");
      assert.equal(failure.stderr, "original error");
      assert.match(failure.message, /^Upgrade rollback CLI run:/);
      return true;
    },
  );
  assert.throws(
    () =>
      observeUpgradeNode(["-e", "process.stdout.write('x'.repeat(1000))"], {
        cwd: root,
        maxBuffer: 16,
        phase: "upgrade",
        operation: "library output",
      }),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOBUFS");
      assert.match(
        (error as Error).message,
        /^Upgrade upgrade library output:/,
      );
      return true;
    },
  );
});
