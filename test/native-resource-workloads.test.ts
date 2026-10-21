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
const stream=bytes=>({bytes:bytes.length,base64:bytes.toString('base64'),sha256:resourceHash(bytes)});
const stdout=Buffer.from('λ\n'),stderr=Buffer.from([0,255,128,10,65]),total=stdout.length+stderr.length;
const capture={completeForObservedStreams:true,observedBytes:total,stdout:stream(stdout),stderr:stream(stderr)},p={exitCode:0,signal:null,outputBytes:total,capturedOutput:capture},check={status:'passed',tests:{passed:1,failed:0,skipped:0},processes:[p]},report={outcome:'passed',sourceChanged:false,sourceError:false,checks:[check]},expected={checks:1,executedTests:1};
const a=summarizeResourceReport(report,expected),reportBytes=Buffer.from(JSON.stringify(report));
assert.deepEqual(a,{checks:1,executedTests:1,observedOutputBytes:total,stdoutBytes:stdout.length,stderrBytes:stderr.length,reportBytes:reportBytes.length,reportSha256:resourceHash(reportBytes)});
function refuses(value,message,counts=expected){assert.throws(()=>summarizeResourceReport(value,counts),{code:'ERR_ASSERTION',message})}
const withCheck=value=>({...report,checks:[value]}),withProcess=value=>withCheck({...check,processes:[value]}),withCapture=value=>withProcess({...p,capturedOutput:value});
for(const outcome of ['failed','incomplete'])refuses({...report,outcome},/validation did not pass/);
refuses({...report,sourceChanged:true},/source changed/);refuses({...report,sourceError:true},/source capture failed/);
refuses({...report,checks:[]},/check accounting differs/);
for(const status of ['failed','incomplete','unavailable','skipped'])refuses(withCheck({...check,status}),/check was incomplete/);
for(const tests of [{passed:0,failed:0,skipped:0},{passed:1,failed:1,skipped:0},{passed:1,failed:0,skipped:1}])refuses(withCheck({...check,tests}),/must execute its original non-skipped test/);
refuses(report,/test accounting differs/,{...expected,executedTests:2});
refuses(withCheck({...check,processes:[]}),/lacks physical process evidence/);
for(const failure of [{exitCode:1},{signal:'SIGTERM'},{errorCode:'EIO'},{timedOut:true},{cancelled:true},{truncated:true}])refuses(withProcess({...p,...failure}),/process did not complete successfully/);
refuses(withCapture({...capture,completeForObservedStreams:false}),/raw output is incomplete/);
refuses(withCapture({...capture,observedBytes:total+1}),/physical output accounting differs/);
refuses(withProcess({...p,outputBytes:total+1}),/observed output differs/);
for(const name of ['stdout','stderr']){
  refuses(withCapture({...capture,[name]:{...capture[name],sha256:'0'.repeat(64)}}),/raw output hash differs/);
  refuses(withCapture({...capture,[name]:{...capture[name],base64:capture[name].base64+'\n'}}),/raw output encoding differs/);
  const changed={...capture,observedBytes:total+1,[name]:{...capture[name],bytes:capture[name].bytes+1}};
  refuses(withProcess({...p,outputBytes:total+1,capturedOutput:changed}),/raw output length differs/);
}
const empty={...capture,observedBytes:0,stdout:stream(Buffer.alloc(0)),stderr:stream(Buffer.alloc(0))},emptyReport=withProcess({...p,outputBytes:0,capturedOutput:empty});
assert.equal(summarizeResourceReport(emptyReport,expected).observedOutputBytes,0);
const twoChecks={...report,checks:[check,{...check,processes:[p,p]}]},two=summarizeResourceReport(twoChecks,{checks:2,executedTests:2});
assert.equal(two.checks,2);assert.equal(two.executedTests,2);assert.equal(two.observedOutputBytes,total*3);assert.equal(two.stdoutBytes,stdout.length*3);assert.equal(two.stderrBytes,stderr.length*3);
const own={userCpuMicroseconds:10,systemCpuMicroseconds:5,peakRssKiB:42},zero={userCpuMicroseconds:0,systemCpuMicroseconds:0,peakRssKiB:0},before={pid:1234,self:own,children:zero},after={pid:1234,self:{userCpuMicroseconds:37,systemCpuMicroseconds:16,peakRssKiB:75},children:{userCpuMicroseconds:200,systemCpuMicroseconds:23,peakRssKiB:100}};
assert.deepEqual(resourceCounterDelta(before,after),{self:{userCpuMicroseconds:27,systemCpuMicroseconds:11,peakRssKiB:75},children:{userCpuMicroseconds:200,systemCpuMicroseconds:23,peakRssKiB:100},summedProcessTreeRss:false,unreapedDescendantCoverage:'unverified'});
const unchanged=resourceCounterDelta(before,before);assert.deepEqual(unchanged.self,{...zero,peakRssKiB:42});assert.deepEqual(unchanged.children,zero);
const max=Number.MAX_SAFE_INTEGER,boundaryBefore={pid:1,self:zero,children:zero},boundaryAfter={pid:1,self:{...zero,userCpuMicroseconds:max,systemCpuMicroseconds:max},children:{...zero,userCpuMicroseconds:max,systemCpuMicroseconds:max}};
const boundary=resourceCounterDelta(boundaryBefore,boundaryAfter);for(const scope of ['self','children'])assert.deepEqual(boundary[scope],{...zero,userCpuMicroseconds:max,systemCpuMicroseconds:max});
assert.throws(()=>resourceCounterDelta(before,{...after,pid:1235}),{code:'ERR_ASSERTION',message:/same worker/});
for(const field of ['userCpuMicroseconds','systemCpuMicroseconds'])assert.throws(()=>resourceCounterDelta({...before,children:{...zero,[field]:1}},after),{code:'ERR_ASSERTION',message:/already reaped a child/});
assert.throws(()=>resourceCounterDelta({...before,children:{...zero,peakRssKiB:1}},after),{code:'ERR_ASSERTION',message:/already has child RSS/});
for(const scope of ['self','children'])for(const field of ['userCpuMicroseconds','systemCpuMicroseconds'])for(const value of [before[scope][field]-1,before[scope][field]+0.5,max+32])assert.throws(()=>resourceCounterDelta(before,{...after,[scope]:{...after[scope],[field]:value}}),{code:'ERR_ASSERTION',message:/CPU counters went backwards/});
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
