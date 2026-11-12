import path from "node:path";
import { z } from "zod";
import { terraformExtensionsProvider as provider } from "./terraform-extensions-contract.js";
import {
  parseReleaseProofPin,
  readReleaseSignatureProof,
  releaseSignaturePolicySha256,
  type ReleaseSignaturePolicy,
} from "./release-signature-proof.js";

export const randomReleaseProofEnvironment =
  "CHECKTRAIL_TERRAFORM_EXTENSIONS_RELEASE_PROOF_SHA256";
export const randomReleaseProofFile = "release-signature-proof.json";
// Original public inputs: docs/measurements/artifact-identities-2026-10-21/random-provider.json.
// A valid detached checksum signature is separate from publisher/key-owner trust.
export const randomReleaseSignaturePolicy = {
  id: "hashicorp-random-3-9-1-release-signature-v1",
  payloads: [
    {
      path: provider.archive,
      bytes: provider.archiveBytes,
      sha256: provider.archiveSha256,
    },
    ...provider.members,
  ],
  publicKey: {
    path: "provider-public-key.asc",
    bytes: 7717,
    sha256: "c2f5bc1163bd8d15a711616b587bcede212d045a5b8b52df01c74095897cd065",
  },
  signatures: [
    {
      subject: {
        path: "provider-SHA256SUMS.txt",
        bytes: 1482,
        sha256:
          "fa551977fc2b4466daca08701e2d0d028ed5fe43d53dab3b0c30602a5313d6f8",
      },
      signature: {
        path: "provider-SHA256SUMS.sig",
        bytes: 566,
        sha256:
          "dc8cfcc4308c5707b85d83d2dfb30640411935494f7d5ccedcf32b0a9c26f437",
      },
      signerFingerprint: "374EC75B485913604A831CC7C820C6D5CD27AB87",
      primaryFingerprint: "C874011F0AB405110D02105534365D9472D7468F",
    },
  ],
} as const satisfies ReleaseSignaturePolicy;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const randomReleaseProofSummarySchema = z.strictObject({
  proofSha256: digest,
  policySha256: digest,
  signerFingerprint: z.literal(
    randomReleaseSignaturePolicy.signatures[0].signerFingerprint,
  ),
  primaryFingerprint: z.literal(
    randomReleaseSignaturePolicy.signatures[0].primaryFingerprint,
  ),
  scope: z.literal("selected-release-checksum-signature"),
  keyOwnerTrustEstablished: z.literal(false),
  publisherAndLicenseClosureVerified: z.literal(false),
});
export type RandomReleaseProofSummary = z.infer<
  typeof randomReleaseProofSummarySchema
>;
export function randomReleaseProofSummary(
  expectedPin: string,
): RandomReleaseProofSummary {
  if (!parseReleaseProofPin(expectedPin))
    throw new Error("Operator release proof pin required");
  return {
    proofSha256: expectedPin,
    policySha256: releaseSignaturePolicySha256(randomReleaseSignaturePolicy),
    signerFingerprint:
      randomReleaseSignaturePolicy.signatures[0].signerFingerprint,
    primaryFingerprint:
      randomReleaseSignaturePolicy.signatures[0].primaryFingerprint,
    scope: "selected-release-checksum-signature",
    keyOwnerTrustEstablished: false,
    publisherAndLicenseClosureVerified: false,
  };
}
export function readRandomReleaseProof(
  directory: string,
  expectedPin: string | undefined,
): RandomReleaseProofSummary | undefined {
  const pin = parseReleaseProofPin(expectedPin);
  if (!pin) return undefined;
  readReleaseSignatureProof(
    path.join(directory, randomReleaseProofFile),
    pin,
    randomReleaseSignaturePolicy,
  );
  return randomReleaseProofSummary(pin);
}
export function randomPreparedFileNames(
  expectedPin: string | undefined,
): string[] {
  const pin = parseReleaseProofPin(expectedPin);
  return [
    provider.archive,
    "identity.json",
    ...provider.members.map((item) => item.path),
    ...(pin ? [randomReleaseProofFile] : []),
  ].toSorted();
}
export function randomPreparedIdentity(
  archiveSource: string,
  proof?: RandomReleaseProofSummary,
) {
  return proof
    ? {
        schemaVersion: 2,
        provider,
        archiveSource,
        completeMembersObserved: true,
        releaseSignatureVerified: true,
        releaseSignatureProof: proof,
        publisherAndLicenseClosureVerified: false,
        nativeExecutionReached: false,
      }
    : {
        schemaVersion: 1,
        provider,
        archiveSource,
        completeMembersObserved: true,
        releaseSignatureVerified: false,
        publisherAndLicenseClosureVerified: false,
        nativeExecutionReached: false,
      };
}
