import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fixture } from "./helpers.js";
async function control(t: TestContext, body: string) {
  const root = await fixture(t, {
    "control.mjs": `import assert from 'node:assert/strict';import {acquireMavenDependencies} from ${JSON.stringify(new URL("../../scripts/retry-maven-acquisition.mjs", import.meta.url).href)};import {mavenDistributionPin,requestMavenDistribution} from ${JSON.stringify(new URL("../../scripts/request-maven-distribution.mjs", import.meta.url).href)};\n${body}`,
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
const rateLimit =
  "[ERROR] The following artifacts could not be resolved: example:original:pom:1 (absent): Could not transfer artifact example:original:pom:1 from/to central (https://repo.maven.apache.org/maven2): HTTP Status: 429";

test("Maven operator acquisition retries only terminal Central artifact rate limits and resets partial repositories before rerunning", async (t) =>
  control(
    t,
    `
  const failure=Object.assign(new Error('original acquisition failure'),{status:1,signal:null,stdout:${JSON.stringify(rateLimit)}});
  const events=[];let calls=0;
  const result=await acquireMavenDependencies({invoke:()=>{events.push('invoke');if(++calls<3)throw failure;return 'original successful fixture output';},beforeRetry:async()=>events.push('reset'),delayImpl:async ms=>events.push(ms)});
  assert.equal(result.attempts,3);assert.equal(result.output,'original successful fixture output');
  assert.deepEqual(events,['invoke',5000,'reset','invoke',15000,'reset','invoke']);
  let exhausted=0;const waits=[];
  await assert.rejects(acquireMavenDependencies({invoke:()=>{exhausted++;throw failure;},beforeRetry:async()=>{},delayImpl:async ms=>waits.push(ms)}),error=>error===failure);
  assert.equal(exhausted,3);assert.deepEqual(waits,[5000,15000]);
`,
  ));
test("Maven acquisition preserves checksum test timeout signal and foreign-origin failures without retries or invented success", async (t) =>
  control(
    t,
    `
  const original=${JSON.stringify(rateLimit)};
  const failures=[
    {status:1,signal:null,stdout:'[ERROR] original test failed: HTTP Status: 429'},
    {status:1,signal:null,stdout:'[WARNING] Could not transfer artifact x from/to central (https://repo.maven.apache.org/maven2): HTTP Status: 429\\n[ERROR] checksum failed'},
    {status:1,signal:null,stdout:original.replace('HTTP Status: 429','HTTP Status: 404')},
    {status:1,signal:null,stdout:original.replace('repo.maven.apache.org','repo.maven.apache.org.evil.invalid')},
    {status:1,signal:null,stdout:original.replace('https:','http:')},
    {status:1,signal:'SIGTERM',stdout:original},
    {status:1,code:'ETIMEDOUT',stdout:original},
    {status:2,signal:null,stdout:original},
  ];
  for(const data of failures){const failure=Object.assign(new Error('original'),data);let calls=0;await assert.rejects(acquireMavenDependencies({invoke:()=>{calls++;throw failure;},beforeRetry:async()=>{throw new Error('must not reset')},delayImpl:async()=>{throw new Error('must not wait')}}),error=>error===failure);assert.equal(calls,1);}
  const valid=await acquireMavenDependencies({invoke:()=>original,beforeRetry:async()=>{throw new Error('must not reset')},delayImpl:async()=>{throw new Error('must not wait')}});assert.equal(valid.attempts,1);assert.equal(valid.output,original);
  const resetError=new Error('original reset failed');let resetCalls=0;
  await assert.rejects(acquireMavenDependencies({invoke:()=>{resetCalls++;throw Object.assign(new Error('original'),{status:1,stdout:original});},beforeRetry:async()=>{throw resetError},delayImpl:async()=>{}}),error=>error===resetError);assert.equal(resetCalls,1);
`,
  ));

test("Maven distribution preparation retries transient connection and response failures with the exact pin and redirect rejection", async (t) =>
  control(
    t,
    `
 const calls=[],waits=[],signal=AbortSignal.timeout(5000);
 const timeout=Object.assign(new AggregateError([],'synthetic connect timeout'),{code:'ETIMEDOUT'});
 const bytes=await requestMavenDistribution({signal,fetchImpl:async(asset,options)=>{calls.push([asset,options.redirect,options.signal===signal]);if(calls.length===1)throw new TypeError('fetch failed',{cause:timeout});if(calls.length===2)return new Response('temporary',{status:503});return new Response(new Uint8Array(mavenDistributionPin.bytes).fill(7));},delayImpl:async ms=>waits.push(ms)});
 assert.deepEqual(calls,[[mavenDistributionPin.asset,'error',true],[mavenDistributionPin.fallbackAssets[0],'error',true],[mavenDistributionPin.fallbackAssets[1],'error',true]]);assert.deepEqual(waits,[1000,3000]);assert.equal(bytes.length,9979885);assert.equal(bytes[0],7);assert.equal(bytes[bytes.length-1],7);
 assert.equal(mavenDistributionPin.sha256,'a46cc51bc74fa23fd267c7a0b9132b146dcf526da60d31aa5174e565632e9e0e');
`,
  ));
test("Maven distribution preparation preserves permanent redirects short bodies exhausted connections and aborts", async (t) =>
  control(
    t,
    `
 for(const response of [()=>new Response('missing',{status:404}),()=>new Response('redirect',{status:302}),()=>new Response('short')]){let calls=0;await assert.rejects(requestMavenDistribution({fetchImpl:async(asset,options)=>{assert.equal(asset,mavenDistributionPin.asset);assert.equal(options.redirect,'error');calls++;return response();},delayImpl:async()=>{throw new Error('must not retry')}}));assert.equal(calls,1);}
 const failure=new TypeError('redirect blocked');let redirects=0;await assert.rejects(requestMavenDistribution({fetchImpl:async()=>{redirects++;throw failure;},delayImpl:async()=>{throw new Error('must not retry')}}),e=>e===failure);assert.equal(redirects,1);
 let attempts=0;const waits=[],last=Object.assign(new Error('connect timeout'),{code:'ETIMEDOUT'});await assert.rejects(requestMavenDistribution({fetchImpl:async()=>{attempts++;throw last},delayImpl:async ms=>waits.push(ms)}),e=>e===last);assert.equal(attempts,3);assert.deepEqual(waits,[1000,3000]);
 const abort=new Error('original abort');let calls=0;await assert.rejects(requestMavenDistribution({signal:AbortSignal.abort(abort),fetchImpl:async()=>{calls++;return new Response('never')}}),e=>e===abort);assert.equal(calls,0);
`,
  ));

test("Pinned artifact mirrors retain bounded retry admission exact filenames and integrity failures instead of treating alternate delivery as validation", async (t) =>
  control(
    t,
    `
 const {requestPinnedArtifactBytes}=await import(${JSON.stringify(new URL("../../scripts/request-pinned-artifact.mjs", import.meta.url).href)});
 const pin={asset:'https://primary.example.invalid/original-1.apk',fallbackAsset:'https://mirror.example.invalid/original-1.apk',bytes:3};
 const calls=[],waits=[];
 const bytes=await requestPinnedArtifactBytes(pin,{retryNotFound:true,fetchImpl:async url=>{calls.push(url);return calls.length===1?new Response('missing',{status:404}):new Response(Uint8Array.from([0,255,7]));},delayImpl:async ms=>waits.push(ms)});
 assert.deepEqual(calls,[pin.asset,pin.fallbackAsset]);assert.deepEqual(waits,[1000]);assert.deepEqual([...bytes],[0,255,7]);
 for(const fallbackAsset of ['http://mirror.example.invalid/original-1.apk','https://mirror.example.invalid/original-2.apk','https://user:secret@mirror.example.invalid/original-1.apk','https://mirror.example.invalid/original-1.apk?changed=1','https://mirror.example.invalid/original-1.apk#changed']){
  let reached=0;await assert.rejects(requestPinnedArtifactBytes({...pin,fallbackAsset},{fetchImpl:async()=>{reached++;return new Response('yes');}}));assert.equal(reached,0);
 }
 for(const response of [()=>new Response('missing',{status:404}),()=>new Response('short'),()=>new Response('longer'),()=>new Response('redirect',{status:302})]){
  let reached=0;await assert.rejects(requestPinnedArtifactBytes(pin,{fetchImpl:async()=>{reached++;return response();},delayImpl:async()=>assert.fail('An integrity or non-admitted HTTP failure must not retry')}));assert.equal(reached,1);
 }
 let reached=0;const waits2=[],failure=Object.assign(new Error('synthetic network timeout'),{code:'ETIMEDOUT'});
 await assert.rejects(requestPinnedArtifactBytes(pin,{fetchImpl:async url=>{assert.equal(url,reached===0?pin.asset:pin.fallbackAsset);reached++;throw failure;},delayImpl:async ms=>waits2.push(ms)}),e=>e===failure);
 assert.equal(reached,3);assert.deepEqual(waits2,[1000,3000]);
`,
  ));

const wrapperControlImports = `
 const {createHash}=await import('node:crypto');
 const {requestJvmWrapperArtifact}=await import(${JSON.stringify(new URL("../../scripts/request-jvm-wrapper-artifact.mjs", import.meta.url).href)});
 const original=Uint8Array.from([0,255,7]);
 const pin={url:'https://downloads.apache.org/maven/maven-3/3.10.0/binaries/apache-maven-3.10.0-bin.zip',bytes:3,sha256:createHash('sha256').update(original).digest('hex')};
`;

test("JVM wrapper setup retries transient deliveries through exact Apache mirrors and keeps Central artifact URLs unchanged", async (t) =>
  control(
    t,
    wrapperControlImports +
      `
 const apachePaths=['/maven/maven-3/3.10.0/binaries/apache-maven-3.10.0-bin.zip','/maven/maven-3/3.10.0/binaries/apache-maven-3.10.0-bin.zip.asc','/maven/KEYS'];
 const centralPaths=['/maven2/org/apache/maven/wrapper/maven-wrapper/3.3.4/maven-wrapper-3.3.4.jar','/maven2/org/apache/maven/wrapper/maven-wrapper/3.3.4/maven-wrapper-3.3.4.jar.asc','/maven2/org/apache/maven/wrapper/maven-wrapper-distribution/3.3.4/maven-wrapper-distribution-3.3.4-bin.zip','/maven2/org/apache/maven/wrapper/maven-wrapper-distribution/3.3.4/maven-wrapper-distribution-3.3.4-bin.zip.asc'];
 for(const [url,expected] of [
  ...apachePaths.map(p=>['https://downloads.apache.org'+p,['https://downloads.apache.org'+p,'https://dlcdn.apache.org'+p,'https://archive.apache.org/dist'+p]]),
  ...centralPaths.map(p=>['https://repo.maven.apache.org'+p,Array(3).fill('https://repo.maven.apache.org'+p)]),
 ]){
  const signal=AbortSignal.timeout(5000),calls=[],waits=[];
  const timeout=Object.assign(new AggregateError([],'synthetic connect timeout'),{code:'ETIMEDOUT'});
  const bytes=await requestJvmWrapperArtifact({...pin,url},{signal,fetchImpl:async(asset,request)=>{calls.push([asset,request.redirect,request.signal===signal]);if(calls.length===1)throw new TypeError('fetch failed',{cause:timeout});if(calls.length===2)return new Response('temporary',{status:503});return new Response(original);},delayImpl:async ms=>waits.push(ms)});
  assert.deepEqual(calls,expected.map(asset=>[asset,'error',true]));assert.deepEqual(waits,[1000,3000]);assert.deepEqual([...bytes],[0,255,7]);
 }
 let reached=0;const bytes=await requestJvmWrapperArtifact(pin,{fetchImpl:async(asset,request)=>{assert.equal(asset,pin.url);assert.equal(request.redirect,'error');reached++;return new Response(original);},delayImpl:async()=>assert.fail('Valid primary must not retry')});assert.equal(reached,1);assert.deepEqual([...bytes],[0,255,7]);
 `,
  ));

test("JVM wrapper setup rejects redirects permanent responses malformed bodies and incorrect digests without retry", async (t) =>
  control(
    t,
    wrapperControlImports +
      `
 for(const response of [()=>new Response('no',{status:404}),()=>new Response('no',{status:401}),()=>new Response('go',{status:302}),()=>new Response('x'),()=>new Response('long'),()=>new Response(),()=>new Response(Uint8Array.from([0,255,8]))]){
  let calls=0;await assert.rejects(requestJvmWrapperArtifact(pin,{fetchImpl:async()=>{calls++;return response();},delayImpl:async()=>assert.fail('Integrity or permanent failures must not retry')}));assert.equal(calls,1);
 }
 for(const failure of [new TypeError('redirect blocked'),Object.assign(new Error('bad certificate'),{code:'CERT_HAS_EXPIRED'})]){let calls=0;await assert.rejects(requestJvmWrapperArtifact(pin,{fetchImpl:async()=>{calls++;throw failure;},delayImpl:async()=>assert.fail('Must not retry')}),e=>e===failure);assert.equal(calls,1);}
 `,
  ));

test("JVM wrapper setup bounds exhausted retries and preserves cancellation before fetch and between attempts", async (t) =>
  control(
    t,
    wrapperControlImports +
      `
 const failure=Object.assign(new Error('connect timeout'),{code:'ETIMEDOUT'}),waits=[],calls=[],retries=[];
 await assert.rejects(requestJvmWrapperArtifact(pin,{fetchImpl:async url=>{calls.push(url);throw failure},delayImpl:async ms=>waits.push(ms),onRetry:event=>retries.push(event)}),e=>e===failure);
 assert.deepEqual(calls,[pin.url,pin.url.replace('downloads.apache.org','dlcdn.apache.org'),pin.url.replace('https://downloads.apache.org/','https://archive.apache.org/dist/')]);assert.deepEqual(waits,[1000,3000]);assert.deepEqual(retries,[{attempt:1,waitMs:1000},{attempt:2,waitMs:3000}]);
 const abort=new Error('original cancellation');let before=0;await assert.rejects(requestJvmWrapperArtifact(pin,{signal:AbortSignal.abort(abort),fetchImpl:async()=>{before++;return new Response(original)}}),e=>e===abort);assert.equal(before,0);
 const controller=new AbortController();let during=0;
 await assert.rejects(requestJvmWrapperArtifact(pin,{signal:controller.signal,fetchImpl:async()=>{during++;throw failure},delayImpl:async()=>controller.abort(abort)}),e=>e===abort);assert.equal(during,1);
 `,
  ));

test("JVM wrapper setup discards interrupted body bytes and rejects URLs outside its exact artifact inventory", async (t) =>
  control(
    t,
    wrapperControlImports +
      `
 let calls=0;const waits=[];
 const bytes=await requestJvmWrapperArtifact(pin,{fetchImpl:async()=>{if(++calls===1)return new Response(new ReadableStream({start(c){c.enqueue(Uint8Array.from([99,99]));},pull(c){c.error(Object.assign(new Error('body interrupted'),{code:'ECONNRESET'}));}}));return new Response(original);},delayImpl:async ms=>waits.push(ms)});
 assert.equal(calls,2);assert.deepEqual(waits,[1000]);assert.deepEqual([...bytes],[0,255,7]);
 for(const url of [pin.url.replace('https:','http:'),pin.url.replace('downloads.apache.org','downloads.apache.org.evil.invalid'),pin.url+'?changed=1',pin.url+'#fragment',pin.url.replace('3.10.0','3.10.1'),pin.url.replace('https://','https://user:secret@')]){let reached=0;await assert.rejects(requestJvmWrapperArtifact({...pin,url},{fetchImpl:async()=>{reached++;return new Response(original)}}));assert.equal(reached,0);}
 `,
  ));
