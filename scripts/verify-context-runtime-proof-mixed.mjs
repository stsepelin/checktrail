import assert from "node:assert/strict";
import process from "node:process";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const repo = process.env.CHECKTRAIL_CONTEXT_TARGET_ROOT ?? sourceRoot;
assert.ok(path.isAbsolute(repo));
const { createReviewContext, parseReviewContext } = await import(
  pathToFileURL(path.join(repo, "dist/src/review.js")).href
);
const { syntheticSyntaxSources } = await import(
  pathToFileURL(path.join(sourceRoot, "dist/test/review-polyglot-fixture.js"))
    .href
);
const root = await mkdtemp(
  path.join(await realpath(tmpdir()), "context-mixed-boundary-"),
);
try {
  for (const [file, content] of Object.entries(syntheticSyntaxSources))
    await writeFile(path.join(root, file), content);
  await writeFile(
    path.join(root, "entry.vb"),
    "Module Entry\nFunction Assign(value As Integer) As Integer\nReturn value + 1\nEnd Function\nEnd Module\n",
  );
  const result = await createReviewContext(root, {
    schemaVersion: 19,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["entry.vb"],
    supportFiles: Object.keys(syntheticSyntaxSources),
    topics: [],
    moduleRoots: ["."],
  });
  assert.equal(result.schemaVersion, 19);
  assert.equal(result.analysis.grammarBindings.length, 17);
  assert.equal(result.analysis.files.length, 17);
  assert.equal(result.analysis.state, "collected");
  assert.equal(
    Boolean(result.analysis.runtimeArtifactProof),
    Boolean(process.env.CHECKTRAIL_CONTEXT_RELEASE_PROOF),
  );
  assert.equal(parseReviewContext(result).analysis.grammarBindings.length, 17);
  process.stdout.write(
    JSON.stringify({
      state: process.env.CHECKTRAIL_CONTEXT_RELEASE_PROOF
        ? "passed-qualified-vb-mixed-boundary"
        : "passed-legacy-vb-mixed-boundary",
      documents: 17,
      grammars: 17,
      independentFinal: true,
      modelCalls: 0,
    }) + "\n",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
