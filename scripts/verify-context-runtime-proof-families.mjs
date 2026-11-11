import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const root = process.env.CHECKTRAIL_CONTEXT_TARGET_ROOT ?? sourceRoot;
assert.ok(path.isAbsolute(root));
const api = await import(
  pathToFileURL(path.join(root, "dist/src/review-polyglot.js")).href
);
const { syntheticSyntaxSources } = await import(
  sourceRoot + "/dist/test/review-polyglot-fixture.js"
);
const { createReviewContext, parseReviewContext, receiveReview } = await import(
  pathToFileURL(path.join(root, "dist/src/review.js")).href
);
const { selectedContextRuntimeProof } = await import(
  pathToFileURL(path.join(root, "dist/src/context-runtime-proof.js")).href
);
const proof = selectedContextRuntimeProof();
assert.ok(proof);
const rows = [
  ["collectReviewPolyglotBehavior", "sample.py", "sample.fsi", undefined],
  ["collectReviewPythonBehavior", "sample.py", "sample.py", ["."]],
  ["collectReviewGoBehavior", "sample.go", "sample.go", ["."]],
  ["collectReviewPhpBehavior", "sample.php", "sample.php", ["."]],
  [
    "collectReviewRustBehavior",
    "sample.rs",
    "sample.rs",
    ["first.rs", "second.rs"],
  ],
  ["collectReviewJavaBehavior", "sample.java", "sample.java", ["."]],
  ["collectReviewKotlinBehavior", "sample.kt", "sample.kt", ["."]],
  ["collectReviewScalaBehavior", "sample.scala", "sample.scala", ["."]],
  ["collectReviewCsharpBehavior", "sample.cs", "sample.cs", ["."]],
  ["collectReviewFsharpBehavior", "sample.fs", "sample.fs", ["."]],
  ["collectReviewRubyBehavior", "sample.rb", "sample.rb", ["."]],
  [
    "collectReviewSwiftBehavior",
    "sample.swift",
    "sample.swift",
    [{ directory: ".", module: "ProofFixture" }],
  ],
  ["collectReviewVbBehavior", "sample.vb", "sample.vb", ["."]],
  ["collectReviewCBehavior", "sample.c", "sample.c", ["."]],
  ["collectReviewCppBehavior", "sample.cpp", "sample.cpp", ["."]],
  ["collectReviewHclBehavior", "sample.tf", "sample.tf", ["."]],
  ["collectReviewYamlBehavior", "sample.yaml", "sample.yaml", ["."]],
];
const grammars = new Set();
const results = [];
for (const [rowIndex, [name, first, second, roots]] of rows.entries()) {
  const files = [first, second].map((file, index) => {
    const content = (
      file === "sample.vb"
        ? "Module ProofFixture\nFunction Assign(value As Integer) As Integer\nReturn value + 1\nEnd Function\nEnd Module\n"
        : syntheticSyntaxSources[file]
    )
      .replaceAll("Sample", "Proof" + index)
      .replaceAll("sample", "proof" + index)
      .replaceAll("assign", "assign" + index)
      .replaceAll("submit", "submit" + index)
      .replaceAll("fallback", "fallback" + index);
    return {
      path: (index ? "second" : "first") + file.slice(file.lastIndexOf(".")),
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
  const result = await api[name](
    files,
    [],
    files.map((f) => f.path),
    false,
    ...(roots ? [roots] : []),
  );
  assert.equal(result.files.length, 2, name);
  assert.ok(
    result.files.every((row) => row.state === "collected"),
    name + ": " + JSON.stringify(result.files),
  );
  assert.deepEqual(result.runtimeArtifactProof, proof, name);
  for (const item of result.grammarBindings) grammars.add(item.grammar);
  const contextVersion = rowIndex === 0 ? 6 : rowIndex + 7;
  const directory = await mkdtemp(
    path.join(await realpath(tmpdir()), "context-proof-family-"),
  );
  try {
    for (const file of files)
      await writeFile(path.join(directory, file.path), file.content);
    const context = await createReviewContext(directory, {
      schemaVersion: contextVersion,
      track: "snapshot",
      currentSource: "working-tree",
      files: files.map((file) => file.path),
      supportFiles: [],
      topics: [],
      ...(roots
        ? { [contextVersion === 11 ? "crateRoots" : "moduleRoots"]: roots }
        : {}),
    });
    assert.equal(context.schemaVersion, contextVersion);
    assert.equal(context.analysis.state, "collected", name);
    assert.equal(context.analysis.files.length, 2);
    assert.ok(
      context.analysis.files.every((file) => file.state === "collected"),
      name,
    );
    assert.deepEqual(context.analysis.runtimeArtifactProof, proof, name);
    assert.deepEqual(
      parseReviewContext(context).analysis.runtimeArtifactProof,
      proof,
      name,
    );
    const receipt = await receiveReview(directory, context, {
      schemaVersion: 2,
      contextDigest: context.contextDigest,
      reviewer: { kind: "human", name: "synthetic-unreviewed-fixture" },
      createdAt: "2026-01-01T00:00:00Z",
      usage: {
        inputTokens: null,
        outputTokens: null,
        elapsedMs: null,
        costUSD: null,
      },
      files: files.map((file) => ({
        path: file.path,
        disposition: "not-reviewed",
        note: "Synthetic admission control; no review performed",
      })),
      observations: [],
    });
    assert.equal(receipt.freshness, "current", name);
    assert.equal(receipt.coverage.declaredNotReviewed, 2);
    assert.equal(receipt.coverage.declaredReviewed, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  results.push({
    api: name,
    contextVersion,
    finalReceiptPassed: true,
    profile: result.profile,
    files: result.files.length,
    grammars: result.grammarBindings.map((g) => g.grammar),
  });
}
assert.deepEqual(
  rows.map((row) => row[0]).sort(),
  Object.keys(api)
    .filter((name) => /^collectReview.*Behavior$/.test(name))
    .sort(),
  "Every exported parser family must retain qualified controls",
);
assert.deepEqual(
  results.map((row) => row.contextVersion),
  [6, ...Array.from({ length: 16 }, (_, index) => index + 8)],
);
const { grammarAssets } = await import(
  pathToFileURL(path.join(root, "dist/src/review-grammar-assets.js")).href
);
assert.equal(
  grammars.size,
  grammarAssets.length + 1,
  "Every current grammar including VB must participate",
);
process.stdout.write(
  JSON.stringify({
    state: "passed-all-qualified-parser-families",
    apis: results.length,
    finalReceipts: results.length,
    contextVersions: results.map((row) => row.contextVersion),
    files: results.reduce((sum, row) => sum + row.files, 0),
    uniqueGrammars: grammars.size,
    results,
    modelCalls: 0,
  }) + "\n",
);
