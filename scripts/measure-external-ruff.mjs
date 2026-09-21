import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, URL } from "node:url";
import { inventory } from "../dist/src/inventory.js";
import { runProcess } from "../dist/src/runner.js";
import {
  extractRuffSnapshot,
  normalizeRuffDiagnostics,
  summarizeRuffEvaluation,
} from "./external-ruff-evidence.mjs";
assert.equal(
  process.argv.length,
  4,
  "Pass prepared inputs and a prepared Ruff executable",
);
const inputsDirectory = await realpath(process.argv[2]);
const executable = await realpath(process.argv[3]);
assert.equal(path.basename(executable), "ruff");
const repository = fileURLToPath(new URL("../", import.meta.url));
const plan = JSON.parse(
  await readFile(new URL("./external-ruff-plan.json", import.meta.url), "utf8"),
);
const inputs = JSON.parse(
  await readFile(
    new URL("./external-ruff-inputs.json", import.meta.url),
    "utf8",
  ),
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(hash(JSON.stringify(plan, null, 2) + "\n"), inputs.planSha256);
async function treeDigest(directory) {
  const digest = createHash("sha256");
  async function visit(relative = "") {
    const entries = await readdir(path.join(directory, relative), {
      withFileTypes: true,
    });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(file);
      else {
        assert.ok(entry.isFile());
        digest
          .update(file.split(path.sep).join("/"))
          .update("\0")
          .update(hash(await readFile(path.join(directory, file))))
          .update("\0");
      }
    }
  }
  await visit();
  return digest.digest("hex");
}
async function identity() {
  return {
    runtimeArtifactsSha256: await treeDigest(path.join(repository, "dist/src")),
    packageLockSha256: hash(
      await readFile(path.join(repository, "package-lock.json")),
    ),
    ruffSha256: hash(await readFile(executable)),
    harnessSha256: hash(
      (
        await Promise.all(
          [
            "measure-external-ruff.mjs",
            "external-ruff-evidence.mjs",
            "external-ruff-worker.mjs",
          ].map((file) => readFile(new URL(file, import.meta.url))),
        )
      ).reduce((all, bytes) => Buffer.concat([all, bytes]), Buffer.alloc(0)),
    ),
  };
}
assert.deepEqual(
  inputs.files.map((item) => item.file).sort(),
  [
    ...plan.supportFiles,
    ...plan.cases.flatMap((item) => [item.source, item.snapshot]),
  ].sort(),
);
assert.equal(plan.cases.length, plan.limits.files);
const before = await identity();
for (const [key, value] of Object.entries(plan.frozenVerifier))
  assert.equal(before[key], value, "Verifier differs from declared freeze");
const sources = new Map();
async function verifyInputs() {
  for (const item of inputs.files) {
    const bytes = await readFile(
      path.join(inputsDirectory, path.posix.basename(item.file)),
    );
    assert.equal(bytes.length, item.bytes);
    if (plan.cases.some((value) => value.source === item.file))
      assert.ok(bytes.length <= plan.limits.sourceBytesPerFile);
    if (plan.cases.some((value) => value.snapshot === item.file))
      assert.ok(bytes.length <= plan.limits.snapshotBytesPerFile);
    assert.equal(hash(bytes), item.sha256);
    sources.set(
      item.file,
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  }
}
await verifyInputs();
const registration = sources.get(
  "crates/ruff_linter/src/rules/pyflakes/mod.rs",
);
const rulesBody =
  /fn rules\(rule_code: Rule, path: &Path\) -> Result<\(\)> \{([^]*?)\n {4}\}/.exec(
    registration,
  )?.[1];
assert.ok(rulesBody?.includes("&LinterSettings::for_rule(rule_code)"));
assert.ok(rulesBody?.includes("assert_diagnostics!(snapshot, diagnostics)"));
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "checktrail-ruff-cohort-")),
);
const environment = {
  PATH: [
    path.dirname(executable),
    path.dirname(process.execPath),
    "/usr/bin",
    "/bin",
  ].join(path.delimiter),
};
const observations = [];
const cases = [];
async function execute(command, args) {
  const start = performance.now();
  const result = await runProcess(
    root,
    { executable: command, args, cwd: "." },
    { timeoutMs: 30000, environment, maxOutputBytes: 1024 * 1024 },
  );
  return { result, wallMs: performance.now() - start };
}
try {
  const version = await execute(executable, ["--version"]);
  assert.equal(version.result.exitCode, 0);
  assert.equal(version.result.stdout.trim(), `ruff ${plan.tool.ruff}`);
  assert.equal(version.result.stderr, "");
  const python = await execute("python3", ["--version"]);
  assert.equal(
    python.result.exitCode,
    0,
    "The frozen verifier requires Python runtime identity alongside Ruff",
  );
  assert.match(python.result.stdout.trim(), /^Python 3\.[0-9]+\.[0-9]+$/);
  assert.equal(python.result.stderr, "");
  await writeFile(path.join(root, "LICENSE"), sources.get("LICENSE"));
  await writeFile(
    path.join(root, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["python.ruff"] }],
    }),
  );
  for (const [index, item] of plan.cases.entries()) {
    const file = path.posix.basename(item.source);
    const ruleName = {
      F401: "UnusedImport",
      F821: "UndefinedName",
      F841: "UnusedVariable",
    }[item.rule];
    assert.ok(
      registration
        .slice(0, registration.indexOf("fn rules("))
        .includes(`#[test_case(Rule::${ruleName}, Path::new("${file}"))]`),
    );
    let expected;
    try {
      expected = extractRuffSnapshot(
        sources.get(item.snapshot),
        item.rule,
        file,
      );
    } catch {
      cases.push({
        rule: item.rule,
        file,
        sourceSha256: hash(sources.get(item.source)),
        snapshotSha256: hash(sources.get(item.snapshot)),
        expected: null,
        exclusion: "unsupported-snapshot",
      });
      continue;
    }
    cases.push({
      rule: item.rule,
      file,
      sourceSha256: hash(sources.get(item.source)),
      snapshotSha256: hash(sources.get(item.snapshot)),
      expected,
    });
    await writeFile(path.join(root, file), sources.get(item.source));
    await writeFile(
      path.join(root, "pyproject.toml"),
      `[tool.ruff]\npreview = false\n[tool.ruff.lint]\nselect = ["${item.rule}"]\n`,
    );
    const fingerprint = (await inventory(root)).fingerprint;
    for (const system of index % 2
      ? ["verifier", "native"]
      : ["native", "verifier"]) {
      const { result, wallMs } =
        system === "native"
          ? await execute(executable, [
              "check",
              "--config",
              "pyproject.toml",
              "--no-cache",
              "--no-fix",
              "--no-fix-only",
              "--no-unsafe-fixes",
              "--force-exclude",
              "--output-format",
              "json",
              "--",
              `./${file}`,
            ])
          : await execute(process.execPath, [
              fileURLToPath(
                new URL("./external-ruff-worker.mjs", import.meta.url),
              ),
              root,
            ]);
      assert.equal((await inventory(root)).fingerprint, fingerprint);
      if (system === "verifier" && result.exitCode !== 0) {
        assert.equal(
          result.exitCode,
          0,
          "Verifier worker failed; measurement cannot classify a harness failure",
        );
      }
      let observation;
      if (
        result.timedOut ||
        result.truncated ||
        result.cancelled ||
        result.errorCode ||
        result.stderr.trim()
      )
        observation = {
          outcome: "incomplete",
          complete: false,
          diagnostics: [],
          reason: "unusable-process-evidence",
        };
      else if (system === "verifier") {
        assert.equal(result.exitCode, 0);
        observation = JSON.parse(result.stdout);
        assert.equal(observation.sourceFingerprint, fingerprint);
      } else if ([0, 1].includes(result.exitCode)) {
        const diagnostics = normalizeRuffDiagnostics(
          JSON.parse(result.stdout),
          root,
          file,
        );
        assert.equal(result.exitCode === 1, diagnostics.length > 0);
        observation = {
          outcome: result.exitCode === 0 ? "passed" : "failed",
          complete: true,
          diagnostics,
        };
      } else
        observation = {
          outcome: "incomplete",
          complete: false,
          diagnostics: [],
          reason: "native-execution-error",
        };
      observations.push({
        rule: item.rule,
        system,
        ...observation,
        sourceFingerprint: fingerprint,
        wallMs,
      });
    }
    await rm(path.join(root, file));
  }
  await verifyInputs();
  assert.deepEqual(await identity(), before);
  process.stdout.write(
    JSON.stringify(
      {
        schemaVersion: 1,
        provenance: "external-ruff-diagnostic-integration",
        interpretation: plan.purpose,
        startedFromDeclaredPlan: inputs.planSha256,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.versions.node,
        pythonVersion: python.result.stdout.trim(),
        upstream: plan.upstream,
        identities: before,
        inputsSha256: hash(JSON.stringify(inputs)),
        cases,
        observations,
        ...summarizeRuffEvaluation(cases, observations),
        model: { calls: 0, tokens: 0, providerCost: 0 },
        limits: [
          "Whole mixed fixtures are not independent valid/invalid cases.",
          "Only rule codes and primary start locations are compared to upstream snapshots.",
          "No message/fix/end-location, population false-positive, review-quality or representative cost claim.",
        ],
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
