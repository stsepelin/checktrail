import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import { z } from "zod";
import { parseAllDocuments } from "yaml";
import {
  grammarManifestDigest,
  grammarRuntimeAssets,
  grammarRuntimeManifestDigest,
  grammarRuntimeVersion,
} from "./review-grammar-assets.js";
import { vbGrammarManifestDigest } from "./review-vb-grammar-assets.js";

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export const contextRuntimeAttestationPolicy = {
  id: "selected-context-runtime-attestation-v1",
  repository: "tree-sitter/tree-sitter",
  signerWorkflow: "tree-sitter/tree-sitter/.github/workflows/release.yml",
  certificateIdentity:
    "https://github.com/tree-sitter/tree-sitter/.github/workflows/release.yml@refs/tags/v0.27.1",
  sourceDigest: "10eb5ac119eec9cb4267a8e035066473983f5f3a",
  sourceRef: "refs/tags/v0.27.1",
  oidcIssuer: "https://token.actions.githubusercontent.com",
  predicateType: "https://slsa.dev/provenance/v1",
  runnerEnvironment: "github-hosted",
  release: {
    name: "web-tree-sitter.tar.gz",
    bytes: 1176564,
    sha256: "0a1c8c6a369c5483bbc5385ef1ae9a0d68793553c59f83458fa5973f5de0568a",
  },
  retainedVerification: {
    path: "attestation-verified.json",
    bytes: 23044,
    sha256: "dfc4bdbbdc257bb7b7b4b4d19c61eadc933b45dc1ff38eea037de6139268eeec",
  },
  trustedRoot: {
    path: "sigstore-trusted-root.jsonl",
    bytes: 34634,
    sha256: "65ca537f6ed8a47fd0e560c421baa1f6c1efb8b25fc200d8c5c02c0e92eb2b9c",
  },
  runtimeVersion: grammarRuntimeVersion,
  runtimeManifestSha256: grammarRuntimeManifestDigest,
  grammarManifestSha256: grammarManifestDigest,
  vbGrammarManifestSha256: vbGrammarManifestDigest,
  runtimeAssets: grammarRuntimeAssets,
  // The signed archive omits LICENSE; its manifest identity is a separate scope.
  archiveRuntimeAssets: ["web-tree-sitter.js", "web-tree-sitter.wasm"],
  unsignedRuntimeAssets: ["LICENSE"],
} as const;
export const contextRuntimeAttestationPolicySha256 = sha256(
  JSON.stringify(contextRuntimeAttestationPolicy),
);

// JSON is the transport. YAML's parser supplies duplicate-key detection only;
// its values never become verification data.
export function parseContextAttestationJson(bytes: Uint8Array): unknown {
  assert.ok(
    bytes.length > 0 && bytes.length <= 262144,
    "Attestation JSON byte bound",
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const documents = parseAllDocuments(text, { uniqueKeys: true, strict: true });
  assert.ok(
    documents.length === 1 && documents[0]!.errors.length === 0,
    "Unambiguous attestation JSON required",
  );
  const value: unknown = JSON.parse(text);
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    assert.ok(
      ++nodes <= 16384 && item.depth <= 24,
      "Attestation JSON structural bound",
    );
    if (item.value && typeof item.value === "object")
      for (const child of Object.values(item.value))
        pending.push({ value: child, depth: item.depth + 1 });
  }
  return value;
}

const certificateSchema = z.object({
  sourceRepositoryURI: z.literal("https://github.com/tree-sitter/tree-sitter"),
  sourceRepositoryDigest: z.literal(
    contextRuntimeAttestationPolicy.sourceDigest,
  ),
  sourceRepositoryRef: z.literal(contextRuntimeAttestationPolicy.sourceRef),
  subjectAlternativeName: z.literal(
    contextRuntimeAttestationPolicy.certificateIdentity,
  ),
  issuer: z.literal(contextRuntimeAttestationPolicy.oidcIssuer),
  runnerEnvironment: z.literal(
    contextRuntimeAttestationPolicy.runnerEnvironment,
  ),
});
const nativeResultSchema = z.object({
  verificationResult: z.object({
    signature: z.object({ certificate: certificateSchema }),
    verifiedTimestamps: z
      .array(
        z.object({
          type: z.string().min(1).max(128),
          uri: z.string().min(1).max(2048),
          timestamp: z.string().min(1).max(128),
        }),
      )
      .min(1)
      .max(16),
    statement: z.object({
      _type: z.literal("https://in-toto.io/Statement/v1"),
      predicateType: z.literal(contextRuntimeAttestationPolicy.predicateType),
      subject: z
        .array(
          z.object({
            name: z.string().min(1).max(512),
            digest: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
          }),
        )
        .min(1)
        .max(64),
    }),
  }),
});

// Call only after a successful, real native verification with the complete
// compiled CLI policy. Inspecting this JSON alone is never signature checking.
export function inspectContextNativeAttestation(input: unknown) {
  const rows = z.array(nativeResultSchema).length(1).parse(input);
  const result = rows[0]!.verificationResult;
  const selected = result.statement.subject.filter(
    (subject) => subject.name === contextRuntimeAttestationPolicy.release.name,
  );
  assert.equal(
    selected.length,
    1,
    "One exact selected release subject required",
  );
  assert.equal(
    selected[0]!.digest.sha256,
    contextRuntimeAttestationPolicy.release.sha256,
    "Selected runtime release digest differs",
  );
  for (const timestamp of result.verifiedTimestamps)
    assert.ok(
      Number.isFinite(Date.parse(timestamp.timestamp)),
      "Native verified timestamp required",
    );
  return {
    certificate: result.signature.certificate,
    subject: selected[0]!,
    verifiedTimestamps: result.verifiedTimestamps,
  };
}

export function assertContextRuntimePolicy(input: unknown): void {
  assert.ok(
    isDeepStrictEqual(input, contextRuntimeAttestationPolicy),
    "Selected context-runtime attestation policy differs",
  );
}
