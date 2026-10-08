import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const callback = new URL(
  "../dist/test/review-context-limits.test.js",
  import.meta.url,
);
const originalCallback = await readFile(callback);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const controls = [
  {
    id: "combined-source-reconstruction-bound",
    file: "review.js",
    name: "expanded context rejects the first combined source byte beyond one MiB during capture and reconstruction",
    before: "bytes > (parsed.schemaVersion === 7 ? 1048576 : 131072)",
    after: "false",
  },
  {
    id: "per-file-utf8-reconstruction-bound",
    file: "review.js",
    name: "expanded context keeps per-file UTF-8 byte limits exact while admitting valid multibyte source",
    before: "content.length > 65536 || hash(content) !== file.sha256",
    after: "hash(content) !== file.sha256",
  },
  {
    id: "shared-selected-path-accounting",
    file: "review.js",
    name: "expanded context accepts exactly 32 selected paths and one MiB of source with complete syntax and disposition accounting",
    before: "selected: declaredScope.size",
    after: "selected: 16",
  },
];
const environment = { ...process.env };
delete environment.NODE_TEST_CONTEXT;
function run(name) {
  const pattern = "^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern",
      pattern,
      fileURLToPath(callback),
    ],
    {
      cwd: repository,
      env: environment,
      encoding: "utf8",
      timeout: 45000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stdout + result.stderr);
  return result;
}
const evidence = [];
for (const control of controls) {
  const source = new URL("../dist/src/" + control.file, import.meta.url);
  const original = await readFile(source, "utf8");
  const baseline = run(control.name);
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  assert.equal(
    original.split(control.before).length,
    2,
    "Exact control address: " + control.id,
  );
  const mutant = original.replace(control.before, control.after);
  try {
    await writeFile(source, mutant);
    const compile = spawnSync(
      process.execPath,
      ["--check", fileURLToPath(source)],
      { encoding: "utf8" },
    );
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const result = run(control.name);
    assert.equal(
      result.status,
      1,
      "Original assertion must kill " +
        control.id +
        "\n" +
        result.stdout +
        result.stderr,
    );
    assert.match(result.stdout, /ERR_ASSERTION/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /SyntaxError|TypeError|ReferenceError/,
    );
    assert.ok(result.stdout.includes("not ok 1 - " + control.name));
    assert.deepEqual(
      await readFile(callback),
      originalCallback,
      "Original callback changed",
    );
    evidence.push({
      id: control.id,
      callback: control.name,
      callbackSha256: digest(originalCallback),
      sourceSha256: digest(original),
      mutantSha256: digest(mutant),
      originalPassed: true,
      mutantCompiled: true,
      mutantFailedAssertion: true,
    });
  } finally {
    await writeFile(source, original);
  }
  const restored = run(control.name);
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  evidence.at(-1).restoredPassed = true;
}
process.stdout.write(
  JSON.stringify({
    scope:
      "Original synthetic expanded-context controls; no model inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
