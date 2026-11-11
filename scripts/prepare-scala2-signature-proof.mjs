import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { scala2Libraries } from "../dist/src/scala2-archive.js";
import {
  scala2ReleaseArchiveFilename,
  scala2ReleaseProofFilename,
  scala2ReleaseSignature,
  scala2ReleaseSignaturePolicy as policy,
} from "../dist/src/scala2-release-signature.js";
import {
  encodeReleaseSignatureProof,
  validateReleaseSignatureProof,
} from "../dist/src/release-signature-proof.js";
import { verifyDetachedReleaseSignatures } from "./release-signature-preparation.mjs";

const hash = (body) => createHash("sha256").update(body).digest("hex");
async function originalInput(directory, pin) {
  const file = path.join(directory, pin.path);
  assert.equal(
    await realpath(file),
    file,
    "Canonical original signature input required",
  );
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assert.ok(before.isFile());
    assert.equal(before.size, pin.bytes);
    const body = Buffer.alloc(pin.bytes + 1);
    let offset = 0;
    while (offset < body.length) {
      const read = await handle.read(
        body,
        offset,
        body.length - offset,
        offset,
      );
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    assert.equal(offset, pin.bytes);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(await realpath(file), file);
    const value = body.subarray(0, pin.bytes);
    assert.equal(
      hash(value),
      pin.sha256,
      "Original signature input identity differs",
    );
    return value;
  } finally {
    await handle.close();
  }
}

export async function scala2SignatureInputs(directory) {
  assert.ok(path.isAbsolute(directory));
  assert.equal(await realpath(directory), directory);
  const publicKey = await originalInput(directory, policy.publicKey);
  const signatures = [];
  for (const signature of policy.signatures) {
    signatures.push(await originalInput(directory, signature.signature));
  }
  return { publicKey, signatures };
}

export async function prepareScala2SignatureProof({
  archive,
  inputs,
  destinationParent,
  publication = rename,
}) {
  const payload = Buffer.from(archive);
  const archivePin = policy.payloads.find(
    (p) => p.path === scala2ReleaseArchiveFilename,
  );
  assert.equal(payload.length, archivePin.bytes);
  assert.equal(hash(payload), archivePin.sha256);
  const libraries = scala2Libraries(payload);
  assert.equal(hash(inputs.publicKey), policy.publicKey.sha256);
  assert.equal(inputs.publicKey.length, policy.publicKey.bytes);
  assert.equal(inputs.signatures.length, policy.signatures.length);
  const signatures = policy.signatures.map((s, i) => {
    const signature = inputs.signatures[i];
    assert.equal(signature.length, s.signature.bytes);
    assert.equal(hash(signature), s.signature.sha256);
    return {
      subject: {
        path: s.subject.path,
        body: libraries.get(path.basename(s.subject.path)),
      },
      signature: { path: s.signature.path, body: signature },
    };
  });
  const verification = await verifyDetachedReleaseSignatures({
    publicKey: { path: policy.publicKey.path, body: inputs.publicKey },
    signatures,
    signerFingerprint: policy.signatures[0].signerFingerprint,
    primaryFingerprint: policy.signatures[0].primaryFingerprint,
  });
  const proof = encodeReleaseSignatureProof(policy, verification);
  const proofSha256 = hash(proof);
  validateReleaseSignatureProof(proof, proofSha256, policy);
  assert.ok(path.isAbsolute(destinationParent));
  await mkdir(destinationParent, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(destinationParent), destinationParent);
  const staging = await mkdtemp(path.join(destinationParent, ".staging-"));
  const destination = path.join(destinationParent, proofSha256);
  try {
    await writeFile(path.join(staging, scala2ReleaseArchiveFilename), payload, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(path.join(staging, scala2ReleaseProofFilename), proof, {
      flag: "wx",
      mode: 0o600,
    });
    assert.equal(
      hash(await readFile(path.join(staging, scala2ReleaseArchiveFilename))),
      archivePin.sha256,
    );
    validateReleaseSignatureProof(
      await readFile(path.join(staging, scala2ReleaseProofFilename)),
      proofSha256,
      policy,
    );
    assert.equal(await realpath(destinationParent), destinationParent);
    try {
      await publication(staging, destination);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
    }
    const physicalArchive = await originalInput(destination, archivePin);
    const reference = scala2ReleaseSignature(
      path.join(destination, scala2ReleaseArchiveFilename),
      physicalArchive,
      proofSha256,
    );
    return {
      archive: path.join(destination, scala2ReleaseArchiveFilename),
      proofSha256,
      reference,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
