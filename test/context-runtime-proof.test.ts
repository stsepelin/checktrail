import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { parseContextAttestationJson } from "../src/context-runtime-attestation.js";
import {
  contextRuntimeProofReferenceSchema,
  readContextRuntimeProofInput,
} from "../src/context-runtime-proof.js";

const moduleUrl = new URL("../src/context-runtime-proof.js", import.meta.url)
  .href;
const child = (
  selection: string | undefined,
  expression = "selectedContextRuntimeProof() === undefined",
) => {
  const env = { ...process.env };
  delete env.CHECKTRAIL_CONTEXT_RELEASE_PROOF;
  if (selection !== undefined) env.CHECKTRAIL_CONTEXT_RELEASE_PROOF = selection;
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {selectedContextRuntimeProof} from ${JSON.stringify(moduleUrl)}; console.log(${expression});`,
    ],
    { env, encoding: "utf8", timeout: 15000, maxBuffer: 262144 },
  );
};
test("context proof reference rejects unknown fields and private paths", () => {
  assert.equal(
    contextRuntimeProofReferenceSchema.safeParse({
      sha256: "a".repeat(64),
      bytes: 1,
      policyId: "wrong",
      policySha256: "b".repeat(64),
      scope: "selected-context-runtime-release",
      proofPath: "/private/proof",
    }).success,
    false,
  );
});
test("context proof operator selection is absent for unset and empty startup values", () => {
  for (const value of [undefined, ""]) {
    const result = child(value);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "true");
  }
});
test("context proof selection rejects malformed nonempty startup authority", () => {
  for (const value of [
    " ",
    "/tmp/proof.json",
    "relative#sha256=" + "a".repeat(64),
    "/tmp/proof.json#sha256=" + "A".repeat(64),
    "/tmp/proof.json#sha256=" + "a".repeat(63),
  ]) {
    const result = child(value);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Malformed operator context-runtime proof selection/,
    );
  }
});
test("context proof authority cannot be added after static module import", () => {
  const result = child(
    undefined,
    `(process.env.CHECKTRAIL_CONTEXT_RELEASE_PROOF='/tmp/late#sha256=${"a".repeat(64)}', selectedContextRuntimeProof() === undefined)`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "true");
});
test("context proof JSON rejects duplicates, invalid UTF-8, depth and byte overflows", () => {
  for (const raw of [
    Buffer.from('{"value":1,"value":2}'),
    Buffer.from([0xff]),
    Buffer.from("[".repeat(26) + "0" + "]".repeat(26)),
    Buffer.alloc(262145, 32),
  ])
    assert.throws(() => parseContextAttestationJson(raw));
  assert.deepEqual(
    parseContextAttestationJson(Buffer.from('{"value":[1,2]}')),
    { value: [1, 2] },
  );
});
test("context proof bounded reader rejects files, directories and linked parents at their actual boundary", () => {
  const directory = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "ct-proof-read-")),
  );
  try {
    const real = path.join(directory, "real");
    mkdirSync(real);
    const file = path.join(real, "input.json");
    writeFileSync(file, "{}", { mode: 0o600 });
    assert.equal(readContextRuntimeProofInput(file, 2).toString(), "{}");
    assert.throws(
      () => readContextRuntimeProofInput(file, 1),
      /Bounded regular proof input/,
    );
    assert.throws(
      () => readContextRuntimeProofInput(real, 100),
      /Bounded regular proof input/,
    );
    const link = path.join(directory, "linked");
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => readContextRuntimeProofInput(path.join(link, "input.json"), 2),
      /Linked input or parent/,
    );
    chmodSync(file, 0o400);
    assert.equal(readContextRuntimeProofInput(file, 2).toString(), "{}");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("context proof reader rejects a real concurrently growing input", async () => {
  const directory = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "ct-proof-grow-")),
  );
  const file = path.join(directory, "input.bin"),
    shared = new SharedArrayBuffer(8),
    state = new Int32Array(shared);
  writeFileSync(file, Buffer.alloc(32 * 1024 * 1024));
  const worker = new Worker(
    `const {workerData}=require('node:worker_threads'); const fs=require('node:fs'); const state=new Int32Array(workerData.shared); const fd=fs.openSync(workerData.file,'a'); Atomics.store(state,0,1); Atomics.notify(state,0); try { while(Atomics.load(state,1)===0) fs.writeSync(fd,Buffer.from([1])); } finally {fs.closeSync(fd);}`,
    { eval: true, workerData: { file, shared } },
  );
  try {
    for (
      let attempts = 0;
      Atomics.load(state, 0) === 0 && attempts < 5000;
      attempts++
    )
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    assert.equal(Atomics.load(state, 0), 1, "Synthetic grower must start");
    assert.throws(
      () => readContextRuntimeProofInput(file, 64 * 1024 * 1024),
      /grew or truncated|changed while reading|changed before open/,
    );
  } finally {
    Atomics.store(state, 1, 1);
    await worker.terminate();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("context proof actual read loop caps growth after the preflight fstat and retains its stable near miss", () => {
  const directory = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "ct-proof-read-loop-")),
  );
  const file = path.join(directory, "input.bin");
  try {
    for (const grow of [false, true]) {
      writeFileSync(file, "original");
      const script = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import {syncBuiltinESMExports} from 'node:module';
        import {readContextRuntimeProofInput} from ${JSON.stringify(moduleUrl)};
        const file=${JSON.stringify(file)}, grow=${JSON.stringify(grow)};
        const original=fs.readSync;
        let bytes=0, calls=0, refusal=null;
        fs.readSync=(...args)=>{
          if(calls++===0 && grow) fs.appendFileSync(file,'growth');
          const read=Reflect.apply(original,fs,args);bytes+=read;return read;
        };
        syncBuiltinESMExports();
        try {
          if(grow) assert.throws(()=>readContextRuntimeProofInput(file,8),error=>{refusal=error.message;return /grew or truncated while reading/.test(error.message);});
          else assert.equal(readContextRuntimeProofInput(file,8).toString(),'original');
        }finally{fs.readSync=original;syncBuiltinESMExports();}
        assert.equal(fs.readSync,original);
        assert.equal(bytes,grow?9:8);
        assert.ok(bytes<=9);
        assert.equal(fs.statSync(file).size,grow?14:8);
        console.log(JSON.stringify({bytesRead:bytes,initialBytes:8,cap:9,calls,refusal,hookRestored:fs.readSync===original}));
      `;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        { encoding: "utf8", timeout: 15000, maxBuffer: 262144 },
      );
      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(result.stdout) as {
        bytesRead: number;
        initialBytes: number;
        cap: number;
        calls: number;
        refusal: string | null;
        hookRestored: boolean;
      };
      assert.deepEqual(
        {
          bytesRead: receipt.bytesRead,
          initialBytes: receipt.initialBytes,
          cap: receipt.cap,
          hookRestored: receipt.hookRestored,
        },
        {
          bytesRead: grow ? 9 : 8,
          initialBytes: 8,
          cap: 9,
          hookRestored: true,
        },
      );
      if (grow) {
        assert.equal(receipt.calls, 1);
        assert.match(receipt.refusal!, /grew or truncated while reading/);
      } else assert.equal(receipt.refusal, null);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
