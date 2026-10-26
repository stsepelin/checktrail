import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { test } from "node:test";
import { fixture, captureFixtureProcessGroup } from "./helpers.js";
import {
  terminal,
  setup as setupTaskFixture,
  started as observeTaskFixture,
  registerTaskCleanup,
} from "./tasks-wire-fixture.js";
import { processSnapshot, type ProcessIdentity } from "../src/process-tree.js";

test("Tasks installed wrapper selects a bounded Windows aggregate allowance while preserving POSIX deadlines and failed child status", async (t) => {
  const root = await fixture(t, {
    "observe.mjs": `import {registerHooks} from 'node:module';
const target=process.argv[2],platform=process.argv[3];
globalThis.originalBudgetCalls=[];globalThis.originalBudgetOutcomes=[];
const testStub="export function test(name,options,callback){if(name==='tasks-matrix installed acceptance'){globalThis.originalBudgetCalls.push({kind:'callback',timeout:options.timeout});globalThis.originalBudgetOutcomes.push(Promise.resolve().then(callback).then(()=>({outcome:'passed'}),error=>({outcome:'failed',message:error.message})));}}";
const childStub="export function spawnSync(executable,args,options){globalThis.originalBudgetCalls.push({kind:'child',executable,args,timeout:options.timeout,maxBuffer:options.maxBuffer});return{status:7,stdout:'',stderr:'synthetic package process refusal'};}";
const unused="export const passingTest='synthetic';export const slow='synthetic',taskExecutionTimeoutMs=5000;export function createPlan(){throw Error('unexpected engine execution');}export const validate=createPlan,openTaskStore=createPlan,setup=createPlan,wire=createPlan,taskId=createPlan,terminal=createPlan,report=createPlan,started=createPlan,stopped=createPlan,acknowledge=createPlan;";
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
  env.CHECKTRAIL_TASKS_RUNTIME_SLOT = "original-selected-slot";
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
    assert.equal(child.args.length, 2);
    assert.ok(child.args[0]!.endsWith("verify-tasks-runtime-package.mjs"));
    assert.equal(child.args[1], "original-selected-slot");
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

test("Tasks terminal observation admits valid completion beyond four seconds and preserves failures while rejecting expired results", async (t) => {
  let elapsed = 0,
    calls = 0;
  const clock = t.mock.method(performance, "now", () => elapsed);
  const working = { resultType: "complete", status: "working" };
  const completed = {
    resultType: "complete",
    status: "completed",
    result: { structuredContent: { outcome: "passed" } },
  };
  const failed = {
    ...completed,
    result: { structuredContent: { outcome: "failed" } },
  };
  const connection = {
    request: async (method: string, params: Record<string, unknown> = {}) => {
      assert.equal(method, "tasks/get");
      assert.deepEqual(params, { taskId: "synthetic-task" });
      calls++;
      elapsed += 1000;
      return { result: elapsed < 5000 ? working : completed };
    },
  };
  try {
    let observed;
    await assert.doesNotReject(async () => {
      observed = await terminal(connection, "synthetic-task");
    }, "A valid task can complete after four seconds within the fixture execution allowance");
    assert.equal(observed, completed);
    assert.equal(calls, 5);
    elapsed = 0;
    calls = 0;
    await assert.rejects(
      terminal(connection, "synthetic-task", 4000),
      /Task did not finish within 4000ms/,
    );
    assert.equal(calls, 4);
    elapsed = 0;
    assert.equal(
      await terminal(
        { request: async () => ({ result: failed }) },
        "synthetic-task",
      ),
      failed,
    );
    elapsed = 0;
    await assert.rejects(
      terminal(
        {
          request: async () => ({
            error: { code: -1, message: "synthetic protocol refusal" },
          }),
        },
        "synthetic-task",
      ),
      { code: "ERR_ASSERTION" },
    );
    elapsed = 0;
    await assert.rejects(
      terminal(
        {
          request: async () => {
            elapsed = 16000;
            return { result: completed };
          },
        },
        "synthetic-task",
      ),
      /Task did not finish within 15000ms/,
    );
    elapsed = 0;
    calls = 0;
    await assert.rejects(
      terminal(
        {
          request: async () => {
            calls++;
            elapsed += 600;
            return { result: working };
          },
        },
        "synthetic-task",
        1000,
      ),
      /Task did not finish within 1000ms/,
    );
    assert.equal(calls, 2);
  } finally {
    clock.mock.restore();
  }
});

test("Tasks terminal observation bounds a stalled read and refuses invalid deadlines without polling", async () => {
  let completed = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let release:
    ((value: { result: Record<string, unknown> }) => void) | undefined;
  try {
    await assert.rejects(
      terminal(
        {
          request: () =>
            new Promise((resolve) => {
              release = resolve;
              timer = setTimeout(() => {
                completed = true;
                resolve({
                  result: { resultType: "complete", status: "completed" },
                });
              }, 200);
            }),
        },
        "synthetic-task",
        20,
      ),
      /Task did not finish within 20ms/,
    );
    assert.equal(
      completed,
      false,
      "A slow read must not consume a later deadline",
    );
  } finally {
    clearTimeout(timer);
    release?.({ result: { resultType: "complete", status: "completed" } });
  }
  let calls = 0;
  for (const deadline of [0, -1, NaN, Infinity, 0.5]) {
    await assert.rejects(
      terminal(
        {
          request: async () => {
            calls++;
            return {};
          },
        },
        "synthetic-task",
        deadline,
      ),
      /Invalid task observation deadline/,
    );
  }
  assert.equal(calls, 0);
});

test("Tasks wire fixtures select bounded Windows budgets and preserve explicit lifecycle execution limits", async (t) => {
  const root = await fixture(t, {
    "wire-observer.mjs": `import {registerHooks} from 'node:module';import{EventEmitter}from'node:events';import{PassThrough}from'node:stream';
const target=process.argv[2],platform=process.argv[3],calls=[],hooks=[],children=[];let killed=0;
globalThis.originalWireSpawn=(executable,args,options)=>{calls.push({executable,args,stdio:options.stdio});const child=new EventEmitter();child.pid=42;child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{killed++;child.emit('exit',1);return true;};children.push(child);child.stdin.on('finish',()=>queueMicrotask(()=>{child.stdout.end();child.stderr.end();child.emit('exit',0);}));return child;};
registerHooks({resolve(specifier,context,next){if(context.parentURL===target&&specifier==='node:child_process')return{url:'data:text/javascript,'+encodeURIComponent('export function spawn(...args){return globalThis.originalWireSpawn(...args)}'),shortCircuit:true};return next(specifier,context);}});
Object.defineProperty(process,'platform',{value:platform});const {wire,terminal,taskExecutionTimeoutMs,taskObservationTimeoutMs,taskRequestTimeoutMs}=await import(target);
const t={after:fn=>hooks.push(fn)},opt={root:'original-root',directory:'original-store'};
for(const args of [undefined,['--allow-execution','--timeout-ms','5000']]){const connection=await wire(t,opt,args);await connection.close();}
const requestConnection=await wire(t,opt),child=children.at(-1),requestOutcomes=[];
const savedSetTimeout=globalThis.setTimeout,savedClearTimeout=globalThis.clearTimeout,timers=new Map();let clock=0,nextTimer=0;
globalThis.setTimeout=(callback,ms)=>{const id=++nextTimer;timers.set(id,{at:clock+ms,callback});return id;};globalThis.clearTimeout=id=>timers.delete(id);
const advance=ms=>{clock+=ms;for(const [id,timer]of [...timers])if(timer.at<=clock){timers.delete(id);timer.callback();}};
try{
const first=requestConnection.request('tools/call',{name:'validation_run',arguments:{}}).then(value=>({result:value.result}),error=>({error:error.message}));
advance(10000);await Promise.resolve();requestOutcomes.push({pending:timers.size});
if(platform==='win32'){child.stdout.write(JSON.stringify({id:0,result:{resultType:'task',taskId:'original-task'}})+'\\n');requestOutcomes.push(await first);advance(taskRequestTimeoutMs);requestOutcomes.push({pending:timers.size});}else requestOutcomes.push(await first);
const expired=requestConnection.request('tasks/get',{taskId:'original-task'}).then(()=>({unexpected:true}),error=>({error:error.message}));advance(taskRequestTimeoutMs-1);requestOutcomes.push({pending:timers.size});advance(1);requestOutcomes.push(await expired);
child.stdout.write(JSON.stringify({id:1,result:{resultType:'complete',status:'completed'}})+'\\n');requestOutcomes.push({pending:timers.size});
}finally{globalThis.setTimeout=savedSetTimeout;globalThis.clearTimeout=savedClearTimeout;}
await requestConnection.close();for(const close of hooks)await close();
let elapsed=0;const previous=Object.getOwnPropertyDescriptor(performance,'now');Object.defineProperty(performance,'now',{value:()=>elapsed,configurable:true});
const connection={request:async()=>{elapsed+=20000;return{result:{resultType:'complete',status:'completed'}}}};const outcomes=[];
try{for(const timeout of [undefined,10000]){elapsed=0;try{const result=await terminal(connection,'original-task',timeout);outcomes.push({status:result.status});}catch(error){outcomes.push({error:error.message});}}}finally{if(previous)Object.defineProperty(performance,'now',previous);else delete performance.now;}
console.log(JSON.stringify({calls,killed,taskExecutionTimeoutMs,taskObservationTimeoutMs,taskRequestTimeoutMs,requestOutcomes,outcomes}));`,
    "lifecycle-observer.mjs": `import{registerHooks}from'node:module';const target=process.argv[2],platform=process.argv[3];globalThis.originalLifecycleCallbacks=[];globalThis.originalLifecycleCalls=[];
const testStub="export function test(name,options,callback){if(name==='tasks-matrix lifecycle acceptance')globalThis.originalLifecycleCallbacks.push(callback);}";
const fixtureStub="export const slow='await new Promise(resolve=>setTimeout(resolve,60000));',passingTest='original',taskExecutionTimeoutMs=20000;export async function setup(){return{root:'original-root',directory:'original-store'}};export async function wire(t,opt,args){globalThis.originalLifecycleCalls.push(args);throw new Error('original lifecycle selection observed');}export function unexpected(){throw Error('unexpected application execution')};export const createPlan=unexpected,validate=unexpected,openTaskStore=unexpected,taskId=unexpected,terminal=unexpected,report=unexpected,started=unexpected,stopped=unexpected,acknowledge=unexpected;";
registerHooks({resolve(specifier,context,next){if(context.parentURL===target){const stub=specifier==='node:test'?testStub:specifier.startsWith('.')?fixtureStub:null;if(stub)return{url:'data:text/javascript,'+encodeURIComponent(stub),shortCircuit:true};}return next(specifier,context);}});
Object.defineProperty(process,'platform',{value:platform});await import(target);if(globalThis.originalLifecycleCallbacks.length!==1)throw Error('Lifecycle callback not selected');let message;try{await globalThis.originalLifecycleCallbacks[0]({});}catch(error){message=error.message;}console.log(JSON.stringify({calls:globalThis.originalLifecycleCalls,message}));`,
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const platform of ["win32", "linux", "darwin"]) {
    const observed = spawnSync(
      process.execPath,
      [
        path.join(root, "wire-observer.mjs"),
        new URL("./tasks-wire-fixture.js", import.meta.url).href,
        platform,
      ],
      { env, encoding: "utf8", timeout: 15000 },
    );
    assert.equal(observed.error, undefined);
    assert.equal(observed.status, 0, observed.stderr);
    const value = JSON.parse(observed.stdout);
    const execution = platform === "win32" ? 20000 : 5000,
      observation = platform === "win32" ? 35000 : 15000;
    assert.equal(value.taskExecutionTimeoutMs, execution);
    assert.equal(value.taskObservationTimeoutMs, observation);
    assert.ok(observation >= execution + 10000);
    assert.equal(value.killed, 0);
    const request = platform === "win32" ? 35000 : 10000;
    assert.equal(value.taskRequestTimeoutMs, request);
    const expired = {
      error: `Request timed out after ${request}ms: tasks/get: `,
    };
    assert.deepEqual(
      value.requestOutcomes,
      platform === "win32"
        ? [
            { pending: 1 },
            { result: { resultType: "task", taskId: "original-task" } },
            { pending: 0 },
            { pending: 1 },
            expired,
            { pending: 0 },
          ]
        : [
            { pending: 0 },
            { error: "Request timed out after 10000ms: tools/call: " },
            { pending: 1 },
            expired,
            { pending: 0 },
          ],
    );
    assert.equal(value.calls.length, 3);
    for (const [index, call] of value.calls.entries()) {
      assert.equal(call.executable, process.execPath);
      assert.deepEqual(call.stdio, ["pipe", "pipe", "pipe"]);
      assert.deepEqual(call.args.slice(1), [
        "serve",
        "--root",
        "original-root",
        "--task-store",
        "original-store",
        "--timeout-ms",
        String(execution),
        "--allow-execution",
        ...(index === 1 ? ["--timeout-ms", "5000"] : []),
      ]);
    }
    if (platform === "win32")
      assert.equal(value.outcomes[0].status, "completed");
    else assert.match(value.outcomes[0].error, /within 15000ms/);
    assert.match(value.outcomes[1].error, /within 10000ms/);
    const lifecycle = spawnSync(
      process.execPath,
      [
        path.join(root, "lifecycle-observer.mjs"),
        new URL("./gate-tasks-matrix.test.js", import.meta.url).href,
        platform,
      ],
      { env, encoding: "utf8", timeout: 15000 },
    );
    assert.equal(lifecycle.error, undefined);
    assert.equal(lifecycle.status, 0, lifecycle.stderr);
    const selected = JSON.parse(lifecycle.stdout);
    assert.equal(selected.message, "original lifecycle selection observed");
    assert.deepEqual(selected.calls, [
      ["--allow-execution", "--timeout-ms", "5000"],
    ]);
  }
});

test("Tasks runtime selection binds every frozen acceptance case and preserves the complete platform control family", async () => {
  const { readFile } = await import("node:fs/promises");
  const { selectTasksRuntimeRequirements } = await import(
    new URL("../../scripts/tasks-runtime-evidence.mjs", import.meta.url).href
  );
  const profiles = JSON.parse(
    await readFile(
      new URL("../../scripts/required-native-tests.json", import.meta.url),
      "utf8",
    ),
  );
  const scope = JSON.parse(
    await readFile(
      new URL("../../docs/gate-a-profiles.v1.json", import.meta.url),
      "utf8",
    ),
  );
  type Row = { file: string; name: string };
  const selected = scope.extensionProfiles.find(
    (row: { id: string }) => row.id === "tasks-matrix",
  );
  const expected = selected.acceptanceCases.map((row: { name: string }) => ({
    file: selected.acceptanceFile,
    name: row.name,
  }));
  assert.equal(expected.length, 9);
  for (const platform of ["darwin", "linux", "win32"]) {
    const before = structuredClone(profiles);
    const rows: Row[] = selectTasksRuntimeRequirements(
      profiles,
      selected,
      platform,
    );
    assert.deepEqual(
      rows.filter((row) => row.file === selected.acceptanceFile),
      expected,
    );
    assert.deepEqual(rows.slice(0, 10), profiles["mcp-tasks"]);
    assert.equal(rows.length, platform === "win32" ? 29 : 26);
    assert.equal(
      rows.filter(
        (row) =>
          row.name ===
          "Tasks wire fixtures select bounded Windows budgets and preserve explicit lifecycle execution limits",
      ).length,
      1,
    );

    assert.equal(
      new Set(rows.map((row) => JSON.stringify([row.file, row.name]))).size,
      rows.length,
    );
    assert.equal(
      rows.filter(
        (row) =>
          row.name ===
          "Tasks runtime selection binds every frozen acceptance case and preserves the complete platform control family",
      ).length,
      1,
    );
    for (const name of [
      "Windows isolated harness namespace cleanup waits for native cwd release and reports exhausted locks",
      "native Windows task storage uses private ACLs for literal Unicode paths and native SQLite owner journals",
      "native Windows task storage refuses a publicly readable directory without changing its ACL or creating a database",
    ])
      assert.equal(
        rows.filter((row) => row.name === name).length,
        platform === "win32" ? 1 : 0,
      );
    const other = structuredClone(profiles);
    other["tasks-matrix-sibling"] = [
      { file: "dist/test/foreign.test.js", name: "OriginalAdjacentProfile" },
    ];
    assert.deepEqual(
      selectTasksRuntimeRequirements(other, selected, platform),
      rows,
    );
    rows[0]!.name = "OriginalReturnedCopyMutation";
    assert.deepEqual(profiles, before);
  }
  for (const mode of [
    "missing",
    "renamed",
    "foreign-file",
    "duplicate",
    "extra",
    "removed-mcp",
    "mcp-extra-field",
  ]) {
    const changed = structuredClone(profiles);
    if (mode === "missing") changed["tasks-matrix"].pop();
    else if (mode === "renamed") changed["tasks-matrix"][0].name += " changed";
    else if (mode === "foreign-file")
      changed["tasks-matrix"][0].file = "dist/test/foreign.test.js";
    else if (mode === "duplicate")
      changed["tasks-matrix"][1] = changed["tasks-matrix"][0];
    else if (mode === "extra")
      changed["tasks-matrix"].push({
        file: "dist/test/foreign.test.js",
        name: "OriginalUnexpectedCase",
      });
    else if (mode === "removed-mcp") changed["mcp-tasks"].pop();
    else changed["mcp-tasks"][0].extra = "OriginalUndeclaredField";
    assert.throws(
      () => selectTasksRuntimeRequirements(changed, selected, "darwin"),
      mode === "removed-mcp"
        ? /Preserved MCP Tasks cohort changed/
        : mode === "mcp-extra-field"
          ? /Invalid Tasks requirement fields/
          : /Frozen Tasks acceptance bindings changed/,
      mode,
    );
  }
  for (const platform of ["win32-suffix", "freebsd", ""])
    assert.throws(
      () => selectTasksRuntimeRequirements(profiles, selected, platform),
      /Unknown Tasks runtime platform/,
    );
  assert.throws(
    () =>
      selectTasksRuntimeRequirements(
        profiles,
        { ...selected, id: "tasks-matrix-sibling" },
        "darwin",
      ),
    /Unknown frozen Tasks profile/,
  );
});

test("Tasks generic CLI isolates exact required callbacks while adjacent profile names retain whole-file skip accounting", async (t) => {
  const { cp, readFile, writeFile } = await import("node:fs/promises");
  const file = "dist/test/original-tasks-cli.test.js";
  const first = { file, name: "OriginalRequiredMatrix" };
  const second = { file, name: "OriginalRequiredManifest" };
  const root = await fixture(t, {
    "package.json": '{"type":"module"}',
    "scripts/required-native-tests.json": JSON.stringify({
      "tasks-matrix": [first],
      "tasks-runtime-manifest": [second],
      "tasks-runtime-cli": [second],
      "native-harness-cleanup": [second],
      "tasks-runtime-startup": [second],
      "tasks-runtime-startup-extra": [first],
      "go-extensions": [second],
      "go-extensions-extra": [first],
      "assembly-laravel": [second],
      "assembly-laravel-extra": [first],
      "tasks-matrix-extra": [first],
      "native-harness-cleanup-extra": [first],
    }),
    "dist/src/original.js": "export const original = 1;\n",
    "marker.txt": "",
    [file]: `import{test}from'node:test';import{appendFileSync}from'node:fs';test('OriginalRequiredMatrix',()=>appendFileSync('marker.txt','matrix\\n'));test('OriginalRequiredManifest',()=>appendFileSync('marker.txt','manifest\\n'));test.skip('OriginalForeignPlatform',()=>{throw Error('Unselected foreign callback must not execute');});`,
  });
  for (const helper of [
    "verify-required-native-tests.mjs",
    "required-test-evidence.mjs",
  ])
    await cp(
      new URL("../../scripts/" + helper, import.meta.url),
      path.join(root, "scripts", helper),
    );
  // Newer runtime revisions use this observer; its synthetic engine input above
  // is deliberate fixture data, separate from the installed engine acceptance.
  await cp(
    new URL("../../scripts/compiled-engine-evidence.mjs", import.meta.url),
    path.join(root, "scripts/compiled-engine-evidence.mjs"),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const selection of [
    ["tasks-matrix"],
    ["tasks-runtime-manifest"],
    ["tasks-runtime-cli"],
    ["native-harness-cleanup"],
    ["tasks-runtime-startup"],
    ["go-extensions"],
    ["go-extensions", "tasks-runtime-manifest"],
    ["assembly-laravel"],
    ["tasks-matrix", "tasks-runtime-manifest"],
    ["tasks-runtime-manifest", "native-harness-cleanup"],
  ]) {
    await writeFile(path.join(root, "marker.txt"), "");
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "scripts/verify-required-native-tests.mjs"),
        ...selection,
      ],
      { cwd: root, env, encoding: "utf8", timeout: 30000, maxBuffer: 1048576 },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const packet = JSON.parse(result.stdout);
    if (["assembly-laravel", "go-extensions"].includes(selection[0]!))
      assert.equal(packet.timeoutMs, 300000);
    const expected = [
      ...new Set(
        selection.map((profile) =>
          profile === "tasks-matrix" ? first.name : second.name,
        ),
      ),
    ].sort();
    if (selection.length > 1)
      assert.deepEqual(
        packet.profiles,
        selection.map((profile) => ({ profile, required: 1 })),
      );
    assert.equal(packet.complete, true);
    assert.equal(packet.required, expected.length);
    assert.equal(packet.passed, expected.length);
    assert.deepEqual(packet.problems, []);
    assert.deepEqual(
      packet.ledger.cases.map((row: { name: string }) => row.name).sort(),
      expected,
    );
    assert.ok(
      packet.ledger.events.every(
        (row: { required: boolean; outcome: string }) =>
          row.required && row.outcome === "passed",
      ),
    );
    const markers = (await readFile(path.join(root, "marker.txt"), "utf8"))
      .trim()
      .split("\n")
      .sort();
    assert.deepEqual(
      markers,
      expected
        .map((name) => (name === first.name ? "matrix" : "manifest"))
        .sort(),
    );
  }
  for (const adjacentProfile of [
    "tasks-matrix-extra",
    "native-harness-cleanup-extra",
    "tasks-runtime-startup-extra",
    "go-extensions-extra",
    "assembly-laravel-extra",
  ]) {
    await writeFile(path.join(root, "marker.txt"), "");
    const adjacent = spawnSync(
      process.execPath,
      [
        path.join(root, "scripts/verify-required-native-tests.mjs"),
        adjacentProfile,
      ],
      { cwd: root, env, encoding: "utf8", timeout: 30000, maxBuffer: 1048576 },
    );
    assert.equal(adjacent.status, 1, adjacent.stderr);
    const packet = JSON.parse(adjacent.stdout);
    assert.equal(packet.complete, false);
    assert.deepEqual(packet.problems, [
      { name: "OriginalForeignPlatform", reason: "skipped-or-todo" },
    ]);
    assert.deepEqual(
      (await readFile(path.join(root, "marker.txt"), "utf8"))
        .trim()
        .split("\n")
        .sort(),
      ["manifest", "matrix"],
    );
  }
});

test(
  "isolated native namespace cleanup retries actual final-directory races and retains exhausted and failed evidence",
  { timeout: 90000 },
  async (t) => {
    const helper = new URL(
      "../../scripts/required-test-evidence.mjs",
      import.meta.url,
    ).href;
    const root = await fixture(t, {
      "case.mjs": `import{test}from'node:test';import assert from'node:assert/strict';import{writeFileSync}from'node:fs';import{tmpdir}from'node:os';test('native-scoped-cleanup',()=>{writeFileSync(process.env.ORIGINAL_CASE_MARKER,JSON.stringify({namespace:tmpdir()}));assert.equal(process.env.ORIGINAL_CASE_FAIL,'0','Original failure must survive namespace cleanup');});`,
      "writer.mjs": `import fs from'node:fs';process.on('message',request=>{try{fs.writeFileSync(request.namespace+'/original-late-'+request.sequence,'Original late native write.');process.send({sequence:request.sequence,created:true});}catch(error){process.send({sequence:request.sequence,error:error.code});}});process.on('disconnect',()=>process.exit(0));process.send({ready:true,pid:process.pid});`,
      "runner.mjs": `import fs from'node:fs';import{fork}from'node:child_process';import{once}from'node:events';import{fileURLToPath}from'node:url';
const nativeRmdir=fs.rmdir;let active=null,sequence=0;const outcomes=[];
const writer=fork(fileURLToPath(new URL('writer.mjs',import.meta.url)),[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});const exited=once(writer,'exit');
const ready=(await once(writer,'message'))[0];if(!ready.ready||ready.pid!==writer.pid)throw Error('Original native writer did not start');
function create(namespace){return new Promise((resolve,reject)=>{const id=++sequence;const receive=message=>{if(message.sequence!==id)return;writer.off('message',receive);if(message.created)resolve();else reject(Error('Actual native write failed: '+message.error));};writer.on('message',receive);writer.send({namespace,sequence:id});});}
fs.rmdir=function(directory,...rest){const state=active,path=Buffer.isBuffer(directory)?directory.toString():String(directory);let empty=false;try{empty=fs.readdirSync(path).length===0;}catch{}const race=state&&state.namespace===path&&empty&&(state.mode.startsWith('held')||state.injected===0);if(!race)return Reflect.apply(nativeRmdir,fs,[directory,...rest]);state.injected++;const callback=rest.pop();void create(path).then(()=>{Reflect.apply(nativeRmdir,fs,[directory,...rest,error=>{if(error)state.nativeCodes.push(error.code);callback(error);}]);},callback);};
const{runRequiredTests}=await import(${JSON.stringify(helper)});
try{for(const mode of ['released','held','failed','held-failed']){const marker=fileURLToPath(new URL(mode+'.json',import.meta.url));process.env.ORIGINAL_CASE_MARKER=marker;process.env.ORIGINAL_CASE_FAIL=mode.includes('failed')?'1':'0';const state={mode,namespace:null,armed:false,injected:0,nativeCodes:[]};active=state;const started=Date.now();let report,error;
try{report=await runRequiredTests([{file:fileURLToPath(new URL('case.mjs',import.meta.url)),name:'native-scoped-cleanup'}],{timeoutMs:10000,isolatedCaseWorkers:1,onCaseProgress:event=>{if(event.phase==='terminal'){state.namespace=JSON.parse(fs.readFileSync(marker,'utf8')).namespace;process.kill(writer.pid,0);state.armed=true;}}});}catch(value){error={code:value.code,evidence:value.nativeTestEvidence};}
finally{active=null;const namespace=state.namespace;let exists=false;if(namespace){try{exists=fs.statSync(namespace).isDirectory();}catch(value){if(value.code!=='ENOENT')throw value;}}outcomes.push({mode,report,error,armed:state.armed,injected:state.injected,nativeCodes:state.nativeCodes,exists,durationMs:Date.now()-started});if(namespace)await fs.promises.rm(namespace,{recursive:true,force:true});}}
}finally{active=null;fs.rmdir=nativeRmdir;if(writer.connected)writer.disconnect();await exited;}console.log(JSON.stringify(outcomes));`,
    });
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const result = spawnSync(
      process.execPath,
      [path.join(root, "runner.mjs")],
      { env, encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1048576 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const cleanupDiagnostics = result.stderr.split("\n").flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return value.profile === "required-native-case-cleanup-failure"
          ? [value]
          : [];
      } catch {
        return [];
      }
    });
    assert.equal(
      cleanupDiagnostics.length,
      2,
      "Every exhausted namespace must emit its observed test evidence",
    );
    assert.deepEqual(
      cleanupDiagnostics.map((value) => value.requiredFailedTerminalCount),
      [0, 1],
    );
    assert.deepEqual(
      cleanupDiagnostics.map((value) => value.observedPasses),
      [1, 0],
    );
    assert.ok(
      cleanupDiagnostics.every(
        (value) =>
          value.evidenceComplete === false &&
          value.sourceStabilityAssessed === false,
      ),
    );
    const rows = JSON.parse(result.stdout) as Array<{
      mode: string;
      report?: {
        complete: boolean;
        required: number;
        passed: number;
        ledger: { cases: Array<{ name: string; outcome: string }> };
      };
      error?: {
        code: string;
        evidence?: {
          evidenceComplete: boolean;
          observedPasses: number;
          failedTerminalCount: number;
          requiredFailedTerminalCount: number;
          failures: Array<{ name: string; outcome: string; required: boolean }>;
        };
      };
      armed: boolean;
      injected: number;
      nativeCodes: string[];
      exists: boolean;
      durationMs: number;
    }>;
    assert.deepEqual(
      rows.map((row) => row.mode),
      ["released", "held", "failed", "held-failed"],
    );
    for (const row of rows) {
      assert.equal(
        row.armed,
        true,
        "The real writer must be alive before actual namespace cleanup",
      );
      assert.ok(row.injected > 0);
      assert.ok(
        row.nativeCodes.length > 0,
        "A real final rmdir must reject the newly created entry",
      );
      assert.ok(
        row.nativeCodes.every((code) =>
          ["ENOTEMPTY", "EPERM", "EBUSY"].includes(code),
        ),
      );
      assert.ok(
        row.durationMs < 15000,
        "Namespace cleanup must retain a finite refusal boundary",
      );
      if (row.mode.startsWith("held")) {
        assert.equal(
          row.report,
          undefined,
          "Persistent native writes must not return passing acceptance",
        );
        assert.ok(row.error);
        assert.ok(["ENOTEMPTY", "EPERM", "EBUSY"].includes(row.error!.code));
        assert.equal(row.exists, true);
        assert.ok(
          row.error!.evidence,
          "Exhausted cleanup must retain observed test evidence",
        );
        assert.equal(row.error!.evidence!.evidenceComplete, false);
        assert.equal(
          row.error!.evidence!.observedPasses,
          row.mode === "held" ? 1 : 0,
        );
        assert.equal(
          row.error!.evidence!.requiredFailedTerminalCount,
          row.mode === "held" ? 0 : 1,
        );
        if (row.mode === "held-failed")
          assert.deepEqual(
            row
              .error!.evidence!.failures.filter((item) => item.required)
              .map((item) => [item.name, item.outcome]),
            [["native-scoped-cleanup", "failed"]],
          );
      } else {
        assert.equal(row.error, undefined, JSON.stringify(row));
        assert.equal(row.exists, false);
        assert.equal(row.report!.required, 1);
        assert.equal(row.report!.passed, row.mode === "released" ? 1 : 0);
        assert.equal(row.report!.complete, row.mode === "released");
        assert.deepEqual(
          row.report!.ledger.cases.map((item) => [item.name, item.outcome]),
          [
            [
              "native-scoped-cleanup",
              row.mode === "released" ? "passed" : "failed",
            ],
          ],
        );
      }
    }
  },
);

test(
  "Tasks native startup observer admits delayed reached bodies and cleans their actual process group without touching siblings",
  { skip: !["darwin", "linux"].includes(process.platform), timeout: 30000 },
  async (t) => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const { root } = await setupTaskFixture(t);
    const leaf =
      "require('node:fs').writeFileSync('.checktrail/leaf-ready',String(process.pid));setInterval(()=>{},1000);";
    const file = path.join(root, "delayed-native-body.mjs");
    await writeFile(
      file,
      `import{spawn}from'node:child_process';import{readFile,writeFile}from'node:fs/promises';import{setTimeout as delay}from'node:timers/promises';const child=spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore'});for(;;){try{if(Number(await readFile('.checktrail/leaf-ready','utf8'))===child.pid)break;}catch(error){if(error.code!=='ENOENT')throw error;}await delay(10);}for(;;){try{await readFile('.checktrail/start-delay');break;}catch(error){if(error.code!=='ENOENT')throw error;}await delay(10);}await delay(4500);await writeFile('.checktrail/started.json',JSON.stringify({pid:process.pid,parent:process.ppid,child:child.pid}));setInterval(()=>{},1000);`,
    );
    const actor = spawn(process.execPath, [file], {
        cwd: root,
        detached: true,
        stdio: "ignore",
      }),
      actorExit = once(actor, "exit");
    // Teardown also runs when readiness fails before identities are captured.
    let actorIdentity: ProcessIdentity | undefined = undefined,
      childIdentity: ProcessIdentity | undefined = undefined;
    const fallbackChildren: ProcessIdentity[] = [];
    registerTaskCleanup(t, async () => {
      const rows = await processSnapshot();
      const current = rows.find((row) => row.pid === actor.pid);
      if (
        current &&
        current.group === actor.pid &&
        (!actorIdentity || current.identity === actorIdentity.identity)
      ) {
        fallbackChildren.push(
          ...rows.filter((row) => row.parent === actor.pid),
        );
        actor.kill("SIGKILL");
      }
      await actorExit;
    });
    const sibling = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { stdio: "ignore" },
      ),
      siblingExit = once(sibling, "exit");
    t.after(async () => {
      try {
        const captured = [actorIdentity, childIdentity].filter(
          (row): row is ProcessIdentity => row !== undefined,
        );
        for (let i = 0; i < 200; i++) {
          const rows = await processSnapshot();
          if (
            captured.every(
              (row) =>
                !rows.some(
                  (current) =>
                    current.pid === row.pid &&
                    current.identity === row.identity,
                ),
            )
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const rows = await processSnapshot();
        assert.ok(
          captured.every(
            (row) =>
              !rows.some(
                (current) =>
                  current.pid === row.pid && current.identity === row.identity,
              ),
          ),
          "Fixture cleanup must release the actual native group, not a guessed parent PID",
        );
        process.kill(sibling.pid!, 0);
      } finally {
        for (const row of [childIdentity, ...fallbackChildren]) {
          if (!row) continue;
          const current = (await processSnapshot()).find(
            (current) => current.pid === row.pid,
          );
          if (current?.identity === row.identity && current.group === row.group)
            process.kill(row.pid, "SIGKILL");
        }
        if (sibling.exitCode === null && sibling.signalCode === null)
          sibling.kill("SIGKILL");
        await siblingExit;
      }
    });
    const until = performance.now() + 5000;
    let childPid: number | undefined;
    while (performance.now() < until) {
      try {
        childPid = Number(
          await readFile(path.join(root, ".checktrail/leaf-ready"), "utf8"),
        );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(childPid);
    const rows = await processSnapshot();
    actorIdentity = rows.find((row) => row.pid === actor.pid);
    childIdentity = rows.find((row) => row.pid === childPid);
    assert.ok(actorIdentity);
    assert.ok(childIdentity);
    assert.equal(actorIdentity.group, actor.pid);
    assert.equal(childIdentity.parent, actor.pid);
    await assert.rejects(
      captureFixtureProcessGroup(actor.pid!, 1),
      /parent differs/,
    );
    await assert.rejects(
      captureFixtureProcessGroup(process.pid, process.ppid),
      /outside this fixture/,
    );
    const started = performance.now();
    const observation = observeTaskFixture(t, root);
    void observation.catch(() => {});
    await writeFile(
      path.join(root, ".checktrail/start-delay"),
      "Original observation armed.",
    );
    const value = await observation;
    assert.equal(value.pid, actor.pid);
    assert.equal(value.child, childPid);
    assert.ok(
      performance.now() - started >= 4000,
      "The actual body must reach readiness beyond the old observation boundary",
    );
  },
);
