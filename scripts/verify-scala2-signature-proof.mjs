import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  realpath,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { scala2Artifacts } from "../dist/src/scala2-artifacts.js";
import {
  scala2ReleaseArchiveFilename,
  scala2ReleaseProofFilename,
} from "../dist/src/scala2-release-signature.js";
import {
  prepareScala2SignatureProof,
  scala2SignatureInputs,
} from "./prepare-scala2-signature-proof.mjs";

const repository = await realpath(
  fileURLToPath(new URL("../", import.meta.url)),
);
const args = process.argv.slice(2);
assert.ok(
  args.length === 0 ||
    (args.length === 2 && args[0] === "--archive" && path.isAbsolute(args[1])),
  "Usage: verify-scala2-signature-proof.mjs [--archive ABSOLUTE_PINNED_ARCHIVE]",
);
const selected =
  args[1] ??
  path.join(
    repository,
    ".checktrail/scala-tools",
    scala2ReleaseArchiveFilename,
  );
assert.equal(await realpath(selected), selected);
const handle = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW);
let archive;
try {
  const before = await handle.stat();
  assert.ok(before.isFile());
  assert.equal(before.size, scala2Artifacts.archiveBytes);
  const body = Buffer.alloc(before.size + 1);
  let offset = 0;
  while (offset < body.length) {
    const result = await handle.read(
      body,
      offset,
      body.length - offset,
      offset,
    );
    if (!result.bytesRead) break;
    offset += result.bytesRead;
  }
  const after = await handle.stat();
  assert.equal(offset, before.size);
  for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"])
    assert.equal(after[field], before[field]);
  archive = body.subarray(0, offset);
} finally {
  await handle.close();
}
const hash = (body) => createHash("sha256").update(body).digest("hex");
assert.equal(hash(archive), scala2Artifacts.archiveSha256);
const inputs = await scala2SignatureInputs(
  path.join(repository, "docs/measurements/artifact-identities-2026-10-21"),
);
const temporary = await realpath(
  await mkdtemp(path.join(tmpdir(), "scala2-signature-controls-")),
);
const cases = [];
async function inventory(directory) {
  const rows = [];
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name),
      metadata = await stat(file),
      body = await readFile(file);
    rows.push({
      name,
      bytes: body.length,
      sha256: hash(body),
      ino: metadata.ino,
      mtimeMs: metadata.mtimeMs,
    });
  }
  return rows;
}
async function noStaging(directory) {
  assert.equal(
    (await readdir(directory)).some((n) => n.startsWith(".staging-")),
    false,
  );
}
try {
  const valid = path.join(temporary, "valid");
  const first = await prepareScala2SignatureProof({
    archive,
    inputs,
    destinationParent: valid,
  });
  assert.equal(first.reference.distributionSignatureVerified, false);
  assert.equal(first.reference.completeArtifactAndNoticeClosureVerified, false);
  assert.equal(
    first.reference.signedSubjects.length + 2,
    scala2Artifacts.runtimeLibraries.length,
  );
  const cohort = path.dirname(first.archive),
    before = await inventory(cohort);
  assert.deepEqual(
    before.map((p) => p.name),
    [scala2ReleaseProofFilename, scala2ReleaseArchiveFilename].sort(),
  );
  cases.push({ id: "valid-real-three-signature-cohort", passed: true });
  const second = await prepareScala2SignatureProof({
    archive,
    inputs,
    destinationParent: valid,
  });
  assert.equal(second.proofSha256, first.proofSha256);
  assert.deepEqual(await inventory(cohort), before);
  await noStaging(valid);
  cases.push({
    id: "immutable-existing-cohort-reused-without-overwrite",
    passed: true,
  });

  const corruptParent = path.join(temporary, "corrupt"),
    corrupt = path.join(corruptParent, first.proofSha256);
  await mkdir(corrupt, { recursive: true });
  const changed = Buffer.from(archive);
  changed[0] ^= 1;
  await writeFile(path.join(corrupt, scala2ReleaseArchiveFilename), changed);
  await writeFile(
    path.join(corrupt, scala2ReleaseProofFilename),
    await readFile(path.join(cohort, scala2ReleaseProofFilename)),
  );
  const corruptBefore = await inventory(corrupt);
  await assert.rejects(
    () =>
      prepareScala2SignatureProof({
        archive,
        inputs,
        destinationParent: corruptParent,
      }),
    /signature input identity differs/,
  );
  assert.deepEqual(await inventory(corrupt), corruptBefore);
  await noStaging(corruptParent);
  cases.push({
    id: "same-size-corrupt-existing-archive-rejected-and-preserved",
    passed: true,
  });

  const failure = path.join(temporary, "publication-failure");
  await mkdir(failure);
  await writeFile(
    path.join(failure, "prior-valid-marker"),
    "synthetic prior valid data",
  );
  const marker = await inventory(failure);
  const injected = new Error("synthetic-publication-failure");
  await assert.rejects(
    () =>
      prepareScala2SignatureProof({
        archive,
        inputs,
        destinationParent: failure,
        publication: async () => {
          throw injected;
        },
      }),
    (error) => error === injected,
  );
  assert.deepEqual(await inventory(failure), marker);
  await noStaging(failure);
  cases.push({
    id: "publication-failure-leaves-prior-data-and-no-cohort",
    passed: true,
  });
  assert.equal(cases.length, 4);
  process.stdout.write(
    JSON.stringify({
      profile: "scala2-selected-jar-signature-preparation",
      cases,
      nativeSignaturesPerPreparation: first.reference.signedSubjects.length,
      completeArtifactAndNoticeClosureVerified: false,
      compilerOrProjectOrModelExecuted: false,
      gateAComplete: false,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
