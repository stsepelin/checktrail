import assert from "node:assert/strict";
import type { Buffer } from "node:buffer";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { scala2Artifacts } from "./scala2-artifacts.js";
import { scala2Hash, scala2Libraries } from "./scala2-archive.js";
import {
  parseReleaseProofPin,
  readReleaseSignatureProof,
  releaseSignaturePolicySha256,
  type ReleaseSignaturePolicy,
} from "./release-signature-proof.js";

export const scala2ReleaseProofEnvironment =
  "CHECKTRAIL_SCALA2_RELEASE_PROOF_SHA256";
export const scala2ReleaseProofFilename = "release-signature-proof.json";
export const scala2ReleaseArchiveFilename = `scala-${scala2Artifacts.version}.zip`;
const fingerprint = "2A5E8B338438CAC7033F9D8FB8A045C0A6EC398E";
// Literal public delivery identities: docs/measurements/artifact-identities-2026-10-21/scala2.json.
// The detached signatures cover these JARs, not the ZIP or the other libraries.
const signatures = [
  {
    name: "scala-compiler.jar",
    signature: {
      path: "scala-compiler-2.13.18.jar.asc",
      bytes: 833,
      sha256:
        "f754dc62a7e4720bde25096929f755b2eb1699961dcae15627b74cc64fbc2e22",
    },
  },
  {
    name: "scala-library.jar",
    signature: {
      path: "scala-library-2.13.18.jar.asc",
      bytes: 833,
      sha256:
        "29df493c0f7cdd2507e85ed57830abca9667e711c0d63770bddcccb7b56fe9f7",
    },
  },
  {
    name: "scala-reflect.jar",
    signature: {
      path: "scala-reflect-2.13.18.jar.asc",
      bytes: 833,
      sha256:
        "d7ec1f87e162ee0429d4aec698352e6b08187f47bf7c730474d8000646b23cff",
    },
  },
] as const;
export const scala2ReleaseSignaturePolicy: ReleaseSignaturePolicy = {
  id: "scala-2-13-18-selected-jar-signatures-v1",
  payloads: [
    {
      path: scala2ReleaseArchiveFilename,
      bytes: scala2Artifacts.archiveBytes,
      sha256: scala2Artifacts.archiveSha256,
    },
    ...scala2Artifacts.runtimeLibraries.map(
      ({ path: name, bytes, sha256 }) => ({
        path: name,
        bytes,
        sha256,
      }),
    ),
  ],
  publicKey: {
    path: "scala-public-key.asc",
    bytes: 2967,
    sha256: "30b860116721fbff5b43dc6f10c2bc0d88ec284241f96eb542c694ed57ff3dd8",
  },
  signatures: signatures.map(({ name, signature }) => {
    const subject = scala2Artifacts.runtimeLibraries.find(
      (p) => p.name === name,
    )!;
    return {
      subject: {
        path: subject.path,
        bytes: subject.bytes,
        sha256: subject.sha256,
      },
      signature,
      signerFingerprint: fingerprint,
      primaryFingerprint: fingerprint,
    };
  }),
};

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const scala2ReleaseSignatureReferenceSchema = z.strictObject({
  scope: z.literal("operator-pinned-selected-jar-native-verification"),
  proofSha256: digest,
  policySha256: digest,
  signedSubjects: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(128),
        bytes: z
          .number()
          .int()
          .positive()
          .max(32 * 1024 * 1024),
        sha256: digest,
      }),
    )
    .length(3),
  distributionSignatureVerified: z.literal(false),
  completeArtifactAndNoticeClosureVerified: z.literal(false),
});

export function scala2ReleaseSignatureReference(expectedSha256: string) {
  assert.notEqual(parseReleaseProofPin(expectedSha256), "");
  return {
    scope: "operator-pinned-selected-jar-native-verification" as const,
    proofSha256: expectedSha256,
    policySha256: releaseSignaturePolicySha256(scala2ReleaseSignaturePolicy),
    signedSubjects: scala2ReleaseSignaturePolicy.signatures.map(
      (s) => s.subject,
    ),
    distributionSignatureVerified: false as const,
    completeArtifactAndNoticeClosureVerified: false as const,
  };
}

export function scala2ReleaseSignature(
  archive: string,
  bytes: Buffer,
  selectedPin: string,
) {
  const expectedSha256 = parseReleaseProofPin(selectedPin);
  const directory = path.dirname(archive);
  const proof = path.join(directory, scala2ReleaseProofFilename);
  if (!expectedSha256) {
    assert.equal(
      lstatSync(proof, { throwIfNoEntry: false }),
      undefined,
      "Qualified Scala cache needs an operator proof pin",
    );
    return null;
  }
  assert.equal(path.isAbsolute(archive), true);
  assert.equal(realpathSync(directory), directory);
  assert.equal(realpathSync(archive), archive);
  const metadata = lstatSync(archive);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
  assert.equal(metadata.size, scala2Artifacts.archiveBytes);
  assert.equal(path.basename(directory), expectedSha256);
  assert.equal(path.basename(archive), scala2ReleaseArchiveFilename);
  assert.deepEqual(
    readdirSync(directory).sort(),
    [scala2ReleaseArchiveFilename, scala2ReleaseProofFilename].sort(),
    "Exact qualified Scala archive/proof cohort required",
  );
  assert.equal(bytes.length, scala2Artifacts.archiveBytes);
  assert.equal(scala2Hash(bytes), scala2Artifacts.archiveSha256);
  // Complete five-library membership and literal pins are checked separately
  // from the three signed subjects; no distribution signature is inferred.
  scala2Libraries(bytes);
  readReleaseSignatureProof(
    proof,
    expectedSha256,
    scala2ReleaseSignaturePolicy,
  );
  return scala2ReleaseSignatureReference(expectedSha256);
}
