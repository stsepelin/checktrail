import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  realpath,
  appendFile,
} from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { fixture } from "./helpers.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const {
  classifyDevelopmentBump,
  dependencyHostCondition,
  captureDevelopmentInventory,
  developmentInventoryPath,
  qualificationInputs,
} = await import(
  new URL("../../scripts/plan-ci-impact.mjs", import.meta.url).href
);
const { buildNativeInputs, planNativeJobs, requireCiCompletion } = await import(
  new URL("../../scripts/ci-impact.mjs", import.meta.url).href
);
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
for (const file of qualificationInputs)
  sourceFiles[file] ??= file.endsWith(".json")
    ? '{"private":true}'
    : "export {};";
for (const file of ["scripts/plan-ci-impact.mjs", "scripts/ci-impact.mjs"])
  sourceFiles[file] = await readFile(path.join(repository, file), "utf8");
Object.assign(sourceFiles, {
  ".gitignore": "node_modules/\n",
  ".github/workflows/ci.yml": JSON.stringify(workflow),
  "scripts/ci-native-inputs.json": JSON.stringify(inputs),
  "test/jvm-wrapper-phases.test.ts": "export {};",
});
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
  exports?: Record<string, Record<string, string>>;
  imports?: Record<string, Record<string, string>>;
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
  {
    before,
    after = bumpVite,
    auditedBefore,
  }: { before?: Change; after?: Change; auditedBefore?: Change } = {},
) {
  const { manifest, lock } = graph();
  const files = { ...sourceFiles };
  auditedBefore?.(manifest, lock, files);
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
  let previousFiles = new Set<string>();
  const save = async (commit = true) => {
    for (const file of previousFiles)
      if (!(file in files)) await rm(path.join(directory, file));
    previousFiles = new Set(Object.keys(files));
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
    if (!commit) return git("write-tree");
    git("commit", "--allow-empty", "-m", "Synthetic dependency graph");
    return git("rev-parse", "HEAD");
  };
  git("init", "--initial-branch=main");
  git("config", "core.autocrlf", "false");
  git("config", "core.filemode", "true");
  const reviewedTree = await save(false);
  files[developmentInventoryPath] = JSON.stringify(
    captureDevelopmentInventory({
      repository: directory,
      revision: reviewedTree,
    }),
  );
  before?.(manifest, lock, files);
  lock.packages[""] = structuredClone(manifest);
  const base = await save();
  after(manifest, lock, files);
  lock.packages[""] = structuredClone(manifest);
  const head = await save();
  const options = {
    repository: directory,
    base,
    head,
    workflow: parse(files[".github/workflows/ci.yml"]!),
    inputs: JSON.parse(files["scripts/ci-native-inputs.json"]!),
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
    "package-smoke-tools",
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
  for (const file of [
    "scripts/package-smoke-tools.mjs",
    "scripts/verify-root-javascript-reporters.mjs",
  ])
    assert.ok(result.evidence.auditedConsumerFiles.includes(file), file);
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
      name: "shared Rolldown descendant reaches the unaudited Playwright root",
      before: (m, l) => {
        m.devDependencies["@playwright/test"] = "1.0.0";
        l.packages["node_modules/@playwright/test"] = {
          ...entry("@playwright/test"),
          dependencies: { "original-shared": "*" },
        };
        (l.packages["node_modules/rolldown"] as Entry).dependencies = {
          "original-shared": "1.0.0",
        };
        l.packages["node_modules/original-shared"] = entry("original-shared");
      },
      after: bumpRolldown,
      reason:
        /Unreviewed production\/compiler\/build\/lint root effect:.*@playwright\/test/,
    },
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
    ...[
      "scripts/package-smoke-tools.mjs",
      "scripts/verify-root-javascript-reporters.mjs",
      "test/package-smoke-tools.test.ts",
      "scripts/ci-full-suite-profiles.json",
      "scripts/ci-full-suite-shards.mjs",
      "scripts/verify-ci-full-suite-shard.mjs",
      "scripts/ci-validation-shards.json",
      "scripts/ci-validation-shards.mjs",
      "test/ci-full-suite-shards.test.ts",
      "test/ci-validation-shards.test.ts",
      "test/ci-duration-workflow.test.ts",
    ].map((file) => ({
      name: "missing qualified consumer/control input: " + file,
      before: (_m: Manifest, _l: Lock, files: Record<string, string>) => {
        delete files[file];
      },
      reason: /Missing qualification input/,
    })),
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
      reason: /audited inventory/,
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
      reason: /audited inventory/,
    },
    {
      name: "encoded consumer already on base",
      before: (_m, _l, f) => {
        f["test/unclassified.test.ts"] = 'import {build} from "v\\u0069te";';
      },
      reason: /audited inventory/,
    },
    {
      name: "unknown dynamic consumer",
      before: (_m, _l, f) => {
        f["test/unclassified.test.ts"] =
          "const tool=process.env.TOOL;await import(tool);";
      },
      reason: /audited inventory/,
    },
    {
      name: "aliased copied root consumer",
      before: (_m, _l, f) => {
        f["test/unclassified.test.ts"] =
          'import {copyInstalledPackages as clone} from "./tool-fixture.js";clone("synthetic",["vite"]);';
      },
      reason: /audited inventory/,
    },
    {
      name: "rebound copied root consumer",
      before: (_m, _l, f) => {
        f["test/unclassified.test.ts"] =
          'import {copyInstalledPackages} from "./tool-fixture.js";const clone=copyInstalledPackages;clone("synthetic",["vite"]);';
      },
      reason: /audited inventory/,
    },
    {
      name: "namespace copied root consumer",
      before: (_m, _l, f) => {
        f["test/unclassified.test.ts"] =
          'import * as tools from "./tool-fixture.js";tools.copyInstalledPackages("synthetic",["vite"]);';
      },
      reason: /audited inventory/,
    },
    {
      name: "rebound module resolver",
      before: (_m, _l, f) => {
        f["test/unclassified.test.ts"] =
          'const resolve=import.meta.resolve;resolve("vite");';
      },
      reason: /audited inventory/,
    },
    {
      name: "aliased require factory",
      before: (_m, _l, f) => {
        f["test/unclassified.test.ts"] =
          'import {createRequire as factory} from "node:module";const load=factory(import.meta.url);load("vite");';
      },
      reason: /audited inventory/,
    },
    {
      name: "unknown root configuration consumer",
      before: (_m, _l, f) => {
        f["vite.config.mjs"] = 'import {build} from "vite";';
      },
      reason: /audited inventory/,
    },
    {
      name: "unknown asset builder consumer",
      before: (_m, _l, f) => {
        f["assets/build.mjs"] = 'import {build} from "vite";';
      },
      reason: /audited inventory/,
    },
    {
      name: "opaque code evaluator",
      before: (_m, _l, f) => {
        f["src/unclassified.ts"] =
          "const execute=eval;execute(process.env.CODE);";
      },
      reason: /audited inventory/,
    },
    {
      name: "relative installed-module consumer",
      before: (_m, _l, f) => {
        f["src/unclassified.ts"] =
          'import {build} from "../node_modules/vite/dist/node/index.js";';
      },
      reason: /audited inventory/,
    },
    {
      name: "live legacy alias consumer",
      before: (_m, _l, f) => {
        f["src/unclassified.ts"] =
          'import {startVitest} from "vitest-native-mutation/node";';
      },
      reason: /audited inventory/,
    },
    {
      name: "unknown root CLI consumer",
      before: (_m, _l, f) => {
        f["scripts/unclassified.mjs"] =
          'import {spawn} from "node:child_process";spawn(process.execPath,["./node_modules/vite/bin/vite.js"]);';
      },
      reason: /audited inventory/,
    },
    {
      name: "unknown computed executable",
      before: (_m, _l, f) => {
        f["scripts/unclassified.mjs"] =
          'import {spawn} from "node:child_process";spawn(process.env.TOOL,[]);';
      },
      reason: /audited inventory/,
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
      reason: /audited inventory/,
    },
  ];
  for (const row of cases)
    await t.test(row.name, async (t) => {
      const { options } = await gitGraph(t, row);
      assert.throws(() => classifyDevelopmentBump(options), row.reason);
    });
});

test("explicitly reviewed stable inventory admits valid near misses without runtime source inference", async (t) => {
  const { options } = await gitGraph(t, {
    auditedBefore: (_m, l, f) => {
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
    "audited-development-dependency-consumers-v1",
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
    /Checked-out owner contract/,
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
    ["ci-plan", "checks", "full-suite-shards", "host-validation", ...jobs].map(
      (id) => [
        id,
        {
          result:
            ["ci-plan", "checks", "host-validation"].includes(id) ||
            plan.selected[id]
              ? "success"
              : "skipped",
        },
      ],
    ),
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
  assert.ok(
    commands.includes(
      "node scripts/run-ci-validation.mjs --shard${{ matrix.shard }}",
    ),
  );
  assert.ok(
    commands
      .flatMap((command: string) =>
        command.split("\n").map((line) => line.trim()),
      )
      .includes("node scripts/verify-root-javascript-reporters.mjs"),
  );
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
      step.run ===
      "node scripts/run-ci-validation.mjs --shard${{ matrix.shard }}",
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
    auditedBefore: (_m, _l, target) => {
      Object.assign(target, nativeFiles, {
        ".github/workflows/ci.yml": JSON.stringify(nativeWorkflow),
        "scripts/required-native-tests.json": "{}",
        "scripts/ci-native-inputs.json": JSON.stringify(nativeInputs),
      });
    },
  });
  const evidence = await fixture(t, {});
  const event = path.join(evidence, "event.json"),
    output = path.join(evidence, "output"),
    summary = path.join(evidence, "summary");
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
      `const {main}=await import(${JSON.stringify(pathToFileURL(path.join(repository, "scripts/plan-ci-impact.mjs")).href)});await main();`,
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
    "audited-development-dependency-consumers-v1",
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

test("complete inventory rejects the reproduced loader and command family without inferring JavaScript or shell semantics", async (t) => {
  const sources = [
    'let tool="node:fs";tool="vite";await import(tool);',
    'import {createRequire} from "node:module";const base=createRequire(import.meta.url);const load=base.bind(null);load("vite");',
    'require.bind(null)("vite");',
    "(0,eval)(process.env.CODE);",
    "const execute=(eval);execute(process.env.CODE);",
    'tools["copy"+"InstalledPackages"]("synthetic",["vite"]);',
    'import {build} from "../node_modules/placeholder/../vite/dist/node/index.js";',
    'await import(new URL("./dist/node/index.js",process.env.TOOL_BASE).href);',
  ];
  for (const source of sources)
    await t.test(source, async (t) => {
      const { options } = await gitGraph(t, {
        before: (_m, _l, f) => {
          f["scripts/unknown.mjs"] = source;
        },
      });
      assert.throws(
        () => classifyDevelopmentBump(options),
        /audited inventory/,
      );
    });
  for (const command of [
    "node ./node_modules/vite/bin/vite.js build",
    '"vite" build',
    'npx --package=vite --call="vite build"',
  ])
    await t.test(command, async (t) => {
      const { options } = await gitGraph(t, {
        before: (m) => {
          m.scripts.build = command;
        },
      });
      assert.throws(
        () => classifyDevelopmentBump(options),
        /audited inventory/,
      );
    });
  for (const file of [
    "bin/tool",
    "scripts/tool.sh",
    "new.config",
    "docs/new.md",
  ])
    await t.test(file, async (t) => {
      const { options } = await gitGraph(t, {
        before: (_m, _l, f) => {
          f[file] = "new input";
        },
      });
      assert.throws(
        () => classifyDevelopmentBump(options),
        /audited inventory/,
      );
    });
});

test("inventory profile is strict data with no caller-selected exclusions", async (t) => {
  type Profile = {
    schemaVersion: number;
    scope: string;
    entries: [
      {
        path: string;
        mode: string;
        type: string;
        fingerprint: string;
        hash: string;
      },
      ...Array<{
        path: string;
        mode: string;
        type: string;
        fingerprint: string;
        hash: string;
      }>,
    ];
  };
  const mutations: Array<[string, (p: Profile) => void]> = [
    ["unknown key", (p) => Object.assign(p, { exclusions: ["src"] })],
    [
      "wrong schema",
      (p) => {
        p.schemaVersion = 2;
      },
    ],
    [
      "wrong scope",
      (p) => {
        p.scope = "unknown";
      },
    ],
    [
      "duplicate path",
      (p) => {
        p.entries.push({ ...p.entries[0] });
      },
    ],
    [
      "case ambiguous path",
      (p) => {
        p.entries.push({
          ...p.entries[0],
          path: p.entries[0].path.toUpperCase(),
        });
      },
    ],
    [
      "symlink mode",
      (p) => {
        p.entries[0].mode = "120000";
      },
    ],
    [
      "gitlink type",
      (p) => {
        p.entries[0].type = "commit";
      },
    ],
    [
      "malformed object ID",
      (p) => {
        p.entries[0].hash = "a";
      },
    ],
    [
      "traversal path",
      (p) => {
        p.entries[0].path = "../outside";
      },
    ],
    [
      "self exclusion entry",
      (p) => {
        p.entries[0].path = developmentInventoryPath;
      },
    ],
    [
      "extra row field",
      (p) => {
        Object.assign(p.entries[0], { exclude: true });
      },
    ],
    [
      "missing reviewed entry",
      (p) => {
        p.entries.pop();
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    await t.test(name, async (t) => {
      const { options } = await gitGraph(t, {
        before: (_m, _l, f) => {
          const p = JSON.parse(f[developmentInventoryPath]!) as Profile;
          mutate(p);
          f[developmentInventoryPath] = JSON.stringify(p);
        },
      });
      assert.throws(() => classifyDevelopmentBump(options));
    });
  const { options, directory } = await gitGraph(t, {
    before: (_m, _l, f) => {
      f[developmentInventoryPath] = f[developmentInventoryPath]!.replace(
        "{",
        '{"scope":"shadow",',
      );
    },
  });
  assert.throws(() => classifyDevelopmentBump(options), /Duplicate JSON key/);
  assert.throws(
    () =>
      captureDevelopmentInventory({
        repository: directory,
        revision: options.head,
        exclusions: ["src"],
      }),
    /Unknown inventory option/,
  );
  assert.throws(
    () => classifyDevelopmentBump({ ...options, qualificationHashes: {} }),
    /Unknown inventory option/,
  );
});

test("bound event revisions cannot admit a different or dirty tested checkout", async (t) => {
  for (const file of [
    "src/new-consumer.ts",
    "new.config",
    "scripts/plan-ci-impact.mjs",
    "package.json",
  ])
    await t.test(file, async (t) => {
      const { options, directory, git } = await gitGraph(t);
      await mkdir(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      if (file === "package.json") {
        const m = JSON.parse(
          await readFile(path.join(directory, file), "utf8"),
        );
        m.scripts.build = '"vite" build';
        await writeFile(path.join(directory, file), JSON.stringify(m));
      } else
        await writeFile(
          path.join(directory, file),
          'import {build} from "vite";',
        );
      git("add", ".");
      git("commit", "-m", "Unreviewed merge checkout input");
      assert.throws(
        () => classifyDevelopmentBump(options),
        /Checked-out (tree|manifest)/,
      );
    });
  for (const file of ["scripts/plan-ci-impact.mjs", "untracked-input"])
    await t.test("dirty " + file, async (t) => {
      const { options, directory } = await gitGraph(t);
      await writeFile(path.join(directory, file), "dirty");
      assert.throws(
        () => classifyDevelopmentBump(options),
        /Dirty or untracked/,
      );
    });
  await t.test("Git-hidden dirty planner bytes", async (t) => {
    const { options, directory, git } = await gitGraph(t);
    git("update-index", "--assume-unchanged", "scripts/plan-ci-impact.mjs");
    await writeFile(
      path.join(directory, "scripts/plan-ci-impact.mjs"),
      "unreviewed controller",
    );
    assert.equal(git("status", "--porcelain"), "");
    assert.throws(
      () => classifyDevelopmentBump(options),
      /Dirty checked-out input/,
    );
  });
  await t.test("mode drift", async (t) => {
    const { options, git } = await gitGraph(t);
    git("update-index", "--chmod=+x", "scripts/plan-ci-impact.mjs");
    git("commit", "-m", "Unreviewed executable mode");
    git("config", "core.filemode", "false");
    assert.equal(git("status", "--porcelain"), "");
    assert.throws(() => classifyDevelopmentBump(options), /audited inventory/);
  });
  await t.test("same audited tree at merge checkout", async (t) => {
    const { options, git } = await gitGraph(t);
    const tree = git("rev-parse", "HEAD^{tree}");
    const merge = git(
      "commit-tree",
      tree,
      "-p",
      options.head,
      "-p",
      options.base,
      "-m",
      "Synthetic same-tree merge",
    );
    git("update-ref", "refs/heads/main", merge);
    assert.equal(
      classifyDevelopmentBump(options).evidence.scope,
      "audited-development-dependency-consumers-v1",
    );
  });
});

test("physical checkout rejects a hidden inside-root parent link and admits the same nonlinked inventory", async (t) => {
  const { options, directory, git } = await gitGraph(t, {
    auditedBefore: (_m, _l, f) => {
      f["left/tool.mjs"] = f["right/tool.mjs"] =
        "export const address=import.meta.url;";
    },
  });
  assert.equal(
    classifyDevelopmentBump(options).evidence.scope,
    "audited-development-dependency-consumers-v1",
  );
  git("update-index", "--assume-unchanged", "left/tool.mjs");
  await rm(path.join(directory, "left"), { recursive: true });
  await symlink(
    path.join(directory, "right"),
    path.join(directory, "left"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await appendFile(path.join(directory, ".git/info/exclude"), "\n/left\n");
  assert.equal(git("status", "--porcelain"), "");
  const canonicalRoot = await realpath(directory),
    file = path.join(canonicalRoot, "left/tool.mjs");
  assert.notEqual(await realpath(file), file);
  assert.equal(
    await readFile(file, "utf8"),
    await readFile(path.join(directory, "right/tool.mjs"), "utf8"),
  );
  assert.throws(
    () => classifyDevelopmentBump(options),
    /noncanonical physical path/,
  );
});

test("ignore-independent checkout inventory rejects hidden first-party source additions", async (t) => {
  for (const mechanism of ["info-exclude", "core-excludesFile"])
    for (const file of ["src/extra.ts", "test/extra.test.ts"])
      await t.test(mechanism + ":" + file, async (t) => {
        const { options, directory, git } = await gitGraph(t, {
          auditedBefore: (_m, _l, f) => {
            f["tsconfig.json"] = '{"include":["src/**/*.ts","test/**/*.ts"]}';
          },
        });
        assert.equal(
          classifyDevelopmentBump(options).evidence.scope,
          "audited-development-dependency-consumers-v1",
        );
        await mkdir(path.dirname(path.join(directory, file)), {
          recursive: true,
        });
        await writeFile(
          path.join(directory, file),
          'import {build} from "vite";export const unknownConsumer=build;',
        );
        assert.throws(
          () => classifyDevelopmentBump(options),
          /Dirty or untracked/,
        );
        if (mechanism === "info-exclude")
          await appendFile(
            path.join(directory, ".git/info/exclude"),
            "\n/" + file + "\n",
          );
        else {
          const patterns = path.join(await fixture(t, {}), "ignore-patterns");
          await writeFile(patterns, "/" + file + "\n");
          git("config", "core.excludesFile", patterns);
        }
        assert.equal(git("status", "--porcelain"), "");
        assert.throws(
          () => classifyDevelopmentBump(options),
          /Unknown untracked input/,
        );
      });
});

test("checkout inventory permits only the exact real dependency root and retains canonical repository aliases", async (t) => {
  await t.test("real node_modules and repository alias", async (t) => {
    const { options, directory, git } = await gitGraph(t);
    const baseline = classifyDevelopmentBump(options);
    await mkdir(path.join(directory, "node_modules"));
    await writeFile(
      path.join(directory, "node_modules", "original-runtime.json"),
      "{}",
    );
    assert.equal(git("status", "--porcelain"), "");
    assert.deepEqual(classifyDevelopmentBump(options), baseline);
    const alias = path.join(await fixture(t, {}), "repository-alias");
    await symlink(
      directory,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.deepEqual(
      classifyDevelopmentBump({ ...options, repository: alias }),
      baseline,
    );
  });
  for (const file of [
    "node_modules-backup/cache.js",
    "NODE_MODULES/cache.js",
    "node_modules.txt",
    "dist/test/extra.test.js",
    ".checktrail/extra.js",
    "node_modules",
  ])
    await t.test(file, async (t) => {
      const { options, directory, git } = await gitGraph(t);
      await mkdir(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      await writeFile(path.join(directory, file), "unreviewed input");
      await appendFile(
        path.join(directory, ".git/info/exclude"),
        "\n/" + file.split("/")[0] + "\n",
      );
      assert.equal(git("status", "--porcelain"), "");
      assert.throws(
        () => classifyDevelopmentBump(options),
        /Unknown untracked input/,
      );
    });
  await t.test("symlinked dependency root", async (t) => {
    const { options, directory, git } = await gitGraph(t);
    const target = await fixture(t, {});
    await writeFile(path.join(target, "original-runtime.json"), "{}");
    await symlink(
      target,
      path.join(directory, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await appendFile(
      path.join(directory, ".git/info/exclude"),
      "\n/node_modules\n",
    );
    assert.equal(git("status", "--porcelain"), "");
    assert.throws(
      () => classifyDevelopmentBump(options),
      /Unknown untracked input|dependency root/,
    );
  });
});

test("checkout inventory reads bypass configured visibility caches without changing repository settings", async (t) => {
  const { options, directory, git } = await gitGraph(t);
  git("config", "core.untrackedCache", "true");
  git("config", "core.fsmonitor", "true");
  assert.equal(
    classifyDevelopmentBump(options).evidence.scope,
    "audited-development-dependency-consumers-v1",
  );
  const file = "test/hidden-with-visibility-cache.test.ts";
  await writeFile(
    path.join(directory, file),
    'import {build} from "vite";export const unknownConsumer=build;',
  );
  await appendFile(
    path.join(directory, ".git/info/exclude"),
    "\n/" + file + "\n",
  );
  assert.throws(
    () => classifyDevelopmentBump(options),
    /Unknown untracked input/,
  );
  assert.equal(git("config", "--get", "core.untrackedCache"), "true");
  assert.equal(git("config", "--get", "core.fsmonitor"), "true");
});

test("whole manifest projection retains conditional exports and imports key order", async (t) => {
  for (const field of ["exports", "imports"] as const)
    await t.test(field, async (t) => {
      const key = field === "exports" ? "." : "#original";
      const auditedBefore: Change = (m, _l, f) => {
        m[field] = { [key]: { default: "./first.js", import: "./second.js" } };
        f["first.js"] = f["second.js"] =
          'throw new Error("Fixture modules must never execute");';
      };
      const reorder: Change = (m) => {
        m[field] = { [key]: { import: "./second.js", default: "./first.js" } };
      };
      const { options, directory, git } = await gitGraph(t, {
        auditedBefore,
        after: (m, l, f) => {
          bumpVite(m, l);
          reorder(m, l, f);
        },
      });
      const rootManifest = path.join(directory, "package.json"),
        headManifest = await readFile(rootManifest, "utf8");
      const resolve = () =>
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            `console.log(import.meta.resolve(${JSON.stringify(field === "exports" ? "original-ci-fixture" : "#original")}))`,
          ],
          { cwd: directory, encoding: "utf8" },
        ).trim();
      const canonicalDirectory = await realpath(directory);
      let beforeResolution: string | undefined;
      try {
        await writeFile(
          rootManifest,
          git("show", options.base + ":package.json"),
        );
        beforeResolution = resolve();
      } finally {
        await writeFile(rootManifest, headManifest);
      }
      assert.equal(
        beforeResolution,
        pathToFileURL(path.join(canonicalDirectory, "first.js")).href,
      );
      assert.equal(
        resolve(),
        pathToFileURL(path.join(canonicalDirectory, "second.js")).href,
      );
      assert.equal(git("status", "--porcelain"), "");
      assert.throws(
        () => classifyDevelopmentBump(options),
        /Shared manifest input changed/,
      );
      const stable = await gitGraph(t, { auditedBefore });
      assert.equal(
        classifyDevelopmentBump(stable.options).evidence.scope,
        "audited-development-dependency-consumers-v1",
      );
      const preexisting = await gitGraph(t, { auditedBefore, before: reorder });
      assert.throws(
        () => classifyDevelopmentBump(preexisting.options),
        /audited inventory/,
      );
    });
});
