import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseAllDocuments } from "yaml";
import { z } from "zod";

export interface ReleaseSignaturePin {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface ReleaseSignaturePolicy {
  readonly id: string;
  readonly payloads: readonly ReleaseSignaturePin[];
  readonly publicKey: ReleaseSignaturePin;
  readonly signatures: readonly {
    readonly subject: ReleaseSignaturePin;
    readonly signature: ReleaseSignaturePin;
    readonly signerFingerprint: string;
    readonly primaryFingerprint: string;
  }[];
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const fingerprint = z.string().regex(/^[A-F0-9]{40}$/);
const logicalPath = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/)
  .refine(
    (value) => !value.split("/").some((part) => part === "." || part === ".."),
  );
const pin = z.strictObject({
  path: logicalPath,
  bytes: z
    .number()
    .int()
    .positive()
    .max(128 * 1024 * 1024),
  sha256: digest,
});
const tool = z.strictObject({
  role: z.enum(["gpg", "gpgv"]),
  before: pin,
  after: pin,
  version: z.string().min(1).max(512),
});
export const releaseSignatureVerificationSchema = z.strictObject({
  keyValidityAssessed: z.literal(false),
  keyOwnerTrustEstablished: z.literal(false),
  publicKey: pin,
  tools: z.array(tool).length(2),
  signatures: z
    .array(
      z.strictObject({
        subject: pin,
        signature: pin,
        exitCode: z.literal(0),
        status: z
          .string()
          .min(1)
          .max(16 * 1024),
        stderr: z.string().max(16 * 1024),
        signerFingerprint: fingerprint,
        primaryFingerprint: fingerprint,
      }),
    )
    .min(1)
    .max(16),
});
export type ReleaseSignatureVerification = z.infer<
  typeof releaseSignatureVerificationSchema
>;
export const releaseSignatureProofSchema = z.strictObject({
  schemaVersion: z.literal(1),
  policySha256: digest,
  payloads: z.array(pin).min(1).max(64),
  verification: releaseSignatureVerificationSchema,
});
export type ReleaseSignatureProof = z.infer<typeof releaseSignatureProofSchema>;
export const maximumReleaseProofBytes = 256 * 1024;
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
function requireProof(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function parseReleaseProofPin(value: string | undefined): string {
  if (value === undefined || value === "") return "";
  return digest.parse(value);
}
function normalizedPolicy(policy: ReleaseSignaturePolicy) {
  requireProof(
    /^[a-z0-9][a-z0-9-]{0,127}$/.test(policy.id),
    "Invalid release signature policy",
  );
  const result = {
    id: policy.id,
    payloads: policy.payloads.map((item) => pin.parse(item)),
    publicKey: pin.parse(policy.publicKey),
    signatures: policy.signatures.map((item) => ({
      subject: pin.parse(item.subject),
      signature: pin.parse(item.signature),
      signerFingerprint: fingerprint.parse(item.signerFingerprint),
      primaryFingerprint: fingerprint.parse(item.primaryFingerprint),
    })),
  };
  requireProof(
    result.payloads.length > 0 &&
      result.payloads.length <= 64 &&
      result.signatures.length > 0 &&
      result.signatures.length <= 16,
    "Release signature policy bounds differ",
  );
  requireProof(
    new Set(result.payloads.map((item) => item.path)).size ===
      result.payloads.length,
    "Duplicate release payload",
  );
  requireProof(
    new Set(result.signatures.map((item) => item.subject.path)).size ===
      result.signatures.length,
    "Duplicate signed subject",
  );
  return result;
}
export function releaseSignaturePolicySha256(
  policy: ReleaseSignaturePolicy,
): string {
  return hash(JSON.stringify(normalizedPolicy(policy)));
}
/** Parses GnuPG's machine status only; this does not implement OpenPGP verification. */
export function validateReleaseGpgStatus(
  status: string,
  signer: string,
  primary: string,
) {
  fingerprint.parse(signer);
  fingerprint.parse(primary);
  requireProof(
    Buffer.byteLength(status) <= 16 * 1024,
    "GPG status exceeds its bound",
  );
  const rows = status
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      requireProof(
        line.startsWith("[GNUPG:] ") && line.length <= 4096,
        "Malformed GPG status",
      );
      return line.slice(9).split(" ");
    });
  requireProof(
    rows.length <= 128 &&
      rows.filter((row) => row[0] === "NEWSIG").length === 1,
    "Expected one detached signature",
  );
  requireProof(
    !rows.some((row) =>
      [
        "BADSIG",
        "ERRSIG",
        "EXPSIG",
        "EXPKEYSIG",
        "REVKEYSIG",
        "NO_PUBKEY",
        "NODATA",
        "FAILURE",
        "ERROR",
      ].includes(row[0]!),
    ),
    "Selected detached signature did not verify",
  );
  const valid = rows.filter((row) => row[0] === "VALIDSIG");
  requireProof(
    valid.length === 1 &&
      valid[0]!.length === 11 &&
      valid[0]![1] === signer &&
      valid[0]![10] === primary,
    "Detached signature signer differs",
  );
  // gpgv does not assess key expiry/revocation; absence of these status rows is
  // not a validity check. See https://www.gnupg.org/documentation/manuals/gnupg/gpgv.html
  // KEYEXPIRED may describe a different key in the supplied original public key.
  // GPG's selected-signature outcome and exact VALIDSIG identities are authoritative.
  return { signerFingerprint: signer, primaryFingerprint: primary };
}
function validateShape(
  proof: ReleaseSignatureProof,
  policy: ReleaseSignaturePolicy,
) {
  const expected = normalizedPolicy(policy);
  requireProof(
    proof.policySha256 === releaseSignaturePolicySha256(policy),
    "Release proof policy differs",
  );
  requireProof(
    isDeepStrictEqual(proof.payloads, expected.payloads),
    "Release proof payload cohort differs",
  );
  requireProof(
    isDeepStrictEqual(proof.verification.publicKey, expected.publicKey),
    "Release proof public key differs",
  );
  requireProof(
    isDeepStrictEqual(
      proof.verification.tools.map((item) => item.role),
      ["gpg", "gpgv"],
    ),
    "Release verifier roles differ",
  );
  for (const item of proof.verification.tools)
    requireProof(
      item.before.path === item.role &&
        isDeepStrictEqual(item.before, item.after),
      "Release verifier bytes changed",
    );
  requireProof(
    proof.verification.signatures.length === expected.signatures.length,
    "Release signed subset differs",
  );
  for (const [index, item] of proof.verification.signatures.entries()) {
    const wanted = expected.signatures[index]!;
    requireProof(
      isDeepStrictEqual(item.subject, wanted.subject) &&
        isDeepStrictEqual(item.signature, wanted.signature),
      "Release signed subject or signature differs",
    );
    requireProof(
      item.signerFingerprint === wanted.signerFingerprint &&
        item.primaryFingerprint === wanted.primaryFingerprint,
      "Release signature identity differs",
    );
    validateReleaseGpgStatus(
      item.status,
      wanted.signerFingerprint,
      wanted.primaryFingerprint,
    );
  }
  return proof;
}
function boundedJson(bytes: Uint8Array) {
  requireProof(
    bytes.byteLength > 0 && bytes.byteLength <= maximumReleaseProofBytes,
    "Release proof byte bound differs",
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let depth = 0,
    quoted = false,
    escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      depth++;
      requireProof(depth <= 12, "Release proof nesting bound differs");
    } else if (char === "}" || char === "]") depth--;
  }
  const parsed: unknown = JSON.parse(text);
  const documents = parseAllDocuments(text, {
    strict: true,
    uniqueKeys: true,
    prettyErrors: false,
  });
  requireProof(
    documents.length === 1 &&
      !documents[0]!.errors.length &&
      !documents[0]!.warnings.length,
    "Release proof JSON is ambiguous",
  );
  return parsed;
}
export function validateReleaseSignatureProof(
  bytes: Uint8Array,
  expectedSha256: string,
  policy: ReleaseSignaturePolicy,
): ReleaseSignatureProof {
  requireProof(
    parseReleaseProofPin(expectedSha256) !== "",
    "Operator release proof pin required",
  );
  requireProof(
    hash(bytes) === expectedSha256,
    "Operator release proof pin differs",
  );
  return validateShape(
    releaseSignatureProofSchema.parse(boundedJson(bytes)),
    policy,
  );
}
export function encodeReleaseSignatureProof(
  policy: ReleaseSignaturePolicy,
  verification: ReleaseSignatureVerification,
): Buffer {
  const raw = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      policySha256: releaseSignaturePolicySha256(policy),
      payloads: normalizedPolicy(policy).payloads,
      verification,
    }) + "\n",
  );
  validateReleaseSignatureProof(raw, hash(raw), policy);
  return raw;
}
export function readReleaseSignatureProof(
  file: string,
  expectedSha256: string,
  policy: ReleaseSignaturePolicy,
): ReleaseSignatureProof {
  requireProof(
    path.isAbsolute(file) && realpathSync(file) === file,
    "Canonical release proof path required",
  );
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    requireProof(
      before.isFile() &&
        before.size > 0 &&
        before.size <= maximumReleaseProofBytes,
      "Bounded regular release proof required",
    );
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let used = 0;
    let eof = false;
    while (used < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        used,
        buffer.length - used,
        null,
      );
      if (count === 0) {
        eof = true;
        break;
      }
      used += count;
    }
    requireProof(
      eof && used === before.size,
      "Release proof grew beyond its read bound",
    );
    const bytes = buffer.subarray(0, used);
    const after = fstatSync(descriptor);
    requireProof(
      before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        bytes.length === before.size,
      "Release proof changed while read",
    );
    return validateReleaseSignatureProof(bytes, expectedSha256, policy);
  } finally {
    closeSync(descriptor);
  }
}
