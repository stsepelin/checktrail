import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { scala2Artifacts } from "../src/scala2-artifacts.js";
import {
  scala2ReleaseSignature,
  scala2ReleaseSignaturePolicy,
  scala2ReleaseSignatureReference,
  scala2ReleaseSignatureReferenceSchema,
  scala2ReleaseProofFilename,
} from "../src/scala2-release-signature.js";

const selected = "a".repeat(64);
async function physical(action: (directory: string) => Promise<void>) {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "scala-release-proof-")),
  );
  try {
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Scala signature policy distinguishes signed JARs from the other payloads", () => {
  const policy = scala2ReleaseSignaturePolicy;
  const signed = new Set(policy.signatures.map((s) => s.subject.path));
  assert.equal(signed.size, policy.signatures.length);
  const jars = scala2Artifacts.runtimeLibraries;
  const unsigned = jars.filter((p) => !signed.has(p.path));
  assert.deepEqual(unsigned.map((p) => p.path).sort(), [
    "lib/java-diff-utils-4.16.jar",
    "lib/jline-3.29.0.jar",
  ]);
  assert.equal(signed.size + unsigned.length, jars.length);
  assert.equal(policy.payloads.length, jars.length + 1);
  for (const signature of policy.signatures) {
    const jar = jars.find((p) => p.path === signature.subject.path);
    assert.ok(jar);
    assert.deepEqual(signature.subject, {
      path: jar.path,
      bytes: jar.bytes,
      sha256: jar.sha256,
    });
    assert.equal(
      signature.signerFingerprint,
      "2A5E8B338438CAC7033F9D8FB8A045C0A6EC398E",
    );
    assert.equal(signature.primaryFingerprint, signature.signerFingerprint);
  }
  assert.equal(signed.has(`scala-${scala2Artifacts.version}.zip`), false);
});

test("Scala scoped reference preserves distribution and full closure uncertainty", () => {
  const reference = scala2ReleaseSignatureReference(selected);
  assert.equal(reference.proofSha256, selected);
  assert.equal(reference.distributionSignatureVerified, false);
  assert.equal(reference.completeArtifactAndNoticeClosureVerified, false);
  assert.deepEqual(
    reference.signedSubjects.map((p) => p.path),
    [
      "lib/scala-compiler.jar",
      "lib/scala-library.jar",
      "lib/scala-reflect.jar",
    ],
  );
  assert.deepEqual(
    scala2ReleaseSignatureReferenceSchema.parse(reference),
    reference,
  );
  for (const change of [
    { distributionSignatureVerified: true },
    { completeArtifactAndNoticeClosureVerified: true },
    { signedSubjects: reference.signedSubjects.slice(0, 1) },
    { extraAuthority: true },
  ]) {
    assert.equal(
      scala2ReleaseSignatureReferenceSchema.safeParse({
        ...reference,
        ...change,
      }).success,
      false,
    );
  }
});

test("Scala legacy archive remains explicitly unverified without a proof entry", async () => {
  await physical(async (directory) => {
    const archive = path.join(directory, "legacy.zip");
    await writeFile(archive, "synthetic legacy data");
    assert.equal(scala2ReleaseSignature(archive, Buffer.alloc(0), ""), null);
  });
});

test("Scala cannot silently use a proof-bearing cohort without operator selection", async () => {
  await physical(async (directory) => {
    await writeFile(path.join(directory, scala2ReleaseProofFilename), "{}");
    assert.throws(
      () =>
        scala2ReleaseSignature(
          path.join(directory, "legacy.zip"),
          Buffer.alloc(0),
          "",
        ),
      /operator proof pin/,
    );
  });
});

test("Scala dangling proof links also prevent an implicit legacy downgrade", async () => {
  await physical(async (directory) => {
    await symlink(
      path.join(directory, "absent.json"),
      path.join(directory, scala2ReleaseProofFilename),
      "junction",
    );
    assert.throws(
      () =>
        scala2ReleaseSignature(
          path.join(directory, "legacy.zip"),
          Buffer.alloc(0),
          "",
        ),
      /operator proof pin/,
    );
  });
});

test("Scala malformed nonempty operator pins never become legacy selection", async () => {
  await physical(async (directory) => {
    for (const pin of [
      " ",
      "A".repeat(64),
      "0".repeat(63),
      "sha256:" + selected,
    ]) {
      assert.throws(() =>
        scala2ReleaseSignature(
          path.join(directory, "legacy.zip"),
          Buffer.alloc(0),
          pin,
        ),
      );
      assert.throws(() => scala2ReleaseSignatureReference(pin));
    }
  });
});

test("Scala an operator pin cannot qualify a legacy-shaped cache", async () => {
  await physical(async (directory) => {
    await writeFile(path.join(directory, "legacy.zip"), "synthetic");
    assert.throws(() =>
      scala2ReleaseSignature(
        path.join(directory, "legacy.zip"),
        Buffer.alloc(0),
        selected,
      ),
    );
  });
});
