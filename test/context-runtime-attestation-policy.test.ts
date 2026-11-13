import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  assertContextRuntimePolicy,
  contextRuntimeAttestationPolicy as policy,
  inspectContextNativeAttestation,
  parseContextAttestationJson,
} from "../src/context-runtime-attestation.js";

const retained = async () =>
  parseContextAttestationJson(
    await readFile(
      new URL(
        "../../docs/measurements/context-runtime-0.27.1-2026-10-30/attestation-verified.json",
        import.meta.url,
      ),
    ),
  );
test("runtime attestation inspection retains the selected native certificate subject and verified timestamp scope", async () => {
  const result = inspectContextNativeAttestation(await retained());
  assert.equal(result.certificate.sourceRepositoryDigest, policy.sourceDigest);
  assert.equal(result.subject.name, policy.release.name);
  assert.equal(result.subject.digest.sha256, policy.release.sha256);
  assert.ok(result.verifiedTimestamps.length > 0);
  assert.equal(Object.hasOwn(result, "signatureVerified"), false);
  assert.equal(Object.hasOwn(result, "producerBuildVerified"), false);
});
test("runtime attestation inspection rejects every wrong native identity and empty or ambiguous subject cohort", async () => {
  const valid = (await retained()) as [
    {
      verificationResult: {
        signature: { certificate: Record<string, string> };
        statement: {
          subject: { name: string; digest: { sha256: string } }[];
          predicateType: string;
        };
        verifiedTimestamps: { type: string; uri: string; timestamp: string }[];
      };
    },
  ];
  for (const name of [
    "sourceRepositoryURI",
    "sourceRepositoryDigest",
    "sourceRepositoryRef",
    "subjectAlternativeName",
    "issuer",
    "runnerEnvironment",
  ]) {
    const changed = structuredClone(valid);
    changed[0].verificationResult.signature.certificate[name] += "-near-miss";
    assert.throws(() => inspectContextNativeAttestation(changed), name);
  }
  const changes = [
    (row: typeof valid) => {
      row[0].verificationResult.statement.subject = [];
    },
    (row: typeof valid) => {
      row[0].verificationResult.statement.subject.find(
        (subject) => subject.name === policy.release.name,
      )!.digest.sha256 = "0".repeat(64);
    },
    (row: typeof valid) => {
      row[0].verificationResult.statement.subject.push(
        structuredClone(
          row[0].verificationResult.statement.subject.find(
            (subject) => subject.name === policy.release.name,
          )!,
        ),
      );
    },
    (row: typeof valid) => {
      row[0].verificationResult.statement.predicateType += "-near-miss";
    },
    (row: typeof valid) => {
      row[0].verificationResult.verifiedTimestamps = [];
    },
    (row: typeof valid) => {
      row[0].verificationResult.verifiedTimestamps[0]!.timestamp = "not-a-time";
    },
  ];
  for (const change of changes) {
    const changed = structuredClone(valid);
    change(changed);
    assert.throws(() => inspectContextNativeAttestation(changed));
  }
  assert.throws(() => inspectContextNativeAttestation([]));
  assert.throws(() => inspectContextNativeAttestation([...valid, ...valid]));
});
test("runtime attestation JSON is bounded strict UTF-8 JSON and refuses duplicate native identity keys", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  assert.deepEqual(parseContextAttestationJson(encode('{"x":[1,2]}')), {
    x: [1, 2],
  });
  for (const text of [
    '{"x":1,"x":2}',
    '{"a":{"issuer":"good","issuer":"bad"}}',
    "x: 1",
    "{}\n{}",
    "[".repeat(26) + "0" + "]".repeat(26),
  ])
    assert.throws(
      () => parseContextAttestationJson(encode(text)),
      text.slice(0, 80),
    );
  assert.throws(() => parseContextAttestationJson(new Uint8Array([0xff])));
  assert.throws(() => parseContextAttestationJson(new Uint8Array()));
  assert.throws(() =>
    parseContextAttestationJson(encode('"' + "x".repeat(262143) + '"')),
  );
  assert.throws(() =>
    parseContextAttestationJson(encode("[" + "0,".repeat(16384) + "0]")),
  );
});
test("runtime attestation policy refuses version workflow member and grammar-manifest substitution", () => {
  assert.doesNotThrow(() =>
    assertContextRuntimePolicy(structuredClone(policy)),
  );
  for (const key of [
    "sourceDigest",
    "sourceRef",
    "certificateIdentity",
    "runtimeVersion",
    "runtimeManifestSha256",
    "grammarManifestSha256",
    "vbGrammarManifestSha256",
  ] as const) {
    const changed: Record<string, unknown> = structuredClone(policy);
    changed[key] = String(changed[key]) + "-changed";
    assert.throws(() => assertContextRuntimePolicy(changed), key);
  }
  assert.throws(() =>
    assertContextRuntimePolicy({ ...policy, extraAuthority: true }),
  );
  assert.throws(() =>
    assertContextRuntimePolicy({
      ...policy,
      archiveRuntimeAssets: [...policy.archiveRuntimeAssets, "LICENSE"],
    }),
  );
});
