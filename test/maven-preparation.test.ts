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
 assert.deepEqual(calls,Array.from({length:3},()=>[mavenDistributionPin.asset,'error',true]));assert.deepEqual(waits,[1000,3000]);assert.equal(bytes.length,9979885);assert.equal(bytes[0],7);assert.equal(bytes[bytes.length-1],7);
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
