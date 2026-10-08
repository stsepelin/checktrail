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
assert.deepEqual(manifest.runtime.files, grammarRuntimeAssets);
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
const requiredFiles = new Set(["manifest.json"]);
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
assert.equal(lock.packages["node_modules/web-tree-sitter"].version, "0.27.0");
process.stdout.write(
  JSON.stringify({
    scope: "selected-parser-artifact-bindings",
    artifactBindingsComplete: true,
    grammars: grammarAssets.length,
    wasmBytes: bytes,
    runtime: "web-tree-sitter@0.27.0",
    manifestSha256: grammarManifestDigest,
    buildToolNoticeClosureVerified: build.buildToolNoticeClosureVerified,
    semanticContextComplete: false,
    gateAComplete: false,
    inferenceInvoked: false,
  }) + "\n",
);
