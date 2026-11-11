import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  encodeFsharpReleaseProof,
  fsharpNugetPolicy,
  fsharpNugetStartupNotice,
  fsharpPreparedFileNames,
  fsharpReleaseProofReference,
  readFsharpReleaseProof,
  validateFsharpNugetOutput,
  validateFsharpReleaseProof,
  type FsharpNugetVerification,
} from "../src/fsharp-format-release-signature.js";
import { mavenHash } from "../src/maven.js";

function observed(): FsharpNugetVerification {
  const stdout = [
    "Verifying fantomas.8.0.7",
    "Signature type: Repository",
    "Service index: " + fsharpNugetPolicy.repositoryServiceIndex,
    "Verifying the repository primary signature with certificate:",
    "  SHA256 hash: " + fsharpNugetPolicy.certificateSha256.toUpperCase(),
    "Timestamp: 10/05/2026 12:07:00",
    "Verifying repository primary signature's timestamp with timestamping service certificate:",
    "Successfully verified package 'fantomas.8.0.7'.",
    "",
  ].join("\n");
  return {
    observationKind: "new-native-preparation",
    image: fsharpNugetPolicy.image,
    imageId: "sha256:" + "2".repeat(64),
    platform: "linux/arm64",
    arguments: [...fsharpNugetPolicy.arguments],
    environment: { ...fsharpNugetPolicy.environment },
    network: "bridge",
    config: { ...fsharpNugetPolicy.config },
    verifierBefore: structuredClone([...fsharpNugetPolicy.verifierPins]),
    verifierAfter: structuredClone([...fsharpNugetPolicy.verifierPins]),
    sdkBeforePinsSha256: fsharpNugetPolicy.sdkPinsSha256,
    sdkAfterPinsSha256: fsharpNugetPolicy.sdkPinsSha256,
    startedAt: "2026-11-11T12:00:00.000Z",
    finishedAt: "2026-11-11T12:00:01.000Z",
    revocationModeConfigured: "online",
    revocationFreshAtRuntime: false,
    revocationResponsesRetained: false,
    exitCode: 0,
    signal: null,
    outputComplete: true,
    stdout,
    stderr: "",
    timestampText: "10/05/2026 12:07:00",
    sdkStartupMessages: [],
  };
}
const altered = (edit: (value: Record<string, unknown>) => void) => {
  const value = JSON.parse(
    encodeFsharpReleaseProof(observed()).toString(),
  ) as Record<string, unknown>;
  edit(value);
  const body = Buffer.from(JSON.stringify(value));
  return () => validateFsharpReleaseProof(body, mavenHash(body));
};
test("Fsharp NuGet observation admits exact policy and explicitly bounded dated scope", () => {
  for (const startup of [false, true]) {
    const native = observed();
    if (startup) {
      native.stderr = fsharpNugetStartupNotice + "\n";
      native.sdkStartupMessages = [fsharpNugetStartupNotice];
    }
    const body = encodeFsharpReleaseProof(native),
      pin = mavenHash(body),
      proof = validateFsharpReleaseProof(body, pin);
    assert.equal(proof.repositorySignatureVerified, true);
    assert.equal(proof.authorSignatureVerified, false);
    assert.equal(proof.publisherOwnershipEstablished, false);
    assert.equal(proof.verification.revocationFreshAtRuntime, false);
    assert.equal(proof.verification.revocationResponsesRetained, false);
    assert.equal(proof.sdkOriginalProducerVerified, false);
    assert.equal(proof.completeArtifactAndNoticeClosureVerified, false);
    assert.equal(fsharpReleaseProofReference(pin).proofSha256, pin);
  }
});
test("Fsharp proof refuses coherently rehashed changed policy/package/selected membership and SDK", () => {
  for (const edit of [
    (p: Record<string, unknown>) => {
      p.policySha256 = "0".repeat(64);
    },
    (p: Record<string, unknown>) => {
      (p.package as Record<string, unknown>).sha256 = "0".repeat(64);
    },
    (p: Record<string, unknown>) => {
      (p.selected as unknown[]).reverse();
    },
    (p: Record<string, unknown>) => {
      const s = p.selected as unknown[];
      s[1] = s[0];
    },
    (p: Record<string, unknown>) => {
      p.sdkPinsSha256 = "0".repeat(64);
    },
    (p: Record<string, unknown>) => {
      p.completeArtifactAndNoticeClosureVerified = true;
    },
  ])
    assert.throws(altered(edit));
});
test("Fsharp proof independently binds native argv, exact environment, verifier, roots, output and attempt times", () => {
  for (const edit of [
    (n: Record<string, unknown>) => {
      n.arguments = [];
    },
    (n: Record<string, unknown>) => {
      n.environment = {};
    },
    (n: Record<string, unknown>) => {
      n.network = "none";
    },
    (n: Record<string, unknown>) => {
      n.verifierBefore = [];
    },
    (n: Record<string, unknown>) => {
      (n.verifierAfter as unknown[]).reverse();
    },
    (n: Record<string, unknown>) => {
      n.sdkBeforePinsSha256 = "0".repeat(64);
    },
    (n: Record<string, unknown>) => {
      n.sdkAfterPinsSha256 = "0".repeat(64);
    },
    (n: Record<string, unknown>) => {
      n.revocationFreshAtRuntime = true;
    },
    (n: Record<string, unknown>) => {
      n.finishedAt = "2026-11-10T12:00:00.000Z";
    },
    (n: Record<string, unknown>) => {
      n.exitCode = 1;
    },
    (n: Record<string, unknown>) => {
      n.timestampText = "invented UTC";
    },
    (n: Record<string, unknown>) => {
      n.stdout = String(n.stdout).replace(
        "Verifying fantomas.8.0.7",
        "Verifying unrelated.8.0.7",
      );
    },
  ])
    assert.throws(
      altered((p) => edit(p.verification as Record<string, unknown>)),
    );
});
test("Fsharp NuGet success refuses native statuses, duplicate/missing success, selected certificate drift and unknown warnings", () => {
  const n = observed();
  for (const [stdout, stderr] of [
    [n.stdout, "NU3034: certificate not trusted"],
    [n.stdout, "warning: new unexplained condition"],
    [n.stdout, fsharpNugetStartupNotice + "\n" + fsharpNugetStartupNotice],
    [n.stdout + n.stdout, ""],
    [
      n.stdout.replace("Successfully verified package 'fantomas.8.0.7'.", ""),
      "",
    ],
    [
      n.stdout.replace(
        fsharpNugetPolicy.certificateSha256.toUpperCase(),
        "0".repeat(64),
      ),
      "",
    ],
  ])
    assert.throws(() => validateFsharpNugetOutput(stdout!, stderr!));
});
test("Fsharp proof rejects malformed external pins, duplicate JSON keys, depth, UTF8 and byte overrun", () => {
  const body = encodeFsharpReleaseProof(observed());
  for (const pin of ["", " ", "0".repeat(63), "A".repeat(64), "0".repeat(64)])
    assert.throws(() => validateFsharpReleaseProof(body, pin));
  for (const b of [
    Buffer.from(
      body
        .toString()
        .replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    ),
    Buffer.from("[".repeat(13) + "0" + "]".repeat(13)),
    Buffer.from([0xff]),
    Buffer.alloc(256 * 1024 + 1),
  ])
    assert.throws(() => validateFsharpReleaseProof(b, mavenHash(b)));
});
test("Fsharp legacy absence is explicit and cannot silently consume an adjacent proof or dangling link", async (t) => {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "fsharp-proof-absence-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(readFsharpReleaseProof(directory, ""), null);
  assert.equal(fsharpPreparedFileNames("").length, 3);
  assert.equal(fsharpPreparedFileNames("0".repeat(64)).length, 5);
  const file = path.join(directory, "release-signature-proof.json");
  await writeFile(file, "{}");
  assert.throws(() => readFsharpReleaseProof(directory, ""));
  await rm(file);
  await symlink(path.join(directory, "missing"), file);
  assert.throws(() => readFsharpReleaseProof(directory, ""));
});
