import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2] ?? "passive",
  family = process.env.CHECKTRAIL_MUTATION_FAMILY;
assert.ok(["passive", "native"].includes(mode));
if (mode === "native")
  assert.ok(["vitest", "jest", "pytest", "phpunit"].includes(family));
const full = JSON.parse(
  await readFile(new URL("mutation-controls.json", import.meta.url), "utf8"),
);
assert.equal(new Set(full.map((d) => d.id)).size, full.length);
const definitions = full.filter(
  (d) => d.mode === mode && (mode !== "native" || d.families.includes(family)),
);
assert.ok(definitions.length > 0);
const originals = new Map(),
  hashes = new Map(),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const d of definitions) {
  if (!originals.has(d.file))
    originals.set(
      d.file,
      await readFile(path.join(repository, "dist/src", d.file), "utf8"),
    );
  assert.equal(originals.get(d.file).split(d.from).length, 2, d.id);
  const file = path.join(repository, "dist/test", d.testFile);
  if (!hashes.has(file)) hashes.set(file, hash(await readFile(file)));
}
const mirror = await mkdtemp(
  path.join(tmpdir(), "checktrail-mutation-guards-"),
);
const controls = [],
  baselines = new Set();
try {
  await cp(path.join(repository, "dist"), path.join(mirror, "dist"), {
    recursive: true,
  });
  await cp(
    path.join(repository, "package.json"),
    path.join(mirror, "package.json"),
  );
  await symlink(
    path.join(repository, "node_modules"),
    path.join(mirror, "node_modules"),
  );
  if (mode === "native")
    await symlink(
      path.join(repository, ".checktrail"),
      path.join(mirror, ".checktrail"),
    );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const invoke = (args) =>
    spawnSync(process.execPath, args, {
      cwd: mirror,
      env,
      encoding: "utf8",
      timeout: 300000,
      maxBuffer: 2 * 1048576,
    });
  const run = (d) =>
    invoke([
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern",
      "^" + escape(d.name) + "$",
      path.join(mirror, "dist/test", d.testFile),
    ]);
  const completed = (r, passed) => {
    assert.equal(r.error, undefined);
    assert.equal(r.signal, null);
    assert.equal(
      r.status,
      passed ? 0 : 1,
      r.stdout.slice(-2200) + r.stderr.slice(-1000),
    );
    for (const value of [
      "tests 1",
      "pass " + (passed ? 1 : 0),
      "fail " + (passed ? 0 : 1),
      "skipped 0",
      "cancelled 0",
    ])
      assert.match(r.stdout, new RegExp("^# " + value + "$", "m"));
    if (!passed) assert.match(r.stdout, /code: 'ERR_ASSERTION'/);
  };
  for (const d of definitions) {
    process.stderr.write(
      JSON.stringify({ mode, family, control: d.id }) + "\n",
    );
    const file = path.join(mirror, "dist/src", d.file),
      original = originals.get(d.file),
      mutant = original.replace(d.from, d.to);
    const key = d.testFile + ":" + d.name;
    if (!baselines.has(key)) {
      completed(run(d), true);
      baselines.add(key);
    }
    let nativeWitness;
    try {
      await writeFile(file, mutant);
      const syntax = invoke(["--check", file]);
      assert.equal(syntax.error, undefined);
      assert.equal(syntax.status, 0, syntax.stderr);
      const result = run(d);
      completed(result, false);
      if (d.witness) {
        const line = result.stdout
          .split("\n")
          .find((s) => s.startsWith("# checktrail-mutation-guard-witness: "));
        assert.ok(
          line,
          "Native guard must retain the actual completed native counts before its assertion",
        );
        nativeWitness = JSON.parse(
          line.slice("# checktrail-mutation-guard-witness: ".length),
        );
        assert.equal(nativeWitness.kind, d.witness);
        assert.equal(nativeWitness.family, family);
        assert.equal(nativeWitness.baselineTests.total, 2);
        assert.equal(nativeWitness.baselineTests.passed, 2);
        if (d.witness === "cohort" || d.witness === "teardown")
          assert.ok(nativeWitness.trialTests.failed > 0);
      }
    } finally {
      await writeFile(file, original);
    }
    completed(run(d), true);
    assert.equal(await readFile(file, "utf8"), original);
    controls.push({
      id: d.id,
      callback: d.name,
      originalPassed: true,
      mutantJavaScriptSyntaxChecked: true,
      mutantFailedAssertion: true,
      restoredPassed: true,
      originalSha256: hash(original),
      mutantSha256: hash(mutant),
      ...(nativeWitness ? { nativeWitness } : {}),
    });
  }
  for (const [file, original] of originals)
    assert.equal(
      await readFile(path.join(repository, "dist/src", file), "utf8"),
      original,
    );
  for (const [file, sha] of hashes)
    assert.equal(hash(await readFile(file)), sha);
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      profile: "mutation-runners",
      mode,
      ...(mode === "native" ? { family } : {}),
      controls,
      originalSourceUnchanged: true,
      callbacksUnchanged: true,
      allPaired: true,
      nativeInvocations: mode === "native",
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
    }) + "\n",
  );
} finally {
  await rm(mirror, { recursive: true, force: true });
}
