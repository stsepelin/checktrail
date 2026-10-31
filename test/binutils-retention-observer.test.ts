import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixture } from "./helpers.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
const moduleFile = path.join(
  root,
  "scripts/producer-qualification/binutils-retention-observer.mjs",
);
const pythonFile = path.join(
  root,
  "scripts/producer-qualification/binutils-retention-observer.py",
);
const {
  retentionObserverArguments,
  validateRetentionMessage,
  reconcileRetentionLog,
} = await import(pathToFileURL(moduleFile).href);
const image = "docker.io/coqorg/coq@sha256:" + "a".repeat(64);
const attempt = "12345678-1234-4234-8234-123456789abc";
const ready = {
  schemaVersion: 1,
  kind: "ready",
  roots: ["/observed/bundle", "/observed/controls", "/observed/work"],
};
const sample = (sequence = 1) => ({
  schemaVersion: 1,
  kind: "sample",
  sequence,
  bytes: 18,
  files: 1,
  directories: 3,
});
const diagnostic = (result: SpawnSyncReturns<string>) =>
  [
    result.error?.message,
    `status=${String(result.status)} signal=${String(result.signal)}`,
    result.stdout,
    result.stderr,
  ]
    .filter(Boolean)
    .join("\n");
const row = (stream: string, bytes: string | Buffer) =>
  JSON.stringify({ stream, base64: Buffer.from(bytes).toString("base64") }) +
  "\n";
const request = (sequence: number) =>
  JSON.stringify({ schemaVersion: 1, kind: "sample", sequence }) + "\n";
function transport() {
  return [
    row("stdout", JSON.stringify(ready) + "\n"),
    row("stdin", request(1)),
    row("stdout", JSON.stringify(sample()) + "\n"),
  ];
}
function receipt(bytes: Buffer) {
  return { retainedLogBytes: bytes.length, samples: 1, lastSample: sample() };
}

test("retention observer argv fixes read-only independent roots resource limits and read-search capability", () => {
  const destination = path.resolve("synthetic-observation");
  const args = retentionObserverArguments({
    destination,
    image,
    platform: "linux/amd64",
    attempt,
  });
  for (const [flag, value] of [
    ["--platform", "linux/amd64"],
    ["--user", "0:0"],
    ["--network", "none"],
    ["--cpus", "0.25"],
    ["--memory", "128m"],
    ["--pids-limit", "16"],
    ["--entrypoint", "/usr/bin/python3"],
  ])
    assert.equal(args[args.indexOf(flag) + 1], value);
  for (const value of [
    "--pull=never",
    "--read-only",
    "--cap-drop=ALL",
    "--cap-add=DAC_READ_SEARCH",
    "--security-opt=no-new-privileges",
  ])
    assert.ok(args.includes(value));
  const mounts = args.filter(
    (_: string, index: number) => args[index - 1] === "--mount",
  );
  assert.deepEqual(
    mounts,
    ["bundle", "controls", "work"].map(
      (name) =>
        `type=bind,src=${path.join(destination, name)},target=/observed/${name},readonly`,
    ),
  );
  assert.deepEqual(args.slice(-4), [
    "-I",
    "-S",
    "-B",
    "/observed/controls/binutils-retention-observer.py",
  ]);
  assert.ok(
    !args.some((value: string) =>
      /docker\.sock|--privileged|DAC_OVERRIDE|type=volume/u.test(value),
    ),
  );
  for (const change of [
    { image: image.replace("coqorg/coq@", "coqorg/coq-lookalike@") },
    { image: "docker.io/coqorg/coq:latest" },
    { platform: "linux/arm64" },
    { destination: "relative" },
    { destination: destination + ",extra" },
    { destination: destination + "\nextra" },
    { attempt: "../foreign" },
  ])
    assert.throws(() =>
      retentionObserverArguments({
        destination,
        image,
        platform: "linux/amd64",
        attempt,
        ...change,
      }),
    );
});
test("retention protocol rejects incomplete adjacent unsafe and over-bound counter identities", () => {
  assert.deepEqual(validateRetentionMessage(ready, 0), ready);
  assert.deepEqual(validateRetentionMessage(sample(), 1), sample());
  validateRetentionMessage({ ...sample(), bytes: 0, files: 999997 }, 1);
  for (const change of [
    { kind: "sample-extra" },
    { schemaVersion: true },
    { sequence: 2 },
    { bytes: -1 },
    { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { files: 0.5 },
    { files: true },
    { directories: 2 },
    { files: 999998 },
    { unknown: true },
  ])
    assert.throws(() =>
      validateRetentionMessage({ ...sample(), ...change }, 1),
    );
  for (const value of [
    { ...ready, roots: ready.roots.slice(1) },
    { ...ready, roots: [...ready.roots, "/observed/extra"] },
    { ...ready, unknown: true },
  ])
    assert.throws(() => validateRetentionMessage(value, 0));
});
test("retention durable replay binds fragmented physical responses to exact requests and final counters", () => {
  const first = JSON.stringify(sample()) + "\n";
  const bytes = Buffer.from(
    row("stdout", JSON.stringify(ready) + "\n") +
      row("stdin", request(1)) +
      row("stdout", first.slice(0, 13)) +
      row("stderr", "synthetic diagnostic\n") +
      row("stdout", first.slice(13)),
  );
  assert.deepEqual(reconcileRetentionLog(bytes, receipt(bytes)), {
    samples: 1,
    lastSample: sample(),
  });
  assert.throws(() =>
    reconcileRetentionLog(bytes, { ...receipt(bytes), samples: 2 }),
  );
  assert.throws(() =>
    reconcileRetentionLog(bytes, {
      ...receipt(bytes),
      retainedLogBytes: bytes.length + 1,
    }),
  );
  assert.throws(() =>
    reconcileRetentionLog(bytes, {
      ...receipt(bytes),
      lastSample: { ...sample(), bytes: 19 },
    }),
  );
});
test("retention durable replay rejects missing duplicate reordered truncated and foreign transport", () => {
  const valid = transport();
  const mutations = [
    valid.slice(1),
    [valid[0], valid[2]],
    [valid[0], valid[1], valid[1], valid[2]],
    [valid[0], row("stdin", request(2)), valid[2]],
    [valid[0], valid[1]],
    [...valid, valid[2]],
    [...valid, row("stdin", request(2))],
    [row("stderr", "diagnostic")],
    [
      row("stdout", JSON.stringify(ready) + "\n"),
      row("stdin", request(1)),
      row("stdout", JSON.stringify({ ...sample(), directories: 2 }) + "\n"),
    ],
  ];
  for (const lines of mutations) {
    const bytes = Buffer.from(lines.join(""));
    assert.throws(() => reconcileRetentionLog(bytes, receipt(bytes)));
  }
  const bytes = Buffer.from(valid.join(""));
  assert.throws(() =>
    reconcileRetentionLog(
      bytes.subarray(0, -1),
      receipt(bytes.subarray(0, -1)),
    ),
  );
  const invalid = Buffer.from(
    JSON.stringify({
      stream: "stdout",
      base64:
        Buffer.from(JSON.stringify(ready) + "\n").toString("base64") + "\n",
    }) + "\n",
  );
  assert.throws(() => reconcileRetentionLog(invalid, receipt(invalid)));
});

async function synthetic(t: TestContext, mode: string) {
  const directory = await fixture(t, { ".keep": "synthetic transport only" });
  const program = String.raw`import assert from 'node:assert/strict';import cp from 'node:child_process';import {syncBuiltinESMExports}from'node:module';import fs,{readFileSync}from'node:fs';import {pathToFileURL}from'node:url';
const [moduleFile,directory,mode,image,attempt]=process.argv.slice(1);const original=cp.spawn,originalWrite=fs.writeSync;let actual;const failures=[];
const peer=String.raw\`import fs from 'node:fs';import readline from 'node:readline';const [mode,marker]=process.argv.slice(1);if(mode==='resist')process.on('SIGTERM',()=>{});if(mode==='startup-fail'){process.stderr.write('synthetic startup failure');process.exit(7);}console.log(JSON.stringify({schemaVersion:1,kind:'ready',roots:['/observed/bundle','/observed/controls','/observed/work']}));const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{fs.appendFileSync(marker,line+'\n');const q=JSON.parse(line);setTimeout(()=>console.log(JSON.stringify({schemaVersion:1,kind:'sample',sequence:q.sequence,bytes:18,files:1,directories:3})),40);});lines.on('close',()=>{if(mode!=='resist')process.exit(0);});if(mode==='resist')setInterval(()=>{},100);\`;
cp.spawn=(command,args,options)=>{assert.equal(command,'docker');if(mode==='spawn-throw')throw Error('synthetic synchronous spawn failure');actual=original(process.execPath,['--input-type=module','-e',peer,mode,directory+'/requests'],options);return actual;};if(mode==='zero-write')fs.writeSync=()=>0;syncBuiltinESMExports();
try{const api=await import(pathToFileURL(moduleFile).href);
 if(mode==='spawn-throw'||mode==='zero-write'){const started=Date.now();await assert.rejects(api.startRetentionObserver({destination:directory,image,platform:'linux/amd64',attempt,environment:process.env,onFailure:error=>failures.push(String(error))}),mode==='spawn-throw'?/synthetic synchronous spawn failure/:/progress/);assert.ok(Date.now()-started<2500);}
 else if(mode==='startup-fail'){await assert.rejects(api.startRetentionObserver({destination:directory,image,platform:'linux/amd64',attempt,environment:process.env,onFailure:error=>failures.push(String(error))}),/terminal/);assert.equal(actual.exitCode,7);assert.ok(failures.length>0);}
 else{const observer=await api.startRetentionObserver({destination:directory,image,platform:'linux/amd64',attempt,environment:process.env,onFailure:error=>failures.push(String(error))});const first=observer.sample();await assert.rejects(observer.sample(),/Concurrent retention request refused/);assert.equal((await first).bytes,18);if(mode==='resist'){await assert.rejects(observer.close(),/terminal/);assert.equal(actual.signalCode,'SIGKILL');}else{const result=await observer.close();assert.equal(result.samples,1);assert.equal(result.terminal.exitCode,0);assert.equal(result.nativeFilesystemQuotaEnforced,false);assert.equal(api.reconcileRetentionLog(readFileSync(directory+'/retention-observer.jsonl'),result).samples,1);assert.deepEqual(failures,[]);}const lines=readFileSync(directory+'/requests','utf8').trim().split('\n');assert.equal(lines.length,1);assert.equal(JSON.parse(lines[0]).sequence,1);}
 console.log(JSON.stringify({syntheticTransportOnly:true,mode,producerExecuted:false,containerExecuted:false}));
}finally{cp.spawn=original;fs.writeSync=originalWrite;syncBuiltinESMExports();if(actual?.pid&&actual.exitCode===null&&actual.signalCode===null)actual.kill('SIGKILL');}`;
  // Nested String.raw is escaped only to keep this public fixture literal intact.
  const executableProgram = program.replaceAll("\\`", "`");
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      executableProgram,
      moduleFile,
      directory,
      mode,
      image,
      attempt,
    ],
    {
      encoding: "utf8",
      timeout: ["spawn-throw", "zero-write"].includes(mode) ? 3000 : 18000,
      maxBuffer: 1048576,
    },
  );
  assert.equal(child.error, undefined, diagnostic(child));
  assert.equal(child.signal, null, diagnostic(child));
  assert.equal(child.status, 0, diagnostic(child));
  assert.deepEqual(JSON.parse(child.stdout), {
    syntheticTransportOnly: true,
    mode,
    producerExecuted: false,
    containerExecuted: false,
  });
  return directory;
}
test(
  "retention actual synthetic transport refuses concurrent writes and reconciles one successful exchange",
  { timeout: 20000 },
  async (t) => {
    await synthetic(t, "normal");
  },
);
test(
  "retention actual synthetic startup failure retains original stderr and closes its foreground client",
  { timeout: 20000 },
  async (t) => {
    const directory = await synthetic(t, "startup-fail");
    const log = await readFile(
      path.join(directory, "retention-observer.jsonl"),
      "utf8",
    );
    const stderr = log
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.stream === "stderr")
      .map((row) => Buffer.from(row.base64, "base64"));
    assert.equal(
      Buffer.concat(stderr).toString("utf8"),
      "synthetic startup failure",
    );
  },
);
test(
  "retention actual synthetic client that ignores TERM is killed and cannot produce a completed receipt",
  {
    timeout: 20000,
    skip:
      process.platform === "win32"
        ? "POSIX TERM resistance is unavailable on Windows"
        : false,
  },
  async (t) => {
    await synthetic(t, "resist");
  },
);

test(
  "retention actual synchronous spawn failure clears the readiness timer and exits promptly",
  { timeout: 5000 },
  async (t) => {
    await synthetic(t, "spawn-throw");
  },
);
test(
  "retention actual zero-progress log write refuses startup instead of spinning past its deadline",
  { timeout: 5000 },
  async (t) => {
    await synthetic(t, "zero-write");
  },
);

const failures: string[] = [];
const python = ["python3", "python"].find((executable) => {
  const result = spawnSync(
    executable,
    [
      "-I",
      "-S",
      "-B",
      "-c",
      "import os,sys; assert sys.version_info.major==3 and hasattr(os,'O_NOFOLLOW') and hasattr(os,'O_DIRECTORY') and os.scandir in os.supports_fd and os.open in os.supports_dir_fd; print('nofollow-fd-walk')",
    ],
    { encoding: "utf8", timeout: 3000, maxBuffer: 65536 },
  );
  if (
    !result.error &&
    result.status === 0 &&
    result.signal === null &&
    result.stdout.trim() === "nofollow-fd-walk"
  )
    return true;
  failures.push(diagnostic(result));
  return false;
});
test(
  "retention actual Python no-follow walk counts only physical files and rejects links special entries and resource overruns",
  {
    skip: python
      ? false
      : "Verified Python3 no-follow FD walker unavailable: " +
        failures.join("; "),
  },
  async (t) => {
    const directory = await fixture(t, { ".keep": "synthetic" });
    const program = String.raw`import importlib.util,json,os,pathlib,sys
spec=importlib.util.spec_from_file_location('observer',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);base=pathlib.Path(sys.argv[2]);roots=[base/n for n in ['bundle','controls','work']]
for p in roots:p.mkdir()
(roots[0]/'a').write_bytes(b'synthetic payload\n');(roots[1]/'b').write_bytes(b'abc');(roots[2]/'nested').mkdir();(roots[2]/'nested/c').write_bytes(b'12345')
assert m.MAX_ENTRIES==1000000 and m.MAX_BYTES==2**53-1 and m.MAX_SECONDS==30;expected={'bytes':26,'files':3,'directories':4};assert m.count_roots(roots)==expected;count=1
for parent,target in [(roots[0],roots[0]/'a'),(roots[2],roots[1])]:
 p=parent/'alias';p.symlink_to(target)
 try:
  try:m.count_roots(roots)
  except ValueError as error:assert 'linked or nonregular' in str(error);count+=1
  else:raise AssertionError('Link admitted')
 finally:p.unlink()
p=roots[2]/'pipe';os.mkfifo(p)
try:
 try:m.count_roots(roots)
 except ValueError as error:assert 'linked or nonregular' in str(error);count+=1
 else:raise AssertionError('FIFO admitted')
finally:p.unlink()
p=base/'root-alias';p.symlink_to(roots[0])
try:
 try:m.count_roots([p,*roots[1:]])
 except OSError:count+=1
 else:raise AssertionError('Root link followed')
finally:p.unlink()
for field,value,reason in [('MAX_ENTRIES',6,'entry'),('MAX_BYTES',25,'byte'),('MAX_SECONDS',-1,'deadline')]:
 old=getattr(m,field);setattr(m,field,value)
 try:
  try:m.count_roots(roots)
  except ValueError as error:assert reason in str(error);count+=1
  else:raise AssertionError('Resource limit admitted: '+field)
 finally:setattr(m,field,old)
assert m.count_roots(roots)==expected;count+=1
print(json.dumps({'passed':count,'producerExecuted':False,'crossUidDenialProven':False}))`;
    const child = spawnSync(
      python!,
      ["-I", "-S", "-B", "-c", program, pythonFile, directory],
      {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1048576,
      },
    );
    assert.equal(child.error, undefined, diagnostic(child));
    assert.equal(child.status, 0, diagnostic(child));
    assert.deepEqual(JSON.parse(child.stdout), {
      passed: 9,
      producerExecuted: false,
      crossUidDenialProven: false,
    });
  },
);
