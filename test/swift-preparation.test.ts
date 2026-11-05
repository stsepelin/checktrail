import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fixture } from "./helpers.js";

const archiveSha256 =
  "9ffa52f478e6d8eb485d37d14715ffac90abc81c58f3370d598bf75be05605f8";
const syntheticDigest = createHash("sha256").update("original").digest("hex");
const scripts = [
  "prepare-swift-tools-runtime.mjs",
  "prepare-swift-extensions-runtime.mjs",
];

async function control(t: TestContext, script: string, scenario: string) {
  const source = await readFile(
    new URL(`../../scripts/${script}`, import.meta.url),
    "utf8",
  );
  // Exercise the real caller with a small synthetic archive pin. Keep every
  // physical byte-count and digest gate, then stop before archive extraction.
  assert.equal(source.split("64444529").length - 1, 3);
  assert.equal(source.split(archiveSha256).length - 1, 1);
  const copied = source
    .replaceAll("64444529", "8")
    .replace(archiveSha256, syntheticDigest);
  const root = await fixture(t, {
    [`scripts/${script}`]: copied,
    "scripts/request-pinned-artifact.mjs": await readFile(
      new URL("../../scripts/request-pinned-artifact.mjs", import.meta.url),
      "utf8",
    ),
    "scripts/pull-pinned-image.mjs": await readFile(
      new URL("../../scripts/pull-pinned-image.mjs", import.meta.url),
      "utf8",
    ),
    "dist/src/maven.js": `export { mavenHash } from ${JSON.stringify(new URL("../../dist/src/maven.js", import.meta.url).href)};`,
    "control.mjs": `
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import childProcess from 'node:child_process';
import {readFileSync} from 'node:fs';
import {readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const scenario=${JSON.stringify(scenario)};
const stopped=new Error('synthetic verified archive boundary');
const task='original-swift-preparation';
Object.defineProperty(process,'arch',{value:'arm64'});
process.env.CHECKTRAIL_TEST_TASK=task;
delete process.env.CHECKTRAIL_SWIFTLINT_ARCHIVE;
let fetches=0,unzip=0;
childProcess.execFileSync=(command,args)=>{
  if(command==='docker'){
    assert.deepEqual(args,['image','inspect','checktrail-'+task+':public']);
    throw Object.assign(new Error('synthetic absent image'),{status:1,stderr:'No such image'});
  }
  assert.equal(command,'unzip');
  assert.equal(args[0],'-Z1');
  assert.equal(path.basename(args[1]),'swiftlint.zip');
  assert.equal(readFileSync(args[1],'utf8'),'original');
  unzip++;
  throw stopped;
};
syncBuiltinESMExports();
const payload=scenario==='digest'?'modified':scenario==='short'?'partial':'original';
globalThis.fetch=async(asset,options)=>{
  assert.equal(asset,'https://github.com/realm/SwiftLint/releases/download/0.65.1/swiftlint_linux_arm64.zip');
  assert.equal(options.signal.aborted,false);
  fetches++;
  if(scenario==='retry'&&fetches===1)return new Response('temporary',{status:504});
  if(scenario==='permanent')return new Response('missing',{status:404});
  return new Response(payload);
};
if(scenario==='local'){
  const archive=path.resolve('original-synthetic.zip');
  await writeFile(archive,'original');
  process.env.CHECKTRAIL_SWIFTLINT_ARCHIVE=archive;
}
let failure;
try{await import('./scripts/'+${JSON.stringify(script)})}catch(error){failure=error}
assert(failure,'preparation must stop at the controlled boundary');
if(['retry','direct','local'].includes(scenario)){
  assert.equal(failure,stopped);
  assert.equal(unzip,1);
}else{
  assert.equal(failure.code,'ERR_ASSERTION');
  assert.equal(unzip,0);
  if(scenario==='digest'){
    assert.equal(failure.actual,createHash('sha256').update(payload).digest('hex'));
    assert.equal(failure.expected,${JSON.stringify(syntheticDigest)});
  }else if(scenario==='permanent'){
    assert.equal(failure.actual,404);
    assert.equal(failure.expected,200);
  }else assert.match(failure.message,/byte count|7 !== 8/);
}
assert.equal(fetches,scenario==='local'?0:scenario==='retry'?2:1);
assert.deepEqual(await readdir('.checktrail'),[]);
`,
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [path.join(root, "control.mjs")], {
    cwd: root,
    encoding: "utf8",
    env,
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

for (const script of scripts) {
  test(`${script} retries a transient 504 before validating the pinned archive`, async (t) =>
    control(t, script, "retry"));
  test(`${script} accepts a valid first response without retrying`, async (t) =>
    control(t, script, "direct"));
  test(`${script} preserves the local archive path without fetching`, async (t) =>
    control(t, script, "local"));
  test(`${script} rejects a changed archive digest without retrying or extracting`, async (t) =>
    control(t, script, "digest"));
  test(`${script} rejects a short archive without retrying or extracting`, async (t) =>
    control(t, script, "short"));
  test(`${script} rejects a permanent HTTP response without retrying or extracting`, async (t) =>
    control(t, script, "permanent"));
}
