import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fixture } from "./helpers.js";
async function observe(
  t: TestContext,
  refused: boolean,
  cleanupFailure = false,
) {
  const root = await fixture(t, {
    "observe.mjs": `import assert from'node:assert/strict';import{registerHooks}from'node:module';import{readdirSync,existsSync}from'node:fs';import{writeFile,rm}from'node:fs/promises';import path from'node:path';
const target=process.argv[2],refused=process.argv[3]==='true',cleanupFailure=process.argv[4]==='true',calls=[];let observed,returnedDirectory,cause,errors;globalThis.originalProbeCleanup=()=>{throw Error('Original native cleanup refusal');};
globalThis.originalProbeAccess=(directory,kind,created)=>{assert.deepEqual(readdirSync(directory),[]);assert.equal(kind,'directory');assert.equal(created,true);observed=directory;calls.push({kind,created,emptyBeforeAccess:true});if(refused)throw Error('Original native ACL refusal');};
registerHooks({resolve(specifier,context,next){if(context.parentURL===target&&cleanupFailure&&specifier==='node:fs/promises')return{url:'data:text/javascript,'+encodeURIComponent("export {mkdtemp,realpath} from 'node:fs/promises';export const rm=(...args)=>globalThis.originalProbeCleanup(...args);"),shortCircuit:true};if(context.parentURL===target&&specifier==='./windows-task-access.js')return{url:'data:text/javascript,'+encodeURIComponent('export const ensureWindowsTaskAccess=(...args)=>globalThis.originalProbeAccess(...args);'),shortCircuit:true};return next(specifier,context);}});
Object.defineProperty(process,'platform',{value:'win32'});const {createPrivateProbeWorkspace}=await import(target);let returned=false,message=null;
try{const directory=await createPrivateProbeWorkspace();returnedDirectory=directory;returned=true;assert.equal(directory,observed);assert.equal(calls.length,1);assert.deepEqual(readdirSync(directory),[]);await writeFile(path.join(directory,'original-synthetic-source'),'original',{flag:'wx',mode:0o600});}catch(error){message=error.message;cause=error.cause?.message;errors=error.errors?.map(item=>item.message);}finally{if(!refused&&returnedDirectory)await rm(returnedDirectory,{recursive:true,force:true});}
const namespaceRemains=observed?existsSync(observed):null;if(observed)await rm(observed,{recursive:true,force:true});console.log(JSON.stringify({calls,returned,message,namespaceRemains,...(cleanupFailure?{cause,errors}:{})}));`,
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "observe.mjs"),
      new URL("../src/review-probe-storage.js", import.meta.url).href,
      String(refused),
      String(cleanupFailure),
    ],
    { env, encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
test("review probe workspace establishes Windows private access before returning any writable captured-source namespace", async (t) => {
  const result = await observe(t, false);
  assert.deepEqual(result, {
    calls: [{ kind: "directory", created: true, emptyBeforeAccess: true }],
    returned: true,
    message: null,
    namespaceRemains: false,
  });
});
test("review probe workspace refuses failed Windows private access and removes its empty namespace before source copying", async (t) => {
  const result = await observe(t, true);
  assert.deepEqual(result, {
    calls: [{ kind: "directory", created: true, emptyBeforeAccess: true }],
    returned: false,
    message: "Original native ACL refusal",
    namespaceRemains: false,
  });
});

test("native probes require the private workspace boundary before source copying or execution on Windows", async (t) => {
  const root = await fixture(t, {
    "caller.mjs": `import assert from'node:assert/strict';import{registerHooks}from'node:module';import{readFile}from'node:fs/promises';import path from'node:path';
const target=process.argv[2],fixtureUrl=process.argv[3],cleanup=[];const {setup,pin}=await import(fixtureUrl);const d=await setup({after:fn=>cleanup.push(fn)},"export function decision(name){process.getBuiltinModule('node:fs').writeFileSync("+JSON.stringify(process.argv[4])+",'executed');return true;}\\n");let calls=0;
globalThis.originalPrivateProbeBoundary=()=>{calls++;throw Error('Original private workspace denied');};registerHooks({resolve(specifier,context,next){if(context.parentURL===target&&specifier==='./review-probe-storage.js')return{url:'data:text/javascript,'+encodeURIComponent('export const createPrivateProbeWorkspace=()=>globalThis.originalPrivateProbeBoundary();'),shortCircuit:true};return next(specifier,context);}});
Object.defineProperty(process,'platform',{value:'win32'});try{const {runReviewProbe}=await import(target);await assert.rejects(runReviewProbe(d.root,d.context,d.target,{trusted:true,recipe:pin(),timeoutMs:10000}),/Original private workspace denied/);assert.equal(calls,1);await assert.rejects(readFile(process.argv[4]),{code:'ENOENT'});console.log(JSON.stringify({calls,sourceExecutionObserved:false}));}finally{for(const close of cleanup)await close();}`,
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "caller.mjs"),
      new URL("../src/review-probe.js", import.meta.url).href,
      new URL("./review-workflow-fixture.js", import.meta.url).href,
      path.join(root, "original-executed"),
    ],
    { env, encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    calls: 1,
    sourceExecutionObserved: false,
  });
});

test("review probe workspace retains initialization and cleanup failures without returning a captured-source namespace", async (t) => {
  const result = await observe(t, true, true);
  assert.deepEqual(result, {
    calls: [{ kind: "directory", created: true, emptyBeforeAccess: true }],
    returned: false,
    message: "Private probe workspace initialization and cleanup failed",
    namespaceRemains: true,
    cause: "Original native cleanup refusal",
    errors: ["Original native ACL refusal", "Original native cleanup refusal"],
  });
});
