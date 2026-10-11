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
for(const bad of [{...good,pid:1235},{...good,napiVersion:9},{...good,extra:true},{...good,childrenScope:'all-descendants'},{...good,children:null},{...good,children:{...usage,userCpuMicroseconds:-1}},{...good,children:{...usage,peakRssRaw:Number.MAX_SAFE_INTEGER+1}},{...good,children:{...usage,peakRssKiB:102}},{...good,children:{...usage,peakRssRawUnit:'KiB'}}])assert.throws(()=>parseNativeChildResourceSnapshot(encode(bad),expected));
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
const before=binding.snapshot();assert.equal(before.pid,process.pid);assert.equal(before.children.userCpuMicroseconds+before.children.systemCpuMicroseconds,0);assert.equal(before.children.peakRssKiB,0);
const own=process.resourceUsage().maxRSS;assert.ok(before.self.peakRssKiB>=own-8192&&before.self.peakRssKiB<=own+8192);
const samples=[];for(const allocation of [64,96]){const r=spawnSync(process.execPath,['-e',"const b=Buffer.alloc(Number(process.argv[1])*1024*1024,7),start=performance.now();while(performance.now()-start<100){};const c=process.cpuUsage();console.log(JSON.stringify({pid:process.pid,rss:process.resourceUsage().maxRSS,cpu:c.user+c.system,bytes:b.length}));",String(allocation)],{encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);samples.push(JSON.parse(r.stdout))}
const after=binding.snapshot();assert.equal(after.pid,process.pid);assert.equal(new Set(samples.map(x=>x.pid)).size,2);assert.ok(samples.every(x=>x.pid!==process.pid&&x.rss>=64*1024&&x.cpu>20000));
const childCpu=after.children.userCpuMicroseconds+after.children.systemCpuMicroseconds-before.children.userCpuMicroseconds-before.children.systemCpuMicroseconds,selfCpu=after.self.userCpuMicroseconds+after.self.systemCpuMicroseconds-before.self.userCpuMicroseconds-before.self.systemCpuMicroseconds;
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
for(const value of [{...metadata,sourceSha256:'0'.repeat(64)},{...metadata,binarySha256:'0'.repeat(64)},{...metadata,platform:'win32'},{...metadata,completeNativeArtifactClosure:true},{...metadata,extra:true},{...metadata,selectedNodeHeaders:metadata.selectedNodeHeaders.slice(1)}]){await writeFile(file,JSON.stringify(value));await assert.rejects(loadNativeChildResource(bundle));}await writeFile(file,original);
const bytes=await readFile(binary);await writeFile(binary,Buffer.from('original_invalid_native_binary'));await assert.rejects(loadNativeChildResource(bundle),/binding bytes differ/);await writeFile(binary,bytes);
await chmod(bundle,0o755);await assert.rejects(loadNativeChildResource(bundle),/private and caller owned/);await chmod(bundle,0o700);
const alias=path.join(process.cwd(),'alias');await symlink(bundle,alias,'dir');await assert.rejects(loadNativeChildResource(alias),/must not follow symlinks/);await rm(alias);
const saved=path.join(process.cwd(),'saved.json');await rename(file,saved);await symlink(saved,file);await assert.rejects(loadNativeChildResource(bundle),/must not follow symlinks/);await rm(file);await rename(saved,file);
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
