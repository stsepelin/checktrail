import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { runProcess } from "../dist/src/runner.js";
import { inventory } from "../dist/src/inventory.js";
import { VERSION } from "../dist/src/types.js";

const args = process.argv.slice(2);
if (
  args.length &&
  (args.length !== 2 || args[0] !== "--samples" || !/^\d+$/.test(args[1]))
)
  throw new Error(
    "Usage: node scripts/measure-performance.mjs [--samples 5..30]",
  );
const samples = args.length ? Number(args[1]) : 10;
assert.ok(samples >= 5 && samples <= 30);
const repository = fileURLToPath(new URL("../", import.meta.url));
const worker = fileURLToPath(
  new URL("./performance-worker.mjs", import.meta.url),
);
const cases = [
  { id: "small", projects: 1, modulesPerProject: 10 },
  { id: "large", projects: 1, modulesPerProject: 1000 },
  { id: "workspace", projects: 20, modulesPerProject: 50 },
];
const digest = (value) => createHash("sha256").update(value).digest("hex");
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
      else if (entry.isFile())
        hash
          .update(file.split(path.sep).join("/"))
          .update("\0")
          .update(digest(await readFile(path.join(directory, file))))
          .update("\0");
      else throw new Error("Unexpected runtime artifact kind");
    }
  }
  await visit("");
  return hash.digest("hex");
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  assert.ok(
    sorted.length === samples &&
      sorted.every((value) => Number.isFinite(value) && value >= 0),
  );
  return {
    min: sorted[0],
    median:
      (sorted[Math.floor((sorted.length - 1) / 2)] +
        sorted[Math.ceil((sorted.length - 1) / 2)]) /
      2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
}
async function artifactIdentity() {
  return {
    runtimeArtifactsSha256: await treeDigest(path.join(repository, "dist/src")),
    packageLockSha256: digest(
      await readFile(path.join(repository, "package-lock.json")),
    ),
    harnessSha256: digest(
      Buffer.concat([
        await readFile(fileURLToPath(import.meta.url)),
        await readFile(worker),
      ]),
    ),
  };
}
const identity = await artifactIdentity();
const temporary = await mkdtemp(path.join(tmpdir(), "checktrail-performance-"));
try {
  const fixtures = [];
  for (const specification of cases) {
    const root = path.join(temporary, specification.id);
    let inputBytes = 0;
    for (let index = 0; index < specification.projects; index++) {
      const project =
        specification.projects === 1
          ? root
          : path.join(root, `project-${String(index).padStart(2, "0")}`);
      await mkdir(project, { recursive: true });
      const files = {
        "package.json": JSON.stringify({
          private: true,
          type: "module",
          scripts: { test: "node --test" },
        }),
      };
      const imports = [];
      const values = [];
      for (let module = 0; module < specification.modulesPerProject; module++) {
        const name = `value-${String(module).padStart(4, "0")}.js`;
        files[name] = `export const value = ${module};\n`;
        imports.push(`import {value as v${module}} from './${name}';`);
        values.push(`v${module}`);
      }
      const total =
        (specification.modulesPerProject *
          (specification.modulesPerProject - 1)) /
        2;
      files["values.test.js"] =
        `import {test} from 'node:test';\nimport assert from 'node:assert/strict';\n${imports.join("\n")}\ntest('sums all fixture modules', () => assert.equal([${values.join(",")}].reduce((sum, value) => sum + value, 0), ${total}));\n`;
      for (const [name, text] of Object.entries(files)) {
        inputBytes += Buffer.byteLength(text);
        await writeFile(path.join(project, name), text);
      }
    }
    const source = await inventory(root);
    assert.equal(
      source.files.length,
      specification.projects * (specification.modulesPerProject + 2),
    );
    fixtures.push({
      ...specification,
      root,
      files: source.files.length,
      inputBytes,
      fingerprint: source.fingerprint,
    });
  }
  const observations = new Map();
  for (let round = 0; round < samples; round++) {
    for (let offset = 0; offset < fixtures.length * 2; offset++) {
      const order = (offset + round) % (fixtures.length * 2);
      const fixture = fixtures[Math.floor(order / 2)];
      const mode = order % 2 === 0 ? "plan" : "validate";
      const execution = await runProcess(
        fixture.root,
        {
          executable: process.execPath,
          args: [
            worker,
            fixture.root,
            mode,
            String(fixture.projects),
            String(fixture.files),
          ],
          cwd: ".",
        },
        { timeoutMs: 60000, maxOutputBytes: 64 * 1024 },
      );
      assert.equal(execution.exitCode, 0, execution.stderr);
      assert.ok(
        !execution.signal &&
          !execution.errorCode &&
          !execution.timedOut &&
          !execution.cancelled &&
          !execution.truncated &&
          !execution.stderr,
      );
      const value = JSON.parse(execution.stdout);
      assert.equal(value.fingerprint, fixture.fingerprint);
      assert.equal(value.checks, fixture.projects);
      assert.equal(value.executedTests, mode === "plan" ? 0 : fixture.projects);
      const key = `${fixture.id}/${mode}`;
      const collected = observations.get(key) ?? [];
      collected.push({ round, wallMs: execution.durationMs, ...value });
      observations.set(key, collected);
    }
    process.stderr.write(`Measured round ${round + 1}/${samples}\n`);
  }
  const results = [];
  for (const fixture of fixtures) {
    assert.equal(
      (await inventory(fixture.root)).fingerprint,
      fixture.fingerprint,
    );
    for (const mode of ["plan", "validate"]) {
      const measurements = observations.get(`${fixture.id}/${mode}`);
      results.push({
        case: fixture.id,
        mode,
        projects: fixture.projects,
        modulesPerProject: fixture.modulesPerProject,
        files: fixture.files,
        inputBytes: fixture.inputBytes,
        fingerprint: fixture.fingerprint,
        samples: measurements,
        summary: Object.fromEntries(
          ["wallMs", "engineMs", "engineCpuMs", "enginePeakRssKiB"].map(
            (key) => [
              key,
              distribution(measurements.map((measurement) => measurement[key])),
            ],
          ),
        ),
      });
    }
  }
  assert.deepEqual(
    await artifactIdentity(),
    identity,
    "Measured runtime and harness must remain unchanged",
  );
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, measuredAt: new Date().toISOString(), engineVersion: VERSION, node: process.version, platform: process.platform, architecture: process.arch, availableParallelism: availableParallelism(), ...identity, method: { freshProcessPerSample: true, warmFilesystemCache: "uncontrolled", rotatedCaseOrder: true, engineCpuAndMemoryExcludeChildProcesses: true, fixturesCreatedOutsideMeasurements: true, percentile: "nearest-rank", regressionBudget: null }, results }, null, 2)}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
