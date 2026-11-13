import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  realpath,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
const root =
  process.env.CHECKTRAIL_CONTEXT_TARGET_ROOT ??
  fileURLToPath(new URL("../", import.meta.url));
assert.ok(path.isAbsolute(root));
const require = createRequire(path.join(root, "package.json"));
const runtimePackage = path.dirname(require.resolve("web-tree-sitter"));
const dependencies = path.dirname(runtimePackage);
assert.equal(path.basename(dependencies), "node_modules");
const owned = await mkdtemp(
  path.join(await realpath(tmpdir()), "context-cache-guard-"),
);
const app = path.join(owned, "app");
let parser, originalParse, asset, originalBytes;
try {
  await mkdir(app);
  await cp(path.join(root, "dist/src"), path.join(app, "dist/src"), {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  });
  await cp(path.join(root, "assets"), path.join(app, "assets"), {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  });
  await writeFile(path.join(app, "package.json"), '{"type":"module"}\n');
  await symlink(dependencies, path.join(app, "node_modules"), "dir");
  const { createReviewContext } = await import(
    pathToFileURL(path.join(app, "dist/src/review.js")).href
  );
  const fixture = path.join(owned, "source");
  await mkdir(fixture);
  await writeFile(
    path.join(fixture, "first.py"),
    "def first(value):\n    return value + 1\n",
  );
  await writeFile(
    path.join(fixture, "second.py"),
    "def second(value):\n    return value * 2\n",
  );
  const selection = {
    schemaVersion: 6,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["first.py", "second.py"],
    supportFiles: [],
    topics: [],
  };
  const warm = await createReviewContext(fixture, selection);
  assert.equal(warm.analysis.state, "collected");
  assert.equal(warm.analysis.files.length, 2);
  assert.ok(warm.analysis.runtimeArtifactProof);
  asset = path.join(app, "assets/context-grammars/tree-sitter-python.wasm");
  originalBytes = await readFile(asset);
  const changed = Buffer.from(originalBytes);
  changed[0] ^= 1;
  parser = (
    await import(
      pathToFileURL(path.join(runtimePackage, "web-tree-sitter.js")).href
    )
  ).Parser;
  originalParse = parser.prototype.parse;
  let parseCalls = 0;
  parser.prototype.parse = function (...args) {
    parseCalls++;
    if (parseCalls === 1) writeFileSyncRestore();
    return originalParse.apply(this, args);
  };
  // The synchronous native parse boundary restores only this owned asset; no AST is stubbed.
  const { writeFileSync } = await import("node:fs");
  function writeFileSyncRestore() {
    writeFileSync(asset, originalBytes);
  }
  await writeFile(asset, changed);
  let state = "inconclusive";
  try {
    state = (await createReviewContext(fixture, selection)).analysis.state;
  } catch {
    // A refused physical asset may stop collection before a partial context exists.
  }
  assert.notEqual(
    state,
    "collected",
    "Cached grammar change must be refused before native parse",
  );
  assert.equal(
    parseCalls,
    0,
    "Changed cached grammar must not reach native parser",
  );
  process.stdout.write(
    JSON.stringify({
      state: "passed-warm-cache-physical-guard",
      documents: 2,
      nativeParseCallsAfterCorruption: parseCalls,
      modelCalls: 0,
    }) + "\n",
  );
} finally {
  try {
    if (parser && originalParse) parser.prototype.parse = originalParse;
    if (asset && originalBytes) await writeFile(asset, originalBytes);
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
}
