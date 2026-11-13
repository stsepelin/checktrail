import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
const root =
  process.env.CHECKTRAIL_CONTEXT_TARGET_ROOT ??
  fileURLToPath(new URL("../", import.meta.url));
assert.ok(path.isAbsolute(root));
const selected = process.env.CHECKTRAIL_CONTEXT_RELEASE_PROOF;
assert.match(selected ?? "", /^\/[^\n]+\/proof\.json#sha256=[a-f0-9]{64}$/);
const directory = await mkdtemp(
  path.join(await realpath(tmpdir()), "context-proof-authority-"),
);
try {
  await writeFile(
    path.join(directory, "first.py"),
    "def first(value):\n    return value + 1\n",
  );
  await writeFile(
    path.join(directory, "second.py"),
    "def second(value):\n    return value * 2\n",
  );
  const module = pathToFileURL(path.join(root, "dist/src/review.js")).href;
  const code = `
    import assert from 'node:assert/strict';
    const {createReviewContext,parseReviewContext} = await import(process.argv[1]);
    if (process.argv[3] === 'late') process.env.CHECKTRAIL_CONTEXT_RELEASE_PROOF = process.argv[4];
    const context = await createReviewContext(process.argv[2], {schemaVersion:6,track:'snapshot',currentSource:'working-tree',files:['first.py','second.py'],supportFiles:[],topics:[]});
    assert.equal(context.analysis.state,'collected');
    assert.equal(context.analysis.files.length,2);
    assert.equal(context.analysis.runtimeArtifactProof,undefined);
    assert.equal(parseReviewContext(context).analysis.runtimeArtifactProof,undefined);
    console.log(JSON.stringify({state:'legacy',documents:2}));
  `;
  for (const mode of ["absent", "blank", "late"]) {
    const env = { ...process.env };
    delete env.CHECKTRAIL_CONTEXT_RELEASE_PROOF;
    if (mode === "blank") env.CHECKTRAIL_CONTEXT_RELEASE_PROOF = "";
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", code, module, directory, mode, selected],
      { env, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, mode + ": " + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      state: "legacy",
      documents: 2,
    });
  }
  const malformed = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(process.argv[1]);`, module],
    {
      env: { ...process.env, CHECKTRAIL_CONTEXT_RELEASE_PROOF: "malformed" },
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(malformed.error, undefined);
  assert.equal(malformed.signal, null);
  assert.equal(malformed.status, 1);
  assert.match(
    malformed.stderr,
    /Malformed operator context-runtime proof selection/,
  );
  process.stdout.write(
    JSON.stringify({
      state: "passed-context-proof-authority",
      nativeLegacyContexts: 3,
      documentsPerContext: 2,
      lateAuthorityPromoted: false,
      malformedStartupRefused: true,
      modelCalls: 0,
    }) + "\n",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
