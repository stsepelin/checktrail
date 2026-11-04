import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fixture } from "./helpers.js";

const imports = `
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {requestPinnedArtifactBytes} from ${JSON.stringify(new URL("../../scripts/request-pinned-artifact.mjs", import.meta.url).href)};
import {requestMavenDistribution,mavenDistributionPin} from ${JSON.stringify(new URL("../../scripts/request-maven-distribution.mjs", import.meta.url).href)};
import {requestJvmWrapperArtifact} from ${JSON.stringify(new URL("../../scripts/request-jvm-wrapper-artifact.mjs", import.meta.url).href)};
const nativeTimeout=AbortSignal.timeout;
let now=0;const timers=[];
AbortSignal.timeout=ms=>{const controller=new AbortController();timers.push({at:now+ms,ms,controller});return controller.signal;};
function advanceNext(){const next=timers.filter(t=>!t.controller.signal.aborted).sort((a,b)=>a.at-b.at)[0];assert(next);now=next.at;next.controller.abort(new DOMException('Authored deterministic attempt deadline','TimeoutError'));return next;}
const payload=Uint8Array.from([0,255,7]);
const pin={asset:'https://primary.example.invalid/original.bin',fallbackAssets:['https://first.example.invalid/original.bin','https://second.example.invalid/original.bin'],bytes:3};
const wrapperPin={url:'https://downloads.apache.org/maven/maven-3/3.10.0/binaries/apache-maven-3.10.0-bin.zip',bytes:3,sha256:createHash('sha256').update(payload).digest('hex')};
`;
async function control(t: TestContext, body: string) {
  const root = await fixture(t, {
    "control.mjs":
      imports +
      "try {\n" +
      body +
      "\n} finally { AbortSignal.timeout=nativeTimeout; }\n",
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

test("Maven hung primary retains its original total budget for a pinned fallback with an owned attempt deadline", async (t) =>
  control(
    t,
    `
 const calls=[],waits=[],original=new Uint8Array(mavenDistributionPin.bytes).fill(7);
 const value=await requestMavenDistribution({fetchImpl:async(asset,{signal,redirect})=>{calls.push(asset);assert.equal(redirect,'error');if(calls.length===1){advanceNext();signal.throwIfAborted();assert.fail('Missing bounded request signal');}return new Response(original);},delayImpl:async ms=>{waits.push(ms);now+=ms;}});
 assert.deepEqual(timers.map(t=>t.ms),[120000,30000,30000]);
 assert.deepEqual(calls,[mavenDistributionPin.asset,mavenDistributionPin.fallbackAssets[0]]);assert.deepEqual(waits,[1000]);assert.equal(now,31000);assert.equal(timers[0].controller.signal.aborted,false);assert.deepEqual(value,Buffer.from(original));
`,
  ));

test("JVM wrapper mirror deadlines fit every attempt within the unchanged total and retain exact digest validation", async (t) =>
  control(
    t,
    `
 const calls=[],waits=[];
 const value=await requestJvmWrapperArtifact(wrapperPin,{fetchImpl:async(asset,{signal,redirect})=>{calls.push(asset);assert.equal(redirect,'error');if(calls.length<3){advanceNext();signal.throwIfAborted();assert.fail('Missing wrapper attempt deadline');}return new Response(payload);},delayImpl:async ms=>{waits.push(ms);now+=ms;}});
 assert.deepEqual(timers.map(t=>t.ms),[60000,15000,15000,15000]);
 assert.deepEqual(calls,[wrapperPin.url,wrapperPin.url.replace('downloads.apache.org','dlcdn.apache.org'),wrapperPin.url.replace('https://downloads.apache.org/','https://archive.apache.org/dist/')]);assert.deepEqual(waits,[1000,3000]);assert.equal(now,34000);assert.equal(timers[0].controller.signal.aborted,false);assert.deepEqual(value,Buffer.from(payload));
 let invalidCalls=0;await assert.rejects(requestJvmWrapperArtifact({...wrapperPin,sha256:'0'.repeat(64)},{fetchImpl:async()=>{invalidCalls++;return new Response(payload);},delayImpl:async()=>assert.fail('Digest failure must not retry')}),/digest/);assert.equal(invalidCalls,1);
`,
  ));

test("Pinned attempt body timeout discards partial bytes and exhausted owned deadlines never become success", async (t) =>
  control(
    t,
    `
 const calls=[],waits=[];
 const value=await requestPinnedArtifactBytes(pin,{attemptTimeoutMs:30000,fetchImpl:async(asset,{signal})=>{calls.push(asset);if(calls.length===1)return new Response(new ReadableStream({start(c){c.enqueue(Uint8Array.from([1]));},pull(c){advanceNext();assert.equal(signal.aborted,true);c.error(new DOMException('Fetch body aborted after its owned deadline','AbortError'));}}));return new Response(payload);},delayImpl:async ms=>{waits.push(ms);now+=ms;}});
 assert.deepEqual(value,Buffer.from(payload));assert.deepEqual(calls,[pin.asset,pin.fallbackAssets[0]]);assert.equal(now,31000);assert.deepEqual(waits,[1000]);
 now=0;timers.length=0;let exhausted=0;const retryWaits=[];
 await assert.rejects(requestPinnedArtifactBytes(pin,{attemptTimeoutMs:30000,fetchImpl:async(asset,{signal})=>{assert.equal(asset,[pin.asset,...pin.fallbackAssets][exhausted++]);advanceNext();signal.throwIfAborted();},delayImpl:async ms=>{retryWaits.push(ms);now+=ms;}}),e=>e.name==='TimeoutError');
 assert.equal(exhausted,3);assert.equal(now,94000);assert.equal(timers[0].controller.signal.aborted,false);assert.deepEqual(retryWaits,[1000,3000]);
`,
  ));

test("Outer cancellation wins before fetch during headers body and retry delay with exact request-signal propagation", async (t) =>
  control(
    t,
    `
 for(const phase of ['before','headers','body','delay']){
  timers.length=0;now=0;const outer=new AbortController(),reason=new DOMException('Authored caller timeout','TimeoutError');let calls=0,propagated=false;
  if(phase==='before')outer.abort(reason);
  await assert.rejects(requestPinnedArtifactBytes(pin,{signal:outer.signal,attemptTimeoutMs:30000,fetchImpl:async(asset,{signal})=>{calls++;if(phase==='headers'){outer.abort(reason);propagated=signal.aborted&&signal.reason===reason;throw signal.reason;}if(phase==='delay')throw Object.assign(new Error('Transient connection'),{code:'ETIMEDOUT'});return new Response(new ReadableStream({start(c){c.enqueue(payload);},pull(c){outer.abort(reason);propagated=signal.aborted&&signal.reason===reason;c.error(reason);}}));},delayImpl:async()=>{assert.equal(phase,'delay');outer.abort(reason);}}),e=>e===reason);
  assert.equal(calls,phase==='before'?0:1);if(phase==='headers'||phase==='body')assert.equal(propagated,true,phase+' caller cancellation did not reach the derived request signal');
 }
`,
  ));

test("Attempt timeout admission does not retry unrelated timeout names or integrity errors even when cleanup expires a deadline", async (t) =>
  control(
    t,
    `
 let calls=0;for(const name of ['TimeoutError','AbortError']){const foreign=new DOMException('Unowned transport exception',name);calls=0;
 await assert.rejects(requestPinnedArtifactBytes(pin,{attemptTimeoutMs:30000,fetchImpl:async()=>{calls++;throw foreign;},delayImpl:async()=>assert.fail('Unowned timeout or abort must not retry')}),e=>e===foreign);assert.equal(calls,1);}
 for(const name of ['AbortError','TimeoutError']){
  now=0;timers.length=0;calls=0;let cleanupExpiredOwned=false;const foreign=new DOMException('Unowned body failure',name);
  await assert.rejects(requestPinnedArtifactBytes(pin,{attemptTimeoutMs:30000,fetchImpl:async()=>{calls++;const body=new ReadableStream({pull(c){c.error(foreign);}});body.cancel=async()=>{cleanupExpiredOwned=advanceNext().ms===30000;};return new Response(body);},delayImpl:async()=>assert.fail('Cleanup must not reclassify an unowned body failure')}),e=>e===foreign);
  assert.equal(calls,1);assert.equal(cleanupExpiredOwned,true);assert.equal(timers[0].controller.signal.aborted,false);
 }
 for(const kind of ['permanent-status','oversized-body','short-body']){
  now=0;timers.length=0;calls=0;let expiredOwned=false;
  await assert.rejects(requestPinnedArtifactBytes(pin,{attemptTimeoutMs:30000,fetchImpl:async()=>{calls++;if(kind==='short-body')return new Response(new ReadableStream({start(c){c.enqueue(Uint8Array.of(7));},pull(c){expiredOwned=advanceNext().ms===30000;c.close();}}));return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(4));},cancel(){expiredOwned=advanceNext().ms===30000;}}),{status:kind==='permanent-status'?404:200});},delayImpl:async()=>assert.fail('Integrity or permanent HTTP must not retry')}));
  assert.equal(calls,1,kind);
  assert.equal(expiredOwned,true,kind+' fixture must expire the owned deadline');assert.equal(timers[0].controller.signal.aborted,false);
 }
`,
  ));

test("Attempt deadline option is finite opt-in and unchanged generic callers retain their original signal", async (t) =>
  control(
    t,
    `
 for(const attemptTimeoutMs of [0,-1,0.5,120001,Infinity,NaN,true,false,null]){let calls=0;await assert.rejects(requestPinnedArtifactBytes(pin,{attemptTimeoutMs,fetchImpl:async()=>{calls++;return new Response(payload);}}),/attempt timeout bound/);assert.equal(calls,0);}
 const outer=new AbortController();let calls=0;
 const value=await requestPinnedArtifactBytes(pin,{signal:outer.signal,fetchImpl:async(asset,{signal})=>{calls++;assert.equal(signal,outer.signal);return new Response(payload);}});assert.equal(calls,1);assert.deepEqual(value,Buffer.from(payload));
`,
  ));
