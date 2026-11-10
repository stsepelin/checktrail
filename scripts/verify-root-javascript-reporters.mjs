import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
import {
  captureSmokeProductionGraph,
  copySmokeToolGraph,
} from "./package-smoke-tools.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-root-reporters-"),
);
try {
  const [packed] = JSON.parse(
    runAcceptanceNpm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const consumer = path.join(temporary, "consumer");
  await installAcceptancePackage(
    repository,
    path.join(temporary, packed.filename),
    consumer,
  );
  const production = await captureSmokeProductionGraph(consumer);
  const lock = JSON.parse(
    await readFile(path.join(repository, "package-lock.json"), "utf8"),
  );
  const tools = await copySmokeToolGraph(
    path.join(consumer, "current-root-runners"),
    {
      modules: await realpath(path.join(repository, "node_modules")),
      packages: ["vitest", "vite", "jest"],
      lock,
    },
  );
  const families = ["vitest", "jest"];
  await writeFile(
    path.join(consumer, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: families.map((name) => ({
        path: "current-root-runners/" + name,
        checks: ["javascript." + name],
      })),
    }),
  );
  for (const family of families) {
    const directory = path.join(consumer, "current-root-runners", family);
    await mkdir(directory);
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    if (family === "jest")
      await writeFile(
        path.join(directory, "jest.config.cjs"),
        "module.exports={};\n",
      );
  }
  const cases = [];
  for (const phase of ["broken", "fixed", "near-miss", "skipped"]) {
    for (const family of families) {
      const directory = path.join(consumer, "current-root-runners", family);
      const extension = family === "vitest" ? "js" : "cjs";
      const imports =
        family === "vitest" ? "import {test,expect} from 'vitest';" : "";
      const name =
        phase === "near-miss"
          ? "test.only and test.skip are ordinary title text"
          : "intended assertion";
      await writeFile(
        path.join(directory, "first.test." + extension),
        imports +
          "test('ordinary passing control',()=>expect(2+3).toBe(5));" +
          (phase === "skipped" ? "test.skip" : "test") +
          "(" +
          JSON.stringify(name) +
          ",()=>expect(2+3).toBe(" +
          (phase === "broken" ? 6 : 5) +
          "));\n",
      );
      await writeFile(
        path.join(directory, "second.test." + extension),
        imports +
          "test('second file control',()=>expect(3*3).toBe(9));test('third passing control',()=>expect('near').toContain('ear'));\n",
      );
    }
    const report = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import{validate}from'@stsepelin/checktrail';console.log(JSON.stringify(await validate(process.cwd(),{trusted:true})));",
        ],
        {
          cwd: consumer,
          encoding: "utf8",
          timeout: 90000,
          maxBuffer: 8 * 1024 * 1024,
        },
      ),
    );
    const context = JSON.stringify({
      phase,
      outcome: report.outcome,
      checks: report.checks.map(({ id, status, reason, tests }) => ({
        id,
        status,
        tests,
        reason: reason?.slice(0, 300),
      })),
    });
    assert.equal(report.checks.length, families.length, context);
    assert.equal(report.sourceChanged, false);
    assert.equal(
      report.outcome,
      phase === "broken"
        ? "failed"
        : phase === "skipped"
          ? "incomplete"
          : "passed",
      context,
    );
    const expected = {
      total: 4,
      passed: phase === "broken" || phase === "skipped" ? 3 : 4,
      failed: phase === "broken" ? 1 : 0,
      skipped: phase === "skipped" ? 1 : 0,
    };
    const observations = families.map((family) => {
      const check = report.checks.find(
        (check) => check.id === "javascript." + family,
      );
      assert.ok(check);
      assert.deepEqual(check.tests, expected, context);
      // Preserve the generic engine contract: mixed Vitest skips can be passed,
      // while Jest pending cases are inconclusive. This stricter reporter control
      // never qualifies an intended skipped assertion as completed evidence.
      const status =
        phase === "broken"
          ? "failed"
          : phase === "skipped" && family === "jest"
            ? "inconclusive"
            : "passed";
      assert.equal(check.status, status, context);
      return { family, status: check.status, tests: check.tests };
    });
    assert.deepEqual(
      await captureSmokeProductionGraph(consumer),
      production,
      "Root reporter controls changed the installed production graph",
    );
    cases.push({
      phase,
      qualification:
        phase === "skipped" ? "incomplete" : "expected-control-observed",
      outcome: report.outcome,
      observations,
    });
  }
  const versions = Object.fromEntries(
    families.map((name) => [
      name,
      tools.packages.find((item) => item.location === "node_modules/" + name)
        .version,
    ]),
  );
  process.stdout.write(
    JSON.stringify({
      currentRootReportersVerified: true,
      installedPackage: true,
      offlineProductionInstall: true,
      productionGraphUnchanged: true,
      versions,
      cases,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
