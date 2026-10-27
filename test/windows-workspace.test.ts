import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { fixture } from "./helpers.js";
async function observe(t: TestContext, mode: "allowed" | "denied") {
  const root = await realpath(
    await fixture(t, {
      "observer.mjs": String.raw`import assert from'node:assert/strict';import{registerHooks}from'node:module';import{existsSync,readdirSync}from'node:fs';import path from'node:path';const target=process.argv[2],mode=process.argv[3];let directory=null,privateAccess=0,spawned=0;const writes=[];globalThis.observeWorkspace=name=>{directory=name;assert.deepEqual(readdirSync(name),[],'Access must precede every command/source write');privateAccess++;if(mode==='denied')throw Object.assign(Error('Original access refusal'),{code:'ORIGINAL_ACCESS_REFUSAL'});};globalThis.observeWrite=(name)=>{writes.push({name:path.basename(name),privateAccess});throw Object.assign(Error('Original bounded checkpoint'),{code:'ORIGINAL_AFTER_GUARD'});};globalThis.observeSpawn=()=>{spawned++;throw Error('Native execution must not be reached by a portable observation');};
const fs="export * from 'node:fs/promises';import{realpath as actualRealpath,lstat as actualLstat}from'node:fs/promises';export const realpath=value=>typeof value==='string'&&/^[A-Za-z]:/.test(value)?Promise.resolve(value):actualRealpath(value);export const lstat=value=>typeof value==='string'&&/^[A-Za-z]:/.test(value)?Promise.resolve({isFile:()=>true}):actualLstat(value);export const writeFile=(name,...args)=>globalThis.observeWrite(name);";
registerHooks({resolve(specifier,context,next){if(context.parentURL===target){const stub=specifier==='./windows-task-access.js'?'export const ensureWindowsTaskAccess=(directory,kind,created)=>{if(kind!=="directory"||created!==true)throw Error("Unexpected access boundary");return globalThis.observeWorkspace(directory)}':specifier==='./inventory.js'?'export async function withinRoot(){return "C:\\\\OriginalProject";}':specifier==='node:fs/promises'?fs:specifier==='node:child_process'?'export const spawn=(...args)=>globalThis.observeSpawn(...args);':null;if(stub)return{url:'data:text/javascript,'+encodeURIComponent(stub),shortCircuit:true};}return next(specifier,context);}});
Object.defineProperty(process,'platform',{value:'win32'});const {runWindowsProcess}=await import(target);const result=await runWindowsProcess('C:\\OriginalProject',{executable:'C:\\OriginalTool.exe',args:[],cwd:'.'},{timeoutMs:1000});console.log(JSON.stringify({privateAccess,writes,spawned,result,namespaceRemains:directory?existsSync(directory):null}));`,
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SYSTEMROOT: "C:\\Windows",
    TMP: root,
    TEMP: root,
    TMPDIR: root,
  };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(
    process.execPath,
    [
      path.join(root, "observer.mjs"),
      pathToFileURL(
        await realpath(
          fileURLToPath(new URL("../src/windows-process.js", import.meta.url)),
        ),
      ).href,
      mode,
    ],
    { env, encoding: "utf8", timeout: 15000 },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
test("Windows process workspace establishes private access before fixed source or command data and removes its owned namespace", async (t) => {
  const seen = await observe(t, "allowed");
  assert.equal(seen.privateAccess, 1);
  assert.deepEqual(seen.writes, [{ name: "native.cs", privateAccess: 1 }]);
  assert.equal(seen.spawned, 0);
  assert.equal(seen.result.errorCode, "ORIGINAL_AFTER_GUARD");
  assert.equal(seen.namespaceRemains, false);
});
test("Windows process workspace refuses private-access failure before every data write or process launch", async (t) => {
  const seen = await observe(t, "denied");
  assert.equal(seen.privateAccess, 1);
  assert.deepEqual(seen.writes, []);
  assert.equal(seen.spawned, 0);
  assert.equal(seen.result.errorCode, "ORIGINAL_ACCESS_REFUSAL");
  assert.equal(seen.namespaceRemains, false);
});
