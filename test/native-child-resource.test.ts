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
  ["linux", "darwin"].includes(process.platform) &&
  (await access(path.join(headers, "node_api.h")).then(
    () => true,
    () => false,
  )) &&
  spawnSync("/usr/bin/cc", ["--version"], { timeout: 10000 }).status === 0;
async function control(t: TestContext, body: string) {
  const root = await fixture(t, {
    "control.mjs": String.raw`import assert from'node:assert/strict';import{Buffer}from'node:buffer';import fs from'node:fs';import{syncBuiltinESMExports,createRequire}from'node:module';import{createHash}from'node:crypto';import{spawnSync}from'node:child_process';import{chmod,cp,mkdir,readFile,readdir,realpath,rename,rm,symlink,writeFile}from'node:fs/promises';import path from'node:path';
import{loadNativeChildResource,parseNativeChildResourceSnapshot}from ${JSON.stringify(new URL("../../scripts/native-child-resource.mjs", import.meta.url).href)};
assert.equal(process.cwd(),fs.realpathSync(process.argv[2]),'Child resource control must run only in its own fixture');
const prepare=${JSON.stringify(fileURLToPath(new URL("../../scripts/prepare-native-child-resource.mjs", import.meta.url)))},source=${JSON.stringify(fileURLToPath(new URL("../../scripts/native-child-resource.c", import.meta.url)))},headers=${JSON.stringify(await realpath(headers).catch(() => headers))};
const hash=b=>createHash('sha256').update(b).digest('hex');const usage={userCpuMicroseconds:100,systemCpuMicroseconds:20,peakRssRaw:102401,peakRssKiB:101,peakRssRawUnit:'bytes'};const good={schemaVersion:1,napiVersion:8,pid:1234,selfScope:'RUSAGE_SELF',childrenScope:'RUSAGE_CHILDREN',self:usage,children:{...usage}};const encode=x=>Buffer.from(JSON.stringify(x)+'\n');const expected={pid:1234,platform:'darwin'};
async function prepared(){const directory=path.join(process.cwd(),'bundle - literal 🧪');await mkdir(directory,{mode:0o700});const r=spawnSync(process.execPath,[prepare,directory,headers],{encoding:'utf8',timeout:45000});assert.equal(r.status,0,r.stderr);return {directory,manifest:JSON.parse(r.stdout),bundle:path.join(directory,'native-child-resource')}}
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
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
}

test("native child resource snapshots retain separate kernel scopes and reject stale process units counters duplicate and incomplete records", async (t) =>
  control(
    t,
    String.raw`
const parsed=parseNativeChildResourceSnapshot(encode(good),expected);assert.equal(parsed.summedProcessTreeRss,false);assert.equal(parsed.unreapedDescendantCoverage,'unverified');assert.equal(parsed.children.peakRssKiB,101);
const linux={...good,self:{...usage,peakRssRaw:101,peakRssRawUnit:'KiB'},children:{...usage,peakRssRaw:101,peakRssRawUnit:'KiB'}};assert.equal(parseNativeChildResourceSnapshot(encode(linux),{...expected,platform:'linux'}).children.peakRssKiB,101);
for(const pid of [1,2,1234])assert.equal(parseNativeChildResourceSnapshot(encode({...good,pid}),{...expected,pid}).pid,pid,'Namespace-init and ordinary counter PIDs remain valid');
for(const pid of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'1234'])assert.throws(()=>parseNativeChildResourceSnapshot(encode({...good,pid}),{...expected,pid}),{code:'ERR_ASSERTION'},'Counter PID must be a positive safe integer: '+String(pid));
for(const scope of ['self','children']){
 for(const field of ['userCpuMicroseconds','systemCpuMicroseconds']){
  for(const value of [0,Number.MAX_SAFE_INTEGER]){const valid={...usage,userCpuMicroseconds:0,systemCpuMicroseconds:0,[field]:value};assert.equal(parseNativeChildResourceSnapshot(encode({...good,[scope]:valid}),expected)[scope][field],value,'Valid CPU boundary '+scope+'.'+field)}
  for(const value of [-1,0.5,'100',null,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>parseNativeChildResourceSnapshot(encode({...good,[scope]:{...usage,[field]:value}}),expected),{code:'ERR_ASSERTION'},'Invalid CPU counter '+scope+'.'+field+': '+String(value));
 }
 for(const raw of [0,Number.MAX_SAFE_INTEGER]){const value={...usage,peakRssRaw:raw,peakRssKiB:Math.ceil(raw/1024)};assert.equal(parseNativeChildResourceSnapshot(encode({...good,[scope]:value}),expected)[scope].peakRssRaw,raw,'Valid Darwin RSS boundary '+scope)}
 for(const raw of [-1,0.5,'102401',null,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>parseNativeChildResourceSnapshot(encode({...good,[scope]:{...usage,peakRssRaw:raw,peakRssKiB:Math.ceil(Number(raw)/1024)}}),expected),{code:'ERR_ASSERTION'},'Invalid raw RSS counter '+scope+': '+String(raw));
 for(const value of [null,[],{...usage,extra:true},{...usage,peakRssKiB:102},{...usage,peakRssRawUnit:'KiB'}])assert.throws(()=>parseNativeChildResourceSnapshot(encode({...good,[scope]:value}),expected),{code:'ERR_ASSERTION'},'Invalid counter scope '+scope);
 for(const field of Object.keys(usage)){const missing={...usage};delete missing[field];assert.throws(()=>parseNativeChildResourceSnapshot(encode({...good,[scope]:missing}),expected),{code:'ERR_ASSERTION'},'Missing counter field '+scope+'.'+field)}
}
for(const bad of [{...good,pid:1235},{...good,schemaVersion:2},{...good,napiVersion:9},{...good,extra:true},{...good,selfScope:'all-descendants'},{...good,childrenScope:'all-descendants'}])assert.throws(()=>parseNativeChildResourceSnapshot(encode(bad),expected));
for(const b of [Buffer.alloc(0),Buffer.alloc(4097),Buffer.from('{'),Buffer.concat([encode(good),encode(good)]),Buffer.concat([encode(good),Buffer.from('\n')]),Buffer.from(JSON.stringify(good).replace('"napiVersion":8','"napiVersion":8,"napiVersion":8')+'\n'),Buffer.from([0xff])])assert.throws(()=>parseNativeChildResourceSnapshot(b,expected));
assert.throws(()=>parseNativeChildResourceSnapshot(encode(good),{...expected,platform:'win32'}),/platform unavailable/);
`,
  ));

test("native child resource binding measures actual CPU and largest reaped child RSS across two allocated children without summing their peaks", async (t) => {
  if (!native)
    return t.skip(
      "Native POSIX compiler and explicit Node headers unavailable",
    );
  await control(
    t,
    String.raw`
let bundle=process.argv[3];if(!bundle){const preparedBundle=await prepared(),manifest=preparedBundle.manifest;assert.equal(manifest.napiVersion,8);assert.equal(manifest.selectedNodeHeaders.length,5);assert.equal(manifest.compilerSdkClosureVerified,false);assert.equal(manifest.completeNativeArtifactClosure,false);const worker=spawnSync(process.execPath,[process.argv[1],process.argv[2],preparedBundle.bundle],{cwd:process.cwd(),encoding:'utf8',timeout:15000});assert.equal(worker.status,0,worker.stdout+worker.stderr);process.exit(0)}
const binding=await loadNativeChildResource(bundle);assert.throws(()=>createRequire(import.meta.url)(path.join(bundle,'binding.node')).snapshot(1),/accepts no arguments/);
let ownWitness=process.cpuUsage();const ownDeadline=performance.now()+2000;while(ownWitness.user<=ownWitness.system+50000&&performance.now()<ownDeadline){const spin=performance.now();while(performance.now()-spin<10){};ownWitness=process.cpuUsage()}assert.ok(ownWitness.user>ownWitness.system+50000&&ownWitness.system>0,'Native self CPU fixture must distinguish user from system time');
function snapshot(){const lower=process.cpuUsage(),value=binding.snapshot(),upper=process.cpuUsage();assert.ok(value.self.userCpuMicroseconds>=lower.user&&value.self.userCpuMicroseconds<=upper.user,'Native self user CPU differs from the same-process sample');assert.ok(value.self.systemCpuMicroseconds>=lower.system&&value.self.systemCpuMicroseconds<=upper.system,'Native self system CPU differs from the same-process sample');return value}
const before=snapshot();assert.equal(before.pid,process.pid);assert.equal(before.children.userCpuMicroseconds+before.children.systemCpuMicroseconds,0);assert.equal(before.children.peakRssKiB,0);
const own=process.resourceUsage().maxRSS;assert.ok(before.self.peakRssKiB>=own-8192&&before.self.peakRssKiB<=own+8192);
const samples=[];for(const allocation of [64,96]){const r=spawnSync(process.execPath,['-e',"const b=Buffer.alloc(Number(process.argv[1])*1024*1024,7),start=performance.now();while(performance.now()-start<100){};let c=process.cpuUsage();const deadline=performance.now()+2000;while(c.user<=c.system+50000&&performance.now()<deadline){const spin=performance.now();while(performance.now()-spin<10){};c=process.cpuUsage()}console.log(JSON.stringify({pid:process.pid,rss:process.resourceUsage().maxRSS,cpu:c.user+c.system,cpuUser:c.user,cpuSystem:c.system,bytes:b.length}));",String(allocation)],{encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);samples.push(JSON.parse(r.stdout))}
const after=snapshot();assert.equal(after.pid,process.pid);assert.equal(new Set(samples.map(x=>x.pid)).size,2);assert.deepEqual(samples.map(x=>x.bytes),[64*1024*1024,96*1024*1024]);assert.ok(samples.every(x=>x.pid!==process.pid&&x.rss>=x.bytes/1024&&x.cpu>20000&&x.cpuUser>x.cpuSystem+50000&&x.cpuSystem>0),'Each allocated native child must expose separate positive CPU fields');
const childUser=after.children.userCpuMicroseconds-before.children.userCpuMicroseconds,childSystem=after.children.systemCpuMicroseconds-before.children.systemCpuMicroseconds;
assert.ok(childUser>=samples.reduce((n,x)=>n+x.cpuUser,0),'Native reaped-child user CPU omits sampled work');assert.ok(childSystem>=samples.reduce((n,x)=>n+x.cpuSystem,0),'Native reaped-child system CPU omits sampled work');
const childCpu=childUser+childSystem,selfCpu=after.self.userCpuMicroseconds+after.self.systemCpuMicroseconds-before.self.userCpuMicroseconds-before.self.systemCpuMicroseconds;
assert.ok(childCpu>=samples.reduce((n,x)=>n+x.cpu,0));assert.ok(childCpu>selfCpu);
const largest=Math.max(...samples.map(x=>x.rss));assert.ok(after.children.peakRssKiB>=largest);assert.ok(after.children.peakRssKiB<=largest+32768);assert.ok(after.children.peakRssKiB<samples.reduce((n,x)=>n+x.rss,0));assert.equal(after.summedProcessTreeRss,false);
`,
  );
});

test("native child resource bundle refuses stale source changed binary malformed metadata and linked or public bundles before native loading", async (t) => {
  if (!native)
    return t.skip(
      "Native POSIX compiler and explicit Node headers unavailable",
    );
  await control(
    t,
    String.raw`
const {bundle}=await prepared(),file=path.join(bundle,'build.json'),original=await readFile(file),metadata=JSON.parse(original),binary=path.join(bundle,'binding.node');
const changedHeader=(change)=>metadata.selectedNodeHeaders.map((header,index)=>index===0?{...header,...change}:header);
for(const value of [{...metadata,sourceSha256:'0'.repeat(64)},{...metadata,binarySha256:'0'.repeat(64)},{...metadata,platform:'win32'},{...metadata,architecture:'foreign'},{...metadata,schemaVersion:2},{...metadata,napiVersion:9},{...metadata,binaryPath:'other/binding.node'},{...metadata,preparedByNode:'not-a-version'},{...metadata,preparedByNodeExecutableSha256:'g'.repeat(64)},{...metadata,compilerSha256:'g'.repeat(64)},{...metadata,compilerVersion:''},{...metadata,compilerVersion:'x'.repeat(1025)},{...metadata,completeNativeArtifactClosure:true},{...metadata,compilerSdkClosureVerified:true},{...metadata,selectedNodeHeaderClosureComplete:true},{...metadata,extra:true},{...metadata,selectedNodeHeaders:metadata.selectedNodeHeaders.slice(1)},{...metadata,selectedNodeHeaders:changedHeader({file:'not-the-selected-header.h'})},{...metadata,selectedNodeHeaders:changedHeader({sha256:'g'.repeat(64)})},{...metadata,selectedNodeHeaders:changedHeader({bytes:0})},{...metadata,selectedNodeHeaders:changedHeader({bytes:0.5})},{...metadata,selectedNodeHeaders:changedHeader({bytes:2*1024*1024+1})},{...metadata,selectedNodeHeaders:changedHeader({extra:true})}]){await writeFile(file,JSON.stringify(value));await assert.rejects(loadNativeChildResource(bundle));}await writeFile(file,original);
const bytes=await readFile(binary);await writeFile(binary,Buffer.from('original_invalid_native_binary'));await assert.rejects(loadNativeChildResource(bundle),/binding bytes differ/);await writeFile(binary,bytes);
await chmod(bundle,0o755);await assert.rejects(loadNativeChildResource(bundle),/private and caller owned/);await chmod(bundle,0o700);
const alias=path.join(process.cwd(),'alias');await symlink(bundle,alias,'dir');await assert.rejects(loadNativeChildResource(alias),/must not follow symlinks/);await rm(alias);
const saved=path.join(process.cwd(),'saved.json');await rename(file,saved);await symlink(saved,file);await assert.rejects(loadNativeChildResource(bundle),/must not follow symlinks/);await rm(file);await rename(saved,file);
for(const phase of ['capture','post-load'])for(const target of [file,binary]){
 const savedArtifact=path.join(process.cwd(),phase+'-'+path.basename(target)+'.saved'),sourceBytes=target===file?original:bytes,promises=fs.promises,originalRead=promises.readFile,originalStat=promises.lstat;let calls=0;
 async function replaceArtifact(){await rename(target,savedArtifact);await writeFile(target,phase==='capture'?sourceBytes:Buffer.concat([sourceBytes,Buffer.from(' ')]),{flag:'wx',mode:0o600})}
 try{
  if(phase==='capture')promises.readFile=async(...args)=>{const result=await originalRead(...args);if(String(args[0])===target&&++calls===1)await replaceArtifact();return result};
  else promises.lstat=async(...args)=>{if(String(args[0])===target&&++calls===3)await replaceArtifact();return originalStat(...args)};
  syncBuiltinESMExports();
  await assert.rejects(loadNativeChildResource(bundle),phase==='capture'?/changed during capture/:target===binary?/binding changed during loading/:/build receipt changed during loading/);
  assert.equal(calls,phase==='capture'?1:4,'The intended artifact lifecycle guard must be reached: '+phase+' '+path.basename(target));
 }finally{promises.readFile=originalRead;promises.lstat=originalStat;syncBuiltinESMExports();if(fs.existsSync(savedArtifact)){await rm(target,{force:true});await rename(savedArtifact,target)}}
}
assert.equal((await loadNativeChildResource(bundle)).snapshot().pid,process.pid);
`,
  );
});

test("native child resource preparation preflights all artifacts and removes owned staging after an actual compiler failure", async (t) => {
  if (!native)
    return t.skip(
      "Native POSIX compiler and explicit Node headers unavailable",
    );
  await control(
    t,
    String.raw`
const output=path.join(process.cwd(),'output');await mkdir(output,{mode:0o700});const marker=path.join(output,'keep.txt');await writeFile(marker,'Original preserved bytes.\n');let r=spawnSync(process.execPath,[prepare,output,headers],{encoding:'utf8',timeout:45000});assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/must be empty/);assert.equal(await readFile(marker,'utf8'),'Original preserved bytes.\n');await rm(marker);
const missing=path.join(process.cwd(),'missing-headers');r=spawnSync(process.execPath,[prepare,output,missing],{encoding:'utf8',timeout:45000});assert.equal(r.status,1);assert.equal(r.stdout,'');assert.deepEqual(await readdir(output),[]);
const scripts=path.join(process.cwd(),'broken-source');await mkdir(scripts);const copied=path.join(scripts,'prepare-native-child-resource.mjs');await cp(prepare,copied);await writeFile(path.join(scripts,'native-child-resource.c'),'int main(void) { original_resource_compile_error }\n');r=spawnSync(process.execPath,[copied,output,headers],{encoding:'utf8',timeout:45000});assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/original_resource_compile_error/);assert.deepEqual(await readdir(output),[]);
`,
  );
});
