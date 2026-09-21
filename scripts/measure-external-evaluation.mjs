import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { TextDecoder } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { inventory } from "../dist/src/inventory.js";
import { runProcess } from "../dist/src/runner.js";
import { copyInstalledPackages } from "../dist/test/tool-fixture.js";
import {
  extractRuleCases,
  sha256,
  summarizeExternalCases,
} from "./external-evaluation-extract.mjs";
import { normalizeExternalDiagnostics } from "./external-evaluation-evidence.mjs";

assert.equal(
  process.argv.length,
  3,
  "Usage: node scripts/measure-external-evaluation.mjs PREPARED_INPUT_DIRECTORY",
);
const inputDirectory = path.resolve(process.argv[2]);
const repository = fileURLToPath(new URL("../", import.meta.url));
const plan = JSON.parse(
  await readFile(
    new URL("./external-evaluation-plan.json", import.meta.url),
    "utf8",
  ),
);
const inputs = JSON.parse(
  await readFile(
    new URL("./external-evaluation-inputs.json", import.meta.url),
    "utf8",
  ),
);
assert.equal(sha256(JSON.stringify(plan, null, 2) + "\n"), inputs.planSha256);
assert.deepEqual(plan.rules, ["eqeqeq", "no-dupe-args", "no-unreachable"]);
assert.equal(plan.upstream.commit, "3f20a57c6293371b6193d3fb6746c2b7b2ac2689");
assert.deepEqual(
  inputs.files.map((item) => item.file),
  ["LICENSE", ...plan.rules.map((rule) => `tests/lib/rules/${rule}.js`)],
);
const require = createRequire(import.meta.url);
assert.equal(require("eslint/package.json").version, plan.expectedTool.eslint);
assert.equal(require("espree/package.json").version, plan.expectedTool.espree);
async function treeDigest(directory) {
  const hash = createHash("sha256");
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
        hash
          .update(file.split(path.sep).join("/"))
          .update("\0")
          .update(sha256(await readFile(path.join(directory, file))))
          .update("\0");
      }
    }
  }
  await visit();
  return hash.digest("hex");
}
async function identity() {
  return {
    runtimeArtifactsSha256: await treeDigest(path.join(repository, "dist/src")),
    packageLockSha256: sha256(
      await readFile(path.join(repository, "package-lock.json")),
    ),
    harnessSha256: sha256(
      Buffer.concat(
        await Promise.all(
          [
            "measure-external-evaluation.mjs",
            "external-evaluation-extract.mjs",
            "external-evaluation-evidence.mjs",
            "external-evaluation-worker.mjs",
          ].map((file) => readFile(new URL(file, import.meta.url))),
        ),
      ),
    ),
    inputsSha256: sha256(JSON.stringify(inputs)),
  };
}
const before = await identity();
for (const [key, value] of Object.entries(plan.frozenVerifier))
  assert.equal(
    before[key],
    value,
    "Verifier changed since external-case selection was declared",
  );
const sources = new Map();
async function checkInputs() {
  for (const item of inputs.files) {
    const bytes = await readFile(
      path.join(inputDirectory, path.posix.basename(item.file)),
    );
    assert.equal(bytes.length, item.bytes);
    assert.equal(sha256(bytes), item.sha256);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    sources.set(item.file, text);
  }
}
await checkInputs();
const extracted = plan.rules.map((rule) => ({
  rule,
  ...extractRuleCases(sources.get(`tests/lib/rules/${rule}.js`), rule, plan),
}));
const cases = extracted.flatMap((group) => group.cases);
const excluded = extracted.flatMap((group) => group.excluded);
const manifest = cases.map(
  ({ code, options, languageOptions, ...metadata }) => {
    void code;
    void options;
    void languageOptions;
    return metadata;
  },
);
assert.equal(
  cases.length + excluded.length,
  extracted.reduce((sum, group) => sum + group.total, 0),
);
const startedAt = new Date().toISOString();
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "repo-verifier-external-evaluation-")),
);
const observations = [];
async function execute(args) {
  const start = performance.now();
  const result = await runProcess(
    root,
    { executable: process.execPath, args, cwd: "." },
    { timeoutMs: 30000, maxOutputBytes: 1024 * 1024 },
  );
  assert.ok(
    !result.errorCode &&
      !result.signal &&
      !result.timedOut &&
      !result.truncated &&
      !result.cancelled,
    "Measurement process failed to complete",
  );
  return { result, wallMs: performance.now() - start };
}
try {
  await copyInstalledPackages(root, ["eslint"]);
  const toolArtifactsSha256 = await treeDigest(path.join(root, "node_modules"));
  await writeFile(path.join(root, "LICENSE"), sources.get("LICENSE"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await writeFile(
    path.join(root, "repo-verifier.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["javascript.eslint"] }],
    }),
  );
  for (const [index, item] of cases.entries()) {
    process.stderr.write(`Measuring ${item.id}\n`);
    await writeFile(path.join(root, "case.js"), item.code);
    const config = [
      {
        files: ["case.js"],
        languageOptions: item.languageOptions,
        rules: { [item.rule]: ["error", ...item.options] },
      },
      {
        files: ["eslint.config.cjs"],
        languageOptions: { ecmaVersion: "latest", sourceType: "commonjs" },
        rules: { "no-debugger": "error" },
      },
    ];
    await writeFile(
      path.join(root, "eslint.config.cjs"),
      `module.exports = ${JSON.stringify(config)};\n`,
    );
    const fingerprint = (await inventory(root)).fingerprint;
    for (const system of index % 2
      ? ["verifier", "native"]
      : ["native", "verifier"]) {
      const args =
        system === "verifier"
          ? [
              fileURLToPath(
                new URL("./external-evaluation-worker.mjs", import.meta.url),
              ),
              root,
            ]
          : [
              path.join(root, "node_modules/eslint/bin/eslint.js"),
              "--no-config-lookup",
              "--config",
              "eslint.config.cjs",
              "--format=json",
              "--no-cache",
              "--no-fix",
              "--max-warnings",
              "0",
              "case.js",
              "eslint.config.cjs",
            ];
      const { result, wallMs } = await execute(args);
      assert.equal(
        result.stderr,
        "",
        "Unexpected tool stderr invalidates the measurement",
      );
      let observation;
      if (system === "verifier") {
        assert.equal(result.exitCode, 0);
        observation = JSON.parse(result.stdout);
        assert.equal(observation.sourceFingerprint, fingerprint);
      } else {
        assert.ok([0, 1, 2].includes(result.exitCode));
        const diagnostics =
          result.exitCode === 2
            ? []
            : normalizeExternalDiagnostics(JSON.parse(result.stdout), root);
        if (result.exitCode !== 2)
          assert.equal(result.exitCode === 1, diagnostics.length > 0);
        observation = {
          outcome:
            result.exitCode === 0
              ? "passed"
              : result.exitCode === 1
                ? "failed"
                : "incomplete",
          diagnostics,
          toolVersion: require("eslint/package.json").version,
        };
      }
      assert.equal((await inventory(root)).fingerprint, fingerprint);
      observations.push({
        id: item.id,
        system,
        ...observation,
        sourceFingerprint: fingerprint,
        outputSha256: sha256(result.stdout),
        wallMs,
      });
    }
  }
  assert.equal(
    await treeDigest(path.join(root, "node_modules")),
    toolArtifactsSha256,
  );
  await checkInputs();
  assert.deepEqual(await identity(), before);
  process.stdout.write(
    JSON.stringify(
      {
        schemaVersion: 1,
        provenance: "externally-authored-native-rule-tests",
        interpretation: plan.purpose,
        startedAt,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        planSha256: inputs.planSha256,
        upstream: plan.upstream,
        identities: { ...before, toolArtifactsSha256 },
        extraction: extracted.map(({ rule, total, cases, excluded }) => ({
          rule,
          total,
          selected: cases.length,
          excluded: excluded.length,
        })),
        corpusSha256: sha256(JSON.stringify({ manifest, excluded })),
        manifest,
        excluded,
        observations,
        ...summarizeExternalCases(cases, observations, excluded),
        model: { invoked: false, tokens: 0, providerCostUSD: 0 },
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
