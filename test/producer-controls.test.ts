import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const posix = {
  skip:
    process.platform === "win32"
      ? "Selected producer controls require POSIX"
      : false,
};

function python(args: string[], temporaryRoot?: string) {
  const result = spawnSync("python3", ["-I", "-S", "-B", ...args], {
    cwd: repository,
    env: temporaryRoot
      ? {
          ...process.env,
          TMPDIR: temporaryRoot,
          TMP: temporaryRoot,
          TEMP: temporaryRoot,
        }
      : process.env,
    encoding: "utf8",
    timeout: 240_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  // CI retains only the beginning of a problem message. Put terminal failures
  // before verbose unittest progress, and keep incomplete-process diagnostics.
  let failures = "";
  try {
    const report = JSON.parse(result.stdout);
    failures = Array.isArray(report.problems)
      ? report.problems
          .map(
            (problem: { test: string; detail: string }) =>
              `${problem.test}: ${problem.detail}`,
          )
          .join("\n")
      : "";
  } catch {
    // A spawn failure or early Python assertion may have no JSON result.
  }
  const diagnostic = failures || result.stderr.slice(-4000);
  assert.equal(
    result.error,
    undefined,
    `${String(result.error)}\n${diagnostic}`,
  );
  assert.equal(result.signal, null, diagnostic);
  assert.equal(result.status, 0, diagnostic);
  return JSON.parse(result.stdout);
}

const syntheticDiscovery = `
import contextlib, json, pathlib, re, sys, unittest
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
def failure_detail(trace):
    lines = trace.strip().splitlines()
    headline = next((line for line in reversed(lines) if re.match(r"^[A-Za-z_][a-zA-Z0-9_.]*: ", line)), lines[-1])
    return headline[:450] + (" | " + lines[-1][-240:] if lines[-1] != headline else "")
row = {"tests": result.testsRun, "expectedCases": len(cases), "modules": modules,
       "failures": len(result.failures), "errors": len(result.errors),
       "skipped": len(result.skipped), "unexpectedSuccesses": len(result.unexpectedSuccesses),
       "expectedFailures": len(result.expectedFailures),
       "problems": [{"test": case.id(), "detail": failure_detail(trace)}
                    for case, trace in [*result.failures, *result.errors]]}
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
  // The notice controls intentionally detect directory timestamp changes.
  // Keep their real filesystem fixtures out of shared system temporary roots,
  // where unrelated test workers legitimately create and remove siblings.
  const scratchParent = path.join(repository, ".checktrail");
  mkdirSync(scratchParent, { recursive: true });
  const scratch = mkdtempSync(path.join(scratchParent, "producer-controls-"));
  let counts;
  try {
    counts = python(
      ["-c", syntheticDiscovery, folder, JSON.stringify(expected)],
      scratch,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
  "Synthetic Python failures retain their cause before verbose progress",
  posix,
  () => {
    const temporary = mkdtempSync(
      path.join(tmpdir(), "checktrail-diagnostic-controls-"),
    );
    try {
      writeFileSync(
        path.join(temporary, "test_diagnostic.py"),
        `
import unittest
class Diagnostics(unittest.TestCase):
    def test_z_failure(self):
        self.assertEqual({"expected": "x" * 200}, {"actual": "y" * 200}, "causal-diagnostic-marker")
for index in range(40):
    setattr(Diagnostics, "test_progress_%03d" % index, lambda self: self.assertTrue(True))
`,
      );
      assert.throws(
        () =>
          python([
            "-c",
            syntheticDiscovery,
            temporary,
            JSON.stringify(["test_diagnostic"]),
          ]),
        (error: unknown) => {
          const retained = String(error).slice(0, 1000);
          assert.match(retained, /test_diagnostic.Diagnostics.test_z_failure/);
          assert.match(retained, /AssertionError:/);
          assert.match(retained, /causal-diagnostic-marker/);
          return true;
        },
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);

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
      for (const key of [
        "failures",
        "errors",
        "skipped",
        "expectedFailures",
        "unexpectedSuccesses",
      ])
        assert.equal(result.python[key], 0);
      assert.deepEqual(result.python.modulesWithoutPassingTests, []);
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
  "SDK10 controls worker runs a packed bundle without reading its emptied directory",
  posix,
  () => {
    // A small marker bundle rather than the real controls, which would run
    // this check again from inside the worker. The real launcher and common.py
    // are packed with one control; every file is then deleted, so the worker
    // can only run what it was given on stdin. A packed file that differs from
    // the pin is refused before any control runs.
    const temporary = mkdtempSync(
      path.join(tmpdir(), "checktrail-sdk10-packed-"),
    );
    try {
      const source = path.join(repository, "scripts/producer-sdk10");
      const bundle = path.join(temporary, "bundle-6271");
      mkdirSync(bundle);
      const markers = path.join(temporary, "markers-6271");
      mkdirSync(markers);
      const files: Record<string, Buffer> = {
        "run_checks.py": readFileSync(path.join(source, "run_checks.py")),
        "common.py": readFileSync(path.join(source, "common.py")),
        "test_packed_marker.py": Buffer.from(
          "import pathlib,unittest\n" +
            "import common\n" +
            "class Packed(unittest.TestCase):\n" +
            " def test_packed_6271(self):\n" +
            "  pathlib.Path(" +
            JSON.stringify(path.join(markers, "packed")) +
            ").write_bytes(common.encoded({'packed':6271}))\n",
        ),
      };
      const rows = Object.keys(files).map((name) => ({
        path: name,
        bytes: files[name]!.length,
        sha256: createHash("sha256").update(files[name]!).digest("hex"),
      }));
      files["MANIFEST.json"] = Buffer.from(
        JSON.stringify({ schemaVersion: 1, files: rows }),
      );
      const pin = createHash("sha256")
        .update(files["MANIFEST.json"])
        .digest("hex");
      for (const [name, body] of Object.entries(files))
        writeFileSync(path.join(bundle, name), body);
      const bootstrap = spawnSync(
        "python3",
        [
          "-I",
          "-S",
          "-B",
          "-c",
          "import sys;sys.path.insert(0,sys.argv[1]);import run_checks;sys.stdout.write(run_checks.BUNDLE_BOOTSTRAP)",
          bundle,
        ],
        { encoding: "utf8" },
      );
      assert.equal(bootstrap.status, 0, bootstrap.stderr);
      for (const name of readdirSync(bundle)) rmSync(path.join(bundle, name));
      assert.deepEqual(readdirSync(bundle), []);
      const packed = (changed: boolean) => {
        const value: Record<string, string> = {};
        for (const [name, body] of Object.entries(files))
          value[name] = (
            changed && name === "common.py"
              ? Buffer.concat([body, Buffer.from("# changed-6271\n")])
              : body
          ).toString("latin1");
        return JSON.stringify(value);
      };
      const worker = (label: string, changed: boolean) => {
        const out = path.join(temporary, "out-" + label);
        mkdirSync(out);
        const result = spawnSync(
          "python3",
          [
            "-I",
            "-S",
            "-B",
            "-c",
            bootstrap.stdout,
            path.join(bundle, "run_checks.py"),
            pin,
            "--python-worker",
            "--out",
            out,
            "--manifest-sha256",
            pin,
          ],
          { input: packed(changed), encoding: "utf8", timeout: 60_000 },
        );
        return { out, result };
      };
      const refused = worker("changed", true);
      assert.notEqual(refused.result.status, 0);
      assert.match(
        refused.result.stderr,
        /frozen first-party control file changed: common\.py/,
      );
      assert.deepEqual(readdirSync(markers), []);
      const { out, result } = worker("exact", false);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /test_packed_6271/);
      assert.deepEqual(
        JSON.parse(readFileSync(path.join(out, "PYTHON.json"), "utf8")),
        {
          tests: 1,
          failures: 0,
          errors: 0,
          skipped: 0,
          expectedFailures: 0,
          unexpectedSuccesses: 0,
          modulesWithoutPassingTests: [],
          originalSourceDockerSdkOrNetworkExecuted: false,
        },
      );
      assert.equal(
        readFileSync(path.join(markers, "packed"), "utf8"),
        '{\n  "packed": 6271\n}\n',
      );
      assert.deepEqual(readdirSync(bundle), []);
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

const envelopeCopies = [
  "scripts/producer-sdk10/envelope.mjs",
  ".github/native-rust198-notices/reused-crypto/envelope.mjs",
];

test("both reused crypto envelope copies stay byte-identical", () => {
  const [first, second] = envelopeCopies.map((file) =>
    readFileSync(path.join(repository, file)),
  );
  assert.ok(first && second && first.length > 0);
  assert.ok(first.equals(second));
});

for (const copy of envelopeCopies) {
  test("envelope CLI runs main only as the entry point: " + copy, posix, () => {
    const temporary = mkdtempSync(
      path.join(tmpdir(), "checktrail-envelope-cli-"),
    );
    try {
      // A directory name with a space is percent-encoded in import.meta.url
      // but not in argv[1]; a symlinked directory differs from the real path
      // import.meta.url reports.
      const spaced = path.join(temporary, "operator evidence 4127");
      mkdirSync(spaced);
      const envelope = path.join(spaced, "envelope.mjs");
      copyFileSync(path.join(repository, copy), envelope);
      const linked = path.join(temporary, "linked-crypto-4127");
      symlinkSync(spaced, linked);
      const { publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 3072,
      });
      const { kty, n, e } = publicKey.export({ format: "jwk" });
      const request = path.join(spaced, "REQUEST 4127.json");
      writeFileSync(request, JSON.stringify({ publicJWK: { kty, n, e } }));
      const operation = ["validate-recipient", request];
      const validated = '{"validPublicRecipient":true}\n';
      // Importers are given operation arguments that would make a wrongly
      // started CLI body print a result, so a false entry match is visible.
      const importer = path.join(spaced, "importer 4127.mjs");
      writeFileSync(
        importer,
        "import {canonical} from './envelope.mjs';\n" +
          "process.stdout.write(canonical({importedOnly:4127})+'\\n');\n",
      );
      const evaluated =
        "import {pathToFileURL} from 'node:url';" +
        "await import(pathToFileURL(process.argv[1]).href);" +
        "process.stdout.write('eval-imported-4127\\n');";
      const cases: [string, string[], string][] = [
        ["spaced entry", [envelope, ...operation], validated],
        [
          "symlinked entry",
          [path.join(linked, "envelope.mjs"), ...operation],
          validated,
        ],
        [
          "entry preloaded by --import runs once",
          ["--import=" + pathToFileURL(envelope).href, envelope, ...operation],
          validated,
        ],
        [
          "static importer",
          [importer, envelope, ...operation],
          '{"importedOnly":4127}\n',
        ],
        [
          "eval importer naming the envelope",
          ["--input-type=module", "-e", evaluated, envelope, ...operation],
          "eval-imported-4127\n",
        ],
      ];
      for (const [label, args, expected] of cases) {
        const result = spawnSync(process.execPath, args, {
          encoding: "utf8",
          timeout: 30_000,
        });
        assert.equal(result.error, undefined, label);
        assert.equal(result.status, 0, label + ": " + result.stderr);
        assert.equal(result.stderr, "", label);
        assert.equal(result.stdout, expected, label);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
