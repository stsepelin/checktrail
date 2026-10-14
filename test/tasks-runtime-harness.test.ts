import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";

test("Tasks installed wrapper selects a bounded Windows aggregate allowance while preserving POSIX deadlines and failed child status", async (t) => {
  const root = await fixture(t, {
    "observe.mjs": `import {registerHooks} from 'node:module';
const target=process.argv[2],platform=process.argv[3];
globalThis.originalBudgetCalls=[];globalThis.originalBudgetOutcomes=[];
const testStub="export function test(name,options,callback){if(name==='tasks-matrix installed acceptance'){globalThis.originalBudgetCalls.push({kind:'callback',timeout:options.timeout});globalThis.originalBudgetOutcomes.push(Promise.resolve().then(callback).then(()=>({outcome:'passed'}),error=>({outcome:'failed',message:error.message})));}}";
const childStub="export function spawnSync(executable,args,options){globalThis.originalBudgetCalls.push({kind:'child',executable,args,timeout:options.timeout,maxBuffer:options.maxBuffer});return{status:7,stdout:'',stderr:'synthetic package process refusal'};}";
const unused="export const passingTest='synthetic';export const slow='synthetic';export function createPlan(){throw Error('unexpected engine execution');}export const validate=createPlan,openTaskStore=createPlan,setup=createPlan,wire=createPlan,taskId=createPlan,terminal=createPlan,report=createPlan,started=createPlan,stopped=createPlan,acknowledge=createPlan;";
registerHooks({resolve(specifier,context,next){if(context.parentURL===target){const stub=specifier==='node:test'?testStub:specifier==='node:child_process'?childStub:specifier.startsWith('.')?unused:null;if(stub)return{url:'data:text/javascript,'+encodeURIComponent(stub),shortCircuit:true};}return next(specifier,context);}});
Object.defineProperty(process,'platform',{value:platform});
await import(target);
const outcomes=await Promise.all(globalThis.originalBudgetOutcomes);
console.log(JSON.stringify({calls:globalThis.originalBudgetCalls,outcomes}));`,
  });
  const target = new URL("./gate-tasks-matrix.test.js", import.meta.url).href;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.CHECKTRAIL_TASKS_MATRIX_INSTALLED;
  for (const platform of ["win32", "linux", "darwin"]) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "observe.mjs"), target, platform],
      {
        env,
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout) as {
      calls: Array<{
        kind: string;
        timeout: number;
        maxBuffer?: number;
        executable?: string;
        args?: string[];
      }>;
      outcomes: Array<{ outcome: string; message: string }>;
    };
    assert.equal(observed.calls.length, 2);
    assert.deepEqual(
      observed.calls.map((call) => [call.kind, call.timeout]),
      [
        ["callback", platform === "win32" ? 600000 : 180000],
        ["child", platform === "win32" ? 590000 : 170000],
      ],
    );
    const child = observed.calls[1]!;
    assert.equal(child.executable, process.execPath);
    assert.ok(child.args);
    assert.equal(child.args.length, 1);
    assert.ok(child.args[0]!.endsWith("verify-tasks-runtime-package.mjs"));
    assert.equal(child.maxBuffer, 4 * 1048576);
    assert.ok(child.timeout < observed.calls[0]!.timeout);
    assert.equal(observed.outcomes.length, 1);
    assert.equal(observed.outcomes[0]!.outcome, "failed");
    assert.match(
      observed.outcomes[0]!.message,
      /synthetic package process refusal/,
    );
  }
});

test(
  "Windows isolated harness namespace cleanup waits for native cwd release and reports exhausted locks",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { readFile, rm, realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const helper = new URL(
      "../../scripts/required-test-evidence.mjs",
      import.meta.url,
    ).href;
    const root = await fixture(t, {
      "runner.mjs": `import{runRequiredTests}from ${JSON.stringify(helper)};import{fileURLToPath}from'node:url';import{readFileSync}from'node:fs';let lockArmed=false;try{const report=await runRequiredTests([{file:fileURLToPath(new URL('held.mjs',import.meta.url)),name:'synthetic-held-cwd'}],{timeoutMs:10000,isolatedCaseWorkers:1,onCaseProgress:event=>{if(event.phase==='terminal'&&event.outcome==='passed'){const holder=JSON.parse(readFileSync(process.env.ORIGINAL_HELD_MARKER,'utf8'));process.kill(holder.pid,0);lockArmed=true;}}});console.log(JSON.stringify({report,lockArmed}));}catch(error){console.log(JSON.stringify({error:error.code,path:error.path,lockArmed}));}`,
      "held.mjs": `import{test}from'node:test';import assert from'node:assert/strict';import{spawn}from'node:child_process';import{readFile}from'node:fs/promises';import{tmpdir}from'node:os';import{setTimeout as delay}from'node:timers/promises';test('synthetic-held-cwd',async()=>{const source="const fs=require('node:fs');const marker=process.env.ORIGINAL_HELD_MARKER;fs.writeFileSync(marker+'.partial',JSON.stringify({pid:process.pid,namespace:process.cwd()}));fs.renameSync(marker+'.partial',marker);setTimeout(()=>process.exit(0),Number(process.env.ORIGINAL_HOLD_MS));";const child=spawn(process.execPath,['-e',source],{cwd:tmpdir(),detached:true,stdio:'ignore'});child.unref();for(let i=0;i<200;i++){try{const value=JSON.parse(await readFile(process.env.ORIGINAL_HELD_MARKER,'utf8'));assert.equal(value.pid,child.pid);return;}catch(error){if(error.code!=='ENOENT')throw error;}await delay(25);}throw Error('Synthetic cwd holder did not start');});`,
    });
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    async function exists(pid: number) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        return false;
      }
    }
    for (const mode of ["release", "hold"]) {
      const marker = path.join(root, mode + ".json");
      const result = spawnSync(
        process.execPath,
        [path.join(root, "runner.mjs")],
        {
          env: {
            ...env,
            ORIGINAL_HELD_MARKER: marker,
            ORIGINAL_HOLD_MS: mode === "release" ? "1500" : "20000",
          },
          encoding: "utf8",
          timeout: 30000,
        },
      );
      const holder = JSON.parse(await readFile(marker, "utf8")) as {
        pid: number;
        namespace: string;
      };
      try {
        assert.match(
          path.basename(holder.namespace),
          /^checktrail-native-case-/,
        );
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        const observed = JSON.parse(result.stdout);
        assert.equal(
          observed.lockArmed,
          true,
          "The native cwd holder must be alive immediately before namespace cleanup",
        );
        if (mode === "release") {
          assert.equal(observed.report.complete, true);
          assert.equal(observed.report.required, 1);
          assert.equal(observed.report.passed, 1);
          assert.equal(
            await exists(holder.pid),
            false,
            "Native cwd owner must have exited before removal",
          );
          await assert.rejects(realpath(holder.namespace), { code: "ENOENT" });
        } else {
          assert.equal(
            observed.report,
            undefined,
            "Exhausted namespace cleanup must not return acceptance",
          );
          assert.ok(["EBUSY", "EPERM"].includes(observed.error));
          assert.equal(observed.path, holder.namespace);
          assert.equal(
            await exists(holder.pid),
            true,
            "The persistent native lock must still be armed",
          );
          assert.equal(
            path.relative(
              await realpath(tmpdir()),
              path.dirname(await realpath(holder.namespace)),
            ),
            "",
          );
        }
      } finally {
        if (await exists(holder.pid)) process.kill(holder.pid, "SIGKILL");
        for (
          let attempt = 0;
          (await exists(holder.pid)) && attempt < 200;
          attempt++
        )
          await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(
          await exists(holder.pid),
          false,
          "Owned synthetic cwd holder survived cleanup",
        );
        await rm(holder.namespace, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      }
    }
  },
);
