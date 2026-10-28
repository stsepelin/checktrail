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

test("upgrade installation observation keeps both installation paths bounded by the exact host and preserves refusal evidence", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { writeFile, realpath } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../../scripts/package-upgrade-readiness.mjs", import.meta.url),
    "utf8",
  );
  for (const platform of ["win32", "linux", "darwin", "win32-control"]) {
    for (const locked of [false, true]) {
      const root = await realpath(await fixture(t, {}));
      let controlled = source;
      for (const [before, after] of [
        ['from "node:process"', 'from "./controlled-process.mjs"'],
        [
          'from "./install-acceptance-package.mjs"',
          'from "./controlled-npm.mjs"',
        ],
        [
          'from "@modelcontextprotocol/client"',
          'from "./controlled-client.mjs"',
        ],
        [
          'from "@modelcontextprotocol/client/stdio"',
          'from "./controlled-client.mjs"',
        ],
      ] as const) {
        assert.equal(controlled.split(before).length, 2, before);
        controlled = controlled.replace(before, after);
      }
      await writeFile(path.join(root, "subject.mjs"), controlled);
      await writeFile(
        path.join(root, "controlled-process.mjs"),
        `import process from "node:process";export default {platform:${JSON.stringify(platform)},execPath:process.execPath};`,
      );
      await writeFile(
        path.join(root, "controlled-client.mjs"),
        'export let starts=0;export class Client{constructor(){starts++;throw Error("Installation refusal must prevent MCP startup");}}export class StdioClientTransport{constructor(){starts++;throw Error("Installation refusal must prevent transport startup");}}',
      );
      await writeFile(
        path.join(root, "controlled-npm.mjs"),
        `import {readFileSync,appendFileSync}from"node:fs";import path from"node:path";export const failure=Object.assign(new Error("original installation timeout"),{code:"ETIMEDOUT",status:null,signal:"SIGTERM",stdout:Buffer.from("original npm output"),stderr:Buffer.from("original npm error")});export function runAcceptanceNpm(args,options){appendFileSync(new URL("calls.jsonl",import.meta.url),JSON.stringify({args,options,manifest:JSON.parse(readFileSync(path.join(options.cwd,"package.json"),"utf8"))})+String.fromCharCode(10));throw failure;}`,
      );
      await writeFile(
        path.join(root, "runner.mjs"),
        `import{writeFile}from"node:fs/promises";import{fileURLToPath}from"node:url";import{createHash}from"node:crypto";import{verifyPackageUpgrade}from"./subject.mjs";import{failure}from"./controlled-npm.mjs";import{starts}from"./controlled-client.mjs";const baseline=fileURLToPath(new URL("baseline.tgz",import.meta.url)),candidate=fileURLToPath(new URL("candidate.tgz",import.meta.url)),rawA=Buffer.from("original baseline archive"),rawB=Buffer.from("original different candidate archive");await writeFile(baseline,rawA);await writeFile(candidate,rawB);const digest=(bytes,algorithm)=>createHash(algorithm).update(bytes).digest(algorithm==="sha256"?"hex":"base64");const prepare=(artifact,bytes,version)=>{const dependencies={"@stsepelin/checktrail":"file:"+artifact};return{manifest:{private:true,dependencies},lock:{lockfileVersion:3,packages:{"":{dependencies},"node_modules/@stsepelin/checktrail":{version,resolved:"file:"+artifact,integrity:"sha512-"+digest(bytes,"sha512")}}}}};const options={baselineIdentity:{sha256:digest(rawA,"sha256"),version:"0.0.1"},candidateVersion:"0.0.2",...(${locked}?{baselineInstallation:prepare(baseline,rawA,"0.0.1"),candidateInstallation:prepare(candidate,rawB,"0.0.2")}:{} )};let caught;try{await verifyPackageUpgrade(baseline,candidate,options);}catch(error){caught=error;}process.stdout.write(JSON.stringify({sameFailure:caught===failure,message:caught?.message,code:caught?.code,status:caught?.status,signal:caught?.signal,stdout:caught?.stdout?.toString(),stderr:caught?.stderr?.toString(),mcpStarts:starts}));`,
      );
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(
        process.execPath,
        [path.join(root, "runner.mjs")],
        {
          encoding: "utf8",
          env,
          timeout: 10000,
        },
      );
      assert.equal(child.error, undefined, child.error?.message ?? "");
      assert.equal(child.status, 0, child.stderr);
      const observed = JSON.parse(child.stdout);
      assert.equal(observed.sameFailure, true);
      assert.equal(observed.code, "ETIMEDOUT");
      assert.equal(observed.status, null);
      assert.equal(observed.signal, "SIGTERM");
      assert.equal(observed.stdout, "original npm output");
      assert.equal(observed.stderr, "original npm error");
      assert.equal(observed.mcpStarts, 0);
      const operation = locked ? "ci" : "install";
      assert.equal(
        observed.message,
        `Upgrade baseline npm ${operation}: original installation timeout`,
      );
      const attempts = (await readFile(path.join(root, "calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        attempts.length,
        1,
        "installation refusal must stop before another attempt",
      );
      const calls = attempts[0];
      assert.deepEqual(calls.args, [
        operation,
        "--offline",
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        ...(locked ? [] : [path.join(root, "baseline.tgz")]),
      ]);
      assert.equal(
        calls.options.timeout,
        platform === "win32" ? 120000 : 60000,
      );
      assert.equal(calls.options.stdio, "pipe");
      assert.equal(path.basename(calls.options.cwd), "installation");
      assert.equal(path.isAbsolute(calls.options.cwd), true);
      assert.equal(Object.hasOwn(calls.options, "phase"), false);
      assert.deepEqual(
        calls.manifest.dependencies,
        locked
          ? {
              "@stsepelin/checktrail":
                "file:" + path.join(root, "baseline.tgz"),
            }
          : undefined,
      );
    }
  }
});
