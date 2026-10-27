import assert from "node:assert/strict";
import { test } from "node:test";
import { access, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createPlan, validate } from "../src/engine.js";
import { runProcess } from "../src/runner.js";
import { fixture, nodeManifest } from "./helpers.js";
import {
  lifecycleProject,
  validateLifecycleProject,
} from "./lifecycle-platforms-fixture.js";

test("lifecycle-platforms broken acceptance", { timeout: 60000 }, async (t) => {
  const { report } = await validateLifecycleProject(t, { broken: true });
  assert.equal(report.outcome, "failed");
  assert.equal(report.sourceChanged, false);
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0]!.status, "failed");
  assert.deepEqual(report.checks[0]!.tests, {
    total: 1,
    passed: 0,
    failed: 1,
    skipped: 0,
  });
});

test("lifecycle-platforms fixed acceptance", { timeout: 60000 }, async (t) => {
  const { report } = await validateLifecycleProject(t);
  assert.equal(report.outcome, "passed");
  assert.equal(report.sourceChanged, false);
  assert.equal(report.sourceFingerprint, report.finalSourceFingerprint);
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0]!.status, "passed");
  assert.deepEqual(report.checks[0]!.tests, {
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
  });
});

test(
  "lifecycle-platforms near-miss acceptance",
  { timeout: 60000 },
  async (t) => {
    const { report, reached } = await validateLifecycleProject(t, {
      file: "quota ; original literal.test.js",
      delayedReady: true,
    });
    assert.equal(report.outcome, "passed");
    assert.equal(report.sourceChanged, false);
    assert.equal(report.checks[0]!.tests!.total, 1);
    assert.equal(report.checks[0]!.tests!.passed, 1);
    assert.notEqual(reached.children[0], reached.children[1]);
  },
);

test(
  "lifecycle-platforms prerequisite acceptance",
  { timeout: 60000 },
  async (t) => {
    const project = await lifecycleProject(t);
    const { plan } = await createPlan(project.root);
    assert.equal(plan.checks.length, 1);
    await assert.rejects(
      validate(project.root, { trusted: false }),
      /operator trust/,
    );
    const result = await runProcess(
      project.root,
      {
        executable: path.join(
          project.root,
          process.platform === "win32"
            ? "original-absent.exe"
            : "original-absent",
        ),
        args: [],
        cwd: ".",
      },
      { timeoutMs: 10000, captureRawOutput: true },
    );
    assert.equal(result.errorCode, "ENOENT");
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.cancelled, false);
    await assert.rejects(access(project.marker), { code: "ENOENT" });
    for (const kind of ["absent", "changed"] as const) {
      const d = await lifecycleProject(t),
        loader = "original loader.mjs",
        source = `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(d.control, "loader-executed"))},'Original loader body.');`;
      if (kind === "changed")
        await writeFile(
          path.join(d.root, loader),
          source + "\n// Changed pinned bytes.\n",
        );
      await writeFile(
        path.join(d.root, "checktrail.javascript.json"),
        JSON.stringify({
          schemaVersion: 1,
          nodeTest: {
            loaders: [
              {
                kind: "import",
                path: loader,
                sha256: createHash("sha256").update(source).digest("hex"),
              },
            ],
          },
        }),
      );
      const selected = (await createPlan(d.root)).plan.checks[0]!;
      assert.match(
        selected.unavailableReason!,
        kind === "absent" ? /absent/ : /bytes/,
      );
      const unavailable = await validate(d.root, {
        trusted: true,
        timeoutMs: 15000,
      });
      assert.equal(unavailable.outcome, "incomplete");
      assert.equal(unavailable.checks[0]!.status, "unavailable");
      assert.deepEqual(unavailable.checks[0]!.processes, []);
      await assert.rejects(access(d.marker), { code: "ENOENT" });
      await assert.rejects(access(path.join(d.control, "loader-executed")), {
        code: "ENOENT",
      });
    }
    for (const index of [0, 1])
      await assert.rejects(
        access(path.join(project.control, "child-" + index)),
        {
          code: "ENOENT",
        },
      );
  },
);

test("lifecycle-platforms stale acceptance", { timeout: 60000 }, async (t) => {
  const { report } = await validateLifecycleProject(t, { stale: true });
  assert.equal(report.checks[0]!.status, "passed");
  assert.equal(report.checks[0]!.tests!.passed, 1);
  assert.equal(report.sourceChanged, true);
  assert.equal(report.outcome, "incomplete");
  assert.notEqual(report.sourceFingerprint, report.finalSourceFingerprint);
});

test("lifecycle-platforms empty acceptance", { timeout: 60000 }, async (t) => {
  for (const mode of ["empty", "skipped"] as const) {
    const root = await fixture(t, {
      "package.json": nodeManifest,
      "empty.test.js":
        mode === "empty"
          ? ""
          : "import{test}from'node:test';test.skip('original skipped lifecycle',()=>{throw Error('Unreachable skipped body');});",
    });
    const report = await validate(root, { trusted: true, timeoutMs: 15000 });
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0]!.status, "inconclusive");
    if (mode === "empty") {
      assert.equal(report.checks[0]!.tests, undefined);
      assert.equal(
        report.checks[0]!.reason,
        "The test evidence could not be parsed unambiguously.",
      );
    } else {
      assert.equal(
        report.checks[0]!.reason,
        "No passing, non-skipped tests were observed.",
      );
      assert.deepEqual(report.checks[0]!.tests, {
        total: 1,
        passed: 0,
        failed: 0,
        skipped: 1,
      });
    }
  }
});

test(
  "lifecycle-platforms privacy acceptance",
  { timeout: process.platform === "win32" ? 300000 : 180000 },
  async (t) => {
    const { lifecyclePrivacy } =
      await import("./lifecycle-platforms-boundaries.js");
    await lifecyclePrivacy(t);
  },
);

test(
  "lifecycle-platforms lifecycle acceptance",
  { timeout: process.platform === "win32" ? 180000 : 90000 },
  async (t) => {
    const { lifecycleInterruption } =
      await import("./lifecycle-platforms-interruption.js");
    await lifecycleInterruption(t);
  },
);

test(
  "lifecycle-platforms installed acceptance",
  { timeout: process.platform === "win32" ? 600000 : 300000 },
  async () => {
    const { readFile, realpath } = await import("node:fs/promises"),
      { fileURLToPath } = await import("node:url");
    if (process.env.CHECKTRAIL_LIFECYCLE_INSTALLED === "1") {
      const actual = await realpath(
        fileURLToPath(import.meta.resolve("../src/engine.js")),
      );
      assert.ok(
        actual.endsWith(
          path.join(
            "node_modules",
            "@stsepelin",
            "checktrail",
            "dist",
            "src",
            "engine.js",
          ),
        ),
      );
      const metadata = JSON.parse(
        await readFile(
          new URL(
            "../../package.json",
            import.meta.resolve("../src/engine.js"),
          ),
          "utf8",
        ),
      );
      assert.equal(metadata.name, "@stsepelin/checktrail");
      return;
    }
    const { spawnSync } = await import("node:child_process"),
      script = fileURLToPath(
        new URL(
          "../../scripts/verify-lifecycle-platforms-package.mjs",
          import.meta.url,
        ),
      );
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      timeout: process.platform === "win32" ? 590000 : 290000,
      maxBuffer: 4 * 1048576,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.offlineProductionInstall, true);
    assert.equal(evidence.lifecycleScriptsExecuted, false);
    assert.equal(evidence.evidence.complete, true);
    assert.equal(evidence.evidence.required, 9);
    assert.equal(evidence.evidence.passed, 9);
    const { writeRuntimeInstallation } = await import(
      new URL("../../scripts/runtime-installation-capture.mjs", import.meta.url)
        .href
    );
    await writeRuntimeInstallation("lifecycle", evidence);
  },
);
