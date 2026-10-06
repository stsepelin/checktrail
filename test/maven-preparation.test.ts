import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fixture } from "./helpers.js";
async function control(t: TestContext, body: string) {
  const root = await fixture(t, {
    "control.mjs": `import assert from 'node:assert/strict';import {acquireMavenDependencies} from ${JSON.stringify(new URL("../../scripts/retry-maven-acquisition.mjs", import.meta.url).href)};\n${body}`,
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
