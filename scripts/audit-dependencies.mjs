import assert from "node:assert/strict";
import { runAuditNpm, observeAuditLibc } from "./dependency-audit-runtime.mjs";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

assert.ok(
  process.argv.slice(2).length === 0 ||
    (process.argv.length === 3 && process.argv[2] === "--include-dev"),
  "Expected no arguments or --include-dev",
);
const includeDev = process.argv[2] === "--include-dev";
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const noticeNames = new Set([
  "licence",
  "licence.txt",
  "licence.md",
  "license",
  "license.txt",
  "license.md",
  "license.rst",
  "license-mit",
  "license-mit.txt",
  "license.bsd",
  "license-apache",
  "license-apache.txt",
  "license.apache",
  "license.apache2",
  "license-bsd",
  "license-bsd.txt",
  "license-isc",
  "license-isc.txt",
  "copying",
  "copying.txt",
  "copying.md",
  "copying.lesser",
  "notice",
  "notice.txt",
  "notice.md",
  "thirdpartynoticetext.txt",
]);

async function packageContents(directory) {
  const files = [];
  let bytes = 0;
  async function visit(relative) {
    const entries = await readdir(path.join(directory, relative), {
      withFileTypes: true,
    });
    for (const item of entries.sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      if (relative === "" && item.name === "node_modules") continue;
      const file = path.posix.join(relative, item.name);
      if (item.isDirectory()) {
        assert.equal(
          await realpath(path.join(directory, file)),
          path.join(directory, file),
          "Package directory must not follow symlinks",
        );
        await visit(file);
      } else {
        assert.ok(
          item.isFile(),
          "Installed package entry is not a regular file",
        );
        const stat = await lstat(path.join(directory, file));
        assert.ok(
          stat.isFile() &&
            !stat.isSymbolicLink() &&
            stat.size <= 128 * 1024 * 1024,
          "Installed package file exceeds bounds",
        );
        const body = await readFile(path.join(directory, file));
        const after = await lstat(path.join(directory, file));
        assert.ok(
          stat.dev === after.dev &&
            stat.ino === after.ino &&
            stat.size === after.size &&
            stat.mtimeMs === after.mtimeMs &&
            stat.ctimeMs === after.ctimeMs &&
            body.length === stat.size,
          "Installed package file changed during capture",
        );
        bytes += body.length;
        assert.ok(
          files.length < 8192 && bytes <= 256 * 1024 * 1024,
          "Installed package content exceeds bounds",
        );
        files.push({ file, bytes: body.length, sha256: hash(body) });
      }
    }
  }
  await visit("");
  assert.ok(files.length > 0, "Installed package content cannot be empty");
  return {
    files: files.length,
    bytes,
    sha256: hash(JSON.stringify(files)),
    fileSha256: Object.fromEntries(
      files.map((file) => [file.file, file.sha256]),
    ),
  };
}

const lockBytes = await readFile(path.join(root, "package-lock.json"));
const lock = JSON.parse(lockBytes);
const allSources = JSON.parse(
  await readFile(new URL("./license-sources.json", import.meta.url), "utf8"),
);
assert.ok(
  allSources && typeof allSources === "object" && !Array.isArray(allSources),
  "Invalid notice source index",
);
for (const source of Object.values(allSources))
  assert.ok(
    source &&
      typeof source === "object" &&
      (source.scope === undefined || source.scope === "development"),
    "Invalid notice source scope",
  );
const sources = Object.fromEntries(
  Object.entries(allSources).filter(
    ([, source]) => includeDev || source.scope !== "development",
  ),
);
const tree = JSON.parse(
  runAuditNpm(
    ["ls", ...(includeDev ? ["--long"] : ["--omit=dev"]), "--all", "--json"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    },
  ),
);
const treeIdentities = new Set();
const treeLocations = new Map();
function inspectTree(node) {
  assert.ok(
    !node.problems?.length,
    "Installed production dependency tree has problems",
  );
  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    if (child.version) {
      const packageName = includeDev ? child.name : name;
      assert.ok(
        typeof packageName === "string" && packageName.length > 0,
        "Installed dependency has no package identity",
      );
      treeIdentities.add(`${packageName}@${child.version}`);
      if (includeDev) {
        const location = path
          .relative(root, child.path)
          .split(path.sep)
          .join("/");
        assert.ok(
          location.startsWith("node_modules/") &&
            !location.split(path.sep).includes(".."),
          "Installed dependency tree path escapes package root",
        );
        const id = `${packageName}@${child.version}`;
        assert.ok(
          !treeLocations.has(location) || treeLocations.get(location) === id,
          "Installed dependency tree location conflicts",
        );
        treeLocations.set(location, id);
      }
    }
    inspectTree(child);
  }
}
inspectTree(tree);

// Use only the lock's literal package graph. An absent shared dependency is
// excluded only when every root-reachable path crosses an incompatible package.
const graph = new Map();
const platformBlocked = new Set();
const libc = includeDev ? observeAuditLibc() : null;
function lockedDependency(parent, name) {
  let prefix = parent;
  while (true) {
    if (!prefix.endsWith("node_modules")) {
      const candidate = (prefix ? prefix + "/" : "") + "node_modules/" + name;
      if (lock.packages[candidate]) return candidate;
    }
    if (!prefix) return undefined;
    const separator = prefix.lastIndexOf("/");
    prefix = separator === -1 ? "" : prefix.slice(0, separator);
  }
}
function reachable(start, blocked) {
  const found = new Set(),
    pending = [start];
  while (pending.length) {
    const node = pending.pop();
    if (found.has(node) || blocked.has(node)) continue;
    found.add(node);
    pending.push(...(graph.get(node) ?? []));
  }
  return found;
}
let allReachable, selectedReachable;

const packages = [];
const gaps = [];
const usedSources = new Set();
const absentPackages = [];
const installedLocations = new Map();
let lockedPackageCount = 0;
const includesPlatform = (selection, value) => {
  if (selection === undefined) return true;
  const list = typeof selection === "string" ? [selection] : selection;
  assert.ok(
    Array.isArray(list) && list.every((item) => typeof item === "string"),
    "Invalid optional platform selector",
  );
  if (list.length === 1 && list[0] === "any") return true;
  const positive = list.filter((item) => !item.startsWith("!"));
  return (
    !list.includes("!" + value) &&
    (positive.length === 0 || positive.includes(value))
  );
};
if (includeDev) {
  for (const [location, entry] of Object.entries(lock.packages)) {
    const libcAllowed = includesPlatform(entry.libc, libc ?? "unknown");
    if (
      !includesPlatform(entry.os, process.platform) ||
      !includesPlatform(entry.cpu, process.arch) ||
      (process.platform === "linux" && libc !== null && !libcAllowed)
    )
      platformBlocked.add(location);
    const names = new Set([
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...Object.keys(entry.peerDependencies ?? {}),
      ...(location === "" ? Object.keys(entry.devDependencies ?? {}) : []),
    ]);
    graph.set(
      location,
      [...names]
        .map((name) => lockedDependency(location, name))
        .filter((node) => node !== undefined),
    );
  }
  allReachable = reachable("", new Set());
  selectedReachable = reachable("", platformBlocked);
}

for (const [location, entry] of Object.entries(lock.packages).sort(([a], [b]) =>
  a.localeCompare(b, "en"),
)) {
  if (!location || (!includeDev && entry.dev)) continue;
  lockedPackageCount++;
  assert.match(location, /^node_modules\//);
  assert.ok(!path.isAbsolute(location) && !location.split("/").includes(".."));
  const directory = path.join(root, location);
  if (includeDev) {
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(new URL(entry.resolved).origin, "https://registry.npmjs.org");
    try {
      await lstat(directory);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      assert.equal(
        entry.optional,
        true,
        "Required locked dependency is not installed",
      );
      const inheritedExclusion =
        allReachable.has(location) && !selectedReachable.has(location);
      const excluded = platformBlocked.has(location) || inheritedExclusion;
      const blockingAncestors = inheritedExclusion
        ? [...platformBlocked]
            .filter(
              (ancestor) =>
                allReachable.has(ancestor) &&
                reachable(ancestor, new Set()).has(location),
            )
            .sort()
        : [];
      const packageName = entry.name ?? location.split("node_modules/").at(-1);
      assert.ok(
        typeof packageName === "string" && packageName.length > 0,
        "Absent dependency has no package identity",
      );
      const id = packageName + "@" + entry.version;
      absentPackages.push({
        location,
        package: id,
        declaredIntegrity: entry.integrity,
        resolved: entry.resolved,
        state: excluded ? "platform-inapplicable" : "not-installed-optional",
        os: entry.os ?? null,
        cpu: entry.cpu ?? null,
        libc: entry.libc ?? null,
        ...(inheritedExclusion ? { blockingAncestors } : {}),
      });
      if (!excluded)
        gaps.push({
          package: id,
          reason:
            "Optional package absent without an incompatible OS, CPU or observed libc declaration",
        });
      continue;
    }
  }
  assert.equal(
    await realpath(directory),
    directory,
    "Production package must not resolve through an external symlink",
  );
  const manifestBytes = await readFile(path.join(directory, "package.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const id = `${manifest.name}@${manifest.version}`;
  if (includeDev) {
    assert.equal(
      manifest.name,
      entry.name ?? location.split("node_modules/").at(-1),
      "Installed dependency name differs from lock for " + location,
    );
    assert.equal(
      treeLocations.get(location),
      id,
      "Installed dependency location differs from tree",
    );
    installedLocations.set(location, id);
  }
  assert.equal(
    manifest.version,
    entry.version,
    `Installed version differs from lock for ${location}`,
  );
  assert.equal(
    manifest.license,
    entry.license,
    `Installed license declaration differs from lock for ${location}`,
  );
  assert.ok(
    treeIdentities.has(id),
    `Locked production package missing from installed dependency tree: ${id}`,
  );
  assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(new URL(entry.resolved).origin, "https://registry.npmjs.org");
  const notices = [];
  for (const name of (await readdir(directory)).sort()) {
    if (!noticeNames.has(name.toLowerCase())) continue;
    const file = path.join(directory, name);
    const stat = await lstat(file);
    assert.ok(
      stat.isFile() && stat.size > 0 && stat.size <= 1024 * 1024,
      `Invalid notice file for ${id}`,
    );
    const bytes = await readFile(file);
    notices.push({
      file: name,
      provenance: "installed-package",
      sha256: hash(bytes),
      bytes: bytes.length,
    });
  }
  if (sources[id]) {
    assert.equal(
      notices.length,
      0,
      `Upstream notice fallback is stale for ${id}`,
    );
    const source = sources[id];
    const actualFiles = {};
    async function visit(relative) {
      for (const item of await readdir(path.join(directory, relative), {
        withFileTypes: true,
      })) {
        const file = path.posix.join(relative, item.name);
        if (item.isDirectory()) await visit(file);
        else {
          assert.ok(item.isFile(), `Unexpected package entry in ${id}`);
          actualFiles[file] = hash(await readFile(path.join(directory, file)));
        }
      }
    }
    await visit("");
    assert.deepEqual(
      actualFiles,
      source.files,
      `Pinned upstream notice source files changed for ${id}`,
    );
    assert.match(
      source.notice,
      /^docs\/licenses\/[^/\\]+\.txt$/,
      "Pinned notice must use a canonical docs/licenses path",
    );
    const noticePath = path.join(root, source.notice);
    const noticeStat = await lstat(noticePath);
    assert.ok(
      noticeStat.isFile() &&
        !noticeStat.isSymbolicLink() &&
        noticeStat.size > 0 &&
        noticeStat.size <= 1024 * 1024,
      "Pinned notice must be a bounded regular file",
    );
    assert.equal(
      await realpath(noticePath),
      noticePath,
      "Pinned notice must not resolve through a symlink",
    );
    const bytes = await readFile(noticePath);
    const noticeAfter = await lstat(noticePath);
    assert.ok(
      noticeStat.dev === noticeAfter.dev &&
        noticeStat.ino === noticeAfter.ino &&
        noticeStat.size === noticeAfter.size &&
        noticeStat.mtimeMs === noticeAfter.mtimeMs &&
        noticeStat.ctimeMs === noticeAfter.ctimeMs &&
        bytes.length === noticeStat.size,
      "Pinned notice changed during capture",
    );
    assert.equal(
      hash(bytes),
      source.sha256,
      `Pinned upstream notice changed for ${id}`,
    );
    if (source.section !== undefined) {
      const section = source.section;
      assert.ok(
        section &&
          typeof section === "object" &&
          typeof section.file === "string" &&
          !path.posix.isAbsolute(section.file) &&
          !section.file
            .split("/")
            .some((part) => !part || part === "." || part === "..") &&
          !section.file.includes("\\") &&
          Number.isSafeInteger(section.startByte) &&
          Number.isSafeInteger(section.endByte) &&
          section.startByte >= 0 &&
          section.endByte > section.startByte,
        "Invalid installed notice section",
      );
      assert.ok(
        Object.hasOwn(actualFiles, section.file),
        "Installed notice section is not a captured package file",
      );
      const sectionPath = path.join(directory, section.file);
      assert.equal(
        await realpath(sectionPath),
        sectionPath,
        "Installed notice section must not resolve through a symlink",
      );
      const sectionBytes = await readFile(sectionPath);
      assert.equal(
        hash(sectionBytes),
        actualFiles[section.file],
        "Installed notice section changed during capture",
      );
      assert.ok(
        section.endByte <= sectionBytes.length &&
          section.endByte - section.startByte <= 1024 * 1024,
        "Installed notice section exceeds bounds",
      );
      assert.deepEqual(
        sectionBytes.subarray(section.startByte, section.endByte),
        bytes,
        "Installed notice section differs from pinned notice bytes",
      );
    }
    if (source.license !== undefined) {
      assert.ok(
        typeof source.license === "string" && source.license.length > 0,
        "Invalid notice source license declaration",
      );
      if (source.license !== manifest.license)
        gaps.push({
          package: id,
          reason: "Installed and notice source license declarations differ",
          installedLicense: manifest.license,
          noticeSourceLicense: source.license,
        });
    }
    notices.push({
      file: source.notice,
      provenance: source.section
        ? "installed-text-section"
        : "pinned-upstream-notice",
      source: source.source,
      upstreamManifestVersion: source.upstreamManifestVersion,
      ...(source.section ? { sourceByteRange: source.section } : {}),
      ...(source.license !== undefined
        ? { noticeSourceLicense: source.license }
        : {}),
      sha256: hash(bytes),
      bytes: bytes.length,
    });
    usedSources.add(id);
  }
  if (!notices.length)
    gaps.push({ package: id, reason: "No notice file was located" });
  if (typeof manifest.license !== "string" || !manifest.license)
    gaps.push({
      package: id,
      reason: "No string license declaration was located",
    });
  const contentSnapshot = includeDev
    ? await packageContents(directory)
    : undefined;
  let content;
  if (contentSnapshot) {
    const { fileSha256, ...identity } = contentSnapshot;
    assert.equal(
      fileSha256["package.json"],
      hash(manifestBytes),
      "Installed package manifest changed during capture",
    );
    for (const notice of notices.filter(
      (notice) => notice.provenance === "installed-package",
    ))
      assert.equal(
        fileSha256[notice.file],
        notice.sha256,
        "Installed notice changed during capture",
      );
    content = identity;
  }
  packages.push({
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    location,
    resolved: entry.resolved,
    declaredIntegrity: entry.integrity,
    notices,
    ...(includeDev
      ? {
          manifestSha256: hash(manifestBytes),
          content,
        }
      : {}),
  });
}
assert.deepEqual(
  new Set(packages.map((item) => `${item.name}@${item.version}`)),
  treeIdentities,
  "Production lock and installed tree identities differ",
);
const uninspectedNoticeSources = includeDev
  ? Object.keys(sources)
      .filter(
        (id) =>
          !usedSources.has(id) &&
          absentPackages.some(
            (p) => p.package === id && p.state === "platform-inapplicable",
          ),
      )
      .map((id) => ({
        package: id,
        state: "platform-inapplicable",
        noticeInspected: false,
      }))
  : [];
assert.deepEqual(
  new Set([
    ...usedSources,
    ...uninspectedNoticeSources.map((source) => source.package),
  ]),
  new Set(Object.keys(sources)),
  "An upstream notice fallback no longer describes an installed production package",
);
if (includeDev) {
  assert.deepEqual(
    installedLocations,
    treeLocations,
    "Installed package locations and lockfile differ",
  );
  assert.equal(
    packages.length + absentPackages.length,
    lockedPackageCount,
    "Locked package accounting differs",
  );
  if (packages.length === 0)
    gaps.push({
      package: null,
      reason: "No installed packages were inspected",
    });
}
process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: includeDev ? 2 : 1,
      provenance: "installed-metadata-and-lockfile-audit",
      scope: includeDev
        ? "production-and-development-npm-dependencies"
        : "production-npm-dependencies",
      ...(includeDev
        ? {
            runtime: {
              node: process.versions.node,
              platform: process.platform,
              architecture: process.arch,
              libc,
              libcEvidence:
                process.platform !== "linux"
                  ? "not-applicable"
                  : libc === null
                    ? "unknown"
                    : "runtime-report",
            },
            lockedPackageCount,
            installedPackageCount: packages.length,
            platformInapplicableCount: absentPackages.filter(
              (p) => p.state === "platform-inapplicable",
            ).length,
            optionalAbsentCount: absentPackages.filter(
              (p) => p.state === "not-installed-optional",
            ).length,
            absentPackages,
            uninspectedNoticeSources,
            installedContentIntegrityIsArchiveIntegrity: false,
            completeNativeArtifactClosure: false,
          }
        : {}),
      complete: gaps.length === 0,
      lockfileSHA256: hash(lockBytes),
      packageCount: packages.length,
      gaps,
      packages,
      limitations: [
        "Declared integrity is recorded, not recomputed over installed package contents",
        "License declarations and notice presence do not establish legal compliance",
        ...(includeDev
          ? [
              "Absent optional packages retain explicit platform exclusions or unresolved gaps",
              "Installed content hashes bind observed files, not npm archive integrity or producer authentication",
              "Native toolchains and container images are outside this audit",
            ]
          : [
              "Development dependencies, native toolchains and container images are outside this audit",
            ]),
      ],
    },
    null,
    2,
  )}\n`,
);
process.exitCode = gaps.length ? 2 : 0;
