// Development-only, closed original producer profiles. Loading executes no source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

export const cProducerCatalogSha256 =
  "0309dcd61b505020cc19bb67beeca7b6a62103c8194784c9eb224bb75466dbc6";
export const cProducerCommand = [
  "dpkg-buildpackage",
  "-b",
  "-us",
  "-uc",
  "--jobs=4",
];
export const cProducerDirectory = fileURLToPath(new URL("./", import.meta.url));
export const safeRelative = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9](?:[A-Za-z0-9.+_~/-]|%3a)*$/u.test(value) &&
  value
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export function validateCProducerCatalog(catalog) {
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(
    catalog.image,
    "docker.io/coqorg/coq@sha256:1f69b9224f068d408e6be7a3f536f67395d00c3497b97bdb99ee2d2c4c91954c",
  );
  assert.equal(catalog.platform, "linux/amd64");
  assert.deepEqual(catalog.environment, {
    HOME: "/work/home",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    DEBIAN_FRONTEND: "noninteractive",
  });
  assert.deepEqual(Object.keys(catalog.profiles).sort(), ["gcc-12", "glibc"]);
  assert.equal(catalog.commonInputs.length, 8);
  for (const [name, version, count, hours, gib] of [
    ["gcc-12", "12.2.0-14+deb12u1", 241, 8, 64],
    ["glibc", "2.36-9+deb12u14", 161, 4, 32],
  ]) {
    const profile = catalog.profiles[name];
    assert.equal(profile.sourcePackage, name);
    assert.equal(profile.sourceVersion, version);
    assert.equal(
      profile.profile,
      `original-debian-${name}-${version}-build-v1`,
    );
    assert.deepEqual(profile.command, cProducerCommand);
    assert.deepEqual(profile.limits, {
      cpuLimit: 4,
      memory: "6g",
      pidsLimit: 1024,
      deadlineSeconds: hours * 3600,
      logByteLimit: 512 * 1024 ** 2,
      workByteLimit: gib * 1024 ** 3,
      inputFileByteLimit: 128 * 1024 ** 2,
    });
    assert.equal(profile.reportFileByteLimit, 64 * 1024 ** 2);
    assert.equal(profile.reportAggregateByteLimit, 512 * 1024 ** 2);
    assert.equal(profile.expectedInputs, count);
    assert.equal(profile.files.length, count);
    assert.deepEqual(
      profile.generatedBuildRoots,
      name === "gcc-12" ? ["build", "build-cross"] : ["build-tree"],
    );
    const seen = new Set();
    for (const row of profile.files) {
      assert.ok(
        safeRelative(row.file) && !seen.has(row.file),
        "Invalid or duplicate closed input",
      );
      seen.add(row.file);
      assert.ok(
        Number.isSafeInteger(row.bytes) &&
          row.bytes >= 0 &&
          row.bytes <= profile.limits.inputFileByteLimit,
        "Exact profile input exceeds its declared finite bound",
      );
      assert.match(row.sha256, /^[a-f0-9]{64}$/u);
      for (const address of row.sourceUrls ?? []) {
        const url = new URL(address);
        assert.equal(url.protocol, "https:");
        assert.ok(
          ["deb.debian.org", "snapshot.debian.org"].includes(url.hostname),
        );
        assert.equal(
          url.username + url.password + url.port + url.hash + url.search,
          "",
        );
      }
    }
    assert.ok(seen.has(profile.descriptor));
    assert.ok(
      profile.files.reduce((sum, row) => sum + row.bytes, 0) <= 1024 ** 3,
    );
    for (const common of catalog.commonInputs) {
      const selected = profile.files.find((row) => row.file === common.file);
      assert.deepEqual(
        selected,
        common,
        "Shared authenticated APT/keyring pin changed",
      );
    }
    for (const field of [
      "noticeCaptureIsExhaustive",
      "sourceFilesPatched",
      "originalBuildChecksDisabled",
      "originalDefaultTargetsDisabled",
      "inputAuthenticationDisabled",
      "sourceBuildQualified",
      "completeOriginalNoticeClosureVerified",
      "historicalPublisherConsumptionVerified",
      "gateAComplete",
    ])
      assert.equal(
        profile[field],
        false,
        "Unproven producer closure must remain false: " + field,
      );
  }
  assert.deepEqual(catalog.profiles.glibc.priorDifferentSourceNotRelabeled, {
    version: "2.36-9+deb12u13",
    descriptorSha256:
      "c034e180a28197c8a9d2b378bcf621d87766a49b3d1bb2d82cc25068ba398cac",
    crossRevisionProducerClosureClaimed: false,
  });
  return catalog;
}

export async function loadCProducerProfile(name) {
  assert.ok(
    ["gcc-12", "glibc"].includes(name),
    "Unknown closed producer profile",
  );
  const bytes = await readFile(
    new URL("c-producer-profiles.v1.json", import.meta.url),
  );
  assert.ok(
    bytes.length <= 1024 ** 2,
    "Profile metadata exceeds its finite bound",
  );
  assert.equal(
    sha256(bytes),
    cProducerCatalogSha256,
    "Frozen producer metadata changed",
  );
  const catalog = validateCProducerCatalog(JSON.parse(bytes));
  return {
    catalog,
    profile: catalog.profiles[name],
    catalogSha256: sha256(bytes),
  };
}
