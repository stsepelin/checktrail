import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { z } from "zod";
import { runProcess } from "../dist/src/runner.js";
import { inventory } from "../dist/src/inventory.js";
import { VERSION } from "../dist/src/types.js";
import { fixtureGit } from "../dist/test/git-fixture.js";
import { prepareImpactFixture, projects } from "./impact-fixture.mjs";
import { summarizeImpact } from "./impact-metrics.mjs";

assert.equal(process.argv.length, 2, "Usage: node scripts/measure-impact.mjs");
const repetitions = 3;
const corpusPath = new URL("./impact-corpus.json", import.meta.url);
const worker = fileURLToPath(new URL("./impact-worker.mjs", import.meta.url));
const corpusSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string(),
  provenance: z.string(),
  cases: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9-]+$/),
        graph: z.enum([
          "declared-complete",
          "declared-incomplete",
          "misdeclared-complete",
        ]),
        changes: z.record(z.string(), z.string().max(4096)),
        selectedProjects: z.array(z.enum(projects)).min(1),
        failingProjects: z.array(z.enum(projects)),
        mode: z.enum(["full", "affected"]),
      }),
    )
    .min(1)
    .max(32),
});
const corpus = corpusSchema.parse(
  JSON.parse(await readFile(corpusPath, "utf8")),
);
assert.equal(
  new Set(corpus.cases.map((item) => item.id)).size,
  corpus.cases.length,
);
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function treeDigest(root) {
  const hash = createHash("sha256");
  async function walk(relative) {
    for (const entry of (
      await readdir(path.join(root, relative), { withFileTypes: true })
    ).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(file);
      else {
        assert.ok(entry.isFile());
        hash
          .update(file.split(path.sep).join("/"))
          .update("\0")
          .update(digest(await readFile(path.join(root, file))))
          .update("\0");
      }
    }
  }
  await walk("");
  return hash.digest("hex");
}
async function identities() {
  return {
    corpusSha256: digest(await readFile(corpusPath)),
    packageLockSha256: digest(
      await readFile(new URL("../package-lock.json", import.meta.url)),
    ),
    runtimeArtifactsSha256: await treeDigest(
      fileURLToPath(new URL("../dist/src", import.meta.url)),
    ),
    harnessSha256: digest(
      Buffer.concat(
        await Promise.all(
          [
            import.meta.url,
            new URL("./impact-worker.mjs", import.meta.url),
            new URL("./impact-fixture.mjs", import.meta.url),
            new URL("./impact-metrics.mjs", import.meta.url),
            new URL("../dist/test/git-fixture.js", import.meta.url),
          ].map((url) => readFile(fileURLToPath(url))),
        ),
      ),
    ),
  };
}
async function run(root, base) {
  const started = performance.now();
  const execution = await runProcess(
    root,
    { executable: process.execPath, args: [worker, root, base], cwd: "." },
    { timeoutMs: 60_000 },
  );
  assert.ok(
    !execution.signal &&
      !execution.cancelled &&
      !execution.timedOut &&
      !execution.truncated &&
      !execution.errorCode,
  );
  assert.equal(execution.exitCode, 0, execution.stderr);
  assert.equal(execution.stderr, "");
  return {
    ...JSON.parse(execution.stdout),
    wallMs: performance.now() - started,
  };
}
function checkObservation(run, selectedProjects, failingProjects) {
  assert.deepEqual(
    run.checks.map((check) => check.project).sort(),
    selectedProjects,
  );
  const failed = failingProjects.filter((project) =>
    selectedProjects.includes(project),
  );
  assert.equal(run.outcome, failed.length ? "failed" : "passed");
  for (const check of run.checks) {
    const expected = Number(failed.includes(check.project));
    assert.equal(check.status, expected ? "failed" : "passed");
    assert.deepEqual(check.tests, {
      total: 1,
      passed: 1 - expected,
      failed: expected,
      skipped: 0,
    });
    assert.deepEqual(
      check.assertions,
      expected ? [`${check.project} contract`] : [],
    );
    assert.deepEqual(check.tools, [
      { name: "node", version: process.versions.node },
    ]);
  }
}
const before = await identities();
const startedAt = new Date().toISOString();
const temporary = await mkdtemp(path.join(tmpdir(), "checktrail-impact-"));
const observations = [];
const baselines = [];
try {
  const gitVersion = fixtureGit(temporary, ["--version"]).trim();
  for (const [index, specification] of corpus.cases.entries()) {
    process.stderr.write(`Measuring ${specification.id}\n`);
    const root = path.join(temporary, specification.id);
    await mkdir(root);
    const fixture = await prepareImpactFixture(root, specification);
    const baseline = await run(root, "full");
    checkObservation(baseline, projects, []);
    baselines.push({ id: specification.id, ...baseline });
    await fixture.applyChanges();
    const source = await inventory(root);
    for (let repetition = 0; repetition < repetitions; repetition++) {
      const order =
        (index + repetition) % 2 ? ["selected", "full"] : ["full", "selected"];
      const result = {};
      for (const mode of order)
        result[mode] = await run(root, mode === "full" ? "full" : fixture.base);
      checkObservation(result.full, projects, specification.failingProjects);
      checkObservation(
        result.selected,
        specification.selectedProjects,
        specification.failingProjects,
      );
      assert.equal(result.full.sourceFingerprint, source.fingerprint);
      assert.equal(result.selected.sourceFingerprint, source.fingerprint);
      assert.equal(
        result.full.policyFingerprint,
        result.selected.policyFingerprint,
      );
      assert.equal(result.selected.selection.mode, specification.mode);
      assert.deepEqual(
        result.selected.selection.projects,
        specification.selectedProjects,
      );
      assert.deepEqual(
        result.selected.selection.changedFiles,
        Object.keys(specification.changes).sort(),
      );
      assert.equal(result.selected.selection.gitVersion, gitVersion);
      assert.equal((await inventory(root)).fingerprint, source.fingerprint);
      observations.push({ id: specification.id, repetition, order, ...result });
    }
  }
  assert.deepEqual(
    await identities(),
    before,
    "Measurement artifacts changed during execution",
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        format: "synthetic-impact-measurement",
        engineVersion: VERSION,
        startedAt,
        completedAt: new Date().toISOString(),
        environment: {
          platform: process.platform,
          arch: process.arch,
          node: process.versions.node,
          git: gitVersion,
        },
        corpus: {
          id: corpus.id,
          provenance: corpus.provenance,
          cases: corpus.cases.length,
          repetitions,
        },
        identities: before,
        baselines,
        observations,
        summaries: summarizeImpact(corpus.cases, observations, repetitions),
        limitations: [
          "Post-implementation synthetic development cases, not held-out evaluation",
          "Maintainer-declared dependency graph; no native import inference",
          "Repeated observations are not independent defect samples",
          "No general performance or review-quality claim",
          "Engine CPU/RSS excludes native child resource use",
          "No model calls or token-cost comparison",
        ],
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
