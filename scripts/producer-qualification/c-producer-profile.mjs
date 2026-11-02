// Development-only, closed original producer profiles. Loading executes no source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

export const cProducerCatalogSha256 =
  "a2cd4b6647bfccab800576b5de4b6bb47d04edb3746a5467f2176daa207dee4f";
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

const profileBindings = [
  [
    "gcc-12",
    "gcc-12",
    "12.2.0-14+deb12u1",
    241,
    8,
    64,
    "source/gcc-12/gcc-12_12.2.0-14+deb12u1.dsc",
  ],
  [
    "glibc",
    "glibc",
    "2.36-9+deb12u14",
    161,
    4,
    32,
    "source/glibc/glibc_2.36-9+deb12u14.dsc",
  ],
  [
    "glibc-u13",
    "glibc",
    "2.36-9+deb12u13",
    161,
    4,
    32,
    "source/glibc/glibc_2.36-9+deb12u13.dsc",
  ],
];

export function cProducerProfileKey(profile) {
  const binding = profileBindings.find(
    ([, sourcePackage, version, , , , descriptor]) =>
      profile.sourcePackage === sourcePackage &&
      profile.sourceVersion === version &&
      profile.profile ===
        `original-debian-${sourcePackage}-${version}-build-v1` &&
      profile.descriptor === descriptor,
  );
  assert.ok(
    binding,
    "Unknown exact C producer key/source/version/descriptor tuple",
  );
  return binding[0];
}

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
  assert.deepEqual(Object.keys(catalog.profiles).sort(), [
    "gcc-12",
    "glibc",
    "glibc-u13",
  ]);
  assert.equal(catalog.commonInputs.length, 8);
  for (const [
    name,
    sourcePackage,
    version,
    count,
    hours,
    gib,
    descriptor,
  ] of profileBindings) {
    const profile = catalog.profiles[name];
    assert.equal(profile.sourcePackage, sourcePackage);
    assert.equal(profile.descriptor, descriptor);
    assert.equal(cProducerProfileKey(profile), name);
    assert.equal(profile.sourceVersion, version);
    assert.equal(
      profile.profile,
      `original-debian-${sourcePackage}-${version}-build-v1`,
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
  const u13 = catalog.profiles["glibc-u13"];
  const u14 = catalog.profiles.glibc;
  const replacements = [
    {
      file: "source/glibc/glibc_2.36-9+deb12u13.debian.tar.xz",
      bytes: 908524,
      sha256:
        "728086077548b13c37a348a99f74b9c7a437d6a8aed4aab5e2ed86b3a5ff6df6",
      kind: "original-source-archive",
      sourceUrls: [
        "https://deb.debian.org/debian/pool/main/g/glibc/glibc_2.36-9+deb12u13.debian.tar.xz",
      ],
    },
    {
      file: "source/glibc/glibc_2.36-9+deb12u13.dsc",
      bytes: 9765,
      sha256:
        "c034e180a28197c8a9d2b378bcf621d87766a49b3d1bb2d82cc25068ba398cac",
      kind: "signed-source-descriptor",
      sourceUrls: [
        "https://deb.debian.org/debian/pool/main/g/glibc/glibc_2.36-9+deb12u13.dsc",
      ],
    },
  ];
  assert.deepEqual(
    u13.files.filter((row) =>
      replacements.some((replacement) => replacement.file === row.file),
    ),
    replacements,
    "Exact u13 source descriptor/archive pins changed",
  );
  const oldSourceNames = new Set([
    "source/glibc/glibc_2.36-9+deb12u14.debian.tar.xz",
    "source/glibc/glibc_2.36-9+deb12u14.dsc",
  ]);
  const newSourceNames = new Set(replacements.map((row) => row.file));
  assert.deepEqual(
    u13.files.filter((row) => !newSourceNames.has(row.file)),
    u14.files.filter((row) => !oldSourceNames.has(row.file)),
    "The 159 unchanged u13 bootstrap/metadata inputs changed",
  );
  assert.equal(
    u13.sourceDescriptorSigner,
    null,
    "Fresh u13 signer identity is not yet observed",
  );
  assert.equal(u13.freshSourceDescriptorSignatureVerified, false);
  assert.equal(u13.historicalPrivateInputReplayVerified, false);
  assert.equal(u13.reusedBootstrapInputProfile, u14.profile);
  assert.equal(u13.originalProducerRules.length, 48);
  assert.equal(u13.capturedOriginalNotices.length, 5);
  return catalog;
}

export async function loadCProducerProfile(name) {
  assert.ok(
    ["gcc-12", "glibc", "glibc-u13"].includes(name),
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
    profileKey: name,
    profile: catalog.profiles[name],
    catalogSha256: sha256(bytes),
  };
}
