import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { fixture } from "./helpers.js";
const headers =
  process.env.CHECKTRAIL_TEST_NODE_HEADERS ??
  path.resolve(
    path.dirname(await realpath(process.execPath)),
    "../include/node",
  );
const native =
  ["darwin", "linux"].includes(process.platform) &&
  (await access(path.join(headers, "node_api.h")).then(
    () => true,
    () => false,
  )) &&
  spawnSync("/usr/bin/cc", ["--version"], { timeout: 10000 }).status === 0;
const go = /^go version go1\.27\.1 /.test(
  spawnSync("go", ["version"], { encoding: "utf8", timeout: 10000 }).stdout ??
    "",
);
async function control(t: TestContext, body: string) {
  const root = await fixture(t, {
    "control.mjs": String.raw`import assert from'node:assert/strict';import{Buffer}from'node:buffer';import fs from'node:fs';import{createHash}from'node:crypto';import{mkdir,readFile,readdir,realpath,writeFile}from'node:fs/promises';import path from'node:path';import{spawnSync}from'node:child_process';
import{resourceCounterDelta,summarizeResourceReport,createNativeResourceFixture,resourceHash}from ${JSON.stringify(new URL("../../scripts/native-resource-workloads.mjs", import.meta.url).href)};
import{measureNativeResourceSample}from ${JSON.stringify(new URL("../../scripts/measure-native-resources.mjs", import.meta.url).href)};
assert.equal(process.cwd(),fs.realpathSync(process.argv[2]),'Workload controls must remain in their own fixture');
const scripts=${JSON.stringify(fileURLToPath(new URL("../../scripts/", import.meta.url)))},headers=${JSON.stringify(await realpath(headers).catch(() => headers))};
async function tools(){const counter=path.join(process.cwd(),'counter'),outer=path.join(process.cwd(),'observer');await mkdir(counter,{mode:0o700});await mkdir(outer,{mode:0o700});for(const [name,args] of [['prepare-native-child-resource.mjs',[counter,headers]],['prepare-native-resource-observer.mjs',[outer]]]){const r=spawnSync(process.execPath,[path.join(scripts,name),...args],{encoding:'utf8',timeout:45000});assert.equal(r.status,0,r.stderr)}return {bundle:path.join(counter,'native-child-resource'),observer:path.join(outer,'native-resource-observer/observer')}}
async function workload(id,tooling,label=id){const root=path.join(process.cwd(),label),directory=path.join(process.cwd(),label+'-sample');await mkdir(root,{mode:0o700});await mkdir(directory,{mode:0o700});const expected=await createNativeResourceFixture(root,id);return {root,directory,expected,...tooling}}
${body}`,
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(
    process.execPath,
    [path.join(root, "control.mjs"), root],
    {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
}

test("native resource workload accounting rejects failed stale empty skipped omitted and physically inconsistent reports", async (t) =>
  control(
    t,
    String.raw`
const bytes=Buffer.from('λ\n'),capture={completeForObservedStreams:true,observedBytes:bytes.length,stdout:{bytes:bytes.length,base64:bytes.toString('base64'),sha256:resourceHash(bytes)},stderr:{bytes:0,base64:'',sha256:resourceHash(Buffer.alloc(0))}},p={exitCode:0,signal:null,outputBytes:bytes.length,capturedOutput:capture},check={status:'passed',tests:{passed:1,failed:0,skipped:0},processes:[p]},report={outcome:'passed',sourceChanged:false,sourceError:false,checks:[check]},expected={checks:1,executedTests:1};const a=summarizeResourceReport(report,expected);assert.equal(a.observedOutputBytes,bytes.length);assert.equal(a.reportBytes,Buffer.byteLength(JSON.stringify(report)));
for(const value of [{...report,outcome:'failed'},{...report,outcome:'incomplete'},{...report,sourceChanged:true},{...report,sourceError:true},{...report,checks:[]},{...report,checks:[{...check,status:'unavailable'}]},{...report,checks:[{...check,tests:{passed:0,failed:0,skipped:1}}]},{...report,checks:[{...check,processes:[]}]},{...report,checks:[{...check,processes:[{...p,truncated:true}]}]},{...report,checks:[{...check,processes:[{...p,capturedOutput:{...capture,completeForObservedStreams:false}}]}]},{...report,checks:[{...check,processes:[{...p,outputBytes:99}]}]},{...report,checks:[{...check,processes:[{...p,capturedOutput:{...capture,stdout:{...capture.stdout,sha256:'0'.repeat(64)}}}]}]}])assert.throws(()=>summarizeResourceReport(value,expected));
const own={userCpuMicroseconds:10,systemCpuMicroseconds:5,peakRssKiB:42},zero={userCpuMicroseconds:0,systemCpuMicroseconds:0,peakRssKiB:0},before={pid:1234,self:own,children:zero},after={pid:1234,self:{...own,userCpuMicroseconds:30},children:{userCpuMicroseconds:200,systemCpuMicroseconds:20,peakRssKiB:100}};const delta=resourceCounterDelta(before,after);assert.equal(delta.self.userCpuMicroseconds,20);assert.equal(delta.children.userCpuMicroseconds,200);assert.equal(delta.summedProcessTreeRss,false);
for(const [b,a] of [[before,{...after,pid:1235}],[{...before,children:{...zero,userCpuMicroseconds:1}},after],[{...before,children:{...zero,peakRssKiB:1}},after],[before,{...after,self:{...own,userCpuMicroseconds:1}}]])assert.throws(()=>resourceCounterDelta(b,a));
`,
  ));

test("native resource workloads execute small large and polyglot original tests with fresh counters exact output and reconstructed multi-chunk archive storage", async (t) => {
  if (!native || !go)
    return t.skip(
      "Native POSIX compiler, explicit Node headers or Go 1.27.1 unavailable",
    );
  await control(
    t,
    String.raw`const tooling=await tools(),rows=[];for(const id of ['small','large','polyglot']){const spec=await workload(id,tooling),row=await measureNativeResourceSample(spec);assert.equal(row.executedTests,id==='polyglot'?2:1);assert.equal(row.snapshots.before.children.userCpuMicroseconds+row.snapshots.before.children.systemCpuMicroseconds,0);assert.equal(row.snapshots.before.children.peakRssKiB,0);assert.ok(row.counters.children.userCpuMicroseconds+row.counters.children.systemCpuMicroseconds>0);assert.ok(row.counters.children.peakRssKiB>0);assert.equal(row.observer.childPid,row.pid);assert.equal(row.workerTransport.completeForObservedStreams,true);assert.equal(row.storage.physicalStoreBytes,row.storage.physicalStoreFiles.reduce((n,f)=>n+f.bytes,0));assert.ok(row.storage.physicalStoreBytes>0);assert.ok(!JSON.stringify(row).includes(process.cwd()));assert.ok(!JSON.stringify(row).includes('λ🚀'));rows.push(row)}assert.ok(rows[1].reportBytes>rows[0].reportBytes);assert.ok(rows[1].observedOutputBytes>rows[0].observedOutputBytes);assert.equal(rows[1].storage.archiveBytes,rows[1].reportBytes);assert.equal(rows[1].storage.reconstructedSha256,rows[1].reportSha256);assert.ok(rows[1].storage.archiveChunks>1);assert.equal(rows[0].storage.archiveBytes,0);`,
  );
});

test("native resource workload measurement refuses an original broken test and changed source without returning successful measurements", async (t) => {
  if (!native)
    return t.skip(
      "Native POSIX compiler and explicit Node headers unavailable",
    );
  await control(
    t,
    String.raw`const tooling=await tools();for(const variant of ['broken','stale']){const spec=await workload('small',tooling,variant),testFile=path.join(spec.root,'values.test.js');if(variant==='broken')await writeFile(path.join(spec.root,'value-0000.js'),'export const value = 100;\n');else {const original=await readFile(testFile,'utf8');await writeFile(testFile,"import{writeFileSync}from'node:fs';writeFileSync('value-0000.js','export const value = 0; // changed during native test\\n');\n"+original)}await assert.rejects(measureNativeResourceSample(spec),error=>{assert.equal(error.code,'ERR_ASSERTION');assert.match(error.message,variant==='broken'?/Resource workload validation did not pass/:/Resource workload source changed/);return true});assert.deepEqual((await readdir(spec.directory)).sort(),['fixture.json','observer.json']);}`,
  );
});

test("native resource workload prerequisite guards refuse changed prepared binary before executing the synthetic test or creating task storage", async (t) => {
  if (!native)
    return t.skip(
      "Native POSIX compiler and explicit Node headers unavailable",
    );
  await control(
    t,
    String.raw`const tooling=await tools(),spec=await workload('small',tooling);await writeFile(path.join(spec.root,'values.test.js'),"import{writeFileSync}from'node:fs';writeFileSync('execution-marker.txt','must not execute');\n");const file=path.join(tooling.bundle,'build.json'),metadata=JSON.parse(await readFile(file,'utf8'));metadata.binarySha256='0'.repeat(64);await writeFile(file,JSON.stringify(metadata));await assert.rejects(measureNativeResourceSample(spec),/binding bytes differ/);assert.equal(fs.existsSync(path.join(spec.root,'execution-marker.txt')),false);assert.equal(fs.existsSync(path.join(spec.directory,'tasks')),false);`,
  );
});
