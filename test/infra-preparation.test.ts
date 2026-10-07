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

test("pinned artifact preparation does not retry HTTP malformed size or unknown failures", async (t) =>
  control(
    t,
    `
 const item=${item};
 for(const [body,reason] of [[()=>new Response('original',{status:404}),/HTTP response/],[()=>new Response('original',{status:503}),/HTTP response/],[()=>new Response(null),/no body/],[()=>new Response('short'),/byte count/],[()=>new Response('too many bytes'),/byte limit/]]){
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

async function preparationControl(t: TestContext, badDigest: boolean) {
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
    "dist/src/maven.js": `export {mavenHash} from ${JSON.stringify(maven.href)};`,
    "control.mjs": `
 import assert from 'node:assert/strict';import {readFile,writeFile,readdir,access} from 'node:fs/promises';import {createHash} from 'node:crypto';import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {setTimeout} from 'node:timers/promises';
 Object.defineProperty(process,'arch',{value:'arm64'});process.env.CHECKTRAIL_TEST_TASK='original-infra-preparation';delete process.env.CHECKTRAIL_INFRA_ARTIFACT_DIRECTORY;
 childProcess.execFileSync=(command,args)=>{assert.equal(command,'docker');assert.deepEqual(args,['image','inspect','checktrail-original-infra-preparation:public']);throw Object.assign(new Error('synthetic absent image'),{status:1,stderr:'No such image'})};syncBuiltinESMExports();
 const digest=createHash('sha256').update('original').digest('hex');const badDigest=${badDigest};
 const schemas=badDigest?[{file:'original.json',asset:'https://get.helm.sh/original',bytes:8,sha256:'0'.repeat(64)}]:[{file:'failed.json',asset:'https://get.helm.sh/failed',bytes:8,sha256:digest},{file:'delayed.json',asset:'https://get.helm.sh/delayed',bytes:8,sha256:digest}];
 await writeFile(new URL('./scripts/infra-tools-artifacts.json',import.meta.url),JSON.stringify({schemaVersion:1,base:'node@sha256:'+'0'.repeat(64),tools:[],schemas}));
 let calls=0,finished=false;
 globalThis.fetch=async asset=>{calls++;if(badDigest)return new Response('original');if(asset.endsWith('/failed'))return new Response('not found',{status:404});return new Response(new ReadableStream({async start(c){await setTimeout(50);c.enqueue(new TextEncoder().encode('original'));c.close();finished=true}}))};
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
