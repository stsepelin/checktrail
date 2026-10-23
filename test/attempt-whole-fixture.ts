import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { validate } from "../src/engine.js";
import type { Report } from "../src/types.js";
import type { ExternalReference } from "../src/external-adapter.js";
import { replayNativeAttemptFrames } from "../src/native-attempt-frames.js";

export const archiveHash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export const archivePolicies = {
  broken: 'export function allowed(value){return value.startsWith("grant");}\n',
  fixed: 'export function allowed(value){return value==="grant";}\n',
  near: 'export function allowed(value){const identifier=["gr","ant"].join("");return value===identifier;}\n',
};
export async function archiveFixture(
  t: TestContext,
  mode: keyof typeof archivePolicies = "fixed",
  control: {
    hold?: boolean;
    child?: boolean;
    flood?: boolean;
    empty?: boolean;
    skip?: boolean;
    padding?: boolean;
  } = {},
) {
  const created = await fixture(t, {
    "project/original.project": "Original archive acceptance.\n",
    "project/decision.mjs": archivePolicies[mode],
    "project/first.mjs":
      'import{allowed}from"./decision.mjs";export const consume=value=>({visible:allowed(value)});\n',
    "project/second.mjs":
      'import{allowed}from"./decision.mjs";export const consume=value=>({state:allowed(value)?"ready":"blocked"});\n',
    "project/checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["external.archive.acceptance"] }],
    }),
    "operator/placeholder.txt": "Original operator data.\n",
    "signals/placeholder.txt": "Original lifecycle data.\n",
  });
  const base = await realpath(created);
  const root = path.join(base, "project"),
    bundle = path.join(base, "operator"),
    ready = path.join(base, "signals", "ready.json"),
    release = path.join(base, "signals", "release.json");
  const program = String.raw`import{readFile,writeFile,access}from'node:fs/promises';import{spawn}from'node:child_process';import{setTimeout as delay}from'node:timers/promises';import{pathToFileURL}from'node:url';import path from'node:path';
const request=JSON.parse(await readFile(process.argv[2],'utf8')),modules=[];
for(const name of ['first.mjs','second.mjs'])modules.push({name,module:await import(pathToFileURL(path.join(request.root,name)).href)});
const control=${JSON.stringify(control)},ready=${JSON.stringify(ready)},release=${JSON.stringify(release)};
let child;if(control.child)child=spawn(process.execPath,['-e','setInterval(()=>{},1000);'],{detached:true,stdio:'ignore'});
await writeFile(ready,JSON.stringify({pid:process.pid,child:child?.pid??null}));
if(control.hold)while(!(await access(release).then(()=>true,()=>false)))await delay(10);
if(control.flood)process.stdout.write('Original physical output. '.repeat(8192));
const cases=[];if(!control.empty)for(const {name,module}of modules)for(const [input,expected]of [['grant',true],['granting',false]]){const result=module.consume(input),actual=name==='first.mjs'?result.visible:result.state==='ready';cases.push({consumer:name,input,expected,actual,passed:actual===expected});}
const failed=cases.filter(c=>!c.passed);process.stderr.write(JSON.stringify({pid:process.pid,originalCases:cases,padding:control.padding?'Original retained bytes. '.repeat(8192):undefined,undeclared:process.env.CHECKTRAIL_ARCHIVE_SYNTHETIC_SECRET??null})+'\n');
process.stdout.write(JSON.stringify({protocolVersion:1,identity:request.identity,checkId:request.checkId,sourceFingerprint:request.sourceFingerprint,files:request.scope.map(path=>{const selected=cases.filter(c=>c.consumer===path),failures=selected.filter(c=>!c.passed).length;return{path,status:'checked',tests:{total:selected.length,passed:control.skip?0:selected.length-failures,failed:control.skip?0:failures,skipped:control.skip?selected.length:0}};}),findings:control.skip?[]:failed.map(c=>({ruleId:'original-exact-policy',level:'error',message:'Original adjacent identifier was accepted by '+c.consumer,file:c.consumer,line:1})),findingsComplete:true,tools:[{name:'original-node-policy-witness',version:'1.0.0'}]}));process.exitCode=control.skip?0:failed.length?1:0;
`;
  const manifest = {
    schemaVersion: 1,
    id: "external.archive",
    version: "1.0.0",
    description: "Original source-bound archive witness",
    runtime: "node",
    entry: "adapter.mjs",
    files: [{ path: "adapter.mjs", sha256: archiveHash(program) }],
    markers: ["original.project"],
    checks: [
      {
        id: "acceptance",
        kind: "test",
        description: "Original two-consumer decision controls",
        failOn: "error",
        scope: { extensions: [], names: ["first.mjs", "second.mjs"] },
      },
    ],
  };
  const text = JSON.stringify(manifest);
  await writeFile(path.join(bundle, "adapter.mjs"), program);
  await writeFile(path.join(bundle, "adapter.json"), text);
  const reference: ExternalReference = {
    path: path.join(bundle, "adapter.json"),
    sha256: archiveHash(text),
  };
  return {
    base,
    root,
    ready,
    release,
    reference,
    options: {
      trusted: true,
      externalAdapters: [reference],
      timeoutMs: process.platform === "win32" ? 45000 : 10000,
    },
  };
}
export async function runArchiveWitness(
  t: TestContext,
  mode: keyof typeof archivePolicies,
) {
  const d = await archiveFixture(t, mode);
  return { ...d, report: await validate(d.root, d.options) };
}
export function archiveNativeWitness(report: Report) {
  assert.equal(report.checks.length, 1);
  const check = report.checks[0]!;
  assert.equal(check.processes.length, 1);
  const process = check.processes[0]!,
    journal = process.nativeJournal!;
  assert.equal(journal.status, "collected");
  assert.equal(journal.errorCode, undefined);
  assert.equal(journal.cleanupErrorCode, undefined);
  assert.equal(journal.producer.name, "external");
  assert.equal(journal.producer.beforeSha256, journal.producer.afterSha256);
  assert.equal(
    journal.expectedHeader.sourceFingerprint,
    report.sourceFingerprint,
  );
  const capture = journal.capture!;
  assert.equal(capture.state, "complete");
  const headerBytes = Buffer.from(capture.headerData.base64, "base64"),
    frameBytes = Buffer.from(capture.framesData.base64, "base64");
  for (const [data, bytes] of [
    [capture.headerData, headerBytes],
    [capture.framesData, frameBytes],
  ] as const) {
    assert.equal(bytes.length, data.bytes);
    assert.equal(archiveHash(bytes), data.sha256);
  }
  const frames = frameBytes
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const replay = replayNativeAttemptFrames(
    JSON.parse(headerBytes.toString("utf8")),
    frames,
    journal.expectedHeader,
  );
  assert.equal(replay.completeForRecordedCalls, true);
  assert.equal(replay.attempts.length, 1);
  const attempt = replay.attempts[0]!;
  assert.equal(attempt.capturedOutput.completeForObservedStreams, true);
  const stderr = Buffer.from(attempt.capturedOutput.stderr.base64, "base64");
  assert.equal(stderr.length, attempt.capturedOutput.stderr.bytes);
  assert.equal(archiveHash(stderr), attempt.capturedOutput.stderr.sha256);
  const witness = JSON.parse(stderr.toString("utf8"));
  assert.equal(witness.pid, attempt.pid);
  assert.ok(witness.pid > 1);
  assert.equal(witness.undeclared, null);
  assert.equal(witness.originalCases.length, 4);
  assert.deepEqual(
    witness.originalCases.map((c: { consumer: string; input: string }) => [
      c.consumer,
      c.input,
    ]),
    [
      ["first.mjs", "grant"],
      ["first.mjs", "granting"],
      ["second.mjs", "grant"],
      ["second.mjs", "granting"],
    ],
  );
  return {
    process,
    journal,
    capture,
    replay,
    attempt,
    cases: witness.originalCases as Array<{
      consumer: string;
      input: string;
      expected: boolean;
      actual: boolean;
      passed: boolean;
    }>,
  };
}
