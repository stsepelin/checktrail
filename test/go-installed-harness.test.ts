import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";

test("Go installed harness keeps ordinary deadlines and bounds the aggregate while preserving a refused child", async (t) => {
  const root = await fixture(t, {
    "observe.mjs": `import{registerHooks}from'node:module';const target=process.argv[2];globalThis.originalCalls=[];globalThis.originalTests=[];globalThis.originalOutcomes=[];
const tests="export function test(name,options,callback){if(typeof options==='function'){callback=options;options={};}globalThis.originalTests.push({name,timeout:options.timeout??null});if(name==='go-extensions installed acceptance')globalThis.originalOutcomes.push(Promise.resolve().then(()=>callback()).then(()=>({outcome:'passed'}),error=>({outcome:'failed',message:error.message})));}";
const child="export function execFileSync(executable,args,options){globalThis.originalCalls.push({executable,args,timeout:options.timeout,maxBuffer:options.maxBuffer,hasTestContext:Object.hasOwn(options.env,'NODE_TEST_CONTEXT')});throw Error('Original refused fresh Go cohort');}";
const unused="export const nativeGoWorkspace=true;export const workspaceOptions={},workspaceConfiguration={},hostTarget={},foreignTarget={},fixedPolicy='original';export const planSchema={},reportSummarySchema={};export function fixture(){throw Error('Unexpected project body');}export const createPlan=fixture,validate=fixture,goScopeComplete=fixture,projectPlan=fixture,projectReport=fixture,validatedReport=fixture,workspaceFiles=fixture;";
registerHooks({resolve(specifier,context,next){if(context.parentURL===target){const source=specifier==='node:test'?tests:specifier==='node:child_process'?child:specifier.startsWith('.')?unused:null;if(source)return{url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};}return next(specifier,context);}});await import(target);const outcomes=await Promise.all(globalThis.originalOutcomes);console.log(JSON.stringify({calls:globalThis.originalCalls,tests:globalThis.originalTests,outcomes}));`,
  });
  const env = { ...process.env };
  delete env.CHECKTRAIL_GATE_GO_INSTALLED;
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "observe.mjs"),
      new URL("./gate-go-extensions.test.js", import.meta.url).href,
    ],
    { env, encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const packet = JSON.parse(result.stdout);
  const installed = packet.tests.find(
    (row: { name: string }) =>
      row.name === "go-extensions installed acceptance",
  );
  const ordinary = packet.tests.filter(
    (row: { name: string; timeout: number | null }) =>
      row.name !== "go-extensions installed acceptance" && row.timeout !== null,
  );
  assert.ok(ordinary.length > 0);
  assert.ok(
    ordinary.every((row: { timeout: number }) => row.timeout === 120000),
  );
  assert.equal(installed.timeout, 300000);
  assert.equal(packet.calls.length, 1);
  assert.equal(packet.calls[0].executable, process.execPath);
  assert.deepEqual(packet.calls[0].args, [
    fileURLToPath(
      new URL("../../scripts/verify-go-workspace-package.mjs", import.meta.url),
    ),
  ]);
  assert.equal(packet.calls[0].timeout, 280000);
  assert.ok(packet.calls[0].timeout < installed.timeout);
  assert.equal(packet.calls[0].maxBuffer, 1048576);
  assert.equal(packet.calls[0].hasTestContext, false);
  assert.deepEqual(packet.outcomes, [
    { outcome: "failed", message: "Original refused fresh Go cohort" },
  ]);
});
