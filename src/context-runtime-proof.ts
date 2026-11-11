import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import {
  assertContextRuntimePolicy,
  contextRuntimeAttestationPolicy as policy,
  contextRuntimeAttestationPolicySha256,
  inspectContextNativeAttestation,
  parseContextAttestationJson,
} from "./context-runtime-attestation.js";

const hash = (raw: Uint8Array | string) =>
  createHash("sha256").update(raw).digest("hex");
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const byteSchema = z
  .number()
  .int()
  .positive()
  .max(128 * 1024 * 1024);
const identitySchema = z
  .object({ bytes: byteSchema, sha256: digestSchema })
  .strict();
export const contextRuntimeProofReferenceSchema = z
  .object({
    sha256: digestSchema,
    bytes: z.number().int().positive().max(262144),
    policyId: z.literal(policy.id),
    policySha256: z.literal(contextRuntimeAttestationPolicySha256),
    scope: z.literal("selected-context-runtime-release"),
  })
  .strict();
export type ContextRuntimeProofReference = z.infer<
  typeof contextRuntimeProofReferenceSchema
>;
export const contextRuntimeProofFiles = Object.freeze({
  archive: policy.release.name,
  originalVerification: policy.retainedVerification.path,
  trustedRoot: policy.trustedRoot.path,
  bundle: "attestation.bundle.jsonl",
  nativeOutput: "native-verification.json",
} as const);
export type ContextRuntimeProofInputs = Record<
  keyof typeof contextRuntimeProofFiles,
  Uint8Array
>;
export const contextRuntimeVerificationArgs = Object.freeze([
  "attestation",
  "verify",
  policy.release.name,
  "--bundle",
  contextRuntimeProofFiles.bundle,
  "--custom-trusted-root",
  policy.trustedRoot.path,
  "--repo",
  policy.repository,
  "--cert-identity",
  policy.certificateIdentity,
  "--cert-oidc-issuer",
  policy.oidcIssuer,
  "--source-digest",
  policy.sourceDigest,
  "--source-ref",
  policy.sourceRef,
  "--predicate-type",
  policy.predicateType,
  "--deny-self-hosted-runners",
  "--format",
  "json",
]);
const filesSchema = z
  .object({
    archive: identitySchema,
    originalVerification: identitySchema,
    trustedRoot: identitySchema,
    bundle: identitySchema,
    nativeOutput: identitySchema,
  })
  .strict();
const proofSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("context-runtime-release-proof"),
    policy: z.unknown(),
    policySha256: z.literal(contextRuntimeAttestationPolicySha256),
    scope: z.literal("selected-context-runtime-release"),
    files: filesSchema,
    nativeVerification: z
      .object({
        tool: z
          .object({
            name: z.literal("gh"),
            version: z
              .string()
              .regex(
                /^gh version 2\.102\.1 \(2026-10-20\)\nhttps:\/\/github\.com\/cli\/cli\/releases\/tag\/v2\.102\.1\n$/,
              ),
            bytes: byteSchema,
            sha256: digestSchema,
          })
          .strict(),
        argv: z.array(z.string()).max(40),
        exitCode: z.literal(0),
        localBundleAndTrustedRoot: z.literal(true),
        result: z.unknown(),
      })
      .strict(),
    runtimeAssets: z.unknown(),
    claims: z
      .object({
        releaseSignatureIdentityAndTransparencyVerified: z.literal(true),
        runtimeEsmAndWasmArchiveMembershipVerified: z.literal(true),
        archiveLicenseMembershipVerified: z.literal(false),
        producerBuildVerified: z.literal(false),
        runtimeProducerBuildClosureVerified: z.literal(false),
        completeArtifactAndNoticeClosureVerified: z.literal(false),
        ownerCurrentStatusVerified: z.literal(false),
        completeLicenseClosureVerified: z.literal(false),
        grammarSignaturesVerified: z.literal(false),
        gateAComplete: z.literal(false),
      })
      .strict(),
  })
  .strict();
export type ContextRuntimeProof = z.infer<typeof proofSchema>;
export const contextRuntimeProofClaims = Object.freeze({
  releaseSignatureIdentityAndTransparencyVerified: true,
  runtimeEsmAndWasmArchiveMembershipVerified: true,
  archiveLicenseMembershipVerified: false,
  producerBuildVerified: false,
  runtimeProducerBuildClosureVerified: false,
  completeArtifactAndNoticeClosureVerified: false,
  ownerCurrentStatusVerified: false,
  completeLicenseClosureVerified: false,
  grammarSignaturesVerified: false,
  gateAComplete: false,
} as const);
export const contextRuntimeInputIdentity = (raw: Uint8Array) => ({
  bytes: raw.length,
  sha256: hash(raw),
});

function object(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Attestation object required",
  );
  return value as Record<string, unknown>;
}
function originalBundle(raw: Uint8Array): unknown {
  const value = parseContextAttestationJson(raw);
  assert.ok(
    Array.isArray(value) && value.length === 1,
    "One original attestation result required",
  );
  const bundle = object(object(value[0]).attestation).bundle;
  assert.ok(bundle !== undefined, "Original attestation bundle required");
  return bundle;
}
export function deriveContextRuntimeBundle(raw: Uint8Array): Buffer {
  assert.deepEqual(
    contextRuntimeInputIdentity(raw),
    {
      bytes: policy.retainedVerification.bytes,
      sha256: policy.retainedVerification.sha256,
    },
    "Original verification input pin differs",
  );
  return Buffer.from(JSON.stringify(originalBundle(raw)) + "\n");
}

// Read only bounded regular tar members. No archive paths are written or executed.
export function inspectContextRuntimeArchive(
  raw: Uint8Array,
): typeof policy.runtimeAssets {
  assert.deepEqual(
    contextRuntimeInputIdentity(raw),
    { bytes: policy.release.bytes, sha256: policy.release.sha256 },
    "Selected release archive pin differs",
  );
  const tar = gunzipSync(raw, { maxOutputLength: 16 * 1024 * 1024 });
  const seen = new Set<string>();
  const selected = new Map<string, Buffer>();
  let offset = 0,
    terminal = false;
  const field = (row: Buffer) => {
    const nul = row.indexOf(0);
    const text = row.subarray(0, nul < 0 ? row.length : nul).toString("ascii");
    assert.ok(!/[^\x20-\x7e]/.test(text), "ASCII tar metadata required");
    return text;
  };
  const octal = (row: Buffer) => {
    const text = field(row).trim();
    assert.match(text, /^[0-7]+$/, "Strict tar octal required");
    const number = Number.parseInt(text, 8);
    assert.ok(
      Number.isSafeInteger(number) && number >= 0,
      "Bounded tar integer required",
    );
    return number;
  };
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert.ok(
        offset + 1024 <= tar.length &&
          tar.subarray(offset).every((byte) => byte === 0),
        "Complete tar terminator required",
      );
      terminal = true;
      break;
    }
    let checksum = 0;
    for (let i = 0; i < 512; i++)
      checksum += i >= 148 && i < 156 ? 32 : header[i]!;
    assert.equal(
      checksum,
      octal(header.subarray(148, 156)),
      "Tar checksum differs",
    );
    const prefix = field(header.subarray(345, 500)),
      name = field(header.subarray(0, 100));
    const tarName = prefix ? prefix + "/" + name : name;
    const type = header[156];
    const full =
      type === 53 && tarName.endsWith("/") ? tarName.slice(0, -1) : tarName;
    assert.ok(
      full === "." ||
        (full.startsWith("./") &&
          full.length < 512 &&
          full
            .slice(2)
            .split("/")
            .every((part) => part !== ".." && part !== "." && part !== "")),
      "Canonical tar member required",
    );
    assert.ok(!seen.has(full), "Duplicate tar member");
    seen.add(full);
    const size = octal(header.subarray(124, 136));
    assert.ok(
      type === 48 || type === 0 || type === 53,
      "Only regular tar members or directories admitted",
    );
    if (type === 53) assert.equal(size, 0, "Tar directory payload forbidden");
    const end = offset + 512 + size;
    assert.ok(end <= tar.length, "Truncated tar member");
    if (full === "./web-tree-sitter.js" || full === "./web-tree-sitter.wasm") {
      assert.ok(
        type === 48 || type === 0,
        "Selected tar member must be regular",
      );
      selected.set(full.slice(2), tar.subarray(offset + 512, end));
    }
    offset = Math.ceil(end / 512) * 512;
  }
  assert.ok(terminal, "Complete tar archive required");
  assert.equal(selected.size, 2, "Both selected runtime members required");
  for (const name of ["web-tree-sitter.js", "web-tree-sitter.wasm"] as const)
    assert.deepEqual(
      contextRuntimeInputIdentity(selected.get(name)!),
      policy.runtimeAssets[name],
      "Signed runtime archive member differs",
    );
  assert.ok(
    !seen.has("./LICENSE") && !seen.has("LICENSE"),
    "Reviewed release license-membership scope changed",
  );
  // LICENSE is an unsigned manifest identity; it is deliberately not claimed as a tar member.
  return policy.runtimeAssets;
}
function nativeWitnessIdentity(
  result: ReturnType<typeof inspectContextNativeAttestation>,
) {
  return {
    ...result,
    verifiedTimestamps: result.verifiedTimestamps.map((row) => {
      const fields =
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(
          row.timestamp,
        );
      assert.ok(fields, "Native strict RFC3339 timestamp required");
      const year = Number(fields[1]),
        month = Number(fields[2]),
        day = Number(fields[3]),
        hour = Number(fields[4]),
        minute = Number(fields[5]),
        second = Number(fields[6]),
        zone = fields[8]!;
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const monthDays = [
        31,
        leap ? 29 : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
      ];
      assert.ok(
        month >= 1 &&
          month <= 12 &&
          day >= 1 &&
          day <= monthDays[month - 1]! &&
          hour <= 23 &&
          minute <= 59 &&
          second <= 59,
        "Native timestamp calendar bound",
      );
      assert.ok(
        zone !== "-00:00" &&
          (zone === "Z" ||
            (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4, 6)) <= 59)),
        "Native timestamp known offset required",
      );
      const whole = Date.parse(
        `${fields[1]}-${fields[2]}-${fields[3]}T${fields[4]}:${fields[5]}:${fields[6]}${zone}`,
      );
      assert.ok(
        Number.isSafeInteger(whole) && whole % 1000 === 0,
        "Native whole-second timestamp required",
      );
      // Fractions stay decimal strings; Date.parse never sees or truncates them.
      return {
        ...row,
        timestamp: {
          seconds: whole / 1000,
          fraction: (fields[7] ?? "").replace(/0+$/u, ""),
        },
      };
    }),
  };
}

export function validateContextRuntimeProofCandidate(
  input: unknown,
  files: ContextRuntimeProofInputs,
): ContextRuntimeProof {
  const proof = proofSchema.parse(input);
  assertContextRuntimePolicy(proof.policy);
  assert.deepEqual(
    proof.nativeVerification.argv,
    contextRuntimeVerificationArgs,
    "Complete compiled native verification policy required",
  );
  for (const key of Object.keys(
    contextRuntimeProofFiles,
  ) as (keyof ContextRuntimeProofInputs)[])
    assert.deepEqual(
      proof.files[key],
      contextRuntimeInputIdentity(files[key]),
      "Proof cohort bytes differ: " + key,
    );
  assert.deepEqual(proof.files.archive, {
    bytes: policy.release.bytes,
    sha256: policy.release.sha256,
  });
  assert.deepEqual(proof.files.originalVerification, {
    bytes: policy.retainedVerification.bytes,
    sha256: policy.retainedVerification.sha256,
  });
  assert.deepEqual(proof.files.trustedRoot, {
    bytes: policy.trustedRoot.bytes,
    sha256: policy.trustedRoot.sha256,
  });
  const bundle = deriveContextRuntimeBundle(files.originalVerification);
  assert.deepEqual(
    Buffer.from(files.bundle),
    bundle,
    "Derived bundle differs from pinned original verification",
  );
  const nativeOutput = parseContextAttestationJson(files.nativeOutput);
  const result = inspectContextNativeAttestation(nativeOutput);
  assert.ok(
    isDeepStrictEqual(
      nativeWitnessIdentity(result),
      nativeWitnessIdentity(
        inspectContextNativeAttestation(
          parseContextAttestationJson(files.originalVerification),
        ),
      ),
    ),
    "Native certificate, subject or verified timestamps differ from pinned original bundle result",
  );
  assert.ok(Array.isArray(nativeOutput) && nativeOutput.length === 1);
  assert.ok(
    isDeepStrictEqual(
      object(object(nativeOutput[0]).attestation).bundle,
      originalBundle(files.originalVerification),
    ),
    "Native verified bundle differs from original input",
  );
  assert.ok(
    isDeepStrictEqual(proof.nativeVerification.result, result),
    "Native result identity, subject or timestamps differ",
  );
  assert.ok(
    isDeepStrictEqual(
      proof.runtimeAssets,
      inspectContextRuntimeArchive(files.archive),
    ),
    "Selected runtime asset manifest differs",
  );
  return proof;
}
export function encodeContextRuntimeProof(
  input: unknown,
  files: ContextRuntimeProofInputs,
): Buffer {
  const raw = Buffer.from(
    JSON.stringify(validateContextRuntimeProofCandidate(input, files)) + "\n",
  );
  assert.ok(raw.length <= 262144, "Proof byte bound");
  return raw;
}

function sameStat(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.nlink === b.nlink
  );
}
export function readContextRuntimeProofInput(
  file: string,
  maximum: number,
): Buffer {
  assert.ok(
    Number.isSafeInteger(maximum) &&
      maximum > 0 &&
      maximum <= 128 * 1024 * 1024,
    "Proof read admission bound required",
  );
  assert.ok(
    path.isAbsolute(file) && path.normalize(file) === file,
    "Absolute canonical input path required",
  );
  assert.equal(realpathSync(file), file, "Linked input or parent forbidden");
  const before = lstatSync(file);
  assert.ok(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1 &&
      before.size > 0 &&
      before.size <= maximum,
    "Bounded regular proof input required",
  );
  const fd = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    assert.ok(
      sameStat(before, fstatSync(fd)),
      "Proof input changed before open",
    );
    const raw = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < raw.length) {
      const read = readSync(fd, raw, count, raw.length - count, null);
      if (read === 0) break;
      count += read;
    }
    assert.equal(
      count,
      before.size,
      "Proof input grew or truncated while reading",
    );
    assert.ok(
      sameStat(before, fstatSync(fd)) && sameStat(before, lstatSync(file)),
      "Proof input changed while reading",
    );
    assert.equal(realpathSync(file), file, "Proof input address changed");
    return raw.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}
export function readContextRuntimeProofCandidate(
  file: string,
  expectedSha256: string,
): { reference: ContextRuntimeProofReference; proof: ContextRuntimeProof } {
  digestSchema.parse(expectedSha256);
  assert.equal(
    path.basename(file),
    "proof.json",
    "Canonical proof filename required",
  );
  const directory = path.dirname(file);
  assert.equal(
    realpathSync(directory),
    directory,
    "Linked proof namespace forbidden",
  );
  const before = lstatSync(directory);
  assert.ok(
    before.isDirectory() && !before.isSymbolicLink(),
    "Regular proof namespace required",
  );
  const names = [
    "proof.json",
    ...Object.values(contextRuntimeProofFiles),
  ].sort();
  assert.deepEqual(
    readdirSync(directory).sort(),
    names,
    "Complete six-file proof cohort required",
  );
  const identities = new Map(
    names.map((name) => [name, lstatSync(path.join(directory, name))]),
  );
  assert.equal(
    before.mode & 0o222,
    0,
    "Published proof namespace must be read-only",
  );
  for (const identity of identities.values())
    assert.equal(
      identity.mode & 0o222,
      0,
      "Published proof files must be read-only",
    );
  const raw = readContextRuntimeProofInput(file, 262144);
  assert.equal(
    hash(raw),
    expectedSha256,
    "Operator-selected proof SHA differs",
  );
  const read = (key: keyof ContextRuntimeProofInputs) =>
    readContextRuntimeProofInput(
      path.join(directory, contextRuntimeProofFiles[key]),
      key === "archive" ? policy.release.bytes : 262144,
    );
  const files: ContextRuntimeProofInputs = {
    archive: read("archive"),
    originalVerification: read("originalVerification"),
    trustedRoot: read("trustedRoot"),
    bundle: read("bundle"),
    nativeOutput: read("nativeOutput"),
  };
  const proof = validateContextRuntimeProofCandidate(
    parseContextAttestationJson(raw),
    files,
  );
  assert.deepEqual(
    readdirSync(directory).sort(),
    names,
    "Proof cohort changed during validation",
  );
  assert.ok(
    sameStat(before, lstatSync(directory)),
    "Proof namespace changed during validation",
  );
  for (const name of names)
    assert.ok(
      sameStat(identities.get(name)!, lstatSync(path.join(directory, name))),
      "Proof cohort changed after reading",
    );
  assert.equal(
    realpathSync(directory),
    directory,
    "Proof namespace address changed",
  );
  return {
    reference: contextRuntimeProofReferenceSchema.parse({
      sha256: expectedSha256,
      bytes: raw.length,
      policyId: policy.id,
      policySha256: contextRuntimeAttestationPolicySha256,
      scope: "selected-context-runtime-release",
    }),
    proof,
  };
}

export function readContextRuntimeProof(
  file: string,
  expectedSha256: string,
): { reference: ContextRuntimeProofReference; proof: ContextRuntimeProof } {
  assert.equal(
    path.basename(path.dirname(file)),
    expectedSha256,
    "Proof namespace must equal its expected digest",
  );
  return readContextRuntimeProofCandidate(file, expectedSha256);
}

// Authority comes only from the operator environment captured before any caller runs.
const operatorSelection = (() => {
  const value = process.env.CHECKTRAIL_CONTEXT_RELEASE_PROOF;
  if (value === undefined || value === "") return undefined;
  const match = /^(.*)#sha256=([a-f0-9]{64})$/.exec(value);
  assert.ok(
    match && path.isAbsolute(match[1]!) && !match[1]!.includes("#"),
    "Malformed operator context-runtime proof selection",
  );
  const file = match[1]!,
    sha256 = match[2]!;
  const initial = readContextRuntimeProof(file, sha256).reference;
  return Object.freeze({ file, sha256, initial });
})();
export function selectedContextRuntimeProof():
  ContextRuntimeProofReference | undefined {
  if (!operatorSelection) return undefined;
  const current = readContextRuntimeProof(
    operatorSelection.file,
    operatorSelection.sha256,
  ).reference;
  assert.deepEqual(
    current,
    operatorSelection.initial,
    "Operator proof reference changed",
  );
  return current;
}
