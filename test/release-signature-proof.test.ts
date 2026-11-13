import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import {
  encodeReleaseSignatureProof,
  parseReleaseProofPin,
  readReleaseSignatureProof,
  releaseSignatureVerificationSchema,
  validateReleaseSignatureProof,
  type ReleaseSignaturePin,
  type ReleaseSignaturePolicy,
  type ReleaseSignatureVerification,
} from "../src/release-signature-proof.js";
const exec = promisify(execFile);
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const pin = (name: string, body: Uint8Array): ReleaseSignaturePin => ({
  path: name,
  bytes: body.byteLength,
  sha256: hash(body),
});
const signer = "F11BC0E2E300D716609BE700E3A813C1B152CF5B";
const fixture = new URL(
  "../../test/fixtures/release-signature/",
  import.meta.url,
);
const helper = new URL(
  "../../scripts/release-signature-preparation.mjs",
  import.meta.url,
).href;
const proofModule = new URL(
  "../src/release-signature-proof.js",
  import.meta.url,
).href;
async function temporary(t: TestContext) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "checktrail-release-proof-test-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function sample() {
  const key = await readFile(new URL("public-key.asc", fixture)),
    subject = await readFile(new URL("checksums.txt", fixture)),
    signature = await readFile(new URL("signature.asc", fixture));
  const first = Buffer.from("synthetic first payload\n"),
    second = Buffer.from("synthetic second payload\n");
  const policy: ReleaseSignaturePolicy = {
    id: "synthetic-two-payload-release-v1",
    payloads: [pin("first.txt", first), pin("second.txt", second)],
    publicKey: pin("public-key.asc", key),
    signatures: [
      {
        subject: pin("checksums.txt", subject),
        signature: pin("signature.asc", signature),
        signerFingerprint: signer,
        primaryFingerprint: signer,
      },
    ],
  };
  return { key, subject, signature, policy };
}
function syntheticVerification(
  policy: ReleaseSignaturePolicy,
): ReleaseSignatureVerification {
  const tool = (role: "gpg" | "gpgv") => ({
    role,
    before: pin(role, Buffer.from(role)),
    after: pin(role, Buffer.from(role)),
    version: "synthetic machine-status fixture; no crypto claim",
  });
  return {
    keyValidityAssessed: false,
    keyOwnerTrustEstablished: false,
    publicKey: { ...policy.publicKey },
    tools: [tool("gpg"), tool("gpgv")],
    signatures: policy.signatures.map((item) => ({
      subject: { ...item.subject },
      signature: { ...item.signature },
      exitCode: 0,
      status: `[GNUPG:] NEWSIG\n[GNUPG:] VALIDSIG ${item.signerFingerprint} 2023-11-14 1700000000 0 4 0 22 8 00 ${item.primaryFingerprint}\n`,
      stderr: "",
      signerFingerprint: item.signerFingerprint,
      primaryFingerprint: item.primaryFingerprint,
    })),
  };
}
test("release proof binds a separately selected signed subset and complete two-payload cohort", async () => {
  const { policy } = await sample(),
    raw = encodeReleaseSignatureProof(policy, syntheticVerification(policy));
  const proof = validateReleaseSignatureProof(raw, hash(raw), policy);
  assert.equal(proof.payloads.length, 2);
  assert.equal(proof.verification.signatures.length, 1);
  assert.equal(proof.verification.keyValidityAssessed, false);
  assert.equal(proof.verification.keyOwnerTrustEstablished, false);
  const changed = JSON.parse(raw.toString());
  changed.payloads.pop();
  const forged = Buffer.from(JSON.stringify(changed));
  assert.throws(
    () => validateReleaseSignatureProof(forged, hash(raw), policy),
    /Operator release proof pin differs/u,
  );
  assert.throws(
    () => validateReleaseSignatureProof(forged, hash(forged), policy),
    /payload cohort differs/u,
  );
  assert.throws(
    () =>
      validateReleaseSignatureProof(raw, hash(raw), {
        ...policy,
        id: "another-policy",
      }),
    /policy differs/u,
  );
});
test("release proof pin is explicit and malformed nonempty values never downgrade", () => {
  assert.equal(parseReleaseProofPin(undefined), "");
  assert.equal(parseReleaseProofPin(""), "");
  assert.equal(parseReleaseProofPin("a".repeat(64)), "a".repeat(64));
  for (const value of [
    " ",
    "a",
    "a".repeat(63),
    "A".repeat(64),
    "a".repeat(64) + "\n",
  ])
    assert.throws(() => parseReleaseProofPin(value));
});
test("release proof retains unrelated expired-key diagnostics without inventing key validity", async () => {
  const { policy } = await sample(),
    verification = syntheticVerification(policy);
  verification.signatures[0]!.status =
    "[GNUPG:] KEYEXPIRED 1\n" + verification.signatures[0]!.status;
  const raw = encodeReleaseSignatureProof(policy, verification);
  assert.equal(
    validateReleaseSignatureProof(raw, hash(raw), policy).verification
      .keyValidityAssessed,
    false,
  );
  for (const code of [
    "BADSIG",
    "ERRSIG",
    "EXPKEYSIG",
    "EXPSIG",
    "REVKEYSIG",
    "NO_PUBKEY",
  ]) {
    const bad = structuredClone(verification);
    bad.signatures[0]!.status += `[GNUPG:] ${code} ${signer}\n`;
    assert.throws(
      () => encodeReleaseSignatureProof(policy, bad),
      /did not verify/u,
    );
  }
});
test("release proof rejects duplicate JSON fields, unknown fields, omitted signatures, changed tools and excessive nesting", async () => {
  const { policy } = await sample(),
    raw = encodeReleaseSignatureProof(policy, syntheticVerification(policy));
  const duplicate = Buffer.from(
    raw
      .toString()
      .replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
  );
  assert.throws(
    () => validateReleaseSignatureProof(duplicate, hash(duplicate), policy),
    /ambiguous/u,
  );
  for (const mutate of [
    (p: Record<string, unknown>) => {
      p.unknown = true;
    },
    (p: Record<string, unknown>) => {
      (p.verification as ReleaseSignatureVerification).signatures = [];
    },
    (p: Record<string, unknown>) => {
      (p.verification as ReleaseSignatureVerification).tools[0]!.after.sha256 =
        "0".repeat(64);
    },
  ]) {
    const changed = JSON.parse(raw.toString()) as Record<string, unknown>;
    mutate(changed);
    const bytes = Buffer.from(JSON.stringify(changed));
    assert.throws(() =>
      validateReleaseSignatureProof(bytes, hash(bytes), policy),
    );
  }
  const deep = Buffer.from("[".repeat(20) + "0" + "]".repeat(20));
  assert.throws(
    () => validateReleaseSignatureProof(deep, hash(deep), policy),
    /nesting bound/u,
  );
});
test("physical release proof reader rejects aliases and consumes at most initial size plus one on growth", async (t) => {
  const root = await temporary(t),
    { policy } = await sample(),
    raw = encodeReleaseSignatureProof(policy, syntheticVerification(policy));
  const file = path.join(root, "proof.json");
  await writeFile(file, raw);
  assert.equal(
    readReleaseSignatureProof(file, hash(raw), policy).payloads.length,
    2,
  );
  const code = `import assert from 'node:assert/strict';import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
const module=await import(process.argv[1]);const[file,pin,policy]=process.argv.slice(2);const before=fs.statSync(file).size;let used=0,max=0,unbounded=0,grown=false;const read=fs.readSync,readFile=fs.readFileSync;
const grow=()=>{if(!grown){grown=true;fs.appendFileSync(file,Buffer.alloc(1024*1024))}};
try{fs.readSync=(fd,b,o,n,p)=>{grow();max=Math.max(max,n);const got=read(fd,b,o,n,p);used+=got;return got};fs.readFileSync=(p,...rest)=>{if(typeof p==='number'){unbounded++;grow()}return readFile(p,...rest)};syncBuiltinESMExports();assert.throws(()=>module.readReleaseSignatureProof(file,pin,JSON.parse(policy)),/read bound|changed/u);assert.equal(unbounded,0);assert.ok(used<=before+1);assert.ok(max<=before+1);assert.equal(grown,true);console.log(JSON.stringify({used,max,before,unbounded}))}finally{fs.readSync=read;fs.readFileSync=readFile;syncBuiltinESMExports()}`;
  const result = await exec(process.execPath, [
    "--input-type=module",
    "-e",
    code,
    proofModule,
    file,
    hash(raw),
    JSON.stringify(policy),
  ]);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.unbounded, 0);
  assert.equal(observed.used, raw.length + 1);
});
test("native signature helper rejects count and aggregate bounds before snapshots or executable access", async () => {
  const code = `import assert from'node:assert/strict';import{Buffer}from'node:buffer';import fs from'node:fs/promises';import{syncBuiltinESMExports}from'node:module';const{verifyDetachedReleaseSignatures:verify}=await import(process.argv[1]);
const key=new Uint8Array([1]),sig=new Uint8Array([2]),large=new Uint8Array(32*1024*1024);const from=Buffer.from,access=fs.access;let copies=0,touched=0;const make=(n,body)=>Array.from({length:n},(_,i)=>({subject:{path:'subject-'+i,body},signature:{path:'signature-'+i,body:sig}}));
try{Buffer.from=function(a,...rest){if(a===key||a===sig||a===large)copies++;return from(a,...rest)};fs.access=async()=>{touched++;throw Error('unexpected verifier access')};syncBuiltinESMExports();for(const signatures of[make(17,key),make(3,large)])await assert.rejects(()=>verify({publicKey:{path:'key.asc',body:key},signatures,signerFingerprint:'A'.repeat(40),primaryFingerprint:'A'.repeat(40)}),/cohort exceeds/u);assert.equal(copies,0);assert.equal(touched,0);console.log(JSON.stringify({copies,touched}))}finally{Buffer.from=from;fs.access=access;syncBuiltinESMExports()}`;
  const result = await exec(process.execPath, [
    "--input-type=module",
    "-e",
    code,
    helper,
  ]);
  assert.deepEqual(JSON.parse(result.stdout), { copies: 0, touched: 0 });
});
test("native verifier observation rejects growth before consuming an unbounded executable", async (t) => {
  if (process.platform === "win32")
    return t.skip("Native GPG preparation is selected on POSIX hosts");
  const root = await temporary(t),
    file = path.join(root, "verifier");
  await writeFile(file, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const code = `import assert from'node:assert/strict';import fs from'node:fs';import fsp from'node:fs/promises';import{syncBuiltinESMExports}from'node:module';const{verifyDetachedReleaseSignatures:verify}=await import(process.argv[1]);const file=process.argv[2],before=fs.statSync(file).size;const open=fsp.open;let used=0,max=0,unbounded=0,grown=false;
try{fsp.open=async(...args)=>{const h=await open(...args);if(args[0]===file){const read=h.read.bind(h),readFile=h.readFile.bind(h);h.read=async(b,o,n,p)=>{if(!grown){grown=true;fs.appendFileSync(file,Buffer.alloc(1024*1024))}max=Math.max(max,n);const r=await read(b,o,n,p);used+=r.bytesRead;return r};h.readFile=async(...a)=>{unbounded++;return readFile(...a)}}return h};syncBuiltinESMExports();await assert.rejects(()=>verify({publicKey:{path:'key',body:new Uint8Array([1])},signatures:[{subject:{path:'data',body:new Uint8Array([2])},signature:{path:'sig',body:new Uint8Array([3])}}],signerFingerprint:'A'.repeat(40),primaryFingerprint:'A'.repeat(40),tools:{gpg:file,gpgv:file}}),/read bound/u);assert.equal(grown,true);assert.equal(unbounded,0);assert.ok(used<=before+1);assert.ok(max<=before+1);console.log(JSON.stringify({used,before,max,unbounded}))}finally{fsp.open=open;syncBuiltinESMExports()}`;
  const result = await exec(process.execPath, [
    "--input-type=module",
    "-e",
    code,
    helper,
    file,
  ]);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.used, observed.before + 1);
  assert.equal(observed.unbounded, 0);
});
test("explicit native GPG preparation verifies the original synthetic signature and rejects changed signed bytes", async (t) => {
  if (process.platform === "win32")
    return t.skip("Native GPG preparation is selected on POSIX hosts");
  const native = (await import(helper)) as {
    verifyDetachedReleaseSignatures(options: unknown): Promise<unknown>;
  };
  const { key, subject, signature, policy } = await sample();
  const input = {
    publicKey: { path: "public-key.asc", body: key },
    signatures: [
      {
        subject: { path: "checksums.txt", body: subject },
        signature: { path: "signature.asc", body: signature },
      },
    ],
    signerFingerprint: signer,
    primaryFingerprint: signer,
  };
  const verification = releaseSignatureVerificationSchema.parse(
    await native.verifyDetachedReleaseSignatures(input),
  );
  assert.equal(verification.tools.length, 2);
  assert.equal(verification.signatures.length, 1);
  assert.match(verification.signatures[0]!.status, /VALIDSIG/u);
  const raw = encodeReleaseSignatureProof(policy, verification);
  assert.equal(
    validateReleaseSignatureProof(raw, hash(raw), policy).payloads.length,
    2,
  );
  const changed = Buffer.from(subject);
  changed[0] = changed[0]! ^ 1;
  await assert.rejects(
    () =>
      native.verifyDetachedReleaseSignatures({
        ...input,
        signatures: [
          {
            ...input.signatures[0],
            subject: { path: "checksums.txt", body: changed },
          },
        ],
      }),
    /did not complete/u,
  );
  await assert.rejects(
    () =>
      native.verifyDetachedReleaseSignatures({
        ...input,
        signerFingerprint: "A".repeat(40),
      }),
    /signer differs/u,
  );
});
