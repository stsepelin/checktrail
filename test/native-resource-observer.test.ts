import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { fixture } from "./helpers.js";

async function control(t: TestContext, body: string) {
  const root = await fixture(t, {
    "control.mjs": String.raw`import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';import process from 'node:process';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {chmod,link,mkdir,readFile,rename,rm,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';import {spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {runProcess} from ${JSON.stringify(new URL("../src/runner.js", import.meta.url).href)};
const {parseNativeResourceReceipt,readNativeResourceReceipt}=await import(${JSON.stringify(new URL("../../scripts/native-resource-receipt.mjs", import.meta.url).href)});
const prepare=${JSON.stringify(fileURLToPath(new URL("../../scripts/prepare-native-resource-observer.mjs", import.meta.url)))};
const requestId='a'.repeat(32),expected={requestId,platform:'linux'};
const original={schemaVersion:1,requestId,observerPid:1234,childPid:1235,completed:true,exitCode:0,signal:null,wallMicroseconds:100000,userCpuMicroseconds:40000,systemCpuMicroseconds:1000,peakRssRaw:100000,peakRssRawUnit:'KiB',peakRssKiB:100000};
const bytes=value=>Buffer.from(JSON.stringify(value)+'\n');
${body}`,
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [path.join(root, "control.mjs")], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 45000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test("native resource receipts retain failed exit evidence and refuse incomplete duplicate stale counter and unit records", async (t) =>
  control(
    t,
    String.raw`
const good=parseNativeResourceReceipt(bytes(original),expected);
assert.equal(good.scope,'wait4-reaped-child-kernel-counters');
assert.equal(good.summedProcessTreeRss,false);assert.equal(good.descendantCoverage,'unverified');
assert.equal(parseNativeResourceReceipt(bytes({...original,exitCode:7}),expected).exitCode,7);
assert.equal(parseNativeResourceReceipt(bytes({...original,exitCode:null,signal:15}),expected).signal,15);
const darwin={...original,peakRssRaw:102401,peakRssRawUnit:'bytes',peakRssKiB:101};
assert.equal(parseNativeResourceReceipt(bytes(darwin),{...expected,platform:'darwin'}).peakRssKiB,101);
const nearby={...original,observerPid:2,childPid:3,exitCode:255,userCpuMicroseconds:0,systemCpuMicroseconds:0};
assert.equal(parseNativeResourceReceipt(bytes(nearby),expected).exitCode,255);
assert.equal(parseNativeResourceReceipt(bytes({...original,observerPid:1,childPid:2}),expected).observerPid,1,'A real namespace-init observer may have PID 1');
assert.throws(()=>parseNativeResourceReceipt(bytes({...original,observerPid:2,childPid:1}),expected),/process identity invalid/);
assert.equal(parseNativeResourceReceipt(bytes({...original,exitCode:null,signal:64}),expected).signal,64);
for(const field of ['observerPid','childPid']) {
 for(const value of [0,Number.MAX_SAFE_INTEGER+1])
  assert.throws(()=>parseNativeResourceReceipt(bytes({...original,[field]:value}),expected),/process identity invalid/);
}
for(const field of ['userCpuMicroseconds','systemCpuMicroseconds'])
 assert.throws(()=>parseNativeResourceReceipt(bytes({...original,[field]:Number.MAX_SAFE_INTEGER+1}),expected),/counters invalid/);
assert.throws(()=>parseNativeResourceReceipt(bytes({...original,exitCode:256}),expected),/exit accounting differs/);
for(const signal of [0,129])
 assert.throws(()=>parseNativeResourceReceipt(bytes({...original,exitCode:null,signal}),expected),/exit accounting differs/);
const unsafeRaw=Number.MAX_SAFE_INTEGER+1;
assert.throws(()=>parseNativeResourceReceipt(bytes({...darwin,peakRssRaw:unsafeRaw,peakRssKiB:Math.ceil(unsafeRaw/1024)}),{...expected,platform:'darwin'}),/counters invalid/);
for(const value of [
 {...original,completed:false},{...original,observerPid:original.childPid},
 {...original,exitCode:0,signal:15},{...original,exitCode:null,signal:null},
 {...original,userCpuMicroseconds:-1},{...original,userCpuMicroseconds:NaN},
 {...original,peakRssRaw:Number.MAX_SAFE_INTEGER+1},{...original,wallMicroseconds:120000001},
 {...original,peakRssRawUnit:'bytes'},{...original,peakRssKiB:original.peakRssKiB+1},
 {...original,extra:true}
])assert.throws(()=>parseNativeResourceReceipt(bytes(value),expected));
assert.throws(()=>parseNativeResourceReceipt(bytes(original),{...expected,requestId:'b'.repeat(32)}),/request differs/);
assert.throws(()=>parseNativeResourceReceipt(bytes(original),{...expected,platform:'win32'}),/platform unavailable/);
for(const body of [Buffer.alloc(0),Buffer.alloc(2049),Buffer.from('{'),
 Buffer.concat([bytes(original),Buffer.from('\n')]),Buffer.concat([bytes(original),bytes(original)]),
 Buffer.from(JSON.stringify(original).replace('"completed":true','"completed":true,"completed":true')+'\n'),
 Buffer.from([0xff])])assert.throws(()=>parseNativeResourceReceipt(body,expected));
`,
  ));

test("POSIX resource receipt files refuse links public permissions and changed identities without consuming unrelated data", async (t) => {
  if (!["linux", "darwin"].includes(process.platform))
    return t.skip("Native POSIX file ownership unavailable");
  await control(
    t,
    String.raw`
const parent=path.join(process.cwd(),'records');await mkdir(parent,{mode:0o700});
const file=path.join(parent,'owned.json'),unrelated=path.join(process.cwd(),'unrelated.json');
await writeFile(file,bytes(original),{mode:0o600});await writeFile(unrelated,'Original unrelated bytes.\n',{mode:0o600});
assert.equal((await readNativeResourceReceipt(file,expected)).childPid,original.childPid);
await chmod(file,0o644);await assert.rejects(readNativeResourceReceipt(file,expected),/bounded regular file/);await chmod(file,0o600);
const linked=path.join(parent,'second-link.json');await link(file,linked);
await assert.rejects(readNativeResourceReceipt(file,expected),/bounded regular file/);await rm(linked);
const alias=path.join(process.cwd(),'alias');await symlink(parent,alias,'dir');
await assert.rejects(readNativeResourceReceipt(path.join(alias,'owned.json'),expected),/must not follow symlinks/);await rm(alias);
const copy=path.join(parent,'replacement.json');await writeFile(copy,bytes(original),{mode:0o600});
const realRead=fs.promises.readFile;let reads=0;
try {
 fs.promises.readFile=async(...args)=>{const body=await realRead(...args);if(args[0]===file){reads++;await rename(copy,file)}return body};
 syncBuiltinESMExports();await assert.rejects(readNativeResourceReceipt(file,expected),/changed during capture/);assert.equal(reads,1);
} finally {fs.promises.readFile=realRead;syncBuiltinESMExports()}
assert.equal((await readNativeResourceReceipt(file,expected)).childPid,original.childPid);
await writeFile(file,Buffer.alloc(2049));await assert.rejects(readNativeResourceReceipt(file,expected),/bounded regular file/);
assert.equal(await readFile(unrelated,'utf8'),'Original unrelated bytes.\n');
`,
  );
});

test("native POSIX observer accounts literal arguments actual PIDs CPU RSS units failed exits and refused receipt reuse", async (t) => {
  if (!["linux", "darwin"].includes(process.platform))
    return t.skip("Native POSIX resource observer unavailable");
  await control(
    t,
    String.raw`
const directory=path.join(process.cwd(),'artifacts - [literal] 🧪');await mkdir(directory,{mode:0o700});
const prepared=spawnSync(process.execPath,[prepare,directory],{encoding:'utf8',timeout:30000});
assert.equal(prepared.status,0,prepared.stderr);const build=JSON.parse(prepared.stdout);
const observer=path.join(directory,build.binaryPath);const hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(hash(await readFile(observer)),build.binarySha256);
assert.equal(build.completeNativeArtifactClosure,false);assert.equal(build.compilerSdkClosureVerified,false);
const hostile=['literal ; $(never-run) * [not-a-glob]','Unicode 🧪'];
const code="import process from 'node:process';import {performance} from 'node:perf_hooks';const memory=Buffer.alloc(64*1024*1024,7);const start=performance.now();let n=0;while(performance.now()-start<100)n++;let cpu=process.cpuUsage();while(cpu.user<cpu.system+50000){for(let i=0;i<100000;i++)n++;cpu=process.cpuUsage()}const usage=process.resourceUsage();cpu=process.cpuUsage();process.stdout.write(JSON.stringify({pid:process.pid,parent:process.ppid,args:process.argv.slice(1),memory:memory.length,rss:usage.maxRSS,cpu:cpu.user+cpu.system,cpuUser:cpu.user,cpuSystem:cpu.system,n}));";
const request=randomBytes(16).toString('hex'),receiptFile=path.join(process.cwd(),'native.json');
const observedStarted=process.hrtime.bigint();
const observed=await runProcess(process.cwd(),{executable:observer,args:[receiptFile,request,process.execPath,'--input-type=module','-e',code,...hostile],cwd:'.'},{timeoutMs:10000,maxOutputBytes:8192});
const outerWallMicroseconds=Number((process.hrtime.bigint()-observedStarted+999n)/1000n);
assert.equal(observed.exitCode,0,observed.stderr);assert.equal(observed.truncated,false);assert.equal(observed.timedOut,false);assert.equal(observed.cancelled,false);assert.equal(observed.errorCode,undefined);
const sample=JSON.parse(observed.stdout),receipt=await readNativeResourceReceipt(receiptFile,{requestId:request,platform:process.platform});
assert.equal(receipt.childPid,sample.pid);assert.equal(receipt.observerPid,sample.parent);assert.deepEqual(sample.args,hostile);
assert.ok(sample.rss>=64*1024);assert.ok(receipt.peakRssKiB>=sample.rss);assert.ok(receipt.peakRssKiB<=sample.rss+32768,'RSS units must describe KiB rather than raw Darwin bytes');
assert.ok(receipt.userCpuMicroseconds+receipt.systemCpuMicroseconds>=sample.cpu);assert.ok(sample.cpu>20000);assert.ok(receipt.wallMicroseconds>=100000);
assert.ok(sample.cpuUser>sample.cpuSystem&&sample.cpuSystem>0,'The selected workload must arm distinct user and system CPU observations');
assert.ok(receipt.userCpuMicroseconds>=sample.cpuUser,'Kernel user CPU must retain the child user CPU observation');
assert.ok(receipt.systemCpuMicroseconds>=sample.cpuSystem,'Kernel system CPU must retain the child system CPU observation');
assert.ok(receipt.wallMicroseconds<=outerWallMicroseconds,'Observer wall interval must fit within the parent monotonic observation');
assert.equal(receipt.summedProcessTreeRss,false);assert.equal(receipt.exitCode,0);
const before=await readFile(receiptFile);const refused=await runProcess(process.cwd(),{executable:observer,args:[receiptFile,request,process.execPath,'-e',"throw new Error('Must not run when receipt exists')"],cwd:'.'},{timeoutMs:5000,maxOutputBytes:8192});
assert.equal(refused.exitCode,125);assert.equal(refused.stdout,'');assert.deepEqual(await readFile(receiptFile),before);
const failedFile=path.join(process.cwd(),'failed.json'),failedId=randomBytes(16).toString('hex');
const failed=await runProcess(process.cwd(),{executable:observer,args:[failedFile,failedId,process.execPath,'-e','process.exit(7)'],cwd:'.'},{timeoutMs:5000,maxOutputBytes:8192});
assert.equal(failed.exitCode,7);assert.equal((await readNativeResourceReceipt(failedFile,{requestId:failedId,platform:process.platform})).exitCode,7);
const signalFile=path.join(process.cwd(),'signal.json'),signalId=randomBytes(16).toString('hex');
const signalled=await runProcess(process.cwd(),{executable:observer,args:[signalFile,signalId,process.execPath,'-e',"process.kill(process.pid,'SIGTERM')"],cwd:'.'},{timeoutMs:5000,maxOutputBytes:8192});
assert.equal(signalled.exitCode,143);const signalReceipt=await readNativeResourceReceipt(signalFile,{requestId:signalId,platform:process.platform});
assert.equal(signalReceipt.exitCode,null);assert.equal(signalReceipt.signal,15);
assert.equal(hash(await readFile(observer)),build.binarySha256);
`,
  );
});

test("native POSIX observer deadlines cannot supply completed resource evidence and preserve unrelated artifacts", async (t) => {
  if (!["linux", "darwin"].includes(process.platform))
    return t.skip("Native POSIX resource observer unavailable");
  await control(
    t,
    String.raw`
const directory=path.join(process.cwd(),'artifacts');await mkdir(directory,{mode:0o700});
const prepared=spawnSync(process.execPath,[prepare,directory],{encoding:'utf8',timeout:30000});assert.equal(prepared.status,0,prepared.stderr);
const observer=path.join(directory,JSON.parse(prepared.stdout).binaryPath),request=randomBytes(16).toString('hex');
const receiptFile=path.join(process.cwd(),'deadline.json'),unrelated=path.join(process.cwd(),'unrelated.txt');await writeFile(unrelated,'Original preserved bytes.\n');
const observed=await runProcess(process.cwd(),{executable:observer,args:[receiptFile,request,process.execPath,'-e','setInterval(()=>{},1000)'],cwd:'.'},{timeoutMs:150,maxOutputBytes:8192});
assert.equal(observed.timedOut,true);assert.notEqual(observed.exitCode,0);
await assert.rejects(readNativeResourceReceipt(receiptFile,{requestId:request,platform:process.platform}));
assert.equal(await readFile(unrelated,'utf8'),'Original preserved bytes.\n');
`,
  );
});

test("native resource preparation preflights private output and leaves no half-published bundle after actual compiler failure", async (t) => {
  if (!["linux", "darwin"].includes(process.platform))
    return t.skip("Native POSIX compiler preparation unavailable");
  await control(
    t,
    String.raw`
const output=path.join(process.cwd(),'output');await mkdir(output,{mode:0o700});
const marker=path.join(output,'owned-marker.txt');await writeFile(marker,'Original preserved marker.\n');
let refusal=spawnSync(process.execPath,[prepare,output],{encoding:'utf8',timeout:30000});
assert.equal(refusal.status,1);assert.equal(refusal.stdout,'');assert.match(refusal.stderr,/must be empty/);
assert.equal(await readFile(marker,'utf8'),'Original preserved marker.\n');await rm(marker);
await chmod(output,0o755);refusal=spawnSync(process.execPath,[prepare,output],{encoding:'utf8',timeout:30000});
assert.equal(refusal.status,1);assert.equal(refusal.stdout,'');assert.match(refusal.stderr,/must be private/);await chmod(output,0o700);
const alias=path.join(process.cwd(),'output-alias');await symlink(output,alias,'dir');
refusal=spawnSync(process.execPath,[prepare,alias],{encoding:'utf8',timeout:30000});assert.equal(refusal.status,1);assert.equal(refusal.stdout,'');assert.match(refusal.stderr,/must not follow symlinks/);await rm(alias);
const scripts=path.join(process.cwd(),'broken-source');await mkdir(scripts,{mode:0o700});
const copied=path.join(scripts,'prepare-native-resource-observer.mjs');await writeFile(copied,await readFile(prepare));
await writeFile(path.join(scripts,'native-resource-observer.c'),'int main(void) { original_synthetic_compiler_error }\n');
refusal=spawnSync(process.execPath,[copied,output],{encoding:'utf8',timeout:30000});
assert.equal(refusal.status,1);assert.equal(refusal.stdout,'');assert.match(refusal.stderr,/original_synthetic_compiler_error/);
assert.deepEqual(await fs.promises.readdir(output),[],'Compiler failure must publish neither binary nor metadata and remove owned staging');
`,
  );
});
