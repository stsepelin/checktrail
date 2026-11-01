// One explicit retained-byte binding. This creates no filesystem alias or legal/source-coverage conclusion.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const originalNoticeSha256 =
  "3a29d0e487eae553ec47f260be1570a0d96e4f28c21f29ef58a14cd3d53147ff";
const associations = [
  {
    archiveSha256:
      "78da3f494109f6e7a39c4626aaae7571c600c5854cecda0bc0c902224986a63b",
    archiveBytes: 47384,
    package: "libpangoft2-1.0-0",
    version: "1.50.12+ds-1",
    architecture: "amd64",
    sourcePackage: "pango1.0",
    noticeMember: "usr/share/doc/libpangoft2-1.0-0/copyright",
  },
  {
    archiveSha256:
      "851720de07441ae6bb6a7f51fc0f2edb4db7aa6f25b5bf1bf7b72dcab8947b7f",
    archiveBytes: 211788,
    package: "libpango-1.0-0",
    version: "1.50.12+ds-1",
    architecture: "amd64",
    sourcePackage: "pango1.0",
    noticeMember: "usr/share/doc/libpango-1.0-0/copyright",
  },
  {
    archiveSha256:
      "96695f9cdd3bf346e3555cf0aa158e23a36114d6dec203b00ab4e93f1b77aab9",
    archiveBytes: 34184,
    package: "libpangocairo-1.0-0",
    version: "1.50.12+ds-1",
    architecture: "amd64",
    sourcePackage: "pango1.0",
    noticeMember: "usr/share/doc/libpangocairo-1.0-0/copyright",
  },
];
const expected = {
  kind: "explicit-alternative-complete-text-bytes",
  sourceNoticeSha256: originalNoticeSha256,
  sourceNoticeBytes: 20917,
  byteOffset: 8550,
  literalPath: "/usr/share/common-licenses/GPL-2.0",
  sourceParagraph: {
    startByte: 7935,
    endByteExclusive: 8587,
    bytes: 652,
    sha256: "28c25ebc4e464049e0a875feb1d1cf30d5d8e7bdbc82e663ce68e54e9806e810",
  },
  originalStatus: "unresolved-literal-reference",
  literalReferenceResolved: false,
  targetCapture: {
    image:
      "docker.io/coqorg/coq@sha256:1f69b9224f068d408e6be7a3f536f67395d00c3497b97bdb99ee2d2c4c91954c",
    imagePath: "/usr/share/common-licenses/GPL-2",
    bytes: 18092,
    sha256: "8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643",
  },
  archiveAssociations: associations,
  pathAliasCreated: false,
  legalInterpretationAssessed: false,
  originalSourceFileCoverageAssessed: false,
  completeOriginalNoticeClosureVerified: false,
  fullCompilerSdkBootstrapClosureVerified: false,
  gateAComplete: false,
};
export function inspectPangoCompleteTextBinding(
  notices,
  originalNotices,
  literalRows,
) {
  const declared = notices.explicitAlternativeCompleteTextBindings;
  assert.deepEqual(
    declared,
    [expected],
    "Pango alternative binding differs from its exact closed source/paragraph/target/association contract",
  );
  const binding = declared[0];
  assert.equal(notices.image, binding.targetCapture.image);
  for (const field of [
    "sourceEmbeddedNoticesComplete",
    "completeOriginalNoticeClosureVerified",
    "fullCompilerSdkBootstrapClosureVerified",
    "gateAComplete",
  ])
    assert.equal(
      notices[field],
      false,
      "Pango alternative bytes cannot promote broader closure",
    );
  const raw = originalNotices.get(binding.sourceNoticeSha256);
  assert.ok(Buffer.isBuffer(raw));
  assert.equal(raw.length, binding.sourceNoticeBytes);
  assert.equal(
    hash(raw),
    binding.sourceNoticeSha256,
    "Pango original source notice bytes changed",
  );
  const token = Buffer.from(binding.literalPath, "ascii");
  assert.deepEqual(
    raw.subarray(binding.byteOffset, binding.byteOffset + token.length),
    token,
    "Pango original literal offset/path changed",
  );
  const { startByte, endByteExclusive, bytes, sha256 } =
      binding.sourceParagraph,
    paragraph = raw.subarray(startByte, endByteExclusive);
  assert.equal(paragraph.length, bytes);
  assert.equal(hash(paragraph), sha256, "Pango source paragraph bytes changed");
  assert.equal(
    raw.lastIndexOf(Buffer.from("\n\n"), binding.byteOffset) + 2,
    startByte,
  );
  assert.equal(
    raw.indexOf(Buffer.from("\n\n"), binding.byteOffset) + 1,
    endByteExclusive,
  );
  assert.deepEqual(
    literalRows.filter(
      (row) =>
        row[0] === binding.sourceNoticeSha256 && row[1] === binding.byteOffset,
    ),
    [
      [
        binding.sourceNoticeSha256,
        binding.byteOffset,
        binding.literalPath,
        binding.literalPath,
        false,
        "unresolved-literal-reference",
        null,
        null,
      ],
    ],
    "Pango original literal reference must stay unresolved",
  );
  const captured = notices.pinnedBaselineSharedLicenseFiles.filter(
    (row) => row.imagePath === binding.targetCapture.imagePath,
  );
  assert.equal(captured.length, 1);
  assert.equal(captured[0].symlinkTarget, null);
  assert.equal(captured[0].bytes, binding.targetCapture.bytes);
  assert.equal(captured[0].sha256, binding.targetCapture.sha256);
  assert.equal(
    notices.pinnedBaselineSharedLicenseFiles.some(
      (row) => row.imagePath === binding.literalPath,
    ),
    false,
    "Pango missing original path cannot be supplied by an alias",
  );
  const target = originalNotices.get(binding.targetCapture.sha256);
  assert.ok(Buffer.isBuffer(target));
  assert.equal(target.length, binding.targetCapture.bytes);
  assert.equal(
    hash(target),
    binding.targetCapture.sha256,
    "Pango captured complete text bytes changed",
  );
  const actual = [];
  for (const archive of notices.uniqueArchives)
    for (const document of archive[7])
      if (document.sha256 === binding.sourceNoticeSha256) {
        assert.equal(document.bytes, binding.sourceNoticeBytes);
        actual.push({
          archiveSha256: archive[0],
          archiveBytes: archive[1],
          package: archive[2],
          version: archive[3],
          architecture: archive[4],
          sourcePackage: archive[5],
          noticeMember: document.archiveMember,
        });
      }
  actual.sort((a, b) => a.archiveSha256.localeCompare(b.archiveSha256));
  assert.deepEqual(
    actual,
    binding.archiveAssociations,
    "Pango original notice archive associations changed",
  );
  return {
    bindings: 1,
    sourceNoticeObjects: 1,
    literalReferences: 1,
    associatedArchives: actual.length,
    completeCapturedTextBytesVerified: true,
    originalLiteralReferenceResolved: false,
    pathAliasCreated: false,
    legalInterpretationAssessed: false,
    originalSourceFileCoverageAssessed: false,
    completeOriginalNoticeClosureVerified: false,
    fullCompilerSdkBootstrapClosureVerified: false,
    gateAComplete: false,
  };
}
