import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import process from "node:process";
import {
  vbGrammarAsset,
  vbGrammarManifestDigest,
} from "../dist/src/review-vb-grammar-assets.js";
const root = fileURLToPath(new URL("../", import.meta.url)),
  directory = path.join(root, "assets/context-vb-grammar"),
  hash = (b) => createHash("sha256").update(b).digest("hex");
const manifestBytes = await readFile(path.join(directory, "manifest.json"));
assert.equal(hash(manifestBytes), vbGrammarManifestDigest);
const manifest = JSON.parse(manifestBytes);
assert.deepEqual(manifest, {
  schemaVersion: 1,
  profile: "vb-selected-bindings-v1",
  runtime: "web-tree-sitter@0.27.0",
  asset: vbGrammarAsset,
});
const build = JSON.parse(
  await readFile(
    path.join(root, "docs/measurements/vb-grammar-build-2026-10-09.json"),
    "utf8",
  ),
);
assert.equal(build.grammarManifestSha256, vbGrammarManifestDigest);
assert.deepEqual(build.asset, vbGrammarAsset);
assert.equal(
  build.sourceRepository,
  "https://github.com/govindbanura/tree-sitter-vbnet",
);
assert.equal(build.sourceCommit, vbGrammarAsset.sourceCommit);
assert.equal(
  build.sourceArchive.url,
  build.sourceRepository.replace(
    "https://github.com/",
    "https://codeload.github.com/",
  ) +
    "/tar.gz/" +
    build.sourceCommit,
);
assert.equal(
  build.sourceArchive.sha256,
  "9343fd4bf9a2857555921167d002e558f5024223ecc35209f0834a1539a13f60",
);
assert.equal(build.sourceArchive.bytes, 241760);
assert.equal(build.upstreamPackageLicenseField, "ISC");
assert.equal(build.distributedSourceLicense, "MIT");
assert.equal(build.unusedUpstreamBinaryArtifactsImported, false);
assert.equal(build.grammarPreparedBeforeCapture, true);
assert.equal(build.projectCodeExecutedDuringCapture, false);
assert.equal(build.buildToolNoticeClosureVerified, false);
assert.equal(build.gateAComplete, false);
const wasm = await readFile(path.join(directory, vbGrammarAsset.file));
assert.equal(hash(wasm), vbGrammarAsset.sha256);
assert.equal(wasm.length, vbGrammarAsset.bytes);
assert.doesNotThrow(() => new globalThis.WebAssembly.Module(wasm));
for (const record of [build.notice, build.patch]) {
  assert.match(
    record.file,
    /^assets\/context-vb-grammar\/(?:notices\/vbnet-MIT\.txt|patches\/vbnet-newlines\.patch)$/,
  );
  const bytes = await readFile(path.join(root, record.file));
  assert.equal(hash(bytes), record.sha256);
  if (record.bytes !== undefined) assert.equal(bytes.length, record.bytes);
}
const license = await readFile(path.join(root, build.notice.file), "utf8");
assert.match(license, /MIT License/);
assert.match(license, /Copyright \(c\) 2025 Govind Banura/);
assert.match(license, /Permission is hereby granted/);
const actual = [];
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
      actual.push(file);
    }
  }
}
await visit();
assert.deepEqual(
  actual.sort(),
  [
    "manifest.json",
    "notices/vbnet-MIT.txt",
    "patches/vbnet-newlines.patch",
    vbGrammarAsset.file,
  ].sort(),
);
const packageManifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
assert.ok(packageManifest.files.includes("assets/context-vb-grammar"));
process.stdout.write(
  JSON.stringify({
    scope: "supplemental-vb-parser-artifact-bindings",
    artifactBindingsComplete: true,
    wasmBytes: wasm.length,
    manifestSha256: vbGrammarManifestDigest,
    sourceNoticeVerified: true,
    buildToolNoticeClosureVerified: false,
    semanticContextComplete: false,
    gateAComplete: false,
    inferenceInvoked: false,
  }) + "\n",
);
