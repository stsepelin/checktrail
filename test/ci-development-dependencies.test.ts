import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { fixture } from "./helpers.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const { classifyDevelopmentBump, dependencyHostCondition } = await import(
  new URL("../../scripts/plan-ci-impact.mjs", import.meta.url).href
);
const { buildNativeInputs, planNativeJobs, requireCiCompletion } = await import(
  new URL("../../scripts/ci-impact.mjs", import.meta.url).href
);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const jobs = [
  "original-vite",
  "original-vitest",
  "original-mutation",
  "unrelated",
];
const workflow = {
  jobs: { "host-validation": { if: dependencyHostCondition } },
};
const inputs: Record<string, string[]> = {
  "test/vite-library.test.ts": ["original-vite"],
  "test/gate-javascript-extensions.test.ts": ["original-vite"],
  "test/vitest.test.ts": ["original-vitest"],
  "test/jest.test.ts": ["original-vitest"],
  "test/mutation-native-fixture.ts": ["original-mutation"],
  "test/unrelated.test.ts": ["unrelated"],
};
const sourceFiles: Record<string, string> = {
  "scripts/javascript-tools/package.json":
    '{"private":true,"dependencies":{"vite":"1.0.0"}}',
  "scripts/javascript-tools/package-lock.json":
    '{"lockfileVersion":3,"packages":{"":{"dependencies":{"vite":"1.0.0"}}}}',
  "scripts/prepare-javascript-tools.mjs":
    'export const qualified="independent";',
  "test/development-bundlers.test.ts":
    'import {build} from "vite";import {rolldown} from "rolldown";',
  "test/vitest.test.ts":
    'copyInstalledPackages("synthetic", ["vitest","vite"]);',
  "test/jest.test.ts": 'copyInstalledPackages("synthetic", ["jest"]);',
  "test/vite-library.test.ts":
    'copyInstalledPackages("synthetic", ["vite"], qualified);',
  "test/mutation-native-fixture.ts":
    'copyInstalledPackages("synthetic", family==="vitest"?["vitest","vite"]:["jest"], qualified);',
  "test/gate-javascript-extensions.test.ts": "export {};",
  "test/unrelated.test.ts": "export {};",
  "test/ci-development-dependencies.test.ts": "export {};",
  "test/ci-validation.test.ts": "export {};",
  "test/dependency-audit.test.ts": "export {};",
  "test/development-dependency-audit.test.ts": "export {};",
  "test/javascript-tool-preparation.test.ts": "export {};",
  "test/consumer-witness-project.test.ts": "export {};",
  "test/mutation-native-evidence.test.ts": "export {};",
  "test/mutation-native-guards.test.ts": "export {};",
  "test/mutation-native-selection.test.ts": "export {};",
};
const qualificationHashes = Object.fromEntries(
  Object.entries(sourceFiles)
    .filter(([file]) => file.startsWith("scripts/"))
    .map(([file, text]) => [file, hash(text)]),
);
const consumerHashes = Object.fromEntries(
  Object.entries(sourceFiles)
    .filter(([file]) => file.startsWith("test/"))
    .map(([file, text]) => [file, hash(text)]),
);
type Entry = {
  version: string;
  name?: string;
  dev?: boolean;
  resolved: string;
  integrity: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional: boolean }>;
};
type Manifest = {
  name: string;
  version: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  overrides?: Record<string, string>;
};
type Lock = {
  name: string;
  version: string;
  lockfileVersion: number;
  packages: Record<string, Entry | Manifest>;
};
const entry = (name: string, version = "1.0.0", dev = true): Entry => ({
  version,
  ...(dev ? { dev: true } : {}),
  resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`,
  integrity: "sha512-" + Buffer.alloc(64).toString("base64"),
});
function graph(): { manifest: Manifest; lock: Lock } {
  const manifest: Manifest = {
    name: "original-ci-fixture",
    version: "1.0.0",
    scripts: { build: "tsc", test: "node test.mjs" },
    dependencies: { "original-runtime": "1.0.0" },
    devDependencies: {
      vite: "1.0.0",
      rolldown: "1.0.0",
      vitest: "1.0.0",
      jest: "1.0.0",
      "vitest-native-mutation": "npm:vitest@5.0.5",
    },
  };
  const lock: Lock = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    packages: {
      "": structuredClone(manifest),
      "node_modules/original-runtime": entry(
        "original-runtime",
        "1.0.0",
        false,
      ),
    },
  };
  for (const name of ["vite", "rolldown", "vitest", "jest"])
    lock.packages["node_modules/" + name] = entry(name);
  lock.packages["node_modules/vitest-native-mutation"] = {
    ...entry("vitest", "5.0.5"),
    name: "vitest",
    dependencies: { vite: "*" },
  };
  (lock.packages["node_modules/vitest"] as Entry).dependencies = { vite: "*" };
  (lock.packages["node_modules/vite"] as Entry).dependencies = {
    rolldown: "*",
  };
  return { manifest, lock };
}
function bumpVite(manifest: Manifest, lock: Lock) {
  manifest.devDependencies.vite = "1.1.0";
  lock.packages["node_modules/vite"] = {
    ...entry("vite", "1.1.0"),
    dependencies: { rolldown: "2.0.0" },
  };
  lock.packages["node_modules/vite/node_modules/rolldown"] = {
    ...entry("rolldown", "2.0.0"),
    dependencies: { "original-native": "1.0.0" },
  };
  lock.packages["node_modules/vite/node_modules/original-native"] =
    entry("original-native");
}
function bumpRolldown(manifest: Manifest, lock: Lock) {
  manifest.devDependencies.rolldown = "1.1.0";
  lock.packages["node_modules/rolldown"] = {
    ...entry("rolldown", "1.1.0"),
    dependencies: { "original-shared": "2.0.0" },
  };
  lock.packages["node_modules/original-shared"] = entry(
    "original-shared",
    "2.0.0",
  );
}
type Change = (
  manifest: Manifest,
  lock: Lock,
  files: Record<string, string>,
) => void;
async function gitGraph(
  t: TestContext,
  { before, after = bumpVite }: { before?: Change; after?: Change } = {},
) {
  const { manifest, lock } = graph();
  const files = { ...sourceFiles };
  before?.(manifest, lock, files);
  lock.packages[""] = structuredClone(manifest);
  const directory = await fixture(t, {});
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
      {
        cwd: directory,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Synthetic",
          GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
          GIT_COMMITTER_NAME: "Synthetic",
          GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
        },
      },
    ).trim();
  const save = async () => {
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      await writeFile(path.join(directory, file), text);
    }
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify(manifest),
    );
    await writeFile(
      path.join(directory, "package-lock.json"),
      JSON.stringify(lock),
    );
    git("add", ".");
    git("commit", "-m", "Synthetic dependency graph");
    return git("rev-parse", "HEAD");
  };
  git("init", "--initial-branch=main");
  const base = await save();
  after(manifest, lock, files);
  lock.packages[""] = structuredClone(manifest);
  const head = await save();
  const options = {
    repository: directory,
    base,
    head,
    workflow,
    inputs,
    qualificationHashes,
    consumerHashes,
    resolutionHash: hash("{}"),
  };
  return { options, directory, git };
}

test("development-only Git graph routes Vite and all shared Vitest/alias owners with full controls", async (t) => {
  const { options } = await gitGraph(t);
  const result = classifyDevelopmentBump(options);
  assert.deepEqual(result.evidence.affectedDevelopmentRoots, [
    "vite",
    "vitest",
    "vitest-native-mutation",
  ]);
  assert.deepEqual(result.evidence.declaredBumps, [
    { name: "vite", before: "1.0.0", after: "1.1.0" },
  ]);
  assert.deepEqual(result.routedFiles, [
    "test/gate-javascript-extensions.test.ts",
    "test/mutation-native-fixture.ts",
    "test/vite-library.test.ts",
    "test/vitest.test.ts",
  ]);
  for (const file of [
    "development-bundlers",
    "javascript-tool-preparation",
    "consumer-witness-project",
    "mutation-native-evidence",
    "mutation-native-guards",
    "mutation-native-selection",
    "ci-development-dependencies",
  ])
    assert.ok(
      result.sharedTestFiles.includes(`dist/test/${file}.test.js`),
      file,
    );
  assert.equal(result.evidence.changedLockEntries.length, 3);
});

test("attributable Rolldown graph retains the real shared Jest and complete native owner/control union", async (t) => {
  const { options } = await gitGraph(t, {
    before: (_m, l) => {
      (l.packages["node_modules/rolldown"] as Entry).dependencies = {
        "original-shared": "1.0.0",
      };
      (l.packages["node_modules/jest"] as Entry).dependencies = {
        "original-shared": "*",
      };
      l.packages["node_modules/original-shared"] = entry("original-shared");
    },
    after: bumpRolldown,
  });
  const result = classifyDevelopmentBump(options);
  assert.deepEqual(result.evidence.affectedDevelopmentRoots, [
    "jest",
    "rolldown",
    "vite",
    "vitest",
    "vitest-native-mutation",
  ]);
  assert.ok(result.routedFiles.includes("test/jest.test.ts"));
  assert.ok(result.sharedTestFiles.includes("dist/test/jest.test.js"));
});

test("development graph rejects shared production, compiler effects and unrelated re-resolutions", async (t) => {
  const cases: Array<{
    name: string;
    before?: Change;
    after?: Change;
    reason: RegExp;
  }> = [
    {
      name: "production descendant",
      before: (_m, l) => {
        (l.packages["node_modules/original-runtime"] as Entry).dependencies = {
          vite: "*",
        };
      },
      reason: /production\/compiler\/build\/lint/,
    },
    {
      name: "nested production descendant",
      before: (_m, l) => {
        (l.packages["node_modules/original-runtime"] as Entry).dependencies = {
          bridge: "*",
        };
        l.packages["node_modules/bridge"] = {
          ...entry("bridge", "1.0.0", false),
          dependencies: { vite: "*" },
        };
      },
      reason: /production\/compiler\/build\/lint/,
    },
    {
      name: "same root also declared as a production peer",
      before: (m) => {
        m.peerDependencies = { vite: "*" };
      },
      reason: /production\/compiler\/build\/lint/,
    },
    {
      name: "optional peer cannot shadow required dependency",
      after: (m, l) => {
        bumpVite(m, l);
        const e = l.packages["node_modules/vite"] as Entry;
        e.dependencies!["original-missing"] = "*";
        e.peerDependencies = { "original-missing": "*" };
        e.peerDependenciesMeta = { "original-missing": { optional: true } };
      },
      reason: /Unresolved required dependency/,
    },
    {
      name: "prototype-named required dependency is still an edge",
      after: (m, l) => {
        bumpVite(m, l);
        (l.packages["node_modules/vite"] as Entry).dependencies =
          Object.fromEntries([["__proto__", "*"]]);
      },
      reason: /Unresolved required dependency/,
    },
    {
      name: "invalid integrity length",
      after: (m, l) => {
        bumpVite(m, l);
        (l.packages["node_modules/vite"] as Entry).integrity = "sha512-aA==";
      },
      reason: /Invalid locked SHA-512/,
    },
    {
      name: "traversing lock location",
      before: (_m, l) => {
        l.packages["node_modules/.."] = entry("original-invalid");
      },
      reason: /Invalid lock location/,
    },
    {
      name: "compiler root bump",
      before: (m, l) => {
        m.devDependencies.typescript = "1.0.0";
        l.packages["node_modules/typescript"] = entry("typescript");
      },
      after: (m, l) => {
        bumpVite(m, l);
        m.devDependencies.typescript = "1.1.0";
        l.packages["node_modules/typescript"] = entry("typescript", "1.1.0");
      },
      reason: /Unreviewed development root bump/,
    },
    {
      name: "unrelated same-range descendant",
      before: (_m, l) => {
        (l.packages["node_modules/vite"] as Entry).dependencies!.unrelated =
          "^1.0.0";
        l.packages["node_modules/unrelated"] = entry("unrelated");
      },
      after: (m, l) => {
        bumpVite(m, l);
        (l.packages["node_modules/vite"] as Entry).dependencies!.unrelated =
          "^1.0.0";
        l.packages["node_modules/unrelated"] = entry("unrelated", "1.0.1");
      },
      reason: /Unrelated dependency re-resolution/,
    },
    {
      name: "duplicate canonical alias",
      before: (m, l) => {
        m.devDependencies["second-alias"] = "npm:vitest@5.0.5";
        l.packages["node_modules/second-alias"] = {
          ...entry("vitest", "5.0.5"),
          name: "vitest",
        };
      },
      reason: /Unreviewed root alias/,
    },
    {
      name: "required missing peer",
      after: (m, l) => {
        bumpVite(m, l);
        (l.packages["node_modules/vite"] as Entry).peerDependencies = {
          "original-missing": "*",
        };
      },
      reason: /Unresolved required dependency/,
    },
    {
      name: "required missing dependency",
      after: (m, l) => {
        bumpVite(m, l);
        delete l.packages["node_modules/vite/node_modules/rolldown"];
      },
      reason: /violates its declared range/,
    },
    {
      name: "root lock metadata",
      after: (m, l) => {
        bumpVite(m, l);
        l.version = "9.0.0";
      },
      reason: /Shared lock metadata/,
    },
  ];
  for (const row of cases)
    await t.test(row.name, async (t) => {
      const { options } = await gitGraph(t, row);
      assert.throws(() => classifyDevelopmentBump(options), row.reason);
    });
});

test("qualification and source boundaries fail closed before migration, for altered wiring and for unclassified consumers", async (t) => {
  const cases: Array<{
    name: string;
    before?: Change;
    after?: Change;
    reason: RegExp;
  }> = [
    {
      name: "pre-migration",
      before: (_m, _l, f) => {
        delete f["scripts/javascript-tools/package-lock.json"];
      },
      reason: /Missing qualification input/,
    },
    {
      name: "unsupported stable wiring",
      before: (_m, _l, f) => {
        f["scripts/prepare-javascript-tools.mjs"] =
          "export const coupled=true;";
      },
      reason: /Unsupported qualification input/,
    },
    {
      name: "changed wiring",
      after: (m, l, f) => {
        bumpVite(m, l);
        f["scripts/prepare-javascript-tools.mjs"] +=
          "\nexport const changed=true;";
      },
      reason: /only root manifest/,
    },
    {
      name: "new static consumer already on base",
      before: (_m, _l, f) => {
        f["test/unclassified.test.ts"] = 'import {build} from "vite";';
      },
      reason: /Unreviewed dependency consumer/,
    },
    {
      name: "encoded consumer already on base",
      before: (_m, _l, f) => {
        f["test/unclassified.test.ts"] = 'import {build} from "v\\u0069te";';
      },
      reason: /Unreviewed dependency consumer/,
    },
    {
      name: "unknown dynamic consumer",
      before: (_m, _l, f) => {
        f["test/unclassified.test.ts"] =
          "const tool=process.env.TOOL;await import(tool);";
      },
      reason: /module-resolution\/copy wiring/,
    },
    {
      name: "aliased copied root consumer",
      before: (_m, _l, f) => {
        f["test/unclassified.test.ts"] =
          'import {copyInstalledPackages as clone} from "./tool-fixture.js";clone("synthetic",["vite"]);';
      },
      reason: /Unreviewed dependency consumer/,
    },
    {
      name: "rebound copied root consumer",
      before: (_m, _l, f) => {
        f["test/unclassified.test.ts"] =
          'import {copyInstalledPackages} from "./tool-fixture.js";const clone=copyInstalledPackages;clone("synthetic",["vite"]);';
      },
      reason: /Unreviewed dependency consumer/,
    },
    {
      name: "namespace copied root consumer",
      before: (_m, _l, f) => {
        f["test/unclassified.test.ts"] =
          'import * as tools from "./tool-fixture.js";tools.copyInstalledPackages("synthetic",["vite"]);';
      },
      reason: /Unreviewed dependency consumer/,
    },
    {
      name: "rebound module resolver",
      before: (_m, _l, f) => {
        f["test/unclassified.test.ts"] =
          'const resolve=import.meta.resolve;resolve("vite");';
      },
      reason: /Unreviewed dependency consumer/,
    },
    {
      name: "aliased require factory",
      before: (_m, _l, f) => {
        f["test/unclassified.test.ts"] =
          'import {createRequire as factory} from "node:module";const load=factory(import.meta.url);load("vite");';
      },
      reason: /Unreviewed dependency consumer/,
    },
    {
      name: "unknown root configuration consumer",
      before: (_m, _l, f) => {
        f["vite.config.mjs"] = 'import {build} from "vite";';
      },
      reason: /Unreviewed dependency consumer/,
    },
    {
      name: "unknown asset builder consumer",
      before: (_m, _l, f) => {
        f["assets/build.mjs"] = 'import {build} from "vite";';
      },
      reason: /Unreviewed dependency consumer/,
    },
    {
      name: "opaque code evaluator",
      before: (_m, _l, f) => {
        f["src/unclassified.ts"] =
          "const execute=eval;execute(process.env.CODE);";
      },
      reason: /module-resolution\/copy wiring/,
    },
    {
      name: "relative installed-module consumer",
      before: (_m, _l, f) => {
        f["src/unclassified.ts"] =
          'import {build} from "../node_modules/vite/dist/node/index.js";';
      },
      reason: /Unreviewed dependency consumer/,
    },
    {
      name: "live legacy alias consumer",
      before: (_m, _l, f) => {
        f["src/unclassified.ts"] =
          'import {startVitest} from "vitest-native-mutation/node";';
      },
      reason: /Unreviewed dependency consumer/,
    },
    {
      name: "unknown root CLI consumer",
      before: (_m, _l, f) => {
        f["scripts/unclassified.mjs"] =
          'import {spawn} from "node:child_process";spawn(process.execPath,["./node_modules/vite/bin/vite.js"]);';
      },
      reason: /Unreviewed dependency consumer/,
    },
    {
      name: "unknown computed executable",
      before: (_m, _l, f) => {
        f["scripts/unclassified.mjs"] =
          'import {spawn} from "node:child_process";spawn(process.env.TOOL,[]);';
      },
      reason: /module-resolution\/copy wiring/,
    },
    {
      name: "source change in bump",
      after: (m, l, f) => {
        bumpVite(m, l);
        f["src/unrelated.ts"] = "export const changed=1;";
      },
      reason: /only root manifest/,
    },
    {
      name: "workflow change in bump",
      after: (m, l, f) => {
        bumpVite(m, l);
        f[".github/workflows/ci.yml"] = "name: changed";
      },
      reason: /only root manifest/,
    },
    {
      name: "planner change in bump",
      after: (m, l, f) => {
        bumpVite(m, l);
        f["scripts/plan-ci-impact.mjs"] = "throw new Error('changed');";
      },
      reason: /only root manifest/,
    },
    {
      name: "script change",
      after: (m, l) => {
        bumpVite(m, l);
        m.scripts.build = "vite build";
      },
      reason: /Shared manifest input/,
    },
    {
      name: "engine change",
      after: (m, l) => {
        bumpVite(m, l);
        m.engines = { node: ">=99" };
      },
      reason: /Shared manifest input/,
    },
    {
      name: "override change",
      after: (m, l) => {
        bumpVite(m, l);
        m.overrides = { vite: "9.0.0" };
      },
      reason: /Shared manifest input/,
    },
    {
      name: "already used as compiler/build tool",
      before: (m) => {
        m.scripts.build = "vite build";
      },
      reason: /used by a build\/test script/,
    },
  ];
  for (const row of cases)
    await t.test(row.name, async (t) => {
      const { options } = await gitGraph(t, row);
      assert.throws(() => classifyDevelopmentBump(options), row.reason);
    });
});

test("valid near misses retain eligibility without treating independent audit bytes or adjacent package names as consumers", async (t) => {
  const { options } = await gitGraph(t, {
    before: (_m, l, f) => {
      f["scripts/original-audit.mjs"] =
        'import {readFile} from "node:fs/promises";export const audit=()=>readFile("package-lock.json");';
      f["test/adjacent.test.ts"] = 'import {build} from "vite-extra";';
      (l.packages["node_modules/vite"] as Entry).peerDependencies = {
        "original-optional": "*",
      };
      (l.packages["node_modules/vite"] as Entry).peerDependenciesMeta = {
        "original-optional": { optional: true },
      };
    },
    after: (m, l) => {
      bumpVite(m, l);
      (l.packages["node_modules/vite"] as Entry).peerDependencies = {
        "original-optional": "*",
      };
      (l.packages["node_modules/vite"] as Entry).peerDependenciesMeta = {
        "original-optional": { optional: true },
      };
    },
  });
  assert.equal(
    classifyDevelopmentBump(options).evidence.scope,
    "development-dependency-consumers-v1",
  );
  assert.throws(
    () =>
      classifyDevelopmentBump({
        ...options,
        workflow: { jobs: { "host-validation": { if: "full-only" } } },
      }),
    /host dependency routing unavailable/,
  );
  assert.throws(
    () =>
      classifyDevelopmentBump({
        ...options,
        inputs: { ...inputs, "test/vitest.test.ts": [] },
      }),
    /Missing declared dependency consumer owners/,
  );
});

test("dependency host route requires the complete existing host queue and rejects skipped missing malformed or unknown routing", async (t) => {
  const { options } = await gitGraph(t);
  const impact = classifyDevelopmentBump(options);
  const selected = planNativeJobs({
    jobs,
    inputs,
    changed: impact.routedFiles,
    eventName: "pull_request",
    contractCurrent: true,
    sourceBoundaries: [],
  });
  const plan = {
    ...selected,
    hostValidation: "required",
    dependencyImpact: impact.evidence,
  };
  const needs = Object.fromEntries(
    ["ci-plan", "checks", "host-validation", ...jobs].map((id) => [
      id,
      {
        result:
          ["ci-plan", "checks", "host-validation"].includes(id) ||
          plan.selected[id]
            ? "success"
            : "skipped",
      },
    ]),
  );
  assert.equal(requireCiCompletion(plan, needs).complete, true);
  assert.deepEqual(
    jobs.filter((id) => plan.selected[id]),
    ["original-vite", "original-vitest", "original-mutation"],
  );
  assert.throws(
    () =>
      requireCiCompletion(plan, {
        ...needs,
        "host-validation": { result: "skipped" },
      }),
    /CI outcome disagrees/,
  );
  const missing = { ...needs };
  delete missing["host-validation"];
  assert.throws(() => requireCiCompletion(plan, missing), /job inventory/);
  for (const route of [undefined, null, false, "unknown", "not-selected"])
    assert.throws(() =>
      requireCiCompletion({ ...plan, hostValidation: route }, needs),
    );
  assert.throws(() =>
    requireCiCompletion(
      { ...plan, dependencyImpact: { ...impact.evidence, scope: "unknown" } },
      needs,
    ),
  );
  assert.throws(() =>
    requireCiCompletion({ ...plan, dependencyImpact: undefined }, needs),
  );
  const actual = parse(
    await readFile(path.join(repository, ".github/workflows/ci.yml"), "utf8"),
  );
  assert.equal(actual.jobs["host-validation"].if, dependencyHostCondition);
  const commands = actual.jobs["host-validation"].steps
    .filter((step: { run?: string }) => step.run)
    .map((step: { run: string }) => step.run);
  assert.ok(commands.includes("node scripts/run-ci-validation.mjs"));
  assert.ok(
    commands.includes("node scripts/verify-consumer-impact-package.mjs"),
  );
  const phases = JSON.parse(
    await readFile(
      path.join(repository, "scripts/ci-validation-phases.json"),
      "utf8",
    ),
  );
  assert.equal(
    phases.packages.filter(
      (row: { script: string }) => row.script === "scripts/smoke-package.mjs",
    ).length,
    1,
  );
  const controller = actual.jobs["host-validation"].steps.find(
    (step: { run?: string }) =>
      step.run === "node scripts/run-ci-validation.mjs",
  );
  assert.equal(controller.if, undefined);
  assert.ok(
    phases.mutations.every(
      (row: { script: string; args: string[]; env: Record<string, string> }) =>
        row.script.startsWith("scripts/verify-") &&
        row.args.length === 0 &&
        Object.keys(row.env).length === 0,
    ),
  );
});

test("planner entrypoint emits the dependency route from a real synthetic Git graph without running repository code", async (t) => {
  const nativeWorkflow = {
    jobs: {
      "ci-plan": { steps: [] },
      checks: { steps: [] },
      "host-validation": { if: dependencyHostCondition, steps: [] },
      ...Object.fromEntries(
        jobs.map((id) => [id, { steps: [{ run: `node scripts/${id}.mjs` }] }]),
      ),
    },
  };
  const nativeFiles = {
    "scripts/original-vite.mjs":
      'const files=["test/vite-library.test.ts","test/gate-javascript-extensions.test.ts"];throw new Error("planner must not execute repository code");',
    "scripts/original-vitest.mjs":
      'const files=["test/vitest.test.ts","test/jest.test.ts"];throw new Error("planner must not execute repository code");',
    "scripts/original-mutation.mjs":
      'const files=["test/mutation-native-fixture.ts"];throw new Error("planner must not execute repository code");',
    "scripts/unrelated.mjs":
      'const files=["test/unrelated.test.ts"];throw new Error("planner must not execute repository code");',
  };
  const files = { ...sourceFiles, ...nativeFiles };
  const nativeInputs = await buildNativeInputs({
    workflow: nativeWorkflow,
    requirements: {},
    files: Object.keys(files),
    readText: async (file: string) => files[file as keyof typeof files],
  });
  const { directory, options } = await gitGraph(t, {
    before: (_m, _l, target) => {
      Object.assign(target, nativeFiles, {
        ".github/workflows/ci.yml": JSON.stringify(nativeWorkflow),
        "scripts/required-native-tests.json": "{}",
        "scripts/ci-native-inputs.json": JSON.stringify(nativeInputs),
      });
    },
  });
  const event = path.join(directory, "event.json"),
    output = path.join(directory, "output"),
    summary = path.join(directory, "summary");
  await writeFile(
    event,
    JSON.stringify({
      pull_request: {
        base: { sha: options.base },
        head: { sha: options.head },
      },
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const {main}=await import(${JSON.stringify(pathToFileURL(path.join(repository, "scripts/plan-ci-impact.mjs")).href)});await main(${JSON.stringify({ qualificationHashes, consumerHashes, resolutionHash: hash("{}") })});`,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1048576,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: event,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        CHECKTRAIL_CI_OBSERVE_BASELINE: "0",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.mode, "affected", plan.reason);
  assert.equal(plan.hostValidation, "required");
  assert.deepEqual(
    Object.entries(plan.selected)
      .filter(([, value]) => value)
      .map(([id]) => id),
    ["original-mutation", "original-vite", "original-vitest"],
  );
  assert.equal(
    plan.dependencyImpact.scope,
    "development-dependency-consumers-v1",
  );
  assert.deepEqual(JSON.parse((await readFile(output, "utf8")).slice(5)), plan);
  assert.match(
    await readFile(summary, "utf8"),
    /entire installed\/package\/mutation host queue/,
  );
});

test("duplicate-key and malformed JSON locks cannot authorize selective dependency validation", async (t) => {
  for (const duplicate of [true, false])
    await t.test(
      duplicate ? "duplicate manifest key" : "malformed lock",
      async (t) => {
        const { options, directory, git } = await gitGraph(t);
        const file = duplicate ? "package.json" : "package-lock.json";
        const previous = await readFile(path.join(directory, file), "utf8");
        await writeFile(
          path.join(directory, file),
          duplicate
            ? previous.replace("{", '{"name":"shadowed",')
            : previous.slice(0, -1),
        );
        git("add", file);
        git("commit", "-m", "Synthetic malformed input");
        assert.throws(
          () =>
            classifyDevelopmentBump({
              ...options,
              head: git("rev-parse", "HEAD"),
            }),
          duplicate ? /Duplicate JSON key/ : /Malformed JSON/,
        );
      },
    );
});
