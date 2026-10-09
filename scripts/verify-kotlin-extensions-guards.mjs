import process from "node:process";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { createHash } from "node:crypto";
import { mixedKotlinFixture } from "../dist/test/kotlin-extensions-fixture.js";
import { createPlan, validate } from "../dist/src/engine.js";
const repository = fileURLToPath(new URL("../", import.meta.url));
const cleanups = [];
const fixture = await mixedKotlinFixture({
  after: (callback) => cleanups.push(callback),
});
const hash = (value) => createHash("sha256").update(value).digest("hex");
try {
  const planned = await createPlan(fixture.root);
  assert.equal(planned.plan.checks[0].commands.length, 1);
  const result = (
    await validate(fixture.root, { trusted: true, timeoutMs: 120000 })
  ).checks[0];
  assert.equal(result.status, "passed", JSON.stringify(result));
  const directory = path.join(fixture.root, ".checktrail/guards");
  await mkdir(directory);
  const receipt = path.join(directory, "receipt.json");
  await writeFile(
    receipt,
    JSON.stringify({
      root: fixture.root,
      check: planned.plan.checks[0],
      process: result.processes[0],
    }),
  );
  const source = path.join(repository, "dist/src/kotlin-extension-evidence.js");
  const original = await readFile(source, "utf8");
  const controls = [
    [
      "current-java-source",
      "current original Java bytes",
      [
        ["before.sha256 === kotlinHash(physical)", "true"],
        ["before.nativeSha256 === kotlinHash(native)", "true"],
      ],
    ],
    [
      "current-declaration",
      "current compiler declaration",
      [
        [
          "JSON.stringify(actualConfig) === JSON.stringify(planned.config)",
          "true",
        ],
      ],
    ],
    [
      "current-archive",
      "current archive bytes",
      [
        [
          "kotlinHash(kotlinReadSync(archive, 100 * 1024 * 1024)) === planned.config.sha256",
          "true",
        ],
      ],
    ],
    [
      "generator-input",
      "generator input",
      [
        [
          "observed.sourceSha256 === kotlinHash(original.get(generator.source))",
          "true",
        ],
      ],
    ],
    [
      "generated-class-name",
      "generated class name",
      [["witness.className === output.className", "true"]],
    ],
    [
      "generated-source-origin",
      "generated class source origin",
      [["witness.sourceFile === path.posix.basename(output.path)", "true"]],
    ],
    [
      "generated-class-hash",
      "generated physical class hash",
      [["physical?.sha256 === witness.sha256", "true"]],
    ],
    [
      "java-parse",
      "Java parse participation",
      [["parsed: z.literal(1)", "parsed: z.number().int().min(0).max(1)"]],
    ],
    [
      "java-target",
      "Java class target",
      [["c.classMajor === Number(planned.config.jvmTarget) + 44", "true"]],
    ],
    [
      "java-class-hash",
      "Java physical class hash",
      [["c.sha256 === physical.sha256", "true"]],
    ],
    [
      "java-suppression",
      "resolved Java suppression",
      [['!s.annotations.includes("java.lang.SuppressWarnings")', "true"]],
    ],
  ];
  const run = (suffix) => {
    const env = { ...process.env, CHECKTRAIL_KOTLIN_GUARD_RECEIPT: receipt };
    delete env.NODE_TEST_CONTEXT;
    const name = "mixed Kotlin guard checks " + suffix;
    const pattern = "^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-reporter=tap",
        "--test-name-pattern",
        pattern,
        path.join(
          repository,
          "dist/test/kotlin-extension-evidence-controls.test.js",
        ),
      ],
      { env, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1048576 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return { result, name };
  };
  const terminal = ({ result, name }, failed) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      result.stdout,
      new RegExp(
        "^" + (failed ? "not ok" : "ok") + " [0-9]+ - " + escaped + "$",
        "m",
      ),
    );
  };
  const evidence = [];
  for (const [id, name, substitutions] of controls) {
    const baseline = run(name);
    assert.equal(
      baseline.result.status,
      0,
      baseline.result.stdout + baseline.result.stderr,
    );
    terminal(baseline, false);
    let mutant = original;
    for (const [before, after] of substitutions) {
      const escaped = before
        .split(/\s+/)
        .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s+");
      const pattern = new RegExp(escaped, "g");
      assert.equal(
        [...mutant.matchAll(pattern)].length,
        1,
        "Exact mutation address: " + id,
      );
      mutant = mutant.replace(pattern, after);
    }
    try {
      await writeFile(source, mutant);
      const compiled = spawnSync(process.execPath, ["--check", source], {
        encoding: "utf8",
      });
      assert.equal(compiled.status, 0, compiled.stderr);
      const control = run(name);
      assert.equal(
        control.result.status,
        1,
        control.result.stdout + control.result.stderr,
      );
      terminal(control, true);
      assert.match(control.result.stdout, /ERR_ASSERTION/);
      evidence.push({
        id,
        name: control.name,
        originalPassed: true,
        mutantCompiled: true,
        mutantFailedAssertion: true,
        mutantSha256: hash(mutant),
        originalSha256: hash(original),
      });
    } finally {
      await writeFile(source, original);
    }
    const restored = run(name);
    assert.equal(
      restored.result.status,
      0,
      restored.result.stdout + restored.result.stderr,
    );
    terminal(restored, false);
    evidence.at(-1).restoredPassed = true;
  }
  const runtimeSource = path.join(
    repository,
    "dist/src/kotlin-extensions-runner.js",
  );
  const runtimeOriginal = await readFile(runtimeSource, "utf8");
  const runtimeName =
    "mixed Kotlin rejects generator changes to staged libraries and original observer classes";
  const runRuntime = () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-reporter=tap",
        "--test-name-pattern",
        "^" + runtimeName + "$",
        path.join(repository, "dist/test/kotlin-extension-regressions.test.js"),
      ],
      { env, encoding: "utf8", timeout: 180000, maxBuffer: 2 * 1048576 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return { result, name: runtimeName };
  };
  const runtimeBaseline = runRuntime();
  assert.equal(
    runtimeBaseline.result.status,
    0,
    runtimeBaseline.result.stdout + runtimeBaseline.result.stderr,
  );
  terminal(runtimeBaseline, false);
  assert.equal(runtimeOriginal.split("await verifyStagedRuntime();").length, 3);
  const runtimeMutant = runtimeOriginal.replaceAll(
    "await verifyStagedRuntime();",
    "await Promise.resolve();",
  );
  try {
    await writeFile(runtimeSource, runtimeMutant);
    const compiled = spawnSync(process.execPath, ["--check", runtimeSource], {
      encoding: "utf8",
    });
    assert.equal(compiled.status, 0, compiled.stderr);
    const control = runRuntime();
    assert.equal(
      control.result.status,
      1,
      control.result.stdout + control.result.stderr,
    );
    terminal(control, true);
    assert.match(control.result.stdout, /ERR_ASSERTION/);
    assert.match(control.result.stdout, /actual: 'passed'/);
    evidence.push({
      id: "staged-runtime-family",
      name: runtimeName,
      originalPassed: true,
      mutantCompiled: true,
      mutantFailedAssertion: true,
      actualFalsePassWithoutGuard: true,
      originalSha256: hash(runtimeOriginal),
      mutantSha256: hash(runtimeMutant),
    });
  } finally {
    await writeFile(runtimeSource, runtimeOriginal);
  }
  const runtimeRestored = runRuntime();
  assert.equal(
    runtimeRestored.result.status,
    0,
    runtimeRestored.result.stdout + runtimeRestored.result.stderr,
  );
  terminal(runtimeRestored, false);
  evidence.at(-1).restoredPassed = true;
  assert.equal(await readFile(source, "utf8"), original);
  process.stdout.write(
    JSON.stringify({
      nativeCapture: {
        compilerActuallyExecuted: true,
        generatedClasses: 2,
        originalFixtureRetainedThroughControls: true,
      },
      controls: evidence,
      allComplete: true,
    }) + "\n",
  );
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await rm(fixture.root, { recursive: true, force: true });
}
