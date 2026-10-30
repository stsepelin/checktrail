import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { parse } from "yaml";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fixture } from "./helpers.js";
async function control(t: TestContext, body: string) {
  const root = await fixture(t, {
    "control.mjs": `import assert from 'node:assert/strict';import {acquirePinnedGoAnalyzer} from ${JSON.stringify(new URL("../../scripts/retry-go-acquisition.mjs", import.meta.url).href)};
const diagnostic='./synthetic.go:3:2: example.invalid/synthetic@v0.0.1: verifying module: example.invalid/synthetic@v0.0.1: reading https://sum.golang.org/tile/8/1/133: stream error: stream ID 1; INTERNAL_ERROR; received from peer';
${body}`,
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [path.join(root, "control.mjs")], {
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
test("Go analyzer acquisition retries only terminal checksum-service tile stream errors and preserves the successful attempt", async (t) =>
  control(
    t,
    `
for(const tile of ['8/1/133','8/0/x219/832','8/0/x219/832.p/255']) {
 const error=Object.assign(new Error('synthetic transport refusal'),{status:1,signal:null,stdout:'',stderr:'go: downloading example.invalid/synthetic v0.0.1\\n'+diagnostic.replace('8/1/133',tile)+'\\n'});
 const events=[];let calls=0;
 const result=await acquirePinnedGoAnalyzer({invoke:()=>{events.push('invoke');if(++calls<3)throw error;return 'original successful acquisition';},delayImpl:async ms=>events.push(ms)});
 assert.equal(result.output,'original successful acquisition');assert.equal(result.attempts,3);assert.equal(calls,3);
 assert.deepEqual(events,['invoke',1000,'invoke',3000,'invoke']);
}
`,
  ));
test("Go analyzer acquisition retries exact proxy zip stream failures and rejects mixed or altered diagnostics", async (t) =>
  control(
    t,
    `
const proxy='./synthetic.go:4:2: example.invalid/synthetic@v0.0.1: read "https://proxy.golang.org/example.invalid/synthetic/@v/v0.0.1.zip": stream error: stream ID 295; INTERNAL_ERROR; received from peer';
const second=proxy.replace('example.invalid/synthetic','example.invalid/other').replace('stream ID 295','stream ID 103');
const escaped=proxy.replace('/example.invalid/synthetic/@v/','/example.invalid/%21synthetic/@v/');
const failure=Object.assign(new Error('synthetic proxy stream'),{status:1,signal:null,stdout:'',stderr:'go: downloading example.invalid/synthetic v0.0.1\\n'+proxy+'\\n'+second+'\\n'+escaped});
const events=[];let calls=0;
const result=await acquirePinnedGoAnalyzer({invoke:()=>{events.push('invoke');if(++calls<3)throw failure;return 'original proxy success';},delayImpl:async ms=>events.push(ms),onRetry:row=>events.push(row)});
assert.equal(result.output,'original proxy success');assert.equal(result.attempts,3);
assert.deepEqual(events,['invoke',{attempt:1,delayMs:1000},1000,'invoke',{attempt:2,delayMs:3000},3000,'invoke']);
for(const stderr of [proxy+'\\n./synthetic.go:1: undefined: missing',proxy+'\\nSECURITY ERROR: checksum mismatch',proxy.replace('proxy.golang.org','proxy.golang.org.evil.invalid'),proxy.replace('https:','http:'),proxy.replace('/example.invalid/synthetic/@v/','/example.invalid/%2fsynthetic/@v/'),proxy.replace('.zip','.mod'),proxy.replace('/@v/','/../'),proxy.replace('INTERNAL_ERROR','CANCEL'),proxy.replace('stream ID 295','stream ID 0'),proxy+' trailing']) {
 const permanent=Object.assign(new Error('synthetic permanent failure'),{status:1,signal:null,stdout:'',stderr});let attempts=0;
 await assert.rejects(acquirePinnedGoAnalyzer({invoke:()=>{attempts++;throw permanent;},delayImpl:async()=>assert.fail('Permanent diagnostics cannot retry')}),error=>error===permanent);
 assert.equal(attempts,1,stderr);
}
`,
  ));
test("Go analyzer acquisition exhausts its finite attempts and preserves a later permanent failure", async (t) =>
  control(
    t,
    `
const errors=Array.from({length:3},(_,i)=>Object.assign(new Error('synthetic attempt '+i),{status:1,signal:null,stdout:'',stderr:diagnostic}));
let calls=0;const waits=[];
await assert.rejects(acquirePinnedGoAnalyzer({invoke:()=>{throw errors[calls++];},delayImpl:async ms=>waits.push(ms)}),error=>error===errors[2]);
assert.equal(calls,3);assert.deepEqual(waits,[1000,3000]);
const permanent=Object.assign(new Error('synthetic checksum mismatch'),{status:1,signal:null,stdout:'',stderr:'verifying module: checksum mismatch'});
let secondCalls=0;const secondWaits=[];
await assert.rejects(acquirePinnedGoAnalyzer({invoke:()=>{if(++secondCalls===1)throw errors[0];throw permanent;},delayImpl:async ms=>secondWaits.push(ms)}),error=>error===permanent);
assert.equal(secondCalls,2);assert.deepEqual(secondWaits,[1000]);
`,
  ));
test("Go analyzer acquisition rejects checksum compiler mixed origin path status signal output and command-budget near misses", async (t) =>
  control(
    t,
    `
const variants=[
 {stderr:'verifying module: checksum mismatch'},
 {stderr:'./synthetic.go:3:2: undefined: missing'},
 {stderr:diagnostic+'\\n./synthetic.go:3:2: undefined: missing'},
 {stderr:diagnostic+'\\nSECURITY ERROR: checksum mismatch'},
 {stderr:diagnostic.replace('sum.golang.org','sum.golang.org.evil.invalid')},
 {stderr:diagnostic.replace('https:','http:')},
 {stderr:diagnostic.replace('/tile/8/1/133','/lookup/example.invalid/synthetic@v0.0.1')},
 {stderr:diagnostic.replace('INTERNAL_ERROR','CANCEL')},
 {stderr:diagnostic.replace('INTERNAL_ERROR','REFUSED_STREAM')},
 {stderr:diagnostic.replace('verifying module:','compiling module:')},
 {stderr:diagnostic,status:2},
 {stderr:diagnostic,signal:'SIGTERM'},
 {stderr:diagnostic,code:'ETIMEDOUT'},
 {stderr:diagnostic,code:'ENOBUFS'},
 {stderr:diagnostic,stdout:'unrelated compiler output'},
 {stderr:''},
];
for(const variant of variants){
 const failure=Object.assign(new Error('synthetic permanent refusal'),{status:1,signal:null,stdout:'',...variant});let calls=0;
 await assert.rejects(acquirePinnedGoAnalyzer({invoke:()=>{calls++;throw failure;},delayImpl:async()=>assert.fail('An unrelated failure must not retry')}),error=>error===failure);
 assert.equal(calls,1,JSON.stringify(variant));
}
let successCalls=0;const success={stdout:'original successful output',stderr:diagnostic};
const result=await acquirePinnedGoAnalyzer({invoke:()=>{successCalls++;return success;},delayImpl:async()=>assert.fail('Success must not retry')});
assert.equal(successCalls,1);assert.equal(result.attempts,1);assert.equal(result.output,success);
`,
  ));

test("Go preparation uses fixed analyzer pins argv and child bounds while retaining checksum settings and rejecting failed installs or versions", async (t) => {
  const root = await fixture(t, {
    "observe.mjs": `import {registerHooks} from 'node:module';
const target=process.argv[2],mode=process.argv[3];globalThis.originalGoCalls=[];
const stub="export function spawnSync(executable,args,options){const install=executable==='go';globalThis.originalGoCalls.push({executable,args,timeout:options.timeout,maxBuffer:options.maxBuffer,shell:Boolean(options.shell),env:{GOBIN:options.env.GOBIN,GOSUMDB:options.env.GOSUMDB,GOPROXY:options.env.GOPROXY,GONOSUMDB:options.env.GONOSUMDB}});return{status:globalThis.originalGoMode===(install?'install-refusal':'version-refusal')?7:0,signal:null,stdout:install?'':'synthetic version output',stderr:globalThis.originalGoMode===(install?'install-refusal':'version-refusal')?'synthetic permanent refusal':''};}";
globalThis.originalGoMode=mode;
registerHooks({resolve(specifier,context,next){if(context.parentURL===target&&specifier==='node:child_process')return{url:'data:text/javascript,'+encodeURIComponent(stub),shortCircuit:true};return next(specifier,context);}});
let failure;try{await import(target);}catch(error){failure={message:error.message,status:error.status};}
console.log('\\nSYNTHETIC_OBSERVATION '+JSON.stringify({calls:globalThis.originalGoCalls,failure}));`,
  });
  const target = new URL("../../scripts/prepare-go-tools.mjs", import.meta.url)
    .href;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GOSUMDB: "sum.golang.org",
    GOPROXY: "https://proxy.golang.org",
    GONOSUMDB: "example.invalid/synthetic-private",
  };
  delete env.NODE_TEST_CONTEXT;
  for (const mode of ["ordinary", "install-refusal", "version-refusal"]) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "observe.mjs"), target, mode],
      { cwd: root, env, encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const marker = result.stdout
      .split("\n")
      .find((line) => line.startsWith("SYNTHETIC_OBSERVATION "));
    assert.ok(marker, result.stdout);
    const observed = JSON.parse(
      marker.slice("SYNTHETIC_OBSERVATION ".length),
    ) as {
      calls: Array<{
        executable: string;
        args: string[];
        timeout: number;
        maxBuffer: number;
        shell: boolean;
        env: {
          GOBIN: string;
          GOSUMDB: string;
          GOPROXY: string;
          GONOSUMDB: string;
        };
      }>;
      failure?: { status: number; message: string };
    };
    const extension = process.platform === "win32" ? ".exe" : "";
    const bin = path.join(await realpath(root), ".checktrail/go-tools/bin");
    const expected = [
      [
        "go",
        ["install", "honnef.co/go/tools/cmd/staticcheck@v0.8.1"],
        300000,
        2 * 1048576,
      ],
      [path.join(bin, "staticcheck" + extension), ["-version"], 15000, 65536],
      [
        "go",
        [
          "install",
          "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2",
        ],
        300000,
        2 * 1048576,
      ],
      [
        path.join(bin, "golangci-lint" + extension),
        ["version", "--short"],
        15000,
        65536,
      ],
    ];
    const count = mode === "ordinary" ? 4 : mode === "install-refusal" ? 1 : 2;
    assert.deepEqual(
      observed.calls.map((c) => [c.executable, c.args, c.timeout, c.maxBuffer]),
      expected.slice(0, count),
    );
    for (const call of observed.calls) {
      assert.equal(call.shell, false);
      assert.deepEqual(call.env, {
        GOBIN: bin,
        GOSUMDB: env.GOSUMDB,
        GOPROXY: env.GOPROXY,
        GONOSUMDB: env.GONOSUMDB,
      });
    }
    if (mode === "ordinary") assert.equal(observed.failure, undefined);
    else
      assert.deepEqual(observed.failure, {
        status: 7,
        message: "Pinned Go analyzer command failed",
      });
  }
});

test("all Go analyzer workflow setup sites call the same preparation helper and retain tool-path admission", async () => {
  const workflow = parse(
    await readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  const owners: string[] = [];
  for (const [name, raw] of Object.entries(workflow.jobs)) {
    const job = raw as { steps: Array<{ name?: string; run?: string }> };
    for (const step of job.steps)
      if (step.name === "Prepare pinned Go analyzers") {
        owners.push(name);
        assert.equal(
          step.run,
          'node scripts/prepare-go-tools.mjs\necho "$PWD/.checktrail/go-tools/bin" >> "$GITHUB_PATH"\n',
        );
      }
  }
  assert.deepEqual(owners.sort(), [
    "checks",
    "go-workspaces-arm64",
    "host-validation",
  ]);
});
