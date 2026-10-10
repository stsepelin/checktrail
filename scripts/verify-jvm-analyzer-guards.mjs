import assert from "node:assert/strict";
import process from "node:process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { createHash } from "node:crypto";
import { analyzerFixture } from "../dist/test/spotbugs-extensions-fixture.js";
import { fullDetektFixture } from "../dist/test/detekt-extensions-fixture.js";
import { createPlan, validate } from "../dist/src/engine.js";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  callbacks = [],
  cleanups = [],
  receipts = {};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const harnessFiles = [
  "jvm-analyzer-evidence-controls.test.js",
  "spotbugs-extension-evidence-fixture.js",
];
for (const file of harnessFiles)
  callbacks.push({
    file,
    bytes: await readFile(path.join(repository, "dist/test", file)),
  });
try {
  for (const name of ["spotbugs", "detekt"]) {
    const t = { after: (callback) => cleanups.push(callback) },
      root =
        name === "spotbugs"
          ? (await analyzerFixture(t, true)).root
          : await fullDetektFixture(t);
    const check = (await createPlan(root)).plan.checks[0],
      result = (await validate(root, { trusted: true, timeoutMs: 120000 }))
        .checks[0];
    assert.equal(result.status, name === "spotbugs" ? "failed" : "passed");
    assert.equal(result.findingsComplete, true);
    receipts[name] = { root, check, process: result.processes[0] };
  }
  const directory = path.join(receipts.spotbugs.root, ".checktrail/guards");
  await mkdir(directory);
  const receipt = path.join(directory, "receipts.json");
  await writeFile(receipt, JSON.stringify(receipts));
  const env = {
    ...process.env,
    CHECKTRAIL_JVM_ANALYZER_GUARD_RECEIPT: receipt,
  };
  delete env.NODE_TEST_CONTEXT;
  const run = (name) => {
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
          "dist/test/jvm-analyzer-evidence-controls.test.js",
        ),
      ],
      { env, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1048576 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
  };
  const controls = [
    [
      "spotbugs-extensions-evidence.js",
      "original source digest",
      [["spotbugsHash(bytes) === expected.sha256", "true"]],
    ],
    [
      "spotbugs-extensions-evidence.js",
      "module analyzed name",
      [
        [
          'same(source.analyzed, [ extensions.jpms.find((m) => m.module === declared.path) .name + ".module-info", ])',
          "true",
        ],
      ],
    ],
    [
      "spotbugs-extensions-evidence.js",
      "module descriptor identity",
      [["module.name === expected.name", "true"]],
    ],
    [
      "spotbugs-extensions-evidence.js",
      "module dependency inventory",
      [['same(module.requires, ["java.base", ...expected.requires])', "true"]],
    ],
    [
      "spotbugs-extensions-evidence.js",
      "post-compilation class digest",
      [["after.sha256 === output.sha256", "true"]],
    ],
    [
      "spotbugs-extensions-evidence.js",
      "generated payload bytes",
      [
        ["bytes.length === payload.bytes", "true"],
        ["spotbugsHash(bytes) === payload.sha256", "true"],
      ],
    ],
    [
      "spotbugs-extensions-evidence.js",
      "native plugin code origin",
      [["actual.origin === origin(data.plugins[i].nativeFile)", "true"]],
    ],
    [
      "spotbugs-extensions-evidence.js",
      "native core code origin",
      [
        [
          'actual.origin === origin(path.join(data.temporary, "tools/spotbugs.jar"))',
          "true",
        ],
      ],
    ],
    [
      "spotbugs-extensions-evidence.js",
      "native disabled prerequisite preference",
      [["actual.enabled === factory.enabled", "true"]],
    ],
    [
      "spotbugs-extensions-evidence.js",
      "native finding provider",
      [["pattern.plugin === bug.provider", "true"]],
    ],
    [
      "spotbugs-extensions-evidence.js",
      "native finding line bound",
      [["bug.endLine <= source.source.lines", "true"]],
    ],
    [
      "detekt-extensions-evidence.js",
      "full native rule implementation",
      [["JSON.stringify(rules) === JSON.stringify(detektFullRules)", "true"]],
    ],
    [
      "detekt-extensions-evidence.js",
      "full native rule origin",
      [["origin === data.warningJarUrl", "true"]],
    ],
    [
      "detekt-extensions-evidence.js",
      "full native source symbol",
      [['typed.symbols.every((s) => s === "SOURCE")', "true"]],
    ],
    [
      "detekt-extensions-evidence.js",
      "full unknown annotation",
      [["typed.unknownAnnotations === 0", "true"]],
    ],
    [
      "detekt-extensions-evidence.js",
      "full resolved suppression",
      [['!typed.annotations.includes("kotlin.Suppress")', "true"]],
    ],
    [
      "detekt-extensions-evidence.js",
      "full SDK modules",
      [
        [
          'same(typed.sdk, detektFullSdkModules.map((m) => data.jdkHome + "!/" + m))',
          "true",
        ],
      ],
    ],
    [
      "detekt-extensions-evidence.js",
      "full classpath roots",
      [["same(typed.roots, data.classPath)", "true"]],
    ],
    [
      "detekt-extensions-evidence.js",
      "full physical configuration",
      [["detektHash(bytes) === pin.sha256", "true"]],
    ],
  ];
  const evidence = [];
  for (const [file, suffix, substitutions] of controls) {
    const name = "analyzer guard checks " + suffix,
      source = path.join(repository, "dist/src", file),
      original = await readFile(source, "utf8"),
      baseline = run(name);
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    assert.match(baseline.stdout, /^# pass 1$/m);
    assert.match(baseline.stdout, /^# skipped 0$/m);
    let mutant = original;
    for (const [before, after] of substitutions) {
      const pattern = new RegExp(
        before
          .split(/\s+/)
          .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("\\s+"),
        "g",
      );
      assert.equal(
        [...mutant.matchAll(pattern)].length,
        1,
        "Exact mutation address: " + suffix,
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
      assert.equal(control.status, 1, control.stdout + control.stderr);
      assert.match(control.stdout, /ERR_ASSERTION/);
      assert.match(control.stdout, /^# fail 1$/m);
      assert.doesNotMatch(
        control.stdout + control.stderr,
        /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/i,
      );
      for (const callback of callbacks)
        assert.deepEqual(
          await readFile(path.join(repository, "dist/test", callback.file)),
          callback.bytes,
        );
      evidence.push({
        name,
        source: file,
        originalPassed: true,
        mutantCompiled: true,
        mutantFailedAssertion: true,
        originalSha256: hash(original),
        mutantSha256: hash(mutant),
      });
    } finally {
      await writeFile(source, original);
    }
    const restored = run(name);
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assert.match(restored.stdout, /^# pass 1$/m);
    evidence.at(-1).restoredPassed = true;
  }
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      profile: "jvm-analyzer-extension-guards-v1",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      controls: evidence,
      callbacks: callbacks.map((f) => ({
        file: f.file,
        sha256: hash(f.bytes),
      })),
      sourceRestored: true,
      callbacksUnchanged: true,
      allComplete: evidence.every(
        (c) =>
          c.originalPassed &&
          c.mutantCompiled &&
          c.mutantFailedAssertion &&
          c.restoredPassed,
      ),
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
    }) + "\n",
  );
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
}
