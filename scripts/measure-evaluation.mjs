import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { z } from "zod";
import { inventory } from "../dist/src/inventory.js";
import { runProcess } from "../dist/src/runner.js";
import { VERSION } from "../dist/src/types.js";
import { summarizeEvaluation } from "./evaluation-metrics.mjs";

assert.equal(
  process.argv.length,
  2,
  "Usage: node scripts/measure-evaluation.mjs",
);
const repository = fileURLToPath(new URL("../", import.meta.url));
const worker = fileURLToPath(
  new URL("./evaluation-worker.mjs", import.meta.url),
);
const corpusPath = fileURLToPath(
  new URL("./evaluation-corpus.json", import.meta.url),
);
const corpusSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string(),
  provenance: z.string(),
  cases: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9-]+$/),
        family: z.enum(["node", "typescript", "actionlint"]),
        label: z.enum([
          "defect",
          "valid",
          "insufficient-evidence",
          "unsupported-profile",
        ]),
        files: z.record(z.string(), z.string().max(64 * 1024)),
        engineSignal: z.string().optional(),
        nativeSignal: z.string().optional(),
      }),
    )
    .min(1)
    .max(64),
});
const corpusBytes = await readFile(corpusPath);
assert.ok(corpusBytes.length <= 2 * 1024 * 1024);
const corpus = corpusSchema.parse(JSON.parse(corpusBytes.toString()));
assert.equal(
  new Set(corpus.cases.map((item) => item.id)).size,
  corpus.cases.length,
);
assert.ok(
  corpus.cases.every(
    (item) =>
      item.label !== "defect" || (item.engineSignal && item.nativeSignal),
  ),
  "Defect labels require specific native and engine signals",
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function treeDigest(directory) {
  const hash = createHash("sha256");
  async function visit(relative) {
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
          .update(digest(await readFile(path.join(directory, file))))
          .update("\0");
      }
    }
  }
  await visit("");
  return hash.digest("hex");
}
const compiler = path.dirname(
  path.dirname(fileURLToPath(import.meta.resolve("typescript"))),
);
const compilerMetadata = JSON.parse(
  await readFile(path.join(compiler, "package.json"), "utf8"),
);
assert.equal(compilerMetadata.version, "6.0.3");
async function identity() {
  return {
    runtimeArtifactsSha256: await treeDigest(path.join(repository, "dist/src")),
    packageLockSha256: digest(
      await readFile(path.join(repository, "package-lock.json")),
    ),
    compilerArtifactsSha256: await treeDigest(compiler),
    corpusSha256: digest(await readFile(corpusPath)),
    harnessSha256: digest(
      Buffer.concat(
        await Promise.all(
          [
            import.meta.url,
            new URL("./evaluation-worker.mjs", import.meta.url),
            new URL("./evaluation-metrics.mjs", import.meta.url),
          ].map((url) => readFile(fileURLToPath(url))),
        ),
      ),
    ),
  };
}
const before = await identity();
const startedAt = new Date().toISOString();
const temporary = await mkdtemp(
  path.join(tmpdir(), "repo-verifier-evaluation-"),
);
const observations = [];
async function execute(root, executable, args) {
  const start = performance.now();
  const result = await runProcess(
    root,
    { executable, args, cwd: "." },
    { timeoutMs: 60000, maxOutputBytes: 1024 * 1024 },
  );
  assert.ok(
    !result.errorCode &&
      !result.signal &&
      !result.timedOut &&
      !result.truncated &&
      !result.cancelled,
    "Measurement process did not complete",
  );
  return { result, wallMs: performance.now() - start };
}
try {
  const probe = await execute(temporary, "actionlint", ["-version"]);
  assert.equal(probe.result.exitCode, 0);
  assert.equal(probe.result.stderr, "");
  assert.match(
    probe.result.stdout,
    /^1\.7\.12\ninstalled by downloading from release page\nbuilt with go[^\n]+ compiler for (?:darwin|linux)\/(?:amd64|arm64)\n$/,
  );
  for (const [index, item] of corpus.cases.entries()) {
    process.stderr.write(`Measuring ${item.id}\n`);
    const root = path.join(temporary, item.id);
    await mkdir(root);
    const entries = Object.entries(item.files);
    assert.ok(entries.length > 0 && entries.length <= 32);
    assert.ok(
      entries.reduce((size, [, text]) => size + Buffer.byteLength(text), 0) <=
        256 * 1024,
    );
    for (const [file, text] of entries) {
      assert.ok(
        file &&
          !path.posix.isAbsolute(file) &&
          path.posix.normalize(file) === file &&
          !file.startsWith("../") &&
          !file.includes("\\") &&
          !file.includes("\0") &&
          !file
            .split("/")
            .some((part) => [".git", "node_modules"].includes(part)),
      );
      const output = path.join(root, file);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, text, { flag: "wx" });
    }
    if (item.family === "typescript")
      await cp(compiler, path.join(root, "node_modules/typescript"), {
        recursive: true,
      });
    if (item.family === "actionlint") await mkdir(path.join(root, ".git"));
    const source = await inventory(root);
    assert.equal(source.files.length, entries.length);
    const checkId = {
      node: "javascript.node-test",
      typescript: "javascript.typescript",
      actionlint: "infrastructure.actionlint",
    }[item.family];
    const commands = {
      node: [
        process.execPath,
        ["--test", "--test-reporter=tap", "value.test.js"],
      ],
      typescript: [
        process.execPath,
        [
          path.join(root, "node_modules/typescript/bin/tsc"),
          "--project",
          "tsconfig.json",
          "--noEmit",
          "--incremental",
          "false",
          "--pretty",
          "false",
        ],
      ],
      actionlint: [
        "actionlint",
        [
          "-format",
          "{{json .}}",
          "-shellcheck=",
          "-pyflakes=",
          "-no-color",
          ".github/workflows/check.yml",
        ],
      ],
    };
    const observation = {
      id: item.id,
      fingerprint: source.fingerprint,
      files: source.files.length,
    };
    for (const system of index % 2
      ? ["engine", "native"]
      : ["native", "engine"]) {
      const command =
        system === "engine"
          ? [process.execPath, [worker, root, checkId]]
          : commands[item.family];
      const { result, wallMs } = await execute(root, command[0], command[1]);
      if (system === "engine") {
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stderr, "");
        const evidence = JSON.parse(result.stdout);
        assert.equal(evidence.sourceFingerprint, source.fingerprint);
        observation.engine = {
          ...evidence,
          signalMatched:
            !item.engineSignal || evidence.signals.includes(item.engineSignal),
          wallMs,
        };
      } else {
        assert.ok([0, 1, 2].includes(result.exitCode));
        const text = result.stdout + result.stderr;
        observation.native = {
          outcome: result.exitCode === 0 ? "passed" : "failed",
          exitCode: result.exitCode,
          signalMatched: !item.nativeSignal || text.includes(item.nativeSignal),
          outputSha256: digest(text.replaceAll(root, "<project>")),
          wallMs,
        };
      }
      assert.equal((await inventory(root)).fingerprint, source.fingerprint);
    }
    observations.push(observation);
    await rm(root, { recursive: true, force: true });
  }
  assert.deepEqual(await identity(), before);
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        startedAt,
        finishedAt: new Date().toISOString(),
        engineVersion: VERSION,
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.versions.node,
        typescriptVersion: compilerMetadata.version,
        actionlintVersion: probe.result.stdout.trim(),
        corpus: {
          id: corpus.id,
          provenance: corpus.provenance,
          cases: corpus.cases.length,
        },
        identities: before,
        model: { used: false, tokens: 0, providerCost: 0 },
        priorWorkflow: {
          measured: false,
          reason:
            "No independently labeled prior-workflow results were supplied",
        },
        confidenceIntervals: {
          estimated: false,
          reason:
            "Small paired convenience corpus; no population sampling or independence claim",
        },
        summaries: summarizeEvaluation(corpus.cases, observations),
        observations,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
