import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fixture } from "./helpers.js";
import path from "node:path";
async function run(t: import("node:test").TestContext, body: string) {
  const root = await fixture(t, {
    "control.mjs": `import assert from 'node:assert/strict';import {requestGradleDistribution} from ${JSON.stringify(new URL("../../scripts/request-gradle-distribution.mjs", import.meta.url).href)};\n${body}`,
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [path.join(root, "control.mjs")], {
    encoding: "utf8",
    env,
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
}
test("Gradle preparation retries bounded request failures from the pinned origin without weakening redirect boundaries", async (t) =>
  run(
    t,
    `
 const origin='https://services.gradle.org/distributions/gradle-9.8.0-bin.zip';
 const asset='https://release-assets.githubusercontent.com/github-production-release-asset/696192900/original?secret=never-print';
 const calls=[],delays=[];
 const responses=[new Response('temporary',{status:503}),new Response(null,{status:307,headers:{location:'https://github.com/gradle/gradle-distributions/releases/download/v9.8.0/gradle-9.8.0-bin.zip'}}),new Response(null,{status:302,headers:{location:asset}}),new Response('expired',{status:403}),new Response('synthetic-stream')];
 const result=await requestGradleDistribution({fetchImpl:async(url,options)=>{calls.push(url.href);assert.equal(options.redirect,'manual');assert.equal(options.headers['cache-control'],'no-cache');return responses[calls.length-1]},delayImpl:async ms=>delays.push(ms)});
 assert.equal(result.attempts,3);assert.equal(result.redirects,0);assert.deepEqual(delays,[500,1000]);assert.deepEqual(calls,[origin,origin,'https://github.com/gradle/gradle-distributions/releases/download/v9.8.0/gradle-9.8.0-bin.zip',asset,origin]);assert.equal(await result.response.text(),'synthetic-stream');
 let attempts=0;const failed=[];
 await assert.rejects(requestGradleDistribution({fetchImpl:async()=>{attempts++;const response=new Response('not found',{status:404});failed.push(response);return response},delayImpl:async()=>{}}),/HTTP 404 from services.gradle.org \\(attempt 3\\/3\\)/);assert.equal(attempts,3);assert.ok(failed.every(response=>response.bodyUsed));
 let failures=0;const recovered=await requestGradleDistribution({fetchImpl:async()=>{if(failures++===0)throw new TypeError('synthetic network failure');return new Response('recovered')},delayImpl:async()=>{}});assert.equal(recovered.attempts,2);assert.equal(await recovered.response.text(),'recovered');
`,
  ));
test("Gradle preparation refuses escaping missing and exhausted redirects and aborted requests", async (t) =>
  run(
    t,
    `
 for(const location of ['https://services.gradle.org/distributions/gradle-other-bin.zip','https://downloads.gradle.org/distributions/gradle-9.8.0-bin.zip.evil','https://github.com/gradle/gradle-distributions/releases/download/v9.8.0/gradle-9.8.0-all.zip','https://services.gradle.org.evil.invalid/distributions/gradle-9.8.0-bin.zip','http://downloads.gradle.org/distributions/gradle-9.8.0-bin.zip','https://user:password@services.gradle.org/distributions/gradle-9.8.0-bin.zip','https://services.gradle.org:8443/distributions/gradle-9.8.0-bin.zip','https://services.gradle.org/distributions/gradle-9.8.0-bin.zip#fragment']){
  let calls=0;await assert.rejects(requestGradleDistribution({fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location}})},delayImpl:async()=>{throw new Error('must not retry a boundary violation')}}));assert.equal(calls,1,location);
 }
 let missing=0;await assert.rejects(requestGradleDistribution({fetchImpl:async()=>{missing++;return new Response(null,{status:302})},delayImpl:async()=>{throw new Error('must not retry missing location')}}),/no location/);assert.equal(missing,1);
 let loops=0;const waits=[];await assert.rejects(requestGradleDistribution({fetchImpl:async()=>{loops++;return new Response(null,{status:302,headers:{location:'https://services.gradle.org/distributions/gradle-9.8.0-bin.zip'}})},delayImpl:async ms=>waits.push(ms)}),/redirect limit/);assert.equal(loops,15);assert.deepEqual(waits,[500,1000]);
 const signal=AbortSignal.abort(new Error('original abort'));let invoked=false;await assert.rejects(requestGradleDistribution({signal,fetchImpl:async()=>{invoked=true;return new Response('never')},delayImpl:async()=>{}}),/original abort/);assert.equal(invoked,false);
 let direct=0;const valid=await requestGradleDistribution({fetchImpl:async()=>{direct++;return new Response('original stream')},delayImpl:async()=>{throw new Error('valid response must not retry')}});assert.equal(direct,1);assert.equal(valid.attempts,1);
`,
  ));
