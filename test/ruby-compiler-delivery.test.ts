import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fixture } from "./helpers.js";
async function control(t: TestContext, body: string) {
  const root = await fixture(t, {
    "control.mjs": String.raw`import assert from 'node:assert/strict';import {Buffer}from'node:buffer';import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';import{createHash}from'node:crypto';import{mkdir,readFile,writeFile,rm,symlink,link,rename}from'node:fs/promises';import path from'node:path';
import{requestRubyCompilerArchive}from ${JSON.stringify(new URL("../../scripts/request-ruby-compiler-archive.mjs", import.meta.url).href)};
assert.equal(process.cwd(),fs.realpathSync(process.argv[2]),'Delivery control must run only in its own fixture');
const root=process.cwd(),bytes=Buffer.from('original'),hash=b=>createHash('sha256').update(b).digest('hex'),pin={path:'zlib-1.3.2-r0.apk',bytes:bytes.length,sha256:hash(bytes)};
const input=(architecture='aarch64',value=pin,local)=>({root,architecture,pin:value,repository:'https://dl-cdn.alpinelinux.org/alpine/v3.24/main/'+architecture+'/',local});
const noFetch={fetchImpl:async()=>assert.fail('Exact bundled or local archives must not fetch')};
const folder=architecture=>path.join(root,'assets/native-tool-archives/alpine-v3.24',architecture);
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
      timeout: 20000,
      maxBuffer: 65536,
    },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
}

test("Ruby compiler delivery uses only exact bundled zlib identities on both architectures and preserves local compiler overrides", async (t) =>
  control(
    t,
    String.raw`
for(const architecture of ['aarch64','x86_64']){await mkdir(folder(architecture),{recursive:true});await writeFile(path.join(folder(architecture),pin.path),bytes);assert.deepEqual(await requestRubyCompilerArchive(input(architecture),noFetch),bytes)}
const local=path.join(root,'local');await mkdir(local);const other={...pin,path:'gcc-15.2.0-r5.apk'};await writeFile(path.join(local,other.path),bytes);assert.deepEqual(await requestRubyCompilerArchive(input('aarch64',other,local),noFetch),bytes);
let calls=0;const near={...pin,path:'zlib-1.3.2-r00.apk'};assert.deepEqual(await requestRubyCompilerArchive(input('aarch64',near),{fetchImpl:async(asset,options)=>{calls++;assert.equal(asset,input().repository+near.path);assert.equal(options.redirect,'error');return new Response(bytes)}}),bytes);assert.equal(calls,1);
`,
  ));

test("Ruby compiler delivery refuses absent changed linked and replaced bundled archives without downloading replacements", async (t) =>
  control(
    t,
    String.raw`
await mkdir(folder('aarch64'),{recursive:true});const file=path.join(folder('aarch64'),pin.path);
await assert.rejects(requestRubyCompilerArchive(input(),noFetch),{code:'ENOENT'});
await writeFile(file,Buffer.from('modified'));await assert.rejects(requestRubyCompilerArchive(input(),noFetch),/digest differs/);await writeFile(file,bytes);
const alias=path.join(root,'alias.apk');await symlink(file,alias);const saved=path.join(root,'saved.apk');await rename(file,saved);await symlink(saved,file);await assert.rejects(requestRubyCompilerArchive(input(),noFetch),/must not follow symlinks/);await rm(file);await rename(saved,file);await rm(alias);
const hard=path.join(root,'hard.apk');await link(file,hard);await assert.rejects(requestRubyCompilerArchive(input(),noFetch),/bounded regular file/);await rm(hard);
const parent=folder('aarch64'),moved=parent+'-moved';await rename(parent,moved);await symlink(moved,parent,'dir');await assert.rejects(requestRubyCompilerArchive(input(),noFetch),/must not follow symlinks/);await rm(parent);await rename(moved,parent);
const copy=path.join(root,'copy.apk');await writeFile(copy,bytes);const original=fs.promises.readFile;let replacements=0;
try{fs.promises.readFile=async(...args)=>{const b=await original(...args);if(args[0]===file){replacements++;await rename(copy,file)}return b};syncBuiltinESMExports();await assert.rejects(requestRubyCompilerArchive(input(),noFetch),/changed during capture/);assert.equal(replacements,1)}finally{fs.promises.readFile=original;syncBuiltinESMExports()}
assert.deepEqual(await requestRubyCompilerArchive(input(),noFetch),bytes);
`,
  ));

test("Ruby compiler delivery rotates exact encoded remote pins and refuses wrong bytes and incompatible source metadata", async (t) =>
  control(
    t,
    String.raw`
const remote={...pin,path:'g++-15.2.0-r5.apk'},urls=[input().repository,'https://dl-4.alpinelinux.org/alpine/v3.24/main/aarch64/','https://mirrors.huaweicloud.com/alpine/v3.24/main/aarch64/'].map(origin=>origin+encodeURIComponent(remote.path));const seen=[],waits=[],signal=new AbortController().signal;
assert.deepEqual(await requestRubyCompilerArchive(input('aarch64',remote),{signal,fetchImpl:async(asset,options)=>{seen.push(asset);assert.equal(options.redirect,'error');assert.equal(options.signal,signal);return seen.length<3?new Response(null,{status:404}):new Response(bytes)},delayImpl:async ms=>waits.push(ms)}),bytes);assert.deepEqual(seen,urls);assert.deepEqual(waits,[1000,3000]);
let calls=0;await assert.rejects(requestRubyCompilerArchive(input('aarch64',remote),{fetchImpl:async()=>{calls++;return new Response('modified')},delayImpl:async()=>assert.fail('Incorrect complete bytes must not retry')}),/digest differs/);assert.equal(calls,1);
for(const bad of [{...input(),architecture:'aarch64-extra'},{...input(),repository:input().repository+'extra/'},{...input(),pin:{...pin,path:'../zlib.apk'}},{...input(),pin:{...pin,sha256:'0'.repeat(63)}},{...input(),pin:{...pin,bytes:64*1024*1024+1}}])await assert.rejects(requestRubyCompilerArchive(bad,noFetch));
`,
  ));

test("Ruby compiler delivery reaches the retained exact musl archive on both architectures without accepting changed or adjacent pins", async (t) =>
  control(
    t,
    String.raw`
const remote={...pin,path:'musl-dev-1.2.6-r2.apk'};
for(const architecture of ['aarch64','x86_64']){
 const urls=[input(architecture).repository,'https://dl-4.alpinelinux.org/alpine/v3.24/main/'+architecture+'/','https://mirrors.huaweicloud.com/alpine/v3.24/main/'+architecture+'/'].map(origin=>origin+remote.path),seen=[],waits=[];
 assert.deepEqual(await requestRubyCompilerArchive(input(architecture,remote),{fetchImpl:async(asset,options)=>{seen.push(asset);assert.equal(options.redirect,'error');assert.equal(asset,urls[seen.length-1]);return seen.length<3?new Response(null,{status:404}):new Response(bytes)},delayImpl:async ms=>waits.push(ms)}),bytes);
 assert.deepEqual(seen,urls);assert.deepEqual(waits,[1000,3000]);
 for(const kind of ['digest','short','overlong','redirect','forbidden']){
  let calls=0;await assert.rejects(requestRubyCompilerArchive(input(architecture,remote),{fetchImpl:async(asset)=>{calls++;assert.equal(asset,urls[calls-1]);if(calls<3)return new Response(null,{status:404});return kind==='redirect'?new Response(null,{status:302}):kind==='forbidden'?new Response(null,{status:403}):new Response(kind==='digest'?Buffer.from('modified'):kind==='short'?bytes.subarray(1):Buffer.concat([bytes,Buffer.from('x')]))},delayImpl:async()=>{}}));assert.equal(calls,3,kind);
 }
 let calls=0;const adjacent={...remote,path:'musl-dev-1.2.6-r20.apk'};
 await assert.rejects(requestRubyCompilerArchive(input(architecture,adjacent),{fetchImpl:async(asset)=>{calls++;assert.ok(asset.endsWith('/'+adjacent.path));return new Response(null,{status:404})},delayImpl:async()=>{}}));assert.equal(calls,3);
}
`,
  ));
