import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fixture } from "./helpers.js";

async function control(t: TestContext, body: string) {
  const root = await fixture(t, {
    "control.mjs": `import assert from 'node:assert/strict';import {requestPinnedArtifactBytes} from ${JSON.stringify(new URL("../../scripts/request-pinned-artifact.mjs", import.meta.url).href)};\n${body}`,
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [path.join(root, "control.mjs")], {
    encoding: "utf8",
    env,
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
const item = "{asset:'https://get.helm.sh/original-synthetic',bytes:8}";

test("pinned artifact preparation retries bounded transport failures with fresh bytes and one deadline", async (t) =>
  control(
    t,
    `
 const item=${item};const signal=new AbortController().signal;const waits=[],signals=[],retries=[];let calls=0;
 const failure=Object.assign(new AggregateError([new Error('synthetic connection timeout')],'synthetic'),{code:'ETIMEDOUT'});
 const result=await requestPinnedArtifactBytes(item,{signal,fetchImpl:async(asset,options)=>{assert.equal(asset,item.asset);signals.push(options.signal);if(++calls<3)throw new TypeError('fetch failed',{cause:failure});return new Response('original')},delayImpl:async ms=>waits.push(ms),onRetry:info=>retries.push(info)});
 assert.equal(result.toString(),'original');assert.equal(calls,3);assert.deepEqual(waits,[1000,3000]);assert.ok(signals.every(value=>value===signal));assert.deepEqual(retries,[{attempt:1,waitMs:1000},{attempt:2,waitMs:3000}]);
 let exhausted=0;const last=Object.assign(new Error('synthetic reset'),{code:'ECONNRESET'});const exhaustedWaits=[];
 await assert.rejects(requestPinnedArtifactBytes(item,{fetchImpl:async()=>{exhausted++;throw last},delayImpl:async ms=>exhaustedWaits.push(ms)}),error=>error===last);assert.equal(exhausted,3);assert.deepEqual(exhaustedWaits,[1000,3000]);
 let streams=0;const recovered=await requestPinnedArtifactBytes(item,{fetchImpl:async()=>{if(streams++===0)return new Response(new ReadableStream({pull(c){if(!this.sent){this.sent=true;c.enqueue(new TextEncoder().encode('partial'))}else c.error(Object.assign(new Error('synthetic socket'),{code:'UND_ERR_SOCKET'}))}}));return new Response('original')},delayImpl:async()=>{}});assert.equal(streams,2);assert.equal(recovered.toString(),'original');
`,
  ));

test("pinned artifact preparation does not retry permanent HTTP malformed size or unknown failures", async (t) =>
  control(
    t,
    `
 const item=${item};
 for(const [body,reason] of [[()=>new Response('original',{status:404}),/HTTP response/],[()=>new Response('original',{status:501}),/HTTP response/],[()=>new Response(null),/no body/],[()=>new Response('short'),/byte count/],[()=>new Response('too many bytes'),/byte limit/]]){
  let calls=0;await assert.rejects(requestPinnedArtifactBytes(item,{fetchImpl:async()=>{calls++;return body()},delayImpl:async()=>{throw new Error('must not retry integrity or HTTP failures')}}),reason);assert.equal(calls,1);
 }
 for(const failure of [new TypeError('ETIMEDOUT without a transport code'),Object.assign(new Error('unknown'),{code:'ETIMEDOUT_EXTRA'}),Object.assign(new Error('integrity'),{code:'ERR_ASSERTION',cause:{code:'ETIMEDOUT'}})]){
  let calls=0;await assert.rejects(requestPinnedArtifactBytes(item,{fetchImpl:async()=>{calls++;throw failure},delayImpl:async()=>{throw new Error('must not retry unknown failures')}}),error=>error===failure);assert.equal(calls,1);
 }
 for(const bytes of [0,-1,1.5,128*1024*1024+1]){
  let calls=0;await assert.rejects(requestPinnedArtifactBytes({...item,bytes},{fetchImpl:async()=>{calls++;return new Response('original')}}));assert.equal(calls,0);
 }
 let validCalls=0;const valid=await requestPinnedArtifactBytes(item,{fetchImpl:async()=>{validCalls++;return new Response('original')},delayImpl:async()=>{throw new Error('must not retry valid bytes')}});assert.equal(validCalls,1);assert.equal(valid.toString(),'original');
 let cancelled=0;const response=new Response(new ReadableStream({cancel(){cancelled++}}),{status:404});await assert.rejects(requestPinnedArtifactBytes(item,{fetchImpl:async()=>response}));assert.equal(cancelled,1);
`,
  ));

test("pinned artifact preparation stops retries and results when the shared deadline aborts", async (t) =>
  control(
    t,
    `
 const item=${item};const failure=new Error('synthetic deadline');let calls=0;
 await assert.rejects(requestPinnedArtifactBytes(item,{signal:AbortSignal.abort(failure),fetchImpl:async()=>{calls++;return new Response('original')}}),error=>error===failure);assert.equal(calls,0);
 const controller=new AbortController();let attempts=0;
 await assert.rejects(requestPinnedArtifactBytes(item,{signal:controller.signal,fetchImpl:async()=>{attempts++;throw Object.assign(new Error('synthetic timeout'),{code:'ETIMEDOUT'})},delayImpl:async()=>controller.abort(failure)}),error=>error===failure);assert.equal(attempts,1);
 const duringBody=new AbortController();let pulls=0;await assert.rejects(requestPinnedArtifactBytes(item,{signal:duringBody.signal,fetchImpl:async()=>new Response(new ReadableStream({async pull(c){if(pulls++===0)c.enqueue(new TextEncoder().encode('original'));else {await new Promise(resolve=>setTimeout(resolve,10));duringBody.abort(failure);c.close()}}}))}),error=>error===failure);
`,
  ));

async function preparationControl(
  t: TestContext,
  badDigest: boolean,
  invalidBase?: string,
) {
  const { readFile } = await import("node:fs/promises");
  const source = new URL(
    "../../scripts/prepare-infra-tools-runtime.mjs",
    import.meta.url,
  );
  const helper = new URL(
    "../../scripts/request-pinned-artifact.mjs",
    import.meta.url,
  );
  const maven = new URL("../../dist/src/maven.js", import.meta.url);
  const root = await fixture(t, {
    "scripts/prepare-infra-tools-runtime.mjs": await readFile(source, "utf8"),
    "scripts/request-pinned-artifact.mjs": await readFile(helper, "utf8"),
    "scripts/pull-pinned-image.mjs": await readFile(
      new URL("../../scripts/pull-pinned-image.mjs", import.meta.url),
      "utf8",
    ),
    "dist/src/maven.js": `export {mavenHash} from ${JSON.stringify(maven.href)};`,
    "control.mjs": `
 import assert from 'node:assert/strict';import {readFile,writeFile,readdir,access} from 'node:fs/promises';import {createHash} from 'node:crypto';import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {setTimeout} from 'node:timers/promises';
 Object.defineProperty(process,'arch',{value:'arm64'});process.env.CHECKTRAIL_TEST_TASK='original-infra-preparation';delete process.env.CHECKTRAIL_INFRA_ARTIFACT_DIRECTORY;
 childProcess.execFileSync=(command,args)=>{assert.equal(command,'docker');assert.deepEqual(args,['image','inspect','checktrail-original-infra-preparation:public']);throw Object.assign(new Error('synthetic absent image'),{status:1,stderr:'No such image'})};syncBuiltinESMExports();
 const digest=createHash('sha256').update('original').digest('hex');const badDigest=${badDigest};
 const schemas=badDigest?[{file:'original.json',asset:'https://get.helm.sh/original',bytes:8,sha256:'0'.repeat(64)}]:[{file:'failed.json',asset:'https://get.helm.sh/failed',bytes:8,sha256:digest},{file:'delayed.json',asset:'https://get.helm.sh/delayed',bytes:8,sha256:digest}];
 await writeFile(new URL('./scripts/infra-tools-artifacts.json',import.meta.url),JSON.stringify({schemaVersion:1,base:${JSON.stringify(invalidBase)} ?? 'public.ecr.aws/docker/library/node@sha256:'+'0'.repeat(64),tools:[],schemas}));
 let calls=0,finished=false;
 globalThis.fetch=async asset=>{calls++;if(badDigest)return new Response('original');if(asset.endsWith('/failed'))return new Response('not found',{status:404});return new Response(new ReadableStream({async start(c){await setTimeout(50);c.enqueue(new TextEncoder().encode('original'));c.close();finished=true}}))};
 if (${JSON.stringify(invalidBase !== undefined)}) { let refusal; try { await import('./scripts/prepare-infra-tools-runtime.mjs'); } catch (error) { refusal=error; } assert.equal(calls,0,'Invalid image identifier must fail before artifact downloads'); assert.equal(refusal?.code,'ERR_ASSERTION'); await assert.rejects(access(new URL('./.checktrail/',import.meta.url)), {code:'ENOENT'}); process.exit(0); }
 await assert.rejects(import('./scripts/prepare-infra-tools-runtime.mjs'),error=>{const failures=error instanceof AggregateError?error.errors:[error];return failures.length===1 && failures[0].code==='ERR_ASSERTION' && (!badDigest || error instanceof AggregateError)});
 assert.equal(calls,badDigest?1:2);if(!badDigest)assert.equal(finished,true,'every in-flight download must settle before cleanup returns');
 assert.deepEqual(await readdir(new URL('./.checktrail/',import.meta.url)),[]);await assert.rejects(access(new URL('./.checktrail/infra-tools-runtime',import.meta.url)),{code:'ENOENT'});
 `,
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [path.join(root, "control.mjs")], {
    encoding: "utf8",
    env,
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test("infra preparation drains concurrent downloads before failure cleanup", async (t) =>
  preparationControl(t, false));
test("infra preparation rejects incorrect pinned digests without retries or publication", async (t) =>
  preparationControl(t, true));

test("pinned artifact preparation retries only transient server statuses without reading failed bodies", async (t) =>
  control(
    t,
    `
 const item=${item};
 for(const status of [500,502,503,504]) {
  let calls=0,cancelled=0;const waits=[];
  const result=await requestPinnedArtifactBytes(item,{fetchImpl:async()=>{calls++;return calls<3?new Response(new ReadableStream({cancel(){cancelled++}}),{status}):new Response('original')},delayImpl:async ms=>waits.push(ms)});
  assert.equal(result.toString(),'original');assert.equal(calls,3);assert.equal(cancelled,2);assert.deepEqual(waits,[1000,3000]);
  calls=0;const exhausted=[];await assert.rejects(requestPinnedArtifactBytes(item,{fetchImpl:async()=>{calls++;return new Response('untrusted error body',{status})},delayImpl:async ms=>exhausted.push(ms)}),new RegExp('HTTP '+status));assert.equal(calls,3);assert.deepEqual(exhausted,[1000,3000]);
 }
 for(const status of [301,400,401,403,404,429,501,505]) {
  let calls=0;await assert.rejects(requestPinnedArtifactBytes(item,{fetchImpl:async()=>{calls++;return new Response('original',{status})},delayImpl:async()=>{throw new Error('permanent status must not retry')}}),/HTTP response/);assert.equal(calls,1);
 }
 const controller=new AbortController();const deadline=new Error('synthetic deadline');let calls=0;
 await assert.rejects(requestPinnedArtifactBytes(item,{signal:controller.signal,fetchImpl:async()=>{calls++;return new Response('original',{status:500})},delayImpl:async()=>controller.abort(deadline)}),error=>error===deadline);assert.equal(calls,1);
`,
  ));

test("infra preparation rejects near-miss registry image identifiers before downloads", async (t) => {
  const digest = "0".repeat(64);
  for (const invalid of [
    `public.ecr.aws.attacker.invalid/docker/library/node@sha256:${digest}`,
    `public.ecr.aws/docker/library/node-extra@sha256:${digest}`,
    `public.ecr.aws/docker/library/node@sha256:${digest}:latest`,
    `public.ecr.aws/docker/library/node@sha256:${digest}\n`,
    `node@sha256:${digest}`,
  ]) {
    await preparationControl(t, false, invalid);
  }
});

test("pinned artifact preparation optionally retries exact not-found delivery without weakening defaults or byte bounds", async (t) =>
  control(
    t,
    `
 const item=${item};const signal=new AbortController().signal;let calls=0,cancelled=0;const waits=[];
 const result=await requestPinnedArtifactBytes(item,{retryNotFound:true,signal,fetchImpl:async(asset,options)=>{assert.equal(asset,item.asset);assert.equal(options.signal,signal);calls++;return calls<3?new Response(new ReadableStream({cancel(){cancelled++}}),{status:404}):new Response('original')},delayImpl:async ms=>waits.push(ms)});
 assert.equal(result.toString(),'original');assert.equal(calls,3);assert.equal(cancelled,2);assert.deepEqual(waits,[1000,3000]);
 let exhausted=0;await assert.rejects(requestPinnedArtifactBytes(item,{retryNotFound:true,fetchImpl:async()=>{exhausted++;return new Response(null,{status:404})},delayImpl:async()=>{}}),/HTTP 404/);assert.equal(exhausted,3);
 for(const value of ['true',1,null]){let count=0;await assert.rejects(requestPinnedArtifactBytes(item,{retryNotFound:value,fetchImpl:async()=>{count++;return new Response('original')}}));assert.equal(count,0);}
 let invalid=0;await assert.rejects(requestPinnedArtifactBytes(item,{retryNotFound:true,fetchImpl:async()=>{invalid++;return new Response('short')},delayImpl:async()=>{throw Error('must not retry invalid bytes')}}),/byte count/);assert.equal(invalid,1);
 const controller=new AbortController();let attempts=0;await assert.rejects(requestPinnedArtifactBytes(item,{retryNotFound:true,signal:controller.signal,fetchImpl:async()=>{attempts++;return new Response(null,{status:404})},delayImpl:async()=>controller.abort(new Error('original deadline'))}),/original deadline/);assert.equal(attempts,1);
`,
  ));

test("Ruby preparation recovers pinned delivery and still refuses changed bytes before publishing", async (t) => {
  const { readFile } = await import("node:fs/promises");
  for (const badDigest of [false, true]) {
    const files: Record<string, string> = {};
    for (const name of [
      "prepare-ruby-tools-runtime.mjs",
      "request-pinned-artifact.mjs",
      "request-ruby-compiler-archive.mjs",
      "pull-pinned-image.mjs",
      "ruby-tools-archives.json",
    ])
      files["scripts/" + name] = await readFile(
        new URL("../../scripts/" + name, import.meta.url),
        "utf8",
      );
    files["dist/src/maven.js"] =
      `export {mavenHash,verifyMavenTree} from ${JSON.stringify(new URL("../../dist/src/maven.js", import.meta.url).href)};`;
    files[
      "assets/native-tool-archives/alpine-v3.24/aarch64/zlib-1.3.2-r0.apk"
    ] = "original";
    files["control.mjs"] = `
import assert from 'node:assert/strict';import {readFile,writeFile,readdir,access} from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
process.env.CHECKTRAIL_TEST_TASK='original-ruby-preparation';delete process.env.CHECKTRAIL_RUBY_APK_DIRECTORY;
const task=process.env.CHECKTRAIL_TEST_TASK,tag='checktrail-'+task+':public',image='sha256:'+'1'.repeat(64),root=new URL('./',import.meta.url);
const digest=createHash('sha256').update('original').digest('hex');const manifest=JSON.parse(await readFile(new URL('./scripts/ruby-tools-archives.json',root),'utf8'));
for(const architecture of Object.values(manifest.architectures)) for(const pin of architecture.archives){pin.bytes=8;pin.sha256=digest;}
await writeFile(new URL('./scripts/ruby-tools-archives.json',root),JSON.stringify(manifest));
const pins=manifest.architectures.aarch64.archives,primary=manifest.architectures.aarch64.repository,mirror='https://dl-4.alpinelinux.org/alpine/v3.24/main/aarch64/',secondMirror='https://mirrors.huaweicloud.com/alpine/v3.24/main/aarch64/';let built=false,pulls=0;const requests=new Map(),signals=new Map(),deliveryUrls=new Map();const badDigest=${badDigest};
const allowed=new Map(pins.flatMap(pin=>[[primary+encodeURIComponent(pin.path),pin],[mirror+encodeURIComponent(pin.path),pin],[secondMirror+encodeURIComponent(pin.path),pin]]));
childProcess.execFileSync=(command,args)=>{
 assert.equal(command,'docker');
 if(args[0]==='pull'){assert.equal(args.length,2);assert.equal(args[1],['docker.io/library/ruby@sha256:79bf10b28c9d98b7b3cffda01aba8190aa1c1c48513d205ec93372a0e2f010e3','docker.io/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'][pulls]);pulls++;return ''; }
 if(args[0]==='image'&&args[1]==='inspect'){assert.deepEqual(args,['image','inspect',tag]);if(!built)throw Object.assign(new Error('absent'),{status:1,stderr:'No such image'});return JSON.stringify([{Id:image,Config:{Labels:{'checktrail.task':task}}}]);}
 if(args[0]==='run'){assert.ok(args.includes('--rm'));assert.equal(args[args.indexOf('--network')+1],'none');if(args.at(-1)==='ruby --disable-gems --version; apk --print-arch; cat /etc/alpine-release')return 'ruby 4.0.7 original\\naarch64\\n3.24.2\\n';if(args.at(-1)==='--version')return '10.9.8\\n';assert.equal(args.at(-1),'node --version; ruby --disable-gems --version; gcc -dumpfullversion; make --version');return 'v22.23.2\\nruby 4.0.7 original\\n15.2.0\\nGNU Make 4.4.1\\n';}
 if(args[0]==='build'){assert.equal(badDigest,false,'Changed archive bytes must never reach the build');assert.equal(args[args.indexOf('--network')+1],'none');assert.equal(requests.size,18);built=true;return '';}
 throw Error('unexpected docker call '+JSON.stringify(args));
};syncBuiltinESMExports();
globalThis.fetch=async(asset,options)=>{
 const pin=allowed.get(asset);assert.ok(pin,'Must retrieve only an enumerated exact encoded pinned archive URL');const urls=deliveryUrls.get(pin.path)||[];assert.equal(asset,([primary,mirror,secondMirror][urls.length])+encodeURIComponent(pin.path));urls.push(asset);deliveryUrls.set(pin.path,urls);assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);if(signals.has(pin.path))assert.equal(options.signal,signals.get(pin.path));else signals.set(pin.path,options.signal);
 const count=(requests.get(pin.path)||0)+1;requests.set(pin.path,count);
 if(pin.path==='g++-15.2.0-r5.apk'&&count===3)assert.deepEqual(deliveryUrls.get(pin.path),[primary,mirror,secondMirror].map(origin=>origin+encodeURIComponent(pin.path)));
 if(pin.path==='g++-15.2.0-r5.apk'&&count<3)return new Response(null,{status:404});
 return new Response(badDigest&&pin.path==='g++-15.2.0-r5.apk'?'modified':'original');
};
if(badDigest){await assert.rejects(import('./scripts/prepare-ruby-tools-runtime.mjs'),{code:'ERR_ASSERTION'});assert.equal(built,false);assert.equal(requests.size,4);assert.deepEqual(await readdir(new URL('./.checktrail/',root)),[]);await assert.rejects(access(new URL('./.checktrail/ruby-tools-runtime',root)),{code:'ENOENT'});}
else {await import('./scripts/prepare-ruby-tools-runtime.mjs');assert.equal(built,true);const identity=JSON.parse(await readFile(new URL('./.checktrail/ruby-tools-runtime/identity.json',root),'utf8'));assert.equal(identity.files.length,19);assert.ok(identity.files.every(pin=>pin.sha256===digest&&pin.bytes===8));assert.equal(identity.transitiveIndexResolution,false);assert.equal(identity.apkSignatureChecksDisabled,false);assert.equal(identity.buildNetwork,'none');}
assert.equal(pulls,2);assert.equal(requests.has('zlib-1.3.2-r0.apk'),false);assert.equal(requests.get('g++-15.2.0-r5.apk'),3);assert.ok([...requests].every(([name,count])=>name==='g++-15.2.0-r5.apk'?count===3:count===1));
`;
    const root = await fixture(t, files);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [path.join(root, "control.mjs")],
      { encoding: "utf8", env, timeout: 20000 },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

test("pinned artifact preparation rotates distinct exact mirrors within the original attempt and deadline budget", async (t) =>
  control(
    t,
    `
 const item={asset:'https://primary.invalid/exact%2Barchive.bin?revision=1',fallbackAssets:['https://first.invalid/exact%2Barchive.bin?revision=1','https://second.invalid/exact%2Barchive.bin?revision=1'],bytes:8};
 for(const kind of ['http','transport']) {
  const seen=[],waits=[],signal=new AbortController().signal;let cancelled=0;
  const result=await requestPinnedArtifactBytes(item,{retryNotFound:true,signal,fetchImpl:async(asset,options)=>{assert.equal(options.signal,signal);seen.push(asset);if(seen.length===3)return new Response('original');if(kind==='transport')throw Object.assign(new Error('original timeout'),{code:'ETIMEDOUT'});return new Response(new ReadableStream({cancel(){cancelled++}}),{status:404});},delayImpl:async ms=>waits.push(ms)});
  assert.deepEqual(seen,[item.asset,...item.fallbackAssets]);assert.deepEqual(waits,[1000,3000]);assert.equal(result.toString(),'original');assert.equal(cancelled,kind==='http'?2:0);
 }
 const seen=[];await assert.rejects(requestPinnedArtifactBytes(item,{retryNotFound:true,fetchImpl:async asset=>{seen.push(asset);return new Response(null,{status:404})},delayImpl:async()=>{}}),/HTTP 404/);assert.deepEqual(seen,[item.asset,...item.fallbackAssets]);
 let calls=0;await assert.rejects(requestPinnedArtifactBytes(item,{fetchImpl:async()=>{calls++;return new Response(null,{status:404})},delayImpl:async()=>assert.fail('Default permanent HTTP must not retry')}),/HTTP response/);assert.equal(calls,1);
 calls=0;await assert.rejects(requestPinnedArtifactBytes(item,{fetchImpl:async()=>{calls++;return new Response('short')},delayImpl:async()=>assert.fail('Incorrect bytes must not reach a mirror')}),/byte count/);assert.equal(calls,1);
 const controller=new AbortController();calls=0;await assert.rejects(requestPinnedArtifactBytes(item,{signal:controller.signal,fetchImpl:async()=>{calls++;return new Response(null,{status:500})},delayImpl:async()=>controller.abort(new Error('original total deadline'))}),/original total deadline/);assert.equal(calls,1);
`,
  ));

test("pinned artifact preparation rejects ambiguous mirror lists credentials fragments filenames and queries before fetching", async (t) =>
  control(
    t,
    `
 const base={asset:'https://primary.invalid/exact%2Barchive.bin?revision=1',bytes:8},good='https://mirror.invalid/exact%2Barchive.bin?revision=1';
 for(const override of [
  {fallbackAssets:[]},{fallbackAssets:[good,good]},{fallbackAssets:[base.asset]},
  {fallbackAssets:[good,good+'2',good+'3']},{fallbackAssets:[1]},
  {fallbackAssets:[good],fallbackAsset:good},{fallbackAssets:good},
  {fallbackAssets:['http://mirror.invalid/exact%2Barchive.bin?revision=1']},
  {fallbackAssets:[good+'#fragment']},{fallbackAssets:[good.replace('mirror.invalid','name:secret@mirror.invalid')]},
  {fallbackAssets:[good.replace('revision=1','revision=2')]},{fallbackAssets:[good.replace('archive.bin','archive.bin.backup')]}
 ]) {let calls=0;await assert.rejects(requestPinnedArtifactBytes({...base,...override},{fetchImpl:async()=>{calls++;return new Response('original')}}));assert.equal(calls,0);}
 let calls=0;const valid=await requestPinnedArtifactBytes({...base,fallbackAssets:[good]},{fetchImpl:async asset=>{calls++;assert.equal(asset,calls===1?base.asset:good);return calls===1?new Response(null,{status:503}):new Response('original')},delayImpl:async()=>{}});assert.equal(calls,2);assert.equal(valid.toString(),'original');
 calls=0;const repeated=await requestPinnedArtifactBytes({...base,fallbackAssets:[good]},{fetchImpl:async asset=>{calls++;assert.equal(asset,calls===1?base.asset:good);return calls<3?new Response(null,{status:503}):new Response('original')},delayImpl:async()=>{}});assert.equal(calls,3);assert.equal(repeated.toString(),'original');
`,
  ));
