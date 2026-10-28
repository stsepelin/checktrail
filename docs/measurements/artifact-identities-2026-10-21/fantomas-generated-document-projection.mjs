// Original read-only byte projection. Neither MSBuild nor target assemblies run.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const root = fileURLToPath(new URL("./", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function read(name, expected) {
  assert.ok(
    typeof name === "string" && name.length <= 512 && !/[\\:\0]/u.test(name),
  );
  assert.ok(
    name.split("/").every((part) => part && part !== "." && part !== ".."),
  );
  const target = path.join(root, name);
  assert.equal(realpathSync(target), target);
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 2 * 1048576);
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    assert.equal(length, stat.size);
    const bytes = buffer.subarray(0, length);
    if (expected) {
      assert.equal(bytes.length, expected.bytes);
      assert.equal(hash(bytes), expected.sha256);
      if (expected.gitBlobSha1)
        assert.equal(
          createHash("sha1")
            .update("blob " + bytes.length + "\0")
            .update(bytes)
            .digest("hex"),
          expected.gitBlobSha1,
        );
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}
const manifestName = "fantomas-sdk-generated-documents.inputs.json";
const manifestBytes = read(manifestName);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.retainedInputs.length, 6);
const inputs = new Map();
for (const ref of manifest.retainedInputs) {
  assert.equal(inputs.has(ref.role), false);
  inputs.set(ref.role, read(ref.file, ref));
}
const xmlEntities = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
function project(template, version, newline = "\r\n") {
  const candidates = [
    ...template.matchAll(
      /<AdditionalSourcesText Condition="[^"]*">([\s\S]*?)<\/AdditionalSourcesText>/g,
    ),
  ].filter((m) => m[1].includes("TargetFrameworkAttribute"));
  assert.equal(candidates.length, 1);
  let text = candidates[0][1].replace(
    /&(lt|gt|quot|apos|amp);/g,
    (_all, key) => xmlEntities[key],
  );
  text = text
    .replaceAll("$(AdditionalSourcesText)", "")
    .replaceAll("$(TargetFrameworkMoniker)", ".NETStandard,Version=v" + version)
    .replaceAll(
      "$(TargetFrameworkMonikerDisplayName)",
      ".NET Standard " + version,
    )
    .trim();
  assert.equal(text.includes("$("), false);
  return Buffer.from(
    text.replaceAll("\r\n", "\n").replaceAll("\n", newline) + newline,
    "utf8",
  );
}
const observation = JSON.parse(inputs.get("debug-documents").toString("utf8"));
const documents = [],
  controls = [],
  unique = new Set();
for (const artifact of observation.artifacts) {
  for (const doc of artifact.debugDocuments) {
    if (!["unresolved", "unresolved-generated-document"].includes(doc.state))
      continue;
    const match =
      /\.NETStandard,Version=v(2\.[01])\.AssemblyAttributes\.fs$/.exec(
        doc.sourceMember,
      );
    assert.ok(match);
    const version = match[1],
      role =
        artifact.assembly === "FSharp.Core.dll"
          ? "core-targets"
          : "fcs-targets";
    const template = inputs.get(role).toString("utf8");
    const original = project(template, version),
      check = (bytes) => assert.equal(hash(bytes), doc.declaredDocumentHash);
    check(original);
    documents.push({
      assembly: artifact.assembly,
      assemblySha256: artifact.sha256,
      sourceMember: doc.sourceMember,
      templateRole: role,
      framework: version,
      frameworkDisplayName: ".NET Standard " + version,
      projectedBytes: original.length,
      projectedSha256: hash(original),
      declaredDocumentHash: doc.declaredDocumentHash,
      projectionMatchesRetainedChecksum: true,
    });
    if (unique.has(version)) continue;
    unique.add(version);
    for (const [id, mutant] of [
      [
        "changed-namespace",
        project(
          template.replace(
            "namespace Microsoft.BuildSettings",
            "namespace Original.GeneratedSettings",
          ),
          version,
        ),
      ],
      ["lf-instead-of-crlf", project(template, version, "\n")],
    ]) {
      assert.notDeepEqual(mutant, original);
      assert.throws(() => check(mutant), { code: "ERR_ASSERTION" });
      check(project(template, version));
      controls.push({
        id,
        framework: version,
        changedProjectionSha256: hash(mutant),
        unchangedPdbChecksumAssertionRejectedChange: true,
        restoredProjectionMatched: true,
      });
    }
  }
}
assert.deepEqual(documents.map((x) => x.assembly).sort(), [
  "FSharp.Core.dll",
  "Fantomas.Core.dll",
  "Fantomas.FCS.dll",
]);
assert.equal(unique.size, 2);
assert.equal(controls.length, 4);
assert.notEqual(documents[0].projectedSha256, documents[1].projectedSha256);
const ownName = path.basename(fileURLToPath(import.meta.url));
const own = read(ownName);
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    observedAt: "2026-10-27",
    scope:
      "Original byte projection of three retained portable-debug checksums using pinned public F# template candidates. This does not identify or execute the actual producer SDK or evaluate a build.",
    retainedInputs: [
      {
        file: manifestName,
        bytes: manifestBytes.length,
        sha256: hash(manifestBytes),
      },
      { file: ownName, bytes: own.length, sha256: hash(own) },
    ],
    projection: {
      additionalSourcesTextInitiallyEmpty: true,
      templatePropertyTrimmed: true,
      explicitFrameworkAndDisplayNameSubstitutions: true,
      newlines: "CRLF",
      utf8Bom: false,
      finalNewline: true,
      writerSourceInspectedForAppendLineAndDefaultEncoding: true,
    },
    documents,
    uniqueProjectedContents: unique.size,
    pairedControls: controls,
    targetAssembliesReinspected: false,
    nativeMsbuildGeneratorExecuted: false,
    actualProducerSdkVerified: false,
    completeCompilerInputInventory: false,
    sourceBuildVerified: false,
    completeArtifactAndNoticeClosureVerified: false,
    preparationAndReceiptIntegrationVerified: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
    gateAComplete: false,
  }) + "\n",
);
