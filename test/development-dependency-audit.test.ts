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
