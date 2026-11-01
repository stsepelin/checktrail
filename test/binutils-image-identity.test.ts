import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const { registryImageIdentity, validateObservedImage } = await import(
  pathToFileURL(
    path.join(
      repository,
      "scripts/producer-qualification/binutils-image-identity.mjs",
    ),
  ).href
);
const record = JSON.parse(
  readFileSync(
    path.join(
      repository,
      "scripts/producer-qualification/binutils-image-identity.v1.json",
    ),
    "utf8",
  ),
);
const selected = record.selectedImage;
const identity = registryImageIdentity(record, selected);
const observed = (id: string) => ({
  Id: id,
  Os: "linux",
  Architecture: "amd64",
  RepoDigests: [selected.replace(/^docker\.io\//u, "")],
  RootFS: { Type: "layers", Layers: [...identity.rootfsDiffIds] },
});
const encode = (value: unknown) => {
  const raw = Buffer.from(JSON.stringify(value));
  return {
    bytes: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex"),
    base64: raw.toString("base64"),
  };
};

test("pinned raw registry manifest binds its config and filesystem without compiler qualification", () => {
  assert.equal(
    identity.manifestDigest,
    "sha256:1f69b9224f068d408e6be7a3f536f67395d00c3497b97bdb99ee2d2c4c91954c",
  );
  assert.equal(
    identity.configDigest,
    "sha256:1800d215751b3f9113556efafa95267fc7641ee6bddbcaf29f692773fbc6cbf3",
  );
  assert.equal(identity.rootfsDiffIds.length, 7);
  assert.equal(identity.rawManifestConfigVerified, true);
  assert.equal(record.compilerBuildExecuted, false);
  assert.equal(record.gateAComplete, false);
});
test("both observed Docker ID forms require the identical pinned filesystem and repository", () => {
  for (const id of [identity.manifestDigest, identity.configDigest]) {
    const actual = validateObservedImage(observed(id), identity);
    assert.equal(actual.id, id);
    assert.deepEqual(actual.rootfsDiffIds, identity.rootfsDiffIds);
  }
  const fullyQualified = observed(identity.configDigest);
  fullyQualified.RepoDigests = [selected];
  assert.equal(
    validateObservedImage(fullyQualified, identity).id,
    identity.configDigest,
  );
});
test("foreign IDs namespaces platforms and filesystem mutations are refused for both ID forms", () => {
  for (const id of [identity.manifestDigest, identity.configDigest]) {
    const edits: ((value: ReturnType<typeof observed>) => void)[] = [
      (value) => (value.Id = "sha256:" + "0".repeat(64)),
      (value) =>
        (value.RepoDigests = [
          selected.replace("coqorg/coq", "coqorg/coq-lookalike"),
        ]),
      (value) => (value.RepoDigests = []),
      (value) => (value.Architecture = "arm64"),
      (value) => (value.Os = "windows"),
      (value) => (value.RootFS.Type = "other"),
      (value) => (value.RootFS.Layers[0] = "sha256:" + "0".repeat(64)),
      (value) => value.RootFS.Layers.pop(),
    ];
    for (const edit of edits) {
      const value = observed(id);
      edit(value);
      assert.throws(() => validateObservedImage(value, identity));
    }
  }
});
test("raw corruption noncanonical encoding and false metadata cannot preserve a valid image proof", () => {
  for (const field of ["manifest", "config"]) {
    const changed = structuredClone(record);
    changed[field].base64 = "AAAA" + changed[field].base64.slice(4);
    assert.throws(() => registryImageIdentity(changed, selected));
    const malformed = structuredClone(record);
    malformed[field].base64 += "\n";
    assert.throws(() => registryImageIdentity(malformed, selected));
    const padding = structuredClone(record);
    padding[field].base64 = padding[field].base64.slice(0, -1);
    assert.throws(() => registryImageIdentity(padding, selected));
  }
  const bad = structuredClone(record);
  bad.rawManifestConfigVerified = false;
  assert.throws(() => registryImageIdentity(bad, selected));
  const compiled = structuredClone(record);
  compiled.compilerBuildExecuted = true;
  assert.throws(() => registryImageIdentity(compiled, selected));
});
test("coherently rehashed config and manifest mutations still cannot change the frozen image", () => {
  const changed = structuredClone(record);
  const config = JSON.parse(
    Buffer.from(changed.config.base64, "base64").toString("utf8"),
  );
  config.rootfs.diff_ids[0] = "sha256:" + "0".repeat(64);
  Object.assign(changed.config, encode(config));
  assert.throws(() => registryImageIdentity(changed, selected));
  const manifest = JSON.parse(
    Buffer.from(changed.manifest.base64, "base64").toString("utf8"),
  );
  manifest.config.digest = "sha256:" + changed.config.sha256;
  manifest.config.size = changed.config.bytes;
  Object.assign(changed.manifest, encode(manifest));
  changed.config.sourceUrl =
    "https://registry-1.docker.io/v2/coqorg/coq/blobs/sha256:" +
    changed.config.sha256;
  changed.manifest.sourceUrl =
    "https://registry-1.docker.io/v2/coqorg/coq/manifests/sha256:" +
    changed.manifest.sha256;
  assert.throws(() => registryImageIdentity(changed, selected));
});
