import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const posix = {
  skip:
    process.platform === "win32"
      ? "Selected producer controls require POSIX"
      : false,
};

function python(args: string[]) {
  const result = spawnSync("python3", ["-I", "-S", "-B", ...args], {
    cwd: repository,
    encoding: "utf8",
    timeout: 240_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const syntheticDiscovery = `
import contextlib, json, pathlib, sys, unittest
folder = pathlib.Path(sys.argv[1]).resolve()
expected = json.loads(sys.argv[2])
actual = sorted(p.stem for p in folder.glob("test_*.py"))
assert actual == expected, "Update the explicit synthetic module inventory"
with contextlib.redirect_stdout(sys.stderr):
    suite = unittest.defaultTestLoader.discover(str(folder), pattern="test_*.py")
    def leaves(node):
        if isinstance(node, unittest.TestSuite):
            for child in node:
                yield from leaves(child)
        else:
            yield node
    cases = list(leaves(suite))
    modules = sorted(set(case.__class__.__module__ for case in cases))
    assert modules == expected, "Every declared module must contribute executable cases"
    result = unittest.TextTestRunner(verbosity=2).run(suite)
row = {"tests": result.testsRun, "expectedCases": len(cases), "modules": modules,
       "failures": len(result.failures), "errors": len(result.errors),
       "skipped": len(result.skipped), "unexpectedSuccesses": len(result.unexpectedSuccesses),
       "expectedFailures": len(result.expectedFailures)}
print(json.dumps(row))
sys.exit(0 if result.wasSuccessful() and result.testsRun > 0 and not result.skipped
         and not result.expectedFailures and result.testsRun == len(cases) else 1)
`;

function syntheticModules(folder: string, modules: string[]) {
  const cohort: { file: string; bytes: number; sha256: string }[] = JSON.parse(
    readFileSync(path.join(repository, folder, "PUBLIC-COHORT.json"), "utf8"),
  );
  assert.ok(cohort.length > 0);
  assert.equal(new Set(cohort.map((row) => row.file)).size, cohort.length);
  for (const row of cohort) {
    assert.match(row.file, /^[a-z0-9_-]+(?:\/[a-z0-9_.-]+)*\.[a-z0-9]+$/i);
    const bytes = readFileSync(path.join(repository, folder, row.file));
    assert.equal(bytes.length, row.bytes, row.file);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      row.sha256,
      row.file,
    );
  }
  const expected = [...modules].sort();
  const counts = python([
    "-c",
    syntheticDiscovery,
    folder,
    JSON.stringify(expected),
  ]);
  assert.deepEqual(counts.modules, expected);
  assert.ok(counts.tests > 0);
  assert.equal(counts.tests, counts.expectedCases);
  for (const key of [
    "failures",
    "errors",
    "skipped",
    "unexpectedSuccesses",
    "expectedFailures",
  ]) {
    assert.equal(counts[key], 0, key);
  }
}

test(
  "SDK10 producer synthetic controls and authenticated envelope round trips",
  posix,
  () => {
    const temporary = mkdtempSync(
      path.join(tmpdir(), "checktrail-sdk10-controls-"),
    );
    try {
      const manifest = readFileSync(
        path.join(repository, "scripts/producer-sdk10/MANIFEST.json"),
      );
      const protectedControls = JSON.parse(
        readFileSync(
          path.join(
            repository,
            "scripts/producer-sdk10/PROTECTED-CONTROLS.json",
          ),
          "utf8",
        ),
      );
      assert.equal(protectedControls.firstPartyControlsOnly, true);
      assert.ok(protectedControls.files.length > 0);
      for (const row of protectedControls.files) {
        assert.match(row.path, /^[a-z0-9_]+\.py$/);
        const bytes = readFileSync(
          path.join(repository, "scripts/producer-sdk10", row.path),
        );
        assert.equal(bytes.length, row.bytes, row.path);
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          row.sha256,
          row.path,
        );
      }
      const result = python([
        "scripts/producer-sdk10/run_checks.py",
        "--out",
        path.join(temporary, "controls"),
        "--manifest-sha256",
        createHash("sha256").update(manifest).digest("hex"),
      ]);
      assert.equal(result.complete, true);
      assert.ok(result.python.tests > 0);
      for (const key of ["failures", "errors", "skipped"])
        assert.equal(result.python[key], 0);
      assert.ok(result.cryptoControls > 0);
      assert.equal(result.cryptoSkips, 0);
      assert.equal(result.upstreamSourceSdkDockerOrNetworkExecuted, false);
      assert.equal(
        result.testOnlyKeysNeverUsedForOperatorCaptureOrUploaded,
        true,
      );
      assert.deepEqual(
        result.processes.map((row: { name: string; exitCode: number }) => [
          row.name,
          row.exitCode,
        ]),
        [
          ["python", 0],
          ["crypto", 0],
        ],
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);

test(
  "Rust producer synthetic admission and owned process lifecycle controls",
  posix,
  () => {
    syntheticModules(".github/native-rust198", [
      "test_controller",
      "test_inner_failure_observation",
      "test_materializer",
      "test_placement",
      "test_process_lifecycle",
      "test_volume_lifecycle",
    ]);
  },
);

test("Rust original-notice custody synthetic controls", posix, () => {
  syntheticModules(".github/native-rust198-notices", ["test_notice_custody"]);
});
