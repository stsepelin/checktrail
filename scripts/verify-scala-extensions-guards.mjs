import process from "node:process";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { createHash } from "node:crypto";
import { mixedScalaFixture } from "../dist/test/scala-extensions-fixture.js";
import { createPlan, validate } from "../dist/src/engine.js";
const repository = fileURLToPath(new URL("../", import.meta.url));
const cleanups = [];
const fixture = await mixedScalaFixture({
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
  const controls = [
    [
      "current-java-source",
      "current original Java bytes",
      [["b.sha256 === scalaHash(physical)", "true"]],
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
          "scalaHash(kotlinReadSync(archive, scalaArtifacts.archiveBytes)) === planned.config.sha256",
          "true",
        ],
      ],
    ],
    [
      "generator-input",
      "generator input",
      [["native.sourceSha256 === scalaHash(original.get(g.source))", "true"]],
    ],
    [
      "generated-class-name",
      "generated class name",
      [["witness.className === p.className", "true"]],
    ],
    [
      "generated-source-origin",
      "generated class source origin",
      [["witness.sourceFile === path.posix.basename(p.path)", "true"]],
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
    [
      "native-feature-phase",
      "native feature phase",
      [["native.featureStages !== 1 ||", "false ||"]],
      "scala-evidence.js",
    ],
    [
      "native-source-features",
      "native source feature visit",
      [["s.featureVisits !== 1 ||", "false ||"]],
      "scala-evidence.js",
    ],
  ];
  const run = (suffix) => {
    const env = { ...process.env, CHECKTRAIL_SCALA_GUARD_RECEIPT: receipt };
    delete env.NODE_TEST_CONTEXT;
    const name = "mixed Scala guard checks " + suffix;
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
          "dist/test/scala-extension-evidence-controls.test.js",
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
  for (const [id, name, substitutions, selectedSource] of controls) {
    const source = path.join(
      repository,
      "dist/src",
      selectedSource ?? "scala-extension-evidence.js",
    );
    const original = await readFile(source, "utf8");
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
  process.stdout.write(
    JSON.stringify({
      nativeCapture: {
        compilerActuallyExecuted: true,
        generatedClasses: JSON.parse(result.processes[0].stdout)
          .generatedClasses.length,
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
