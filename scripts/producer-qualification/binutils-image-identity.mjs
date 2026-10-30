import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function bytes(row) {
  assert.ok(
    Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= 1048576,
  );
  assert.match(row.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(typeof row.base64 === "string" && row.base64.length <= 1398104);
  const raw = Buffer.from(row.base64, "base64");
  assert.equal(
    raw.toString("base64"),
    row.base64,
    "Noncanonical registry bytes",
  );
  assert.equal(raw.length, row.bytes);
  assert.equal(sha(raw), row.sha256, "Registry byte identity changed");
  return raw;
}
export function registryImageIdentity(record, selectedImage) {
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.selectedImage, selectedImage);
  assert.match(selectedImage, /^docker\.io\/coqorg\/coq@sha256:[a-f0-9]{64}$/u);
  const manifestRaw = bytes(record.manifest),
    configRaw = bytes(record.config);
  assert.equal(record.manifest.sha256, selectedImage.split("@sha256:")[1]);
  const manifest = JSON.parse(manifestRaw.toString("utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.ok(
    [
      "application/vnd.docker.distribution.manifest.v2+json",
      "application/vnd.oci.image.manifest.v1+json",
    ].includes(manifest.mediaType),
  );
  assert.equal(manifest.config.digest, "sha256:" + record.config.sha256);
  assert.equal(manifest.config.size, configRaw.length);
  assert.equal(
    record.manifest.sourceUrl,
    "https://registry-1.docker.io/v2/coqorg/coq/manifests/" +
      "sha256:" +
      record.manifest.sha256,
  );
  assert.equal(
    record.config.sourceUrl,
    "https://registry-1.docker.io/v2/coqorg/coq/blobs/" +
      manifest.config.digest,
  );
  const config = JSON.parse(configRaw.toString("utf8"));
  assert.equal(config.os, "linux");
  assert.equal(config.architecture, "amd64");
  assert.equal(config.rootfs.type, "layers");
  assert.ok(
    Array.isArray(config.rootfs.diff_ids) &&
      config.rootfs.diff_ids.length > 0 &&
      config.rootfs.diff_ids.length <= 128,
  );
  assert.equal(config.rootfs.diff_ids.length, manifest.layers.length);
  for (const digest of config.rootfs.diff_ids)
    assert.match(digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(record.rawManifestConfigVerified, true);
  assert.equal(record.compilerBuildExecuted, false);
  assert.equal(record.gateAComplete, false);
  return {
    selectedImage,
    manifestDigest: "sha256:" + record.manifest.sha256,
    configDigest: manifest.config.digest,
    rootfsDiffIds: config.rootfs.diff_ids,
    rawManifestConfigVerified: true,
  };
}
export function validateObservedImage(image, identity) {
  assert.ok(
    [identity.manifestDigest, identity.configDigest].includes(image.Id),
    "Observed image ID is neither the pinned manifest nor its config",
  );
  assert.equal(image.Os, "linux");
  assert.equal(image.Architecture, "amd64");
  const references = [
    identity.selectedImage,
    identity.selectedImage.replace(/^docker\.io\//u, ""),
  ];
  assert.ok(
    image.RepoDigests.some((ref) => references.includes(ref)),
    "Exact pinned repository digest is missing",
  );
  assert.equal(image.RootFS.Type, "layers");
  assert.deepEqual(
    image.RootFS.Layers,
    identity.rootfsDiffIds,
    "Observed filesystem differs from pinned raw config",
  );
  return {
    id: image.Id,
    os: image.Os,
    architecture: image.Architecture,
    manifestDigest: identity.manifestDigest,
    configDigest: identity.configDigest,
    rootfsDiffIds: [...image.RootFS.Layers],
  };
}
