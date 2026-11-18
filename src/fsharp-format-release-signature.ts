import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseAllDocuments } from "yaml";
import { z } from "zod";
import { kotlinReadSync } from "./kotlin-io.js";
import { parseReleaseProofPin } from "./release-signature-proof.js";
import {
  fantomasPackagePin,
  fsharpFormatterPins,
  fsharpSdkPins,
} from "./fsharp-format-pins.js";

export const fsharpReleaseProofEnvironment =
  "CHECKTRAIL_FSHARP_FORMAT_RELEASE_PROOF_SHA256";
export const fsharpReleaseProofFile = "release-signature-proof.json";
export const fsharpReleasePackageFile = "fantomas.8.0.7.nupkg";
export const maximumFsharpReleaseProofBytes = 256 * 1024;
const hash = (body: Uint8Array | string) =>
  createHash("sha256").update(body).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pin = z.strictObject({
  file: z.string().min(1).max(256),
  bytes: z
    .number()
    .int()
    .positive()
    .max(256 * 1024 * 1024),
  sha256: digest,
});
export const fsharpNugetPolicy = {
  id: "fantomas-8-0-7-nuget-repository-signature-v1",
  image:
    "mcr.microsoft.com/dotnet/sdk@sha256:3cc3bbbbf93d82104892f42aa9106b6be4d120346dea0649643a97c801525256",
  platform: "linux/arm64",
  sdkArchiveSha256:
    "830d3b4b022453b09b9ecdf59b004e6b032a8a4394b275d47dec175e37030782",
  sdkVersion: "10.0.401",
  runtimeVersion: "10.0.12",
  sdkPinsSha256: hash(JSON.stringify(fsharpSdkPins)),
  sdkSelectedComponents: fsharpSdkPins.length,
  package: {
    file: fsharpReleasePackageFile,
    bytes: fantomasPackagePin.bytes,
    sha256: fantomasPackagePin.sha256,
  },
  selected: fsharpFormatterPins,
  repositoryServiceIndex: "https://api.nuget.org/v3/index.json",
  certificateSha256:
    "1f4b311d9acc115c8dc8018b5a49e00fce6da8e2855f9f014ca6f34570bc482d",
  config: {
    file: "nuget-verification.config",
    bytes: 414,
    sha256: "88948d94b3ced17400f5cfe7dc7bf2cad9b9a8cf98670b3fc3a6d956f8519c7c",
  },
  verifierPins: [
    {
      file: "sdk/10.0.401/NuGet.CommandLine.XPlat.dll",
      bytes: 1392976,
      sha256:
        "612c4c8ee573d61e8a4f7a7b157262597fa4cd5bfbee29ef1ed28f9bd5c1bdc7",
    },
    {
      file: "sdk/10.0.401/trustedroots/codesignctl.pem",
      bytes: 512074,
      sha256:
        "aab671f52e5229906b2100727370007ef4b6d2e360b23f2cf12a6d87773be611",
    },
    {
      file: "sdk/10.0.401/trustedroots/timestampctl.pem",
      bytes: 552370,
      sha256:
        "5ccb03367b52f047099f07e1653160e8578a83711cb18560c979febb65f8cb5d",
    },
  ],
  arguments: [
    "nuget",
    "verify",
    "/artifact/fantomas.nupkg",
    "--all",
    "--certificate-fingerprint",
    "1F4B311D9ACC115C8DC8018B5A49E00FCE6DA8E2855F9F014CA6F34570BC482D",
    "--configfile",
    "/policy/nuget.config",
    "--verbosity",
    "detailed",
  ],
  revocationModeConfigured: "online",
  environment: {
    PATH: "/usr/share/dotnet:/usr/bin:/bin",
    HOME: "/home/nuget",
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    DOTNET_ROOT: "/usr/share/dotnet",
    DOTNET_CLI_HOME: "/home/nuget",
    DOTNET_CLI_UI_LANGUAGE: "en-US",
    DOTNET_MULTILEVEL_LOOKUP: "0",
    DOTNET_ROLL_FORWARD: "Disable",
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    NUGET_CERT_REVOCATION_MODE: "online",
    NUGET_PACKAGES: "/home/nuget/packages",
  },
  network: "bridge",
} as const;
export const fsharpNugetPolicySha256 = hash(JSON.stringify(fsharpNugetPolicy));
export const fsharpNugetStartupNotice =
  'An issue was encountered verifying workloads. For more information, run "dotnet workload update".';
export function validateFsharpNugetOutput(stdout: string, stderr: string) {
  assert.ok(
    Buffer.byteLength(stdout) <= 128 * 1024 &&
      Buffer.byteLength(stderr) <= 128 * 1024,
  );
  const text = stdout + "\n" + stderr;
  assert.ok(
    !/\bNU\d{4}\b/u.test(text),
    "Native NuGet warning or error is not qualified",
  );
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const notices = lines.filter((line) => line === fsharpNugetStartupNotice);
  assert.ok(notices.length <= 1, "Duplicate SDK startup notice");
  const other = lines
    .filter((line) => line !== fsharpNugetStartupNotice)
    .join("\n");
  assert.ok(
    !/^\s*(?:warn(?:ing)?|error)\s*:/imu.test(other),
    "Unaccounted verifier warning or error",
  );
  assert.equal(
    lines.filter((line) => line === "Verifying fantomas.8.0.7").length,
    1,
  );
  assert.equal(
    lines.filter((line) => line === "Signature type: Repository").length,
    1,
  );
  assert.equal(
    lines.filter(
      (line) =>
        line === "Service index: " + fsharpNugetPolicy.repositoryServiceIndex,
    ).length,
    1,
  );
  assert.equal(
    lines.filter(
      (line) => line === "Successfully verified package 'fantomas.8.0.7'.",
    ).length,
    1,
  );
  const selected = other.match(
    /Verifying the repository primary signature with certificate: ?\n([\s\S]*?)(?:\nTimestamp:|\nVerifying repository)/u,
  );
  assert.ok(selected, "Selected repository certificate observation absent");
  assert.equal(
    selected[1]!.match(/^ {2}SHA256 hash: ([A-F0-9]{64})$/mu)?.[1],
    fsharpNugetPolicy.certificateSha256.toUpperCase(),
  );
  const timestamps = lines.filter((line) => line.startsWith("Timestamp: "));
  assert.equal(
    timestamps.length,
    1,
    "Native signature timestamp observation absent",
  );
  assert.ok(timestamps[0]!.length <= 128);
  assert.equal(
    lines.filter(
      (line) =>
        line ===
        "Verifying repository primary signature's timestamp with timestamping service certificate: ",
    ).length +
      lines.filter(
        (line) =>
          line ===
          "Verifying repository primary signature's timestamp with timestamping service certificate:",
      ).length,
    1,
  );
  return {
    timestampText: timestamps[0]!.slice(11),
    sdkStartupMessages: notices,
  };
}
export const fsharpNugetVerificationSchema = z.strictObject({
  observationKind: z.literal("new-native-preparation"),
  image: z.literal(fsharpNugetPolicy.image),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  platform: z.literal("linux/arm64"),
  arguments: z.array(z.string().max(512)).max(16),
  environment: z.record(z.string(), z.string().max(512)),
  network: z.literal("bridge"),
  config: pin,
  verifierBefore: z.array(pin).length(fsharpNugetPolicy.verifierPins.length),
  verifierAfter: z.array(pin).length(fsharpNugetPolicy.verifierPins.length),
  sdkBeforePinsSha256: digest,
  sdkAfterPinsSha256: digest,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  revocationModeConfigured: z.literal("online"),
  revocationFreshAtRuntime: z.literal(false),
  revocationResponsesRetained: z.literal(false),
  exitCode: z.literal(0),
  signal: z.null(),
  outputComplete: z.literal(true),
  stdout: z
    .string()
    .min(1)
    .max(128 * 1024),
  stderr: z.string().max(128 * 1024),
  timestampText: z.string().min(1).max(128),
  sdkStartupMessages: z.array(z.literal(fsharpNugetStartupNotice)).max(1),
});
export type FsharpNugetVerification = z.infer<
  typeof fsharpNugetVerificationSchema
>;
const proofSchema = z.strictObject({
  schemaVersion: z.literal(1),
  policySha256: digest,
  package: pin,
  selected: z.array(pin).length(fsharpFormatterPins.length),
  sdkPinsSha256: digest,
  verification: fsharpNugetVerificationSchema,
  repositorySignatureVerified: z.literal(true),
  authorSignatureVerified: z.literal(false),
  publisherOwnershipEstablished: z.literal(false),
  sdkOriginalProducerVerified: z.literal(false),
  completeArtifactAndNoticeClosureVerified: z.literal(false),
});
export function validateFsharpReleaseProof(body: Uint8Array, expected: string) {
  assert.notEqual(parseReleaseProofPin(expected), "");
  assert.ok(
    body.byteLength > 0 && body.byteLength <= maximumFsharpReleaseProofBytes,
  );
  assert.equal(hash(body), expected, "Operator F# proof digest differs");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  let quoted = false,
    escaped = false,
    depth = 0;
  for (const c of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[")
      assert.ok(++depth <= 12, "F# proof nesting exceeds bound");
    else if (c === "}" || c === "]") depth--;
  }
  const value: unknown = JSON.parse(text),
    docs = parseAllDocuments(text, {
      strict: true,
      uniqueKeys: true,
      prettyErrors: false,
    });
  assert.ok(
    docs.length === 1 && !docs[0]!.errors.length && !docs[0]!.warnings.length,
    "F# proof JSON is ambiguous",
  );
  const proof = proofSchema.parse(value),
    native = proof.verification;
  assert.equal(
    proof.policySha256,
    fsharpNugetPolicySha256,
    "F# proof policy differs",
  );
  assert.deepEqual(proof.package, fsharpNugetPolicy.package);
  assert.deepEqual(proof.selected, fsharpNugetPolicy.selected);
  assert.equal(proof.sdkPinsSha256, fsharpNugetPolicy.sdkPinsSha256);
  assert.deepEqual(native.arguments, fsharpNugetPolicy.arguments);
  assert.deepEqual(native.environment, fsharpNugetPolicy.environment);
  assert.deepEqual(native.config, fsharpNugetPolicy.config);
  assert.deepEqual(native.verifierBefore, fsharpNugetPolicy.verifierPins);
  assert.deepEqual(native.verifierAfter, fsharpNugetPolicy.verifierPins);
  assert.equal(native.sdkBeforePinsSha256, fsharpNugetPolicy.sdkPinsSha256);
  assert.equal(native.sdkAfterPinsSha256, fsharpNugetPolicy.sdkPinsSha256);
  assert.ok(
    Date.parse(native.finishedAt) >= Date.parse(native.startedAt),
    "Verification observation time order differs",
  );
  const observed = validateFsharpNugetOutput(native.stdout, native.stderr);
  assert.equal(native.timestampText, observed.timestampText);
  assert.deepEqual(native.sdkStartupMessages, observed.sdkStartupMessages);
  return proof;
}
export function encodeFsharpReleaseProof(
  verification: FsharpNugetVerification,
) {
  const body = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      policySha256: fsharpNugetPolicySha256,
      package: fsharpNugetPolicy.package,
      selected: fsharpNugetPolicy.selected,
      sdkPinsSha256: fsharpNugetPolicy.sdkPinsSha256,
      verification,
      repositorySignatureVerified: true,
      authorSignatureVerified: false,
      publisherOwnershipEstablished: false,
      sdkOriginalProducerVerified: false,
      completeArtifactAndNoticeClosureVerified: false,
    }) + "\n",
  );
  validateFsharpReleaseProof(body, hash(body));
  return body;
}
export const fsharpReleaseProofReferenceSchema = z.strictObject({
  scope: z.literal("operator-pinned-nuget-repository-signature-observation"),
  proofSha256: digest,
  policySha256: digest,
  packageSha256: digest,
  sdkPinsSha256: digest,
  repositoryCertificateSha256: digest,
  revocationFreshAtRuntime: z.literal(false),
  publisherOwnershipEstablished: z.literal(false),
  sdkOriginalProducerVerified: z.literal(false),
  completeArtifactAndNoticeClosureVerified: z.literal(false),
});
export function fsharpReleaseProofReference(expected: string) {
  assert.notEqual(parseReleaseProofPin(expected), "");
  return {
    scope: "operator-pinned-nuget-repository-signature-observation" as const,
    proofSha256: expected,
    policySha256: fsharpNugetPolicySha256,
    packageSha256: fsharpNugetPolicy.package.sha256,
    sdkPinsSha256: fsharpNugetPolicy.sdkPinsSha256,
    repositoryCertificateSha256: fsharpNugetPolicy.certificateSha256,
    revocationFreshAtRuntime: false as const,
    publisherOwnershipEstablished: false as const,
    sdkOriginalProducerVerified: false as const,
    completeArtifactAndNoticeClosureVerified: false as const,
  };
}
export function fsharpPreparedFileNames(expected: string) {
  return [
    ...fsharpFormatterPins.map((p) => p.file),
    ...(parseReleaseProofPin(expected)
      ? [fsharpReleasePackageFile, fsharpReleaseProofFile]
      : []),
  ].sort();
}
export function readFsharpReleaseProof(directory: string, selected: string) {
  const expected = parseReleaseProofPin(selected),
    proof = path.join(directory, fsharpReleaseProofFile);
  assert.ok(
    path.isAbsolute(directory) && realpathSync(directory) === directory,
  );
  if (!expected) {
    assert.equal(
      lstatSync(proof, { throwIfNoEntry: false }),
      undefined,
      "Proof-bearing F# cohort needs operator selection",
    );
    return null;
  }
  assert.equal(
    path.basename(directory),
    expected,
    "Qualified F# directory must retain its proof digest",
  );
  assert.deepEqual(
    readdirSync(directory).sort(),
    fsharpPreparedFileNames(expected),
  );
  for (const pin of [
    fsharpNugetPolicy.package,
    ...fsharpNugetPolicy.selected,
  ]) {
    const file = path.join(directory, pin.file);
    assert.equal(realpathSync(file), file);
    const bytes = kotlinReadSync(file, pin.bytes);
    assert.equal(bytes.length, pin.bytes);
    assert.equal(hash(bytes), pin.sha256);
  }
  assert.equal(realpathSync(proof), proof);
  validateFsharpReleaseProof(
    kotlinReadSync(proof, maximumFsharpReleaseProofBytes),
    expected,
  );
  return fsharpReleaseProofReference(expected);
}
