import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { fixture } from "./helpers.js";

type Dependency = {
  name: string;
  location?: string;
  alias?: string;
  dev?: boolean;
  absent?: boolean;
  optional?: boolean;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
async function auditFixture(t: TestContext, dependencies: Dependency[]) {
  const script = await readFile(
    new URL("../../scripts/audit-dependencies.mjs", import.meta.url),
    "utf8",
  );
  const manifest = {
    name: "synthetic-development-audit",
    version: "1.0.0",
    private: true,
    dependencies: {} as Record<string, string>,
    devDependencies: {} as Record<string, string>,
    optionalDependencies: {} as Record<string, string>,
  };
  const packages: Record<string, unknown> = { "": manifest };
  const files: Record<string, string> = {
    "scripts/audit-dependencies.mjs": script,
    "scripts/license-sources.json": "{}",
  };
  for (const dependency of dependencies) {
    const key = dependency.alias ?? dependency.name;
    const location = dependency.location ?? "node_modules/" + key;
    const metadata = {
      name: dependency.name,
      version: "1.0.0",
      license: "MIT",
      ...(dependency.libc ? { libc: dependency.libc } : {}),
      ...(dependency.dependencies
        ? { dependencies: dependency.dependencies }
        : {}),
      ...(dependency.optionalDependencies
        ? { optionalDependencies: dependency.optionalDependencies }
        : {}),
    };
    packages[location] = {
      ...metadata,
      dev: dependency.dev ?? false,
      optional: dependency.optional ?? false,
      ...(dependency.os ? { os: dependency.os } : {}),
      ...(dependency.cpu ? { cpu: dependency.cpu } : {}),
      resolved:
        "https://registry.npmjs.org/" +
        dependency.name +
        "/-/" +
        dependency.name +
        "-1.0.0.tgz",
      integrity: "sha512-" + Buffer.alloc(64).toString("base64"),
    };
    if (!dependency.location) {
      const group = dependency.optional
        ? manifest.optionalDependencies
        : dependency.dev
          ? manifest.devDependencies
          : manifest.dependencies;
      group[key] = dependency.alias
        ? "npm:" + dependency.name + "@1.0.0"
        : "1.0.0";
    }
    if (!dependency.absent) {
      files[location + "/package.json"] = JSON.stringify(metadata);
      files[location + "/LICENSE"] =
        "Original synthetic notice; presence accounting only.\n";
      files[location + "/index.js"] =
        "throw new Error('Audit must never import dependency code');\n";
    }
  }
  files["package.json"] = JSON.stringify(manifest);
  files["package-lock.json"] = JSON.stringify({
    lockfileVersion: 3,
    name: manifest.name,
    version: manifest.version,
    packages,
  });
  return fixture(t, files);
}
function invoke(
  root: string,
  args = ["--include-dev"],
  nodeArgs: string[] = [],
) {
  return spawnSync(
    process.execPath,
    [...nodeArgs, path.join(root, "scripts/audit-dependencies.mjs"), ...args],
    { cwd: root, encoding: "utf8", timeout: 30000 },
  );
}
type Audit = {
  runtime?: { libc: { family: string; evidence: string; version?: string } };
  complete: boolean;
  scope: string;
  lockedPackageCount: number;
  installedPackageCount: number;
  platformInapplicableCount: number;
  optionalAbsentCount: number;
  packageCount: number;
  completeNativeArtifactClosure: boolean;
  absentPackages: { location: string; state: string; package: string }[];
  uninspectedNoticeSources: {
    package: string;
    state: string;
    noticeInspected: boolean;
  }[];
  gaps: { package: string | null; reason: string }[];
  packages: {
    name: string;
    location: string;
    manifestSha256: string;
    content: { files: number; bytes: number; sha256: string };
    notices: {
      file: string;
      sha256: string;
      provenance: string;
      sourceByteRange?: { file: string; startByte: number; endByte: number };
    }[];
  }[];
};
function parsed(result: ReturnType<typeof invoke>, status = 0): Audit {
  assert.equal(result.status, status, result.stderr);
  return JSON.parse(result.stdout) as Audit;
}

type NpmNode = {
  name: string;
  version: string;
  path: string;
  dev?: boolean;
  optional?: boolean;
  extraneous?: boolean;
  invalid?: boolean | string;
  missing?: boolean;
  problems?: string[];
  dependencies?: Record<string, NpmNode>;
};
type NpmDiagnosticNode = Pick<
  NpmNode,
  "version" | "extraneous" | "invalid" | "missing" | "problems"
> & {
  dependencies?: Record<string, NpmDiagnosticNode>;
};
function npmDiagnosticTree(node: NpmNode): NpmDiagnosticNode {
  return {
    version: node.version,
    ...(node.extraneous !== undefined ? { extraneous: node.extraneous } : {}),
    ...(node.invalid !== undefined ? { invalid: node.invalid } : {}),
    ...(node.missing !== undefined ? { missing: node.missing } : {}),
    ...(node.problems !== undefined ? { problems: node.problems } : {}),
    ...(node.dependencies
      ? {
          dependencies: Object.fromEntries(
            Object.entries(node.dependencies).map(([name, child]) => [
              name,
              npmDiagnosticTree(child),
            ]),
          ),
        }
      : {}),
  };
}
async function optionalOverinstallFixture(
  t: TestContext,
  selector: "cpu" | "os" = "cpu",
) {
  const retained = ["@synthetic/retained-core", "synthetic-retained-helper"];
  const root = await realpath(
    await auditFixture(t, [
      { name: "synthetic-prod" },
      {
        name: "synthetic-development-parent",
        dev: true,
        optionalDependencies: { "synthetic-foreign-parent": "1.0.0" },
      },
      {
        name: "synthetic-foreign-parent",
        location: "node_modules/synthetic-foreign-parent",
        dev: true,
        optional: true,
        absent: true,
        ...(selector === "cpu"
          ? { cpu: ["synthetic-other-cpu"] }
          : { os: ["!" + process.platform] }),
        dependencies: Object.fromEntries(
          retained.map((name) => [name, "1.0.0"]),
        ),
      },
      ...retained.map((name) => ({
        name,
        location: "node_modules/" + name,
        dev: true,
        optional: true,
      })),
    ]),
  );
  const nodes: Record<string, NpmNode> = {};
  for (const name of [
    "synthetic-prod",
    "synthetic-development-parent",
    ...retained,
  ]) {
    const directory = path.join(root, "node_modules", name);
    nodes[name] = {
      ...JSON.parse(
        await readFile(path.join(directory, "package.json"), "utf8"),
      ),
      path: directory,
      ...(name !== "synthetic-prod" ? { dev: true } : {}),
      ...(retained.includes(name)
        ? {
            optional: true,
            extraneous: true,
            problems: [`extraneous: ${name}@1.0.0 ${directory}`],
          }
        : {}),
    };
    // npm's child dependency graph is distinct from manifest range declarations.
    delete nodes[name]!.dependencies;
  }
  const aggregate = retained.flatMap((name) => nodes[name]!.problems!);
  const trees = {
    production: {
      name: "synthetic-development-audit",
      version: "1.0.0",
      path: root,
      problems: [...aggregate],
      dependencies: Object.fromEntries(
        Object.entries(nodes).filter(
          ([name]) => name !== "synthetic-development-parent",
        ),
      ),
    } satisfies NpmNode,
    development: {
      name: "synthetic-development-audit",
      version: "1.0.0",
      path: root,
      problems: [...aggregate],
      dependencies: structuredClone(nodes),
    } satisfies NpmNode,
  };
  const metadata = path.join(root, "npm-tree.json");
  const loader = path.join(root, "npm-metadata-loader.mjs");
  await writeFile(
    loader,
    `import cp from 'node:child_process';import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const original=cp.execFileSync;cp.execFileSync=(file,args,options)=>{if(file!=='npm'||args[0]!=='ls')return original(file,args,options);fs.writeFileSync(${JSON.stringify(path.join(root, "npm-observed-arguments.json"))},JSON.stringify(args));const captured=JSON.parse(fs.readFileSync(${JSON.stringify(metadata)},'utf8'));const trees=args.includes('--long')?captured.long:captured.diagnostics;return JSON.stringify(args.includes('--omit=dev')?trees.production:trees.development);};syncBuiltinESMExports();`,
  );
  async function save(
    diagnostics = {
      production: npmDiagnosticTree(trees.production),
      development: npmDiagnosticTree(trees.development),
    },
  ) {
    await writeFile(metadata, JSON.stringify({ long: trees, diagnostics }));
  }
  await save();
  return {
    root,
    retained,
    trees,
    save,
    invoke: (args = ["--include-dev"]) =>
      invoke(root, args, ["--import", pathToFileURL(loader).href]),
  };
}

test("dependency audit reconciles npm 10 retained optional descendants of an incompatible ancestor in both scopes", async (t) => {
  const f = await optionalOverinstallFixture(t);
  const production = parsed(f.invoke([]));
  assert.equal(production.complete, true);
  assert.deepEqual(
    production.packages.map((p) => p.name),
    ["synthetic-prod"],
  );
  const development = parsed(f.invoke());
  assert.equal(development.complete, true);
  assert.equal(development.lockedPackageCount, 5);
  assert.equal(development.installedPackageCount, 4);
  assert.equal(development.platformInapplicableCount, 1);
  for (const name of f.retained) {
    const entry = development.packages.find((p) => p.name === name)!;
    assert.equal(entry.content.files, 3);
    assert.equal(entry.notices.length, 1);
    assert.equal(
      entry.manifestSha256,
      createHash("sha256")
        .update(
          await readFile(
            path.join(f.root, "node_modules", name, "package.json"),
          ),
        )
        .digest("hex"),
    );
  }
});

type FixtureLockEntry = {
  dev?: boolean;
  name?: string;
  version?: string;
  optional?: boolean;
  cpu?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
async function changeFixtureLock(
  root: string,
  change: (packages: Record<string, FixtureLockEntry>) => void,
) {
  const file = path.join(root, "package-lock.json");
  const lock = JSON.parse(await readFile(file, "utf8"));
  change(lock.packages);
  await writeFile(file, JSON.stringify(lock));
}
async function nestedProjectionFixture(
  t: TestContext,
  live: "none" | "dev" | "production" = "none",
) {
  const f = await optionalOverinstallFixture(t);
  const parent = f.retained[0]!;
  const child = f.retained[1]!;
  const normal = structuredClone(f.trees.development.dependencies[child]!);
  normal.extraneous = false;
  delete normal.problems;
  if (live !== "none") {
    normal.optional = false;
    normal.dev = live === "dev";
  }
  const owner =
    live === "production" ? "synthetic-prod" : "synthetic-development-parent";
  const update = async (name: string) => {
    const file = path.join(f.root, "node_modules", name, "package.json");
    const value = JSON.parse(await readFile(file, "utf8"));
    await writeFile(
      file,
      JSON.stringify({
        ...value,
        dependencies: { ...value.dependencies, [child]: "1.0.0" },
      }),
    );
  };
  await update(parent);
  if (live !== "none") await update(owner);
  await changeFixtureLock(f.root, (packages) => {
    packages["node_modules/" + parent]!.dependencies = { [child]: "1.0.0" };
    if (live !== "none") {
      packages["node_modules/" + owner]!.dependencies = { [child]: "1.0.0" };
      packages["node_modules/" + child]!.optional = false;
      packages["node_modules/" + child]!.dev = live === "dev";
    }
  });
  const ownDiagnostic = f.trees.production.dependencies[child]!.problems![0]!;
  for (const tree of Object.values(f.trees)) {
    tree.dependencies[parent]!.dependencies = {
      [child]: structuredClone(normal),
    };
    if (live !== "none") {
      delete tree.dependencies[child];
      tree.problems = tree.problems.filter(
        (problem) => problem !== ownDiagnostic,
      );
      if (tree.dependencies[owner])
        tree.dependencies[owner]!.dependencies = {
          [child]: structuredClone(normal),
        };
    }
    tree.dependencies = {
      [parent]: tree.dependencies[parent]!,
      ...Object.fromEntries(
        Object.entries(tree.dependencies).filter(([name]) => name !== parent),
      ),
    };
  }
  await f.save();
  return { ...f, parent, child };
}

function refused(result: ReturnType<typeof invoke>, pattern: RegExp) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, pattern);
}

test("dependency audit reconciles repeated non-extraneous descendants beneath omitted development roots", async (t) => {
  const f = await nestedProjectionFixture(t);
  const nested =
    f.trees.production.dependencies[f.parent]!.dependencies![f.child]!;
  assert.equal(nested.extraneous, false);
  assert.equal(nested.path, f.trees.production.dependencies[f.child]!.path);
  const production = parsed(f.invoke([]));
  assert.deepEqual(
    production.packages.map((p) => p.name),
    ["synthetic-prod"],
  );
  const development = parsed(f.invoke());
  assert.equal(development.complete, true);
  assert.equal(development.installedPackageCount, 4);
});

test("dependency audit omits a repeated child shared only with a compatible required development path", async (t) => {
  const f = await nestedProjectionFixture(t, "dev");
  const production = parsed(f.invoke([]));
  assert.deepEqual(
    production.packages.map((p) => p.name),
    ["synthetic-prod"],
  );
  const development = parsed(f.invoke());
  assert.equal(development.complete, true);
  assert.equal(development.installedPackageCount, 4);
  assert.equal(
    f.trees.development.dependencies["synthetic-development-parent"]!
      .dependencies![f.child]!.optional,
    false,
  );
});

test("dependency audit preserves a genuine production shared path first reached under an omitted branch", async (t) => {
  const f = await nestedProjectionFixture(t, "production");
  assert.equal(Object.keys(f.trees.production.dependencies)[0], f.parent);
  const production = parsed(f.invoke([]));
  assert.deepEqual(
    production.packages.map((p) => p.name).sort(),
    ["synthetic-prod", f.child].sort(),
  );
  assert.equal(production.packageCount, 2);
  assert.equal(parsed(f.invoke()).complete, true);
  for (const tree of Object.values(f.trees)) {
    const child = tree.dependencies[f.parent]!.dependencies![f.child]!;
    child.extraneous = true;
    child.problems = [
      `extraneous: ${child.name}@${child.version} ${child.path}`,
    ];
    tree.problems.push(child.problems[0]!);
  }
  await f.save();
  for (const args of [[], ["--include-dev"]])
    refused(f.invoke(args), /Unreconciled extraneous dependency/);
});

test("dependency audit refuses an unlocked normal descendant even when its identity duplicates production", async (t) => {
  const f = await nestedProjectionFixture(t);
  const location = path.join(f.root, "node_modules/synthetic-unlocked-copy");
  await mkdir(location);
  await writeFile(
    path.join(location, "package.json"),
    JSON.stringify({
      name: "synthetic-prod",
      version: "1.0.0",
      license: "MIT",
    }),
  );
  for (const tree of Object.values(f.trees))
    tree.dependencies[f.parent]!.dependencies!["synthetic-unlocked-copy"] = {
      name: "synthetic-prod",
      version: "1.0.0",
      path: location,
      extraneous: false,
    };
  await f.save();
  for (const args of [[], ["--include-dev"]])
    refused(f.invoke(args), /location is not locked/);
});

test("dependency audit rejects a mismatching normal descendant inside an omitted development branch", async (t) => {
  const f = await nestedProjectionFixture(t);
  for (const tree of Object.values(f.trees))
    tree.dependencies[f.parent]!.dependencies![f.child]!.version = "2.0.0";
  await f.save();
  for (const args of [[], ["--include-dev"]])
    refused(f.invoke(args), /Installed version differs from lock/);
});

async function syntheticLibcReport(
  root: string,
  report: unknown,
  throws = false,
) {
  const loader = path.join(root, "synthetic-libc-report.mjs");
  const observed = path.join(root, "report-settings-observed.json");
  const restored = path.join(root, "report-settings-restored.json");
  const commands = path.join(root, "runtime-helper-commands.json");
  await writeFile(
    loader,
    `import process from 'node:process';import fs from 'node:fs';import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';const names=['excludeNetwork','excludeEnv'];const settings=()=>Object.fromEntries(names.filter(name=>typeof process.report[name]==='boolean').map(name=>[name,process.report[name]]));const before=settings();Object.defineProperty(process,'platform',{value:'linux'});fs.writeFileSync(${JSON.stringify(commands)},'[]');const original=cp.execFileSync;cp.execFileSync=(file,...args)=>{if(file!=='npm'){const calls=JSON.parse(fs.readFileSync(${JSON.stringify(commands)},'utf8'));calls.push(file);fs.writeFileSync(${JSON.stringify(commands)},JSON.stringify(calls));throw Error('Runtime helper commands are forbidden');}return original(file,...args);};syncBuiltinESMExports();process.report.getReport=()=>{fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify(settings()));if(${JSON.stringify(throws)})throw Error('Original synthetic report error; do not retain');return ${JSON.stringify(report)};};process.on('exit',()=>fs.writeFileSync(${JSON.stringify(restored)},JSON.stringify({before,after:settings()})));`,
  );
  return {
    args: ["--import", pathToFileURL(loader).href],
    async checked() {
      const captured = JSON.parse(await readFile(observed, "utf8"));
      assert.equal(captured.excludeNetwork, true);
      assert.ok(Object.values(captured).every((value) => value === true));
      const result = JSON.parse(await readFile(restored, "utf8"));
      assert.deepEqual(result.after, result.before);
      assert.deepEqual(JSON.parse(await readFile(commands, "utf8")), []);
    },
  };
}

const glibcReport = {
  header: { glibcVersionRuntime: "2.36" },
  environmentVariables: {
    SYNTHETIC_PRIVATE_ENV: "Original-private-report-marker",
  },
};
const muslReport = {
  header: {},
  sharedObjects: ["/original/lib/ld-musl-x86_64.so.1"],
  environmentVariables: {
    SYNTHETIC_PRIVATE_ENV: "Original-private-report-marker",
  },
};
const libcCases = [
  {
    name: "glibc excludes musl",
    report: glibcReport,
    selector: ["musl"],
    family: "glibc",
    excluded: true,
  },
  {
    name: "musl excludes glibc",
    report: muslReport,
    selector: ["glibc"],
    family: "musl",
    excluded: true,
  },
  {
    name: "matching glibc stays unresolved when absent",
    report: glibcReport,
    selector: ["glibc"],
    family: "glibc",
    excluded: false,
  },
  {
    name: "matching musl stays unresolved when absent",
    report: muslReport,
    selector: ["musl"],
    family: "musl",
    excluded: false,
  },
  {
    name: "unknown report stays unresolved",
    report: { header: {}, sharedObjects: [] },
    selector: ["musl"],
    family: "unknown",
    excluded: false,
  },
  {
    name: "musl path backup is not a loader",
    report: {
      header: {},
      sharedObjects: [
        "/original/ld-musl-x86_64.so.1.backup",
        "/original/ld-musl-x86_64.so.1/ordinary.so",
      ],
    },
    selector: ["musl"],
    family: "unknown",
    excluded: false,
  },
  {
    name: "known glibc header takes precedence",
    report: { ...muslReport, header: { glibcVersionRuntime: "2.36" } },
    selector: ["musl"],
    family: "glibc",
    excluded: true,
  },
  {
    name: "report errors remain unknown",
    report: {},
    throws: true,
    selector: ["musl"],
    family: "unknown",
    excluded: false,
  },
  {
    name: "exact any remains compatible",
    report: glibcReport,
    selector: ["any"],
    family: "glibc",
    excluded: false,
  },
  {
    name: "mixed any is literal",
    report: glibcReport,
    selector: ["any", "musl"],
    family: "glibc",
    excluded: true,
  },
  {
    name: "matching negation excludes",
    report: glibcReport,
    selector: ["!glibc"],
    family: "glibc",
    excluded: true,
  },
  {
    name: "other negation is compatible",
    report: glibcReport,
    selector: ["!musl"],
    family: "glibc",
    excluded: false,
  },
];
for (const entry of libcCases) {
  test(`development audit libc facts: ${entry.name}`, async (t) => {
    const root = await auditFixture(t, [
      { name: "synthetic-prod" },
      {
        name: "synthetic-development-parent",
        dev: true,
        optionalDependencies: { "synthetic-libc-native": "1.0.0" },
      },
      {
        name: "synthetic-libc-native",
        location: "node_modules/synthetic-libc-native",
        dev: true,
        optional: true,
        absent: true,
        libc: entry.selector,
      },
    ]);
    const report = await syntheticLibcReport(
      root,
      entry.report,
      entry.throws ?? false,
    );
    const result = invoke(root, ["--include-dev"], report.args);
    const evidence = parsed(result, entry.excluded ? 0 : 2);
    assert.equal(evidence.runtime!.libc.family, entry.family);
    assert.equal(evidence.complete, entry.excluded);
    assert.equal(evidence.platformInapplicableCount, entry.excluded ? 1 : 0);
    assert.equal(evidence.optionalAbsentCount, entry.excluded ? 0 : 1);
    assert.equal(
      evidence.absentPackages[0]!.state,
      entry.excluded ? "platform-inapplicable" : "not-installed-optional",
    );
    assert.equal(
      result.stdout.includes("Original-private-report-marker"),
      false,
    );
    await report.checked();
  });
}

test("development audit retains an active matching-libc path instead of inheriting a foreign exclusion", async (t) => {
  const root = await auditFixture(t, [
    { name: "synthetic-prod" },
    {
      name: "synthetic-libc-foreign",
      optional: true,
      absent: true,
      libc: ["musl"],
      dependencies: { "synthetic-libc-shared": "1.0.0" },
    },
    {
      name: "synthetic-libc-active",
      optional: true,
      libc: ["glibc"],
      optionalDependencies: { "synthetic-libc-shared": "1.0.0" },
    },
    {
      name: "synthetic-libc-shared",
      location: "node_modules/synthetic-libc-shared",
      optional: true,
      absent: true,
    },
  ]);
  const report = await syntheticLibcReport(root, glibcReport);
  const evidence = parsed(invoke(root, ["--include-dev"], report.args), 2);
  assert.equal(evidence.complete, false);
  assert.equal(evidence.platformInapplicableCount, 1);
  assert.equal(evidence.optionalAbsentCount, 1);
  assert.equal(
    evidence.absentPackages.find(
      (item) => item.package === "synthetic-libc-shared@1.0.0",
    )!.state,
    "not-installed-optional",
  );
  assert.ok(
    evidence.packages.some((item) => item.name === "synthetic-libc-active"),
  );
  await report.checked();
});

test("development audit retains a compatible absent optional notice source without declaring its notice inspected", async (t) => {
  const f = await pinnedNoticeFixture(t, false);
  const file = path.join(f.root, "package.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  delete manifest.dependencies[f.name];
  manifest.optionalDependencies[f.name] = "1.0.0";
  await writeFile(file, JSON.stringify(manifest));
  await changeFixtureLock(f.root, (packages) => {
    delete packages[""]!.dependencies![f.name];
    packages[""]!.optionalDependencies = { [f.name]: "1.0.0" };
    packages[f.dependency]!.optional = true;
  });
  await rm(path.join(f.root, f.dependency), { recursive: true });
  const report = parsed(invoke(f.root), 2);
  assert.equal(report.complete, false);
  assert.deepEqual(report.uninspectedNoticeSources, [
    {
      package: f.name + "@1.0.0",
      state: "not-installed-optional",
      noticeInspected: false,
    },
  ]);
  assert.deepEqual(report.gaps, [
    {
      package: f.name + "@1.0.0",
      reason:
        "Optional package absent without a demonstrated platform exclusion",
    },
  ]);
  await writeFile(
    path.join(f.root, "scripts/license-sources.json"),
    JSON.stringify({ [f.name + "@2.0.0"]: f.source }),
  );
  refused(invoke(f.root), /no longer describes/);
});

test("dependency audit accepts OS-incompatible optional ancestry and continues hashing retained development contents and notices", async (t) => {
  const f = await optionalOverinstallFixture(t, "os");
  const before = parsed(f.invoke());
  const name = f.retained[0]!;
  const first = before.packages.find((p) => p.name === name)!;
  await writeFile(
    path.join(f.root, "node_modules", name, "index.js"),
    "throw Error('Original changed synthetic bytes; never load');",
  );
  const after = parsed(f.invoke()).packages.find((p) => p.name === name)!;
  assert.notEqual(after.content.sha256, first.content.sha256);
  assert.equal(after.manifestSha256, first.manifestSha256);
  await rm(path.join(f.root, "node_modules", name, "LICENSE"));
  const incomplete = parsed(f.invoke(), 2);
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.gaps, [
    { package: name + "@1.0.0", reason: "No notice file was located" },
  ]);
  assert.equal(parsed(f.invoke([])).complete, true);
  const args = JSON.parse(
    await readFile(path.join(f.root, "npm-observed-arguments.json"), "utf8"),
  );
  assert.deepEqual(args, ["ls", "--omit=dev", "--all", "--json", "--long"]);
});

for (const field of [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const) {
  test(`dependency audit refuses an extraneous optional package with a live shared ${field} path`, async (t) => {
    const f = await optionalOverinstallFixture(t);
    await changeFixtureLock(f.root, (packages) => {
      packages["node_modules/synthetic-prod"]![field] = {
        [f.retained[0]!]: "1.0.0",
      };
    });
    for (const args of [[], ["--include-dev"]])
      refused(f.invoke(args), /Unreconciled extraneous dependency/);
  });
}

for (const kind of [
  "required",
  "unreachable",
  "compatible",
  "required-ancestor",
] as const) {
  test(`dependency audit refuses the ${kind} near miss to an excluded optional subtree`, async (t) => {
    const f = await optionalOverinstallFixture(t);
    await changeFixtureLock(f.root, (packages) => {
      const foreign = packages["node_modules/synthetic-foreign-parent"]!;
      if (kind === "required")
        packages["node_modules/" + f.retained[0]!]!.optional = false;
      if (kind === "unreachable") foreign.dependencies = {};
      if (kind === "compatible") foreign.cpu = [process.arch];
      if (kind === "required-ancestor") foreign.optional = false;
    });
    for (const args of [[], ["--include-dev"]])
      refused(
        f.invoke(args),
        /Unreconciled extraneous dependency|no incompatible optional ancestor/,
      );
  });
}

for (const source of ["tree", "lock", "manifest", "name"] as const) {
  test(`dependency audit refuses retained optional ${source} identity drift`, async (t) => {
    const f = await optionalOverinstallFixture(t);
    const name = f.retained[0]!;
    if (source === "tree" || source === "name") {
      for (const tree of Object.values(f.trees)) {
        const node = tree.dependencies[name]!;
        if (source === "tree") node.version = "2.0.0";
        else node.name += "-different";
      }
      await f.save();
    } else if (source === "lock") {
      await changeFixtureLock(f.root, (packages) => {
        packages["node_modules/" + name]!.version = "2.0.0";
      });
    } else {
      const file = path.join(f.root, "node_modules", name, "package.json");
      await writeFile(
        file,
        JSON.stringify({
          ...JSON.parse(await readFile(file, "utf8")),
          version: "2.0.0",
        }),
      );
    }
    for (const args of [[], ["--include-dev"]])
      refused(
        f.invoke(args),
        /identity differs from lock or installed manifest/,
      );
  });
}

for (const flag of ["invalid", "missing"] as const) {
  test(`dependency audit refuses ${flag === "invalid" ? "an" : "a"} ${flag} node even beside reconciled optional diagnostics`, async (t) => {
    const f = await optionalOverinstallFixture(t);
    for (const tree of Object.values(f.trees))
      tree.dependencies[f.retained[0]!]![flag] = true;
    await f.save();
    for (const args of [[], ["--include-dev"]])
      refused(f.invoke(args), /Invalid or missing installed dependency/);
  });
}

test("dependency audit refuses an unlocked extra instead of allowing an extraneous-name pattern", async (t) => {
  const f = await optionalOverinstallFixture(t);
  const name = f.retained[0]!;
  await changeFixtureLock(f.root, (packages) => {
    delete packages["node_modules/" + name];
  });
  for (const args of [[], ["--include-dev"]])
    refused(f.invoke(args), /Unreconciled extraneous dependency/);
});

for (const kind of [
  "unknown-root",
  "missing-node",
  "missing-flag",
  "missing-own-diagnostic",
  "suffix",
] as const) {
  test(`dependency audit reconciles each aggregate diagnostic and refuses ${kind} metadata`, async (t) => {
    const f = await optionalOverinstallFixture(t);
    for (const tree of Object.values(f.trees)) {
      const name = f.retained[0]!;
      const node = tree.dependencies[name]!;
      if (kind === "unknown-root")
        tree.problems.push(
          "extraneous: synthetic-unlocked@1.0.0 " +
            f.root +
            "/node_modules/synthetic-unlocked",
        );
      if (kind === "missing-node") delete tree.dependencies[name];
      if (kind === "missing-flag") delete node.extraneous;
      if (kind === "missing-own-diagnostic") delete node.problems;
      if (kind === "suffix") {
        node.problems = node.problems!.map((problem) => problem + "-backup");
        tree.problems = tree.problems.map((problem) => problem + "-backup");
      }
    }
    await f.save();
    for (const args of [[], ["--include-dev"]])
      refused(f.invoke(args), /unreconciled problems|no exact diagnostic/);
  });
}

test("dependency audit refuses a retained optional node whose installed package is absent", async (t) => {
  const f = await optionalOverinstallFixture(t);
  await rm(path.join(f.root, "node_modules", f.retained[0]!), {
    recursive: true,
  });
  for (const args of [[], ["--include-dev"]]) refused(f.invoke(args), /ENOENT/);
});

test("dependency audit refuses noncanonical and escaping optional package paths", async (t) => {
  const f = await optionalOverinstallFixture(t);
  const name = f.retained[0]!;
  const outside = await realpath(
    await fixture(t, {
      "package.json": JSON.stringify({
        name,
        version: "1.0.0",
        license: "MIT",
      }),
    }),
  );
  for (const tree of Object.values(f.trees))
    tree.dependencies[name]!.path = outside;
  await f.save();
  for (const args of [[], ["--include-dev"]])
    refused(f.invoke(args), /path escapes package root/);
  const directory = path.join(f.root, "node_modules", name);
  await rm(directory, { recursive: true });
  await symlink(
    outside,
    directory,
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const tree of Object.values(f.trees))
    tree.dependencies[name]!.path = directory;
  await f.save();
  for (const args of [[], ["--include-dev"]])
    refused(f.invoke(args), /path must be canonical/);
});

test("dependency audit binds retained optional aliases to their installed identity and lock location", async (t) => {
  const f = await optionalOverinstallFixture(t);
  const name = f.retained[0]!;
  const alias = "synthetic-retained-alias";
  const oldLocation = "node_modules/" + name;
  const location = "node_modules/" + alias;
  await rename(path.join(f.root, oldLocation), path.join(f.root, location));
  await changeFixtureLock(f.root, (packages) => {
    packages[location] = packages[oldLocation]!;
    delete packages[oldLocation];
    const names =
      packages["node_modules/synthetic-foreign-parent"]!.dependencies!;
    delete names[name];
    names[alias] = "npm:" + name + "@1.0.0";
  });
  for (const tree of Object.values(f.trees)) {
    const node = tree.dependencies[name]!;
    const oldProblem = node.problems![0]!;
    node.path = path.join(f.root, location);
    node.problems = [`extraneous: ${name}@1.0.0 ${node.path}`];
    tree.problems = tree.problems.map((problem) =>
      problem === oldProblem ? node.problems![0]! : problem,
    );
    tree.dependencies[alias] = node;
    delete tree.dependencies[name];
  }
  await f.save();
  assert.deepEqual(
    parsed(f.invoke([])).packages.map((p) => p.name),
    ["synthetic-prod"],
  );
  const entry = parsed(f.invoke()).packages.find(
    (p) => p.location === location,
  )!;
  assert.equal(entry.name, name);
  assert.equal(entry.content.files, 3);
});

test("dependency audit confines aggregate diagnostics to the root and exact extraneous owner", async (t) => {
  const f = await optionalOverinstallFixture(t);
  f.trees.development.dependencies["synthetic-development-parent"]!.problems = [
    f.trees.development.problems[0]!,
  ];
  await f.save();
  refused(f.invoke(), /unreconciled problems/);
});

test("dependency audit bounds unreconciled diagnostic context", async (t) => {
  const f = await optionalOverinstallFixture(t);
  for (const tree of Object.values(f.trees))
    tree.problems.push("unknown: " + "x".repeat(4096));
  await f.save();
  const result = f.invoke([]);
  refused(result, /unreconciled problems.*unknown:/);
  assert.equal(result.stderr.includes("x".repeat(257)), false);
});

test("dependency audit refuses a retained optional manifest symlink without reading it as installed identity", async (t) => {
  const f = await optionalOverinstallFixture(t);
  const name = f.retained[0]!;
  const file = path.join(f.root, "node_modules", name, "package.json");
  const outside = await fixture(t, {
    "package.json": await readFile(file, "utf8"),
  });
  await rm(file);
  await symlink(path.join(outside, "package.json"), file);
  for (const args of [[], ["--include-dev"]])
    refused(f.invoke(args), /manifest must be a regular file/);
});

test("dependency audit accepts ordinary custom npm long metadata without mistaking it for diagnostics", async (t) => {
  const root = await realpath(
    await auditFixture(t, [{ name: "synthetic-prod" }]),
  );
  const file = path.join(root, "node_modules/synthetic-prod/package.json");
  const custom = {
    peerMissing: true,
    error: { message: "Original synthetic package metadata" },
    invalid: "Original package-owned invalid field",
    missing: true,
    problems: ["Original package-owned problems field"],
  };
  for (const manifest of [path.join(root, "package.json"), file])
    await writeFile(
      manifest,
      JSON.stringify({
        ...JSON.parse(await readFile(manifest, "utf8")),
        ...custom,
      }),
    );
  for (const args of [[], ["--include-dev"]]) {
    const prefix = [
      "ls",
      ...(args.length ? [] : ["--omit=dev"]),
      "--all",
      "--json",
    ];
    const short = spawnSync("npm", prefix, {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
    const long = spawnSync("npm", [...prefix, "--long"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(short.status, 0, short.stderr);
    assert.equal(long.status, 0, long.stderr);
    const structural = JSON.parse(short.stdout);
    const metadata = JSON.parse(long.stdout);
    for (const [plain, detailed] of [
      [structural, metadata],
      [
        structural.dependencies["synthetic-prod"],
        metadata.dependencies["synthetic-prod"],
      ],
    ])
      for (const [field, value] of Object.entries(custom)) {
        assert.equal(plain[field], undefined);
        assert.deepEqual(detailed[field], value);
      }
    const report = parsed(invoke(root, args));
    assert.equal(report.complete, true);
    assert.equal(report.packageCount, 1);
  }
});

test("dependency audit preserves real npm missing and invalid failures", async (t) => {
  for (const kind of ["missing", "invalid"] as const) {
    const root = await realpath(
      await auditFixture(t, [{ name: "synthetic-prod" }]),
    );
    const file = path.join(root, "node_modules/synthetic-prod/package.json");
    if (kind === "missing") await rm(path.dirname(file), { recursive: true });
    else
      await writeFile(
        file,
        JSON.stringify({
          ...JSON.parse(await readFile(file, "utf8")),
          version: "2.0.0",
          peerMissing: true,
          error: "Original package metadata",
        }),
      );
    const native = spawnSync("npm", ["ls", "--all", "--json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
    assert.notEqual(native.status, 0);
    assert.match(native.stdout, new RegExp(kind + ":"));
    for (const args of [[], ["--include-dev"]])
      refused(invoke(root, args), /Command failed: npm ls/);
  }
});

for (const mismatch of ["topology", "version", "extraneous-state"] as const) {
  test(`dependency audit refuses paired npm trees with changed ${mismatch}`, async (t) => {
    const f = await optionalOverinstallFixture(t);
    const diagnostics = {
      production: npmDiagnosticTree(f.trees.production),
      development: npmDiagnosticTree(f.trees.development),
    };
    for (const tree of Object.values(diagnostics)) {
      const node = tree.dependencies![f.retained[0]!]!;
      if (mismatch === "version") node.version = "2.0.0";
      if (mismatch === "topology") delete tree.dependencies![f.retained[0]!];
      if (mismatch === "extraneous-state") node.extraneous = false;
    }
    await f.save(diagnostics);
    for (const args of [[], ["--include-dev"]])
      refused(
        f.invoke(args),
        /tree (topology|version|extraneous state) changed between captures/,
      );
  });
}

test("production dependency audit binds ordinary transitive and aliased installed names to literal lock identities", async (t) => {
  const root = await realpath(
    await auditFixture(t, [
      { name: "synthetic-prod" },
      { name: "synthetic-published", alias: "synthetic-production-alias" },
      {
        name: "synthetic-wrapper",
        dependencies: { "synthetic-leaf": "1.0.0" },
      },
      { name: "synthetic-leaf", location: "node_modules/synthetic-leaf" },
    ]),
  );
  await changeFixtureLock(root, (packages) => {
    delete packages["node_modules/synthetic-prod"]!.name;
    delete packages["node_modules/synthetic-leaf"]!.name;
  });
  const valid = parsed(invoke(root, []));
  assert.equal(valid.complete, true);
  assert.equal(valid.packageCount, 4);
  assert.equal(
    valid.packages.find(
      (p) => p.location === "node_modules/synthetic-production-alias",
    )!.name,
    "synthetic-published",
  );
  assert.equal(parsed(invoke(root)).complete, true);
  for (const location of [
    "node_modules/synthetic-prod",
    "node_modules/synthetic-leaf",
    "node_modules/synthetic-production-alias",
  ]) {
    const file = path.join(root, location, "package.json");
    const original = await readFile(file, "utf8");
    try {
      await writeFile(
        file,
        JSON.stringify({
          ...JSON.parse(original),
          name: "synthetic-name-drift",
        }),
      );
      const tree = spawnSync(
        "npm",
        ["ls", "--omit=dev", "--all", "--json", "--long"],
        { cwd: root, encoding: "utf8", timeout: 30000 },
      );
      assert.equal(tree.status, 0, tree.stderr);
      for (const args of [[], ["--include-dev"]])
        refused(
          invoke(root, args),
          /Installed dependency name differs from lock/,
        );
    } finally {
      await writeFile(file, original);
    }
    assert.equal(parsed(invoke(root, [])).complete, true);
  }
});

test("production dependency audit runs immediately after root installation before JavaScript fixtures and build", async () => {
  const { parse } = await import("yaml");
  const workflow = parse(
    await readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  const steps = workflow.jobs.checks.steps as { run?: string; name?: string }[];
  const installs = steps
    .map((step, index) => (step.run === "npm ci --ignore-scripts" ? index : -1))
    .filter((index) => index !== -1);
  const audits = steps
    .map((step, index) =>
      step.run === "node scripts/audit-dependencies.mjs" ? index : -1,
    )
    .filter((index) => index !== -1);
  assert.equal(installs.length, 1);
  assert.deepEqual(audits, [installs[0]! + 1]);
  assert.ok(
    audits[0]! < steps.findIndex((step) => step.run === "npm run build"),
  );
  assert.ok(
    audits[0]! <
      steps.findIndex(
        (step) => step.name === "Prepare qualified native JavaScript fixtures",
      ),
  );
});

test("development audit preserves production scope and reconciles actual alias identities at every location without loading code", async (t) => {
  const root = await auditFixture(t, [
    { name: "synthetic-prod" },
    { name: "synthetic-dev", dev: true },
    { name: "synthetic-prod", alias: "synthetic-alias", dev: true },
  ]);
  const production = parsed(invoke(root, []));
  assert.equal(production.scope, "production-npm-dependencies");
  assert.equal(production.packageCount, 1);
  const result = invoke(root),
    report = parsed(result);
  assert.equal(report.scope, "production-and-development-npm-dependencies");
  assert.equal(report.complete, true);
  assert.equal(report.lockedPackageCount, 3);
  assert.equal(report.installedPackageCount, 3);
  assert.deepEqual(
    report.packages.map((p) => [p.location, p.name]),
    [
      ["node_modules/synthetic-alias", "synthetic-prod"],
      ["node_modules/synthetic-dev", "synthetic-dev"],
      ["node_modules/synthetic-prod", "synthetic-prod"],
    ],
  );
  assert.ok(report.packages.every((p) => p.content.files === 3));
  assert.equal(report.completeNativeArtifactClosure, false);
  assert.ok(!result.stdout.includes(root));
});

test("development audit counts duplicate nested package locations and excludes those files from their parent content", async (t) => {
  const root = await auditFixture(t, [
    { name: "synthetic-dev", dev: true },
    { name: "synthetic-wrapper", dependencies: { "synthetic-dev": "1.0.0" } },
    {
      name: "synthetic-dev",
      location: "node_modules/synthetic-wrapper/node_modules/synthetic-dev",
    },
  ]);
  const report = parsed(invoke(root));
  assert.equal(report.installedPackageCount, 3);
  assert.equal(
    report.packages.filter((p) => p.name === "synthetic-dev").length,
    2,
  );
  assert.deepEqual(
    report.packages.map((p) => p.content.files),
    [3, 3, 3],
  );
  const before = report.packages.find(
    (p) => p.location === "node_modules/synthetic-dev",
  )!;
  await writeFile(
    path.join(root, "node_modules/synthetic-dev/index.js"),
    "Original changed synthetic bytes.\n",
  );
  const changed = parsed(invoke(root)).packages.find(
    (p) => p.location === before.location,
  )!;
  assert.notEqual(changed.content.sha256, before.content.sha256);
  assert.equal(changed.manifestSha256, before.manifestSha256);
});

test("development audit reconciles installed foreign-platform and unresolved optional absences without counting them as inspected", async (t) => {
  const root = await auditFixture(t, [
    { name: "synthetic-prod" },
    {
      name: "synthetic-foreign",
      optional: true,
      absent: true,
      os: ["!" + process.platform],
    },
    {
      name: "synthetic-cpu",
      optional: true,
      absent: true,
      cpu: ["synthetic-other-cpu"],
    },
    {
      name: "synthetic-local",
      optional: true,
      absent: true,
      os: [process.platform],
      cpu: [process.arch],
    },
  ]);
  const report = parsed(invoke(root), 2);
  assert.equal(report.complete, false);
  assert.equal(report.lockedPackageCount, 4);
  assert.equal(report.installedPackageCount, 1);
  assert.equal(report.platformInapplicableCount, 2);
  assert.equal(report.optionalAbsentCount, 1);
  assert.equal(
    report.installedPackageCount +
      report.platformInapplicableCount +
      report.optionalAbsentCount,
    report.lockedPackageCount,
  );
  assert.deepEqual(report.gaps, [
    {
      package: "synthetic-local@1.0.0",
      reason:
        "Optional package absent without a demonstrated platform exclusion",
    },
  ]);
  assert.deepEqual(
    report.absentPackages.map((p) => p.state),
    [
      "platform-inapplicable",
      "platform-inapplicable",
      "not-installed-optional",
    ],
  );
});

test("development audit leaves empty and missing development notice cohorts non-passing while retaining present notices", async (t) => {
  const root = await auditFixture(t, [
    { name: "synthetic-prod" },
    { name: "synthetic-dev", dev: true },
  ]);
  await rm(path.join(root, "node_modules/synthetic-dev/LICENSE"));
  await writeFile(
    path.join(
      root,
      "node_modules/synthetic-dev/ThirdPartyNoticeText.txt.backup",
    ),
    "Original backup; not a shipped notice.\n",
  );
  const report = parsed(invoke(root), 2);
  assert.equal(report.complete, false);
  assert.equal(
    report.packages.find((p) => p.name === "synthetic-prod")!.notices.length,
    1,
  );
  assert.deepEqual(report.gaps, [
    { package: "synthetic-dev@1.0.0", reason: "No notice file was located" },
  ]);
  const empty = await auditFixture(t, []),
    emptyReport = parsed(invoke(empty), 2);
  assert.equal(emptyReport.complete, false);
  assert.equal(emptyReport.lockedPackageCount, 0);
  assert.deepEqual(emptyReport.gaps, [
    { package: null, reason: "No installed packages were inspected" },
  ]);
});

test("development audit refuses dev manifest license drift and stale upstream fallback entries", async (t) => {
  const root = await auditFixture(t, [
    { name: "synthetic-prod" },
    { name: "synthetic-dev", dev: true },
  ]);
  const file = path.join(root, "node_modules/synthetic-dev/package.json"),
    original = await readFile(file, "utf8");
  await writeFile(
    file,
    JSON.stringify({ ...JSON.parse(original), license: "ISC" }),
  );
  const drift = invoke(root);
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /license declaration differs/);
  assert.equal(drift.stdout, "");
  await writeFile(file, original);
  await writeFile(
    path.join(root, "scripts/license-sources.json"),
    JSON.stringify({ "synthetic-uninstalled@1.0.0": {} }),
  );
  const stale = invoke(root);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /no longer describes/);
  assert.equal(stale.stdout, "");
});

test("development audit refuses regular-file symlink substitution without inspecting the external file", async (t) => {
  const root = await auditFixture(t, [{ name: "synthetic-prod" }]),
    external = await fixture(t, {
      "external.txt": "Original external marker; must not be captured.\n",
    });
  const link = path.join(root, "node_modules/synthetic-prod/index.js");
  await rm(link);
  await symlink(path.join(external, "external.txt"), link);
  const result = invoke(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /regular file/);
  assert.equal(result.stdout, "");
  assert.equal(
    await readFile(path.join(external, "external.txt"), "utf8"),
    "Original external marker; must not be captured.\n",
  );
});

test("development audit admits the exact individual file byte limit and refuses the next byte before returning evidence", async (t) => {
  const root = await auditFixture(t, [{ name: "synthetic-prod" }]),
    file = path.join(root, "node_modules/synthetic-prod/large.bin");
  const descriptor = await open(file, "w");
  try {
    await descriptor.truncate(128 * 1024 * 1024);
  } finally {
    await descriptor.close();
  }
  const report = parsed(invoke(root));
  assert.equal(report.complete, true);
  assert.equal(report.packages[0]!.content.files, 4);
  assert.ok(report.packages[0]!.content.bytes > 128 * 1024 * 1024);
  const descriptor2 = await open(file, "r+");
  try {
    await descriptor2.truncate(128 * 1024 * 1024 + 1);
  } finally {
    await descriptor2.close();
  }
  const over = invoke(root);
  assert.equal(over.status, 1);
  assert.match(over.stderr, /file exceeds bounds/);
  assert.equal(over.stdout, "");
});

test("development audit admits the exact aggregate byte limit and refuses one extra byte across individually valid files", async (t) => {
  const root = await auditFixture(t, [{ name: "synthetic-prod" }]);
  const directory = path.join(root, "node_modules/synthetic-prod");
  const existing = ["package.json", "LICENSE", "index.js"];
  let existingBytes = 0;
  for (const file of existing)
    existingBytes += (await readFile(path.join(directory, file))).length;
  const firstBytes = 128 * 1024 * 1024;
  const secondBytes = 256 * 1024 * 1024 - existingBytes - firstBytes;
  assert.ok(secondBytes > 0 && secondBytes + 1 <= firstBytes);
  for (const [file, bytes] of [
    ["first.bin", firstBytes],
    ["second.bin", secondBytes],
  ] as const) {
    const descriptor = await open(path.join(directory, file), "w");
    try {
      await descriptor.truncate(bytes);
    } finally {
      await descriptor.close();
    }
  }
  const report = parsed(invoke(root));
  assert.equal(report.complete, true);
  assert.equal(report.packages[0]!.content.bytes, 256 * 1024 * 1024);
  assert.equal(report.packages[0]!.content.files, 5);
  const descriptor = await open(path.join(directory, "second.bin"), "r+");
  try {
    await descriptor.truncate(secondBytes + 1);
  } finally {
    await descriptor.close();
  }
  const over = invoke(root);
  assert.equal(over.status, 1, over.stderr);
  assert.match(over.stderr, /Installed package content exceeds bounds/);
  assert.equal(over.stdout, "");
});

test("development audit admits the exact aggregate file limit and refuses one extra empty file", async (t) => {
  const root = await auditFixture(t, [{ name: "synthetic-prod" }]);
  const directory = path.join(root, "node_modules/synthetic-prod");
  for (let index = 3; index < 8192; index++)
    await writeFile(path.join(directory, `part-${index}.txt`), "");
  const report = parsed(invoke(root));
  assert.equal(report.complete, true);
  assert.equal(report.packages[0]!.content.files, 8192);
  await writeFile(path.join(directory, "one-more.txt"), "");
  const over = invoke(root);
  assert.equal(over.status, 1, over.stderr);
  assert.match(over.stderr, /Installed package content exceeds bounds/);
  assert.equal(over.stdout, "");
});

test("development audit validates the exact CLI selector and retains manifest and notice byte hashes", async (t) => {
  const root = await auditFixture(t, [{ name: "synthetic-prod" }]),
    report = parsed(invoke(root));
  const hash = (body: Uint8Array) =>
    createHash("sha256").update(body).digest("hex");
  assert.equal(
    report.packages[0]!.manifestSha256,
    hash(
      await readFile(
        path.join(root, "node_modules/synthetic-prod/package.json"),
      ),
    ),
  );
  assert.equal(
    report.packages[0]!.notices[0]!.sha256,
    hash(
      await readFile(path.join(root, "node_modules/synthetic-prod/LICENSE")),
    ),
  );
  for (const args of [
    ["--include-dev-extra"],
    ["--include-dev", "--include-dev"],
    ["--root", "outside"],
  ]) {
    const result = invoke(root, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected no arguments or --include-dev/);
    assert.equal(result.stdout, "");
  }
});

test("development audit excludes an absent dependency only when every declared path crosses a foreign platform ancestor", async (t) => {
  const root = await auditFixture(t, [
    {
      name: "synthetic-prod",
      optionalDependencies: { "synthetic-shared": "1.0.0" },
    },
    {
      name: "synthetic-foreign",
      optional: true,
      absent: true,
      os: ["!" + process.platform],
      dependencies: {
        "synthetic-only-foreign": "1.0.0",
        "synthetic-shared": "1.0.0",
      },
    },
    {
      name: "synthetic-only-foreign",
      location: "node_modules/synthetic-only-foreign",
      optional: true,
      absent: true,
    },
    {
      name: "synthetic-shared",
      location: "node_modules/synthetic-shared",
      optional: true,
      absent: true,
    },
  ]);
  const report = parsed(invoke(root), 2);
  assert.equal(report.lockedPackageCount, 4);
  assert.equal(report.platformInapplicableCount, 2);
  assert.equal(report.optionalAbsentCount, 1);
  assert.deepEqual(report.gaps, [
    {
      package: "synthetic-shared@1.0.0",
      reason:
        "Optional package absent without a demonstrated platform exclusion",
    },
  ]);
  assert.equal(
    report.absentPackages.find(
      (p) => p.location === "node_modules/synthetic-only-foreign",
    )!.state,
    "platform-inapplicable",
  );
  assert.equal(
    report.absentPackages.find(
      (p) => p.location === "node_modules/synthetic-shared",
    )!.state,
    "not-installed-optional",
  );
});

test("development audit follows exact npm platform selector boundaries including mixed any and negative-only lists", async (t) => {
  const root = await auditFixture(t, [
    { name: "synthetic-prod" },
    { name: "synthetic-any", optional: true, absent: true, os: ["any"] },
    {
      name: "synthetic-mixed",
      optional: true,
      absent: true,
      os: ["any", "synthetic-foreign-os"],
    },
    {
      name: "synthetic-negative",
      optional: true,
      absent: true,
      os: ["!synthetic-foreign-os"],
    },
    {
      name: "synthetic-case",
      optional: true,
      absent: true,
      os: [process.platform.toUpperCase()],
    },
  ]);
  const report = parsed(invoke(root), 2);
  assert.equal(report.platformInapplicableCount, 2);
  assert.equal(report.optionalAbsentCount, 2);
  assert.deepEqual(
    report.gaps.map((g) => g.package),
    ["synthetic-any@1.0.0", "synthetic-negative@1.0.0"],
  );
  assert.equal(
    report.absentPackages.find(
      (p) => p.location === "node_modules/synthetic-mixed",
    )!.state,
    "platform-inapplicable",
  );
  assert.equal(
    report.absentPackages.find(
      (p) => p.location === "node_modules/synthetic-case",
    )!.state,
    "platform-inapplicable",
  );
});

test("dependency audit refuses backup notice filenames in both scopes and retains exact recognized license variants", async (t) => {
  for (const backup of [
    "LICENSE.backup",
    "NOTICE.old",
    "COPYING.save",
    "LICENSE-MIT.txt.backup",
    "ThirdPartyNoticeText.txt.backup",
  ]) {
    const root = await auditFixture(t, [{ name: "synthetic-prod" }]);
    await rm(path.join(root, "node_modules/synthetic-prod/LICENSE"));
    await writeFile(
      path.join(root, "node_modules/synthetic-prod", backup),
      "Original backup text, not an accepted shipped notice.\n",
    );
    for (const args of [[], ["--include-dev"]]) {
      const report = parsed(invoke(root, args), 2);
      assert.equal(report.complete, false);
      assert.deepEqual(report.gaps, [
        {
          package: "synthetic-prod@1.0.0",
          reason: "No notice file was located",
        },
      ]);
    }
  }
  const root = await auditFixture(t, [{ name: "synthetic-prod" }]);
  await rm(path.join(root, "node_modules/synthetic-prod/LICENSE"));
  for (const valid of [
    "LICENSE-MIT",
    "LICENSE-MIT.txt",
    "LICENSE.bsd",
    "License.md",
    "COPYING.LESSER",
    "ThirdPartyNoticeText.txt",
  ]) {
    const file = path.join(root, "node_modules/synthetic-prod", valid);
    await writeFile(
      file,
      "Original synthetic recognized notice variant; presence accounting only.\n",
    );
    for (const args of [[], ["--include-dev"]]) {
      const report = parsed(invoke(root, args));
      assert.equal(report.complete, true);
      assert.deepEqual(
        report.packages[0]!.notices.map((n) => n.file),
        [valid],
      );
    }
    await rm(file);
  }
});

async function pinnedNoticeFixture(
  t: TestContext,
  development: boolean,
  embedded = false,
) {
  const name = "synthetic-notice";
  const root = await auditFixture(t, [
    { name: "synthetic-prod" },
    { name, dev: development },
  ]);
  const dependency = "node_modules/" + name;
  const notice =
    "Original synthetic notice; accounting only, no legal claim.\n";
  const prefix = "Original 🧪 README heading.\n";
  const readme = prefix + notice + "Original trailing instructions.\n";
  await rm(path.join(root, dependency, "LICENSE"));
  await writeFile(path.join(root, dependency, "README.md"), readme);
  const files = Object.fromEntries(
    await Promise.all(
      ["package.json", "index.js", "README.md"].map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(path.join(root, dependency, file)))
          .digest("hex"),
      ]),
    ),
  );
  const source = {
    ...(development ? { scope: "development" } : {}),
    notice: "docs/licenses/synthetic-notice.txt",
    sha256: createHash("sha256").update(notice).digest("hex"),
    source: "https://example.test/original/" + "a".repeat(40) + "/LICENSE",
    upstreamManifestVersion: "1.0.0",
    license: "MIT",
    files,
    ...(embedded
      ? {
          section: {
            file: "README.md",
            startByte: Buffer.byteLength(prefix),
            endByte: Buffer.byteLength(prefix + notice),
          },
        }
      : {}),
  };
  await mkdir(path.join(root, "docs/licenses"), { recursive: true });
  await writeFile(path.join(root, source.notice), notice);
  const setSource = async (value: unknown) =>
    writeFile(
      path.join(root, "scripts/license-sources.json"),
      JSON.stringify({ [name + "@1.0.0"]: value }),
    );
  await setSource(source);
  return { root, name, dependency, notice, source, setSource };
}

test("development audit scopes pinned notices and preserves exact package document and stale fallback bindings", async (t) => {
  const f = await pinnedNoticeFixture(t, true);
  assert.equal(
    parsed(invoke(f.root, [])).packageCount,
    1,
    "A development notice source cannot widen the production dependency scope",
  );
  const report = parsed(invoke(f.root));
  assert.equal(report.complete, true);
  assert.equal(
    report.packages.find((p) => p.name === f.name)!.notices[0]!.provenance,
    "pinned-upstream-notice",
  );
  const file = path.join(f.root, f.dependency, "index.js");
  const original = await readFile(file);
  await writeFile(file, "Original drifted bytes.\n");
  let bad = invoke(f.root);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /source files changed/);
  assert.equal(bad.stdout, "");
  await writeFile(file, original);
  await writeFile(
    path.join(f.root, f.source.notice),
    f.notice + "Original unexpected suffix.\n",
  );
  bad = invoke(f.root);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Pinned upstream notice changed/);
  assert.equal(bad.stdout, "");
  await writeFile(path.join(f.root, f.source.notice), f.notice);
  await writeFile(path.join(f.root, f.dependency, "LICENSE"), f.notice);
  bad = invoke(f.root);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /fallback is stale/);
  assert.equal(bad.stdout, "");
  await rm(path.join(f.root, f.dependency, "LICENSE"));
  await f.setSource({ ...f.source, scope: "development-extra" });
  bad = invoke(f.root);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Invalid notice source scope/);
  assert.equal(bad.stdout, "");
  await f.setSource(f.source);
  assert.equal(parsed(invoke(f.root)).complete, true);
});

test("development audit binds embedded notice bytes to a captured file and refuses wrong ranges and uncaptured addresses", async (t) => {
  const f = await pinnedNoticeFixture(t, true, true);
  const result = invoke(f.root),
    report = parsed(result);
  const notice = report.packages.find((p) => p.name === f.name)!.notices[0]!;
  assert.equal(notice.provenance, "installed-text-section");
  assert.deepEqual(notice.sourceByteRange, f.source.section);
  assert.equal(notice.sha256, f.source.sha256);
  assert.ok(!result.stdout.includes(f.root));
  const section = f.source.section!;
  for (const [changed, message] of [
    [
      { ...section, startByte: section.startByte - 1 },
      /differs from pinned notice bytes/,
    ],
    [
      { ...section, endByte: section.startByte },
      /Invalid installed notice section/,
    ],
    [{ ...section, endByte: 100000 }, /section exceeds bounds/],
    [{ ...section, file: "not-captured.txt" }, /not a captured package file/],
    [
      { ...section, file: "../external.txt" },
      /Invalid installed notice section/,
    ],
  ] as const) {
    await f.setSource({ ...f.source, section: changed });
    const bad = invoke(f.root);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, message);
    assert.equal(bad.stdout, "");
  }
  await f.setSource(f.source);
  assert.equal(parsed(invoke(f.root)).complete, true);
});

test("dependency audit refuses direct and parent notice symlinks in both scopes and accepts restored regular bytes", async (t) => {
  const f = await pinnedNoticeFixture(t, false);
  const external = await fixture(t, { "notice.txt": f.notice });
  const file = path.join(f.root, f.source.notice);
  for (const args of [[], ["--include-dev"]]) {
    assert.equal(parsed(invoke(f.root, args)).complete, true);
    await rm(file);
    await symlink(path.join(external, "notice.txt"), file);
    let bad = invoke(f.root, args);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /bounded regular file/);
    assert.equal(bad.stdout, "");
    await rm(file);
    await writeFile(file, f.notice);
    const directory = path.dirname(file),
      moved = directory + "-owned-copy";
    await rename(directory, moved);
    try {
      await symlink(moved, directory, "dir");
      bad = invoke(f.root, args);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /must not resolve through a symlink/);
      assert.equal(bad.stdout, "");
    } finally {
      await rm(directory, { force: true });
      await rename(moved, directory);
    }
    assert.equal(parsed(invoke(f.root, args)).complete, true);
  }
  assert.equal(
    await readFile(path.join(external, "notice.txt"), "utf8"),
    f.notice,
  );
});

test("development audit reports conflicting notice license declarations and leaves absent alias sources explicitly uninspected", async (t) => {
  const f = await pinnedNoticeFixture(t, true);
  await f.setSource({ ...f.source, license: "BSD-2-Clause" });
  const report = parsed(invoke(f.root), 2);
  assert.equal(report.complete, false);
  assert.deepEqual(report.gaps, [
    {
      package: f.name + "@1.0.0",
      reason: "Installed and notice source license declarations differ",
      installedLicense: "MIT",
      noticeSourceLicense: "BSD-2-Clause",
    },
  ]);
  await f.setSource(f.source);
  assert.equal(parsed(invoke(f.root)).complete, true);
  const foreign = await auditFixture(t, [
    { name: "synthetic-prod" },
    {
      name: "synthetic-foreign",
      alias: "synthetic-alias",
      optional: true,
      absent: true,
      os: ["!" + process.platform],
    },
  ]);
  await writeFile(
    path.join(foreign, "scripts/license-sources.json"),
    JSON.stringify({
      "synthetic-foreign@1.0.0": { ...f.source, files: {} },
    }),
  );
  const excluded = parsed(invoke(foreign));
  assert.equal(excluded.platformInapplicableCount, 1);
  assert.deepEqual(excluded.uninspectedNoticeSources, [
    {
      package: "synthetic-foreign@1.0.0",
      state: "platform-inapplicable",
      noticeInspected: false,
    },
  ]);
  assert.equal(excluded.absentPackages[0]!.package, "synthetic-foreign@1.0.0");
  await writeFile(
    path.join(foreign, "scripts/license-sources.json"),
    JSON.stringify({
      "synthetic-uninstalled@1.0.0": f.source,
    }),
  );
  const stale = invoke(foreign);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /no longer describes/);
  assert.equal(stale.stdout, "");
});

test("development audit refuses installed names that disagree with literal lock identities at ordinary and aliased locations", async (t) => {
  for (const alias of [undefined, "synthetic-alias"]) {
    const root = await auditFixture(t, [
      { name: "synthetic-prod" },
      { name: "synthetic-dev", dev: true, ...(alias ? { alias } : {}) },
    ]);
    assert.equal(parsed(invoke(root)).complete, true);
    const file = path.join(root, "package-lock.json"),
      original = await readFile(file, "utf8");
    const lock = JSON.parse(original) as {
      packages: Record<string, { name?: string }>;
    };
    const entry = lock.packages["node_modules/" + (alias ?? "synthetic-dev")]!;
    entry.name = "synthetic-mismatched-identity";
    await writeFile(file, JSON.stringify(lock));
    let bad = invoke(root);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Installed dependency name differs from lock/);
    assert.equal(bad.stdout, "");
    delete entry.name;
    await writeFile(file, JSON.stringify(lock));
    if (alias) {
      bad = invoke(root);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /Installed dependency name differs from lock/);
      assert.equal(bad.stdout, "");
    } else {
      assert.equal(
        parsed(invoke(root)).complete,
        true,
        "An ordinary location retains its exact basename identity when the lock omits name",
      );
    }
    await writeFile(file, original);
    assert.equal(parsed(invoke(root)).complete, true);
  }
});

test("dependency audit admits exact pinned notice bounds and refuses empty or oversized bytes in both scopes", async (t) => {
  const f = await pinnedNoticeFixture(t, false);
  for (const args of [[], ["--include-dev"]]) {
    for (const size of [0, 1024 * 1024, 1024 * 1024 + 1]) {
      const bytes = Buffer.alloc(size, 0x78);
      await writeFile(path.join(f.root, f.source.notice), bytes);
      await f.setSource({
        ...f.source,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      const result = invoke(f.root, args);
      if (size === 1024 * 1024) {
        assert.equal(parsed(result).complete, true);
      } else {
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /bounded regular file/);
        assert.equal(result.stdout, "");
      }
    }
  }
});

test("dependency audit refuses same-byte notice replacement during capture in both scopes and accepts stable restored files", async (t) => {
  const f = await pinnedNoticeFixture(t, false);
  const file = await realpath(path.join(f.root, f.source.notice));
  const loader = path.join(f.root, "scripts/notice-replacement-loader.mjs");
  await writeFile(
    loader,
    `
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const target = ${JSON.stringify(file)};
const originalRead = fs.readFile;
let replaced = false;
fs.readFile = async (...args) => {
  const bytes = await originalRead(...args);
  if (!replaced && args[0] === target) {
    replaced = true;
    await fs.writeFile(target + ".owned-replacement", bytes);
    await fs.rename(target + ".owned-replacement", target);
  }
  return bytes;
};
syncBuiltinESMExports();
`,
  );
  for (const args of [[], ["--include-dev"]]) {
    const before = await lstat(file);
    const result = invoke(f.root, args, [
      "--import",
      pathToFileURL(loader).href,
    ]);
    const after = await lstat(file);
    assert.notDeepEqual(
      [after.dev, after.ino, after.ctimeMs],
      [before.dev, before.ino, before.ctimeMs],
      "The fixture must actually replace the file during the read",
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Pinned notice changed during capture/);
    assert.equal(result.stdout, "");
    assert.equal(await readFile(file, "utf8"), f.notice);
    assert.equal(parsed(invoke(f.root, args)).complete, true);
  }
});

test("dependency audit requires canonical notice addresses before platform normalization in both scopes", async (t) => {
  const f = await pinnedNoticeFixture(t, false);
  const bad = String.raw`docs/licenses/..\..\outside.txt`;
  assert.equal(
    path.win32.join(String.raw`C:\original-synthetic-root`, bad),
    String.raw`C:\original-synthetic-root\outside.txt`,
  );
  await rename(path.join(f.root, f.source.notice), path.join(f.root, bad));
  await f.setSource({ ...f.source, notice: bad });
  for (const args of [[], ["--include-dev"]]) {
    const result = invoke(f.root, args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /canonical docs\/licenses path/);
    assert.equal(result.stdout, "");
  }
  const valid = "docs/licenses/synthetic-notice+secondary@1.0.0.txt";
  await rename(path.join(f.root, bad), path.join(f.root, valid));
  await f.setSource({ ...f.source, notice: valid });
  for (const args of [[], ["--include-dev"]])
    assert.equal(parsed(invoke(f.root, args)).complete, true);
});
