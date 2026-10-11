import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
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
function invoke(root: string, args = ["--include-dev"]) {
  return spawnSync(
    process.execPath,
    [path.join(root, "scripts/audit-dependencies.mjs"), ...args],
    { cwd: root, encoding: "utf8", timeout: 30000 },
  );
}
type Audit = {
  complete: boolean;
  scope: string;
  lockedPackageCount: number;
  installedPackageCount: number;
  platformInapplicableCount: number;
  optionalAbsentCount: number;
  packageCount: number;
  completeNativeArtifactClosure: boolean;
  absentPackages: { location: string; state: string }[];
  gaps: { package: string | null; reason: string }[];
  packages: {
    name: string;
    location: string;
    manifestSha256: string;
    content: { files: number; bytes: number; sha256: string };
    notices: { file: string; sha256: string }[];
  }[];
};
function parsed(result: ReturnType<typeof invoke>, status = 0): Audit {
  assert.equal(result.status, status, result.stderr);
  return JSON.parse(result.stdout) as Audit;
}

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
        "Optional package absent without an incompatible OS or CPU declaration",
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
        "Optional package absent without an incompatible OS or CPU declaration",
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
