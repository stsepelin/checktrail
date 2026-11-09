import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";

const helper = new URL(
  "../../scripts/consumer-native-runtime-receipts.mjs",
  import.meta.url,
);
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function original(stdout: Buffer, stderr: Buffer) {
  const entry = {
    complete: true,
    truncated: false,
    stdout: {
      bytes: stdout.length,
      observedBytes: stdout.length,
      sha256: hash(stdout),
    },
    stderr: {
      bytes: stderr.length,
      observedBytes: stderr.length,
      sha256: hash(stderr),
    },
  };
  const body = {
    profile: "native-consumer-scope-capsule-v1",
    scope: {
      id: "consumer-impact:ci-linux-node22",
      acceptanceProfile: "consumer-impact",
    },
    attemptId: "12345678-1234-4123-8123-123456789abc",
    source: { commit: "a".repeat(40), gitTree: "b".repeat(40) },
    ci: { runId: "12345", runAttempt: "1" },
    controller: {
      moduleCompleted: true,
      processExitObserved: false,
      requiresSuccessfulOuterJob: true,
      stdoutBytes: stdout.length,
      stdoutSha256: hash(stdout),
      stderrBytes: stderr.length,
      stderrSha256: hash(stderr),
    },
    scopeComplete: true,
    gateAComplete: false,
    hostAttestationPerformed: false,
    wholeUpstreamClosureVerified: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  };
  return {
    entry,
    capsule: {
      ...body,
      capsuleSha256: hash(Buffer.from(JSON.stringify(body))),
    },
  };
}

test("consumer runtime retention preserves original binary CRLF newline and empty stderr bytes with capsule binding", async (t) => {
  const { retainConsumerRuntimeReceipt: retain } = await import(helper.href);
  const root = await realpath(await fixture(t, {})),
    directory = path.join(root, "receipts");
  await mkdir(directory, { mode: 0o700 });
  const stdout = Buffer.from([0xff, 0, 123, 13, 10, 125, 10]),
    stderr = Buffer.alloc(0);
  const { capsule, entry } = original(stdout, stderr);
  const saved = await retain(directory, capsule, entry, stdout, stderr);
  const bundle = path.join(directory, saved.directory);
  assert.deepEqual((await readdir(bundle)).sort(), [
    "controller.stderr",
    "controller.stdout",
    "receipt.json",
  ]);
  assert.deepEqual(
    await readFile(path.join(bundle, "controller.stdout")),
    stdout,
  );
  assert.deepEqual(
    await readFile(path.join(bundle, "controller.stderr")),
    stderr,
  );
  const rawManifest = await readFile(path.join(bundle, "receipt.json"), "utf8");
  const manifest = JSON.parse(rawManifest);
  assert.equal(manifest.capsuleSha256, capsule.capsuleSha256);
  assert.deepEqual(manifest.streams.stdout, {
    file: "controller.stdout",
    bytes: stdout.length,
    sha256: hash(stdout),
  });
  assert.deepEqual(manifest.streams.stderr, {
    file: "controller.stderr",
    bytes: 0,
    sha256: hash(stderr),
  });
  assert.equal(manifest.processExitObserved, false);
  assert.equal(manifest.hostAttestationPerformed, false);
  assert.equal(manifest.gateAComplete, false);
  assert.equal(rawManifest.includes(root), false);
  await assert.rejects(retain(directory, capsule, entry, stdout, stderr));
  assert.deepEqual(
    await readFile(path.join(bundle, "controller.stdout")),
    stdout,
  );
});

test("consumer runtime retention refuses stale forged incomplete and oversized evidence before publishing any member", async (t) => {
  const { retainConsumerRuntimeReceipt: retain } = await import(helper.href);
  const root = await realpath(await fixture(t, {})),
    directory = path.join(root, "receipts");
  await mkdir(directory, { mode: 0o700 });
  const stdout = Buffer.from('{"original":"unchanged"}\r\n'),
    stderr = Buffer.from("original diagnostic\n");
  for (const mode of [
    "body",
    "hash",
    "length",
    "observed",
    "incomplete",
    "truncated",
    "capsule-stream",
    "promotion",
    "scope",
    "empty",
    "overflow",
  ]) {
    let value = original(stdout, stderr);
    let selected = stdout;
    if (mode === "body") value.capsule.source.commit = "c".repeat(40);
    else if (mode === "hash") value.entry.stdout.sha256 = "c".repeat(64);
    else if (mode === "length") value.entry.stdout.bytes++;
    else if (mode === "observed") value.entry.stderr.observedBytes++;
    else if (mode === "incomplete") value.entry.complete = false;
    else if (mode === "truncated") value.entry.truncated = true;
    else if (mode === "capsule-stream")
      value.capsule.controller.stderrSha256 = "c".repeat(64);
    else if (mode === "promotion") value.capsule.gateAComplete = true;
    else if (mode === "scope")
      value.capsule.scope.acceptanceProfile = "consumer-impact-extra";
    else if (mode === "empty") selected = Buffer.alloc(0);
    else selected = Buffer.alloc(32 * 1048576 + 1);
    if (["empty", "overflow"].includes(mode))
      value = original(selected, stderr);
    if (!["body", "empty", "overflow"].includes(mode)) {
      const body = Object.fromEntries(
        Object.entries(value.capsule).filter(
          ([key]) => key !== "capsuleSha256",
        ),
      );
      value.capsule.capsuleSha256 = hash(Buffer.from(JSON.stringify(body)));
    }
    await assert.rejects(
      retain(directory, value.capsule, value.entry, selected, stderr),
      { name: "AssertionError" },
      mode,
    );
    assert.deepEqual(await readdir(directory), [], mode);
  }
});

test("consumer runtime retention admits a valid stderr stream and refuses linked output custody", async (t) => {
  const { retainConsumerRuntimeReceipt: retain } = await import(helper.href);
  const root = await realpath(await fixture(t, {})),
    directory = path.join(root, "receipts"),
    alias = path.join(root, "alias");
  await mkdir(directory, { mode: 0o700 });
  await symlink(
    directory,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const stdout = Buffer.from("{}\n"),
    stderr = Buffer.from("ordinary progress\r\n");
  const { capsule, entry } = original(stdout, stderr);
  await assert.rejects(retain(alias, capsule, entry, stdout, stderr));
  assert.deepEqual(await readdir(directory), []);
  const saved = await retain(directory, capsule, entry, stdout, stderr);
  assert.deepEqual(
    await readFile(path.join(directory, saved.directory, "controller.stderr")),
    stderr,
  );
});

test("reconciled consumer wrapper retains original streams separately and refuses overlapping publication directories", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const root = await realpath(await fixture(t, {}));
  const worker = path.join(root, "observe.mjs");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    worker,
    `import {registerHooks} from'node:module';import{fileURLToPath}from'node:url';const target=process.argv[2];
const scope={id:'consumer-impact:ci-linux-node22',acceptanceProfile:'consumer-impact',slot:'ci-linux-node22',docker:false,selectedClang:false,command:{executable:process.execPath,args:['scripts/verify-consumer-runtime.mjs','ci-linux-node22']}};globalThis.originalScope=scope;globalThis.originalStreamValues={"stdout":[123,34,111,114,105,103,105,110,97,108,34,58,34,115,121,110,116,104,101,116,105,99,32,114,101,99,101,105,112,116,34,125,13,10],"stderr":[79,114,105,103,105,110,97,108,32,115,121,110,116,104,101,116,105,99,32,112,114,111,103,114,101,115,115,10]};
const scopeModule="export const selectConsumerNativeAcceptance=()=>globalThis.originalScope;export const consumerNativeAcceptanceScopes=()=>[globalThis.originalScope];";
const frameModule="export async function captureConsumerNativeSourceFrame(){return{commit:'a'.repeat(40),gitTree:'b'.repeat(40),clean:true};}export function requireConsumerNativeSourceFrame(){};export function consumerNativeCIRunObservation(){return{kind:'github-actions-run-metadata',runId:'12345',runAttempt:'1'};}";
const storage=new URL('./consumer-native-host-storage.mjs',target).href;
const storageModule="import * as original from "+JSON.stringify(storage)+";export const requireConsumerPrivateDirectory=original.requireConsumerPrivateDirectory,readConsumerPrivateFile=original.readConsumerPrivateFile,writeConsumerPrivateFile=original.writeConsumerPrivateFile;export async function acquireConsumerHostCapture(){return{};}export async function releaseConsumerHostCapture(){};";
const captureModule="import{Buffer}from'node:buffer';import{createHash}from'node:crypto';import path from'node:path';import{writeConsumerPrivateFile}from "+JSON.stringify(storage)+";export async function captureConsumerControllerEntry(root,command,directory){const record={complete:true,truncated:false};for(const [name,values]of Object.entries(globalThis.originalStreamValues)){const bytes=Buffer.from(values);const filename=path.join(directory,'controller.'+name);await writeConsumerPrivateFile(filename,bytes);record[name]={path:filename,bytes:bytes.length,observedBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}return record;}export function consumerNativeFailureDiagnostic(){return null;}";
const capsuleModule="import{createHash}from'node:crypto';export function consumerNativeCapsuleFilename(){return'consumer-impact--ci-linux-node22.json';}export const consumerNativeScopeSummary=()=>({});export async function normalizeConsumerNativeCapsule({scope,context,entry,frameBefore,ci}){const body={profile:'native-consumer-scope-capsule-v1',scope,attemptId:context.attemptId,source:frameBefore,ci,controller:{moduleCompleted:true,processExitObserved:false,requiresSuccessfulOuterJob:true,stdoutBytes:entry.stdout.bytes,stdoutSha256:entry.stdout.sha256,stderrBytes:entry.stderr.bytes,stderrSha256:entry.stderr.sha256},scopeComplete:true,gateAComplete:false,hostAttestationPerformed:false,wholeUpstreamClosureVerified:false,inferenceInvoked:false,fieldEvaluationExecuted:false};return{...body,capsuleSha256:createHash('sha256').update(JSON.stringify(body)).digest('hex')};}";
registerHooks({resolve(specifier,context,next){if(context.parentURL===target){const code=specifier==='./consumer-native-acceptance-scope.mjs'?scopeModule:specifier==='./consumer-native-acceptance-frame.mjs'?frameModule:specifier==='./consumer-native-controller-entry.mjs'?captureModule:specifier==='./consumer-native-capture-registry.mjs'?"export async function createConsumerCaptureRegistry(directory){return{path:directory+'/registry.json'};}":specifier==='./consumer-native-host-storage.mjs'?storageModule:specifier==='./consumer-native-acceptance-capsule.mjs'?capsuleModule:null;if(code)return{url:'data:text/javascript,'+encodeURIComponent(code),shortCircuit:true};}return next(specifier,context);}});
process.argv=[process.execPath,fileURLToPath(target),'consumer-impact','ci-linux-node22'];await import(target);`,
  );
  for (const mode of [
    "separate",
    "same",
    "inside-capsule",
    "contains-capsule",
  ]) {
    const overlap = mode !== "separate";
    const base = path.join(root, mode);
    await mkdir(base, { mode: 0o700 });
    const capsules = path.join(base, "capsules");
    const receipts =
      mode === "same"
        ? capsules
        : mode === "inside-capsule"
          ? path.join(capsules, "receipts")
          : mode === "contains-capsule"
            ? base
            : path.join(base, "receipts");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      CHECKTRAIL_NATIVE_CAPSULE_DIRECTORY: capsules,
      CHECKTRAIL_NATIVE_RUNTIME_RECEIPT_DIRECTORY: receipts,
    };
    for (const key of [
      "NODE_TEST_CONTEXT",
      "CHECKTRAIL_CONSUMER_WITNESS_DIR",
      "CHECKTRAIL_CONSUMER_CAPTURE_ROOT",
      "CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY",
      "CHECKTRAIL_CONSUMER_DOCKER_CONTEXT",
      "CHECKTRAIL_NATIVE_DIAGNOSTIC_DIRECTORY",
    ])
      delete env[key];
    const result = spawnSync(
      process.execPath,
      [
        worker,
        new URL(
          "../../scripts/verify-consumer-native-acceptance.mjs",
          import.meta.url,
        ).href,
      ],
      { env, encoding: "utf8", timeout: 20000, maxBuffer: 65536 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, overlap ? 1 : 0, result.stderr);
    if (overlap) {
      assert.equal(result.stdout, "");
      assert.deepEqual(await readdir(capsules), []);
      continue;
    }
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.scope, "consumer-impact:ci-linux-node22");
    assert.equal(result.stdout.includes("synthetic receipt"), false);
    assert.deepEqual(await readdir(capsules), [
      "consumer-impact--ci-linux-node22.json",
    ]);
    const bundles = await readdir(receipts);
    assert.equal(bundles.length, 1);
    const bundle = path.join(receipts, bundles[0]!);
    const stdout = await readFile(path.join(bundle, "controller.stdout"));
    assert.deepEqual(
      stdout,
      Buffer.from('{"original":"synthetic receipt"}\r\n'),
    );
    const manifest = JSON.parse(
      await readFile(path.join(bundle, "receipt.json"), "utf8"),
    );
    assert.equal(manifest.capsuleSha256, summary.capsuleSha256);
    assert.equal(manifest.streams.stdout.sha256, hash(stdout));
  }
});
