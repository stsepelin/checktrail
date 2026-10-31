import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import process from "node:process";
import {
  grammarAssets,
  grammarManifestDigest,
  grammarRuntimeAssets,
  grammarRuntimeVersion,
  grammarRuntimeManifestDigest,
} from "../dist/src/review-grammar-assets.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const directory = path.join(root, "assets/context-grammars");
const manifestBytes = await readFile(path.join(directory, "manifest.json"));
assert.equal(hash(manifestBytes), grammarManifestDigest);
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.runtime.package, "web-tree-sitter");
assert.equal(manifest.runtime.version, "0.27.0");
assert.deepEqual(manifest.grammars, grammarAssets);
const runtimeBytes = await readFile(
  path.join(directory, "runtime-manifest.json"),
);
assert.equal(hash(runtimeBytes), grammarRuntimeManifestDigest);
const runtime = JSON.parse(runtimeBytes);
assert.equal(runtime.schemaVersion, 1);
assert.equal(runtime.package, "web-tree-sitter");
assert.equal(runtime.version, grammarRuntimeVersion);
assert.equal(runtime.grammarBuildManifestSHA256, grammarManifestDigest);
assert.deepEqual(runtime.files, grammarRuntimeAssets);
const build = JSON.parse(
  await readFile(
    path.join(root, "docs/measurements/context-grammar-build-2026-10-08.json"),
    "utf8",
  ),
);
assert.equal(build.grammarManifestSHA256, grammarManifestDigest);
const plan = JSON.parse(
  await readFile(path.join(root, "docs/gate-a-profiles.v1.json"), "utf8"),
);
const requiredFiles = new Set(["manifest.json", "runtime-manifest.json"]);
let bytes = 0;
for (const asset of grammarAssets) {
  assert.match(asset.file, /^tree-sitter-[a-z_]+\.wasm$/);
  requiredFiles.add(asset.file);
  const actual = await readFile(path.join(directory, asset.file));
  assert.equal(hash(actual), asset.sha256);
  assert.equal(actual.length, asset.bytes);
  bytes += actual.length;
  assert.doesNotThrow(() => new globalThis.WebAssembly.Module(actual));
  const record = build.grammars.find(
    (record) => record.grammar === asset.grammar,
  );
  assert.ok(record);
  assert.equal(record.wasmSha256, asset.sha256);
  assert.equal(record.wasmBytes, asset.bytes);
  const pin = plan.contextGrammarPins.find(
    (pin) => pin.repository === record.sourceRepository,
  );
  assert.ok(pin);
  assert.equal(record.sourceCommit, pin.commit);
  assert.equal(asset.sourceCommit, pin.commit);
  assert.equal(
    record.sourceArchive.url,
    pin.repository.replace(
      "https://github.com/",
      "https://codeload.github.com/",
    ) +
      "/tar.gz/" +
      pin.commit,
  );
  assert.match(record.sourceArchive.sha256, /^[a-f0-9]{64}$/);
  assert.ok(record.sourceArchive.bytes > 0);
  for (const [file, digest] of Object.entries(record.sourceFiles)) {
    assert.ok(!file.startsWith("/") && !file.split("/").includes(".."));
    assert.match(digest, /^[a-f0-9]{64}$/);
  }
  assert.ok(record.notices.length > 0);
  for (const notice of record.notices) {
    assert.match(
      notice.distributedNotice,
      /^assets\/context-grammars\/notices\/[a-z_]+-\d+\.txt$/,
    );
    const relative = notice.distributedNotice.slice(
      "assets/context-grammars/".length,
    );
    requiredFiles.add(relative);
    const actual = await readFile(path.join(root, notice.distributedNotice));
    assert.equal(hash(actual), notice.sha256);
    assert.equal(actual.length, notice.bytes);
  }
  for (const patch of record.patches ?? []) {
    assert.match(
      patch.file,
      /^assets\/context-grammars\/patches\/[a-z-]+\.patch$/,
    );
    requiredFiles.add(patch.file.slice("assets/context-grammars/".length));
    assert.equal(
      hash(await readFile(path.join(root, patch.file))),
      patch.sha256,
    );
  }
}
assert.equal(
  new Set(build.grammars.map((record) => record.grammar)).size,
  grammarAssets.length,
);
const actualFiles = [];
async function visit(relative = "") {
  for (const entry of await readdir(path.join(directory, relative), {
    withFileTypes: true,
  })) {
    const file = path.posix.join(relative, entry.name);
    assert.equal(
      await realpath(path.join(directory, file)),
      path.join(directory, file),
    );
    if (entry.isDirectory()) await visit(file);
    else {
      assert.ok(entry.isFile());
      actualFiles.push(file);
    }
  }
}
await visit();
assert.deepEqual(actualFiles.sort(), [...requiredFiles].sort());
const runtimeDirectory = fileURLToPath(
  new URL(".", import.meta.resolve("web-tree-sitter")),
);
for (const [name, pin] of Object.entries(grammarRuntimeAssets)) {
  const actual = await readFile(path.join(runtimeDirectory, name));
  assert.equal(hash(actual), pin.sha256);
  assert.equal(actual.length, pin.bytes);
}
const lock = JSON.parse(
  await readFile(path.join(root, "package-lock.json"), "utf8"),
);
assert.equal(
  lock.packages["node_modules/web-tree-sitter"].version,
  grammarRuntimeVersion,
);
const upgradeDirectory = path.join(
  root,
  "docs/measurements/context-runtime-0.27.1-2026-10-30",
);
const upgrade = JSON.parse(
  await readFile(path.join(upgradeDirectory, "observation.json"), "utf8"),
);
assert.equal(upgrade.schemaVersion, 1);
assert.equal(upgrade.scope, "selected-context-runtime-upgrade");
assert.equal(upgrade.runtimeManifestSHA256, grammarRuntimeManifestDigest);
assert.equal(upgrade.grammarBuildManifestSHA256, grammarManifestDigest);
assert.equal(upgrade.runtimeVersion, grammarRuntimeVersion);
assert.equal(upgrade.previousRuntimeVersion, manifest.runtime.version);
assert.equal(
  upgrade.npm.url,
  lock.packages["node_modules/web-tree-sitter"].resolved,
);
assert.equal(
  upgrade.npm.integrity,
  lock.packages["node_modules/web-tree-sitter"].integrity,
);
for (const flag of [
  "grammarBinariesRebuilt",
  "runtimeProducerBuildClosureVerified",
  "conditionalMuslOutputMembershipVerified",
  "completeArtifactAndNoticeClosureVerified",
  "gateAComplete",
  "inferenceInvoked",
])
  assert.equal(upgrade[flag], false);
const verification = await readFile(
  path.join(upgradeDirectory, "attestation-verified.json"),
);
assert.equal(upgrade.attestation.verificationFile, "attestation-verified.json");
assert.equal(hash(verification), upgrade.attestation.sha256);
assert.equal(verification.length, upgrade.attestation.bytes);
const verified = JSON.parse(verification);
assert.equal(verified.length, 1);
const certificate = verified[0].verificationResult.signature.certificate;
assert.equal(
  certificate.sourceRepositoryURI,
  "https://github.com/tree-sitter/tree-sitter",
);
assert.equal(certificate.sourceRepositoryDigest, upgrade.sourceArchive.commit);
assert.equal(certificate.sourceRepositoryRef, "refs/tags/v0.27.1");
assert.equal(
  certificate.subjectAlternativeName,
  "https://github.com/tree-sitter/tree-sitter/.github/workflows/release.yml@refs/tags/v0.27.1",
);
assert.equal(certificate.runnerEnvironment, "github-hosted");
assert.ok(
  verified[0].verificationResult.statement.subject.some(
    (subject) =>
      subject.name === "web-tree-sitter.tar.gz" &&
      subject.digest.sha256 === upgrade.releaseArchive.sha256,
  ),
);
for (const notice of upgrade.notices) {
  assert.match(
    notice.retainedFile,
    /^docs\/measurements\/artifact-identities-2026-10-21\/tree-sitter-(?:LICENSE|Unicode-LICENSE|conditional-musl-LICENSE)\.txt$/,
  );
  const actual = await readFile(path.join(root, notice.retainedFile));
  assert.equal(hash(actual), notice.sha256);
  assert.equal(actual.length, notice.bytes);
}
assert.deepEqual(
  upgrade.notices.map((n) => n.sourceMember).sort(),
  [
    "LICENSE",
    "lib/src/unicode/LICENSE",
    "lib/src/wasm-stdlib/libc/LICENSE",
  ].sort(),
);
process.stdout.write(
  JSON.stringify({
    scope: "selected-parser-artifact-bindings",
    artifactBindingsComplete: true,
    grammars: grammarAssets.length,
    wasmBytes: bytes,
    runtime: "web-tree-sitter@" + grammarRuntimeVersion,
    runtimeManifestSha256: grammarRuntimeManifestDigest,
    runtimeProducerBuildClosureVerified: false,
    manifestSha256: grammarManifestDigest,
    buildToolNoticeClosureVerified: build.buildToolNoticeClosureVerified,
    semanticContextComplete: false,
    gateAComplete: false,
    inferenceInvoked: false,
  }) + "\n",
);
