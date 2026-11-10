import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
function captureRuntimeLibc() {
  if (process.platform !== "linux")
    return { family: "unknown", evidence: "not-linux" };
  const report = process.report;
  if (!report || typeof report.getReport !== "function")
    return { family: "unknown", evidence: "report-unavailable" };
  const settings = ["excludeNetwork", "excludeEnv"]
    .map((name) => [name, report[name]])
    .filter(([, value]) => typeof value === "boolean");
  try {
    for (const [name] of settings) report[name] = true;
    const observed = report.getReport();
    const version = observed?.header?.glibcVersionRuntime;
    if (
      typeof version === "string" &&
      version.length <= 32 &&
      /^\d+\.\d+(?:\.\d+)?$/.test(version)
    )
      return { family: "glibc", evidence: "node-report-header", version };
    if (
      Array.isArray(observed?.sharedObjects) &&
      observed.sharedObjects.some(
        (file) =>
          typeof file === "string" &&
          /^(?:libc\.musl-|ld-musl-)[A-Za-z0-9_-]+\.so\.1$/.test(
            path.posix.basename(file),
          ),
      )
    )
      return { family: "musl", evidence: "node-report-shared-object" };
    return { family: "unknown", evidence: "unrecognized-report" };
  } catch {
    return { family: "unknown", evidence: "report-unavailable" };
  } finally {
    for (const [name, value] of settings) report[name] = value;
  }
}
const runtimeLibc = captureRuntimeLibc();

// Use only the lock's literal graph in both audit modes. An absent or retained
// optional dependency is platform-excluded only without a compatible root path.
const graph = new Map();
const platformBlocked = new Set();
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
function reachable(start, blocked, rootEdges = graph.get("") ?? []) {
  const found = new Set(),
    pending = [start];
  while (pending.length) {
    const node = pending.pop();
    if (found.has(node) || blocked.has(node)) continue;
    found.add(node);
    pending.push(...(node === "" ? rootEdges : (graph.get(node) ?? [])));
  }
  return found;
}
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
for (const [location, entry] of Object.entries(lock.packages)) {
  const libcMatches = includesPlatform(entry.libc, runtimeLibc.family);
  if (
    !includesPlatform(entry.os, process.platform) ||
    !includesPlatform(entry.cpu, process.arch) ||
    (runtimeLibc.family !== "unknown" && !libcMatches)
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
const allReachable = reachable("", new Set());
const selectedReachable = reachable("", platformBlocked);
const rootPackage = lock.packages[""];
const productionRoots = [
  ...new Set([
    ...Object.keys(rootPackage.dependencies ?? {}),
    ...Object.keys(rootPackage.optionalDependencies ?? {}),
    ...Object.keys(rootPackage.peerDependencies ?? {}),
  ]),
]
  .map((name) => lockedDependency("", name))
  .filter((location) => location !== undefined);
const productionReachable = reachable("", platformBlocked, productionRoots);

function npmTree(long) {
  return JSON.parse(
    execFileSync(
      "npm",
      [
        "ls",
        ...(includeDev ? [] : ["--omit=dev"]),
        "--all",
        "--json",
        ...(long ? ["--long"] : []),
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
      },
    ),
  );
}
// Long output copies arbitrary package.json fields. Only the short tree's
// npm-owned diagnostics can authorize failures or a retained-optional exception.
const diagnosticTree = npmTree(false);
const tree = npmTree(true);
const treeIdentities = new Set();
const treeLocations = new Map();
const retainedOptionalProblems = new Set();
const treeProblems = [];
function treeContext(node) {
  return JSON.stringify({
    name: typeof node.name === "string" ? node.name.slice(0, 128) : null,
    version:
      typeof node.version === "string" ? node.version.slice(0, 64) : null,
    location:
      typeof node.path === "string"
        ? path.relative(root, node.path).slice(0, 256)
        : null,
  });
}
async function inspectTree(
  node,
  diagnostic,
  isRoot = false,
  omittedDevelopment = false,
) {
  let omittedBranch = omittedDevelopment;
  assert.ok(
    node && typeof node === "object" && !Array.isArray(node),
    "Invalid installed dependency tree node",
  );
  assert.ok(
    diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic),
    "Invalid installed dependency diagnostic node",
  );
  const context = treeContext(node);
  assert.equal(
    node.version,
    diagnostic.version,
    "Installed dependency tree version changed between captures: " + context,
  );
  assert.equal(
    node.extraneous === true,
    diagnostic.extraneous === true,
    "Installed dependency tree extraneous state changed between captures: " +
      context,
  );
  assert.deepEqual(
    Object.keys(node.dependencies ?? {}).sort(),
    Object.keys(diagnostic.dependencies ?? {}).sort(),
    "Installed dependency tree topology changed between captures: " + context,
  );
  assert.ok(
    !diagnostic.invalid && !diagnostic.missing,
    "Invalid or missing installed dependency: " + context,
  );
  assert.ok(
    diagnostic.extraneous === undefined ||
      typeof diagnostic.extraneous === "boolean",
    "Invalid extraneous dependency flag: " + context,
  );
  if (diagnostic.problems !== undefined) {
    assert.ok(
      Array.isArray(diagnostic.problems),
      "Invalid installed dependency diagnostics: " + context,
    );
    for (const problem of diagnostic.problems)
      treeProblems.push({ problem, context, node, diagnostic, isRoot });
  }
  assert.ok(
    !isRoot || !diagnostic.extraneous,
    "Installed root cannot be extraneous",
  );
  if (!isRoot && (node.version || diagnostic.extraneous)) {
    const packageName = node.name;
    assert.ok(
      typeof packageName === "string" &&
        packageName.length > 0 &&
        typeof node.version === "string" &&
        node.version.length > 0,
      "Installed dependency has no package identity: " + context,
    );
    const id = `${packageName}@${node.version}`;
    assert.ok(
      typeof node.path === "string" && path.isAbsolute(node.path),
      "Installed dependency tree has no absolute path: " + context,
    );
    const location = path.relative(root, node.path).split(path.sep).join("/");
    assert.ok(
      location.startsWith("node_modules/") &&
        !location.split("/").includes("..") &&
        path.join(root, location) === node.path,
      "Installed dependency tree path escapes package root: " + context,
    );
    const entry = lock.packages[location];
    if (diagnostic.extraneous) {
      // npm 10 can retain locked optional descendants of omitted foreign
      // packages. Its aggregate diagnostics are not themselves proof of this.
      assert.ok(
        entry &&
          entry.optional === true &&
          allReachable.has(location) &&
          !selectedReachable.has(location),
        "Unreconciled extraneous dependency: " + context,
      );
      assert.ok(
        [...platformBlocked].some(
          (ancestor) =>
            ancestor !== location &&
            lock.packages[ancestor].optional === true &&
            allReachable.has(ancestor) &&
            reachable(ancestor, new Set()).has(location),
        ),
        "Extraneous dependency has no incompatible optional ancestor: " +
          context,
      );
      assert.equal(
        await realpath(node.path),
        node.path,
        "Extraneous dependency path must be canonical: " + context,
      );
      const manifestPath = path.join(node.path, "package.json");
      const stat = await lstat(manifestPath);
      assert.ok(
        stat.isFile() && !stat.isSymbolicLink(),
        "Extraneous dependency manifest must be a regular file: " + context,
      );
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.ok(
        packageName ===
          (entry.name ?? location.split("node_modules/").at(-1)) &&
          packageName === manifest.name &&
          node.version === entry.version &&
          node.version === manifest.version,
        "Extraneous dependency identity differs from lock or installed manifest: " +
          context,
      );
      const problem = `extraneous: ${id} ${node.path}`;
      assert.ok(
        diagnostic.problems?.includes(problem),
        "Extraneous dependency has no exact diagnostic: " + context,
      );
      retainedOptionalProblems.add(problem);
      if (entry.dev) omittedBranch = true;
    } else {
      assert.ok(
        entry,
        "Installed dependency tree location is not locked: " + context,
      );
      assert.equal(
        await realpath(node.path),
        node.path,
        "Installed dependency path must be canonical: " + context,
      );
      const manifestPath = path.join(node.path, "package.json");
      const stat = await lstat(manifestPath);
      assert.ok(
        stat.isFile() && !stat.isSymbolicLink(),
        "Installed dependency manifest must be a regular file: " + context,
      );
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const expectedName = entry.name ?? location.split("node_modules/").at(-1);
      assert.equal(
        packageName,
        expectedName,
        "Installed dependency name differs from lock for " + location,
      );
      assert.equal(
        manifest.name,
        expectedName,
        "Installed dependency name differs from lock for " + location,
      );
      assert.equal(
        node.version,
        entry.version,
        "Installed version differs from lock for " + location,
      );
      assert.equal(
        manifest.version,
        entry.version,
        "Installed version differs from lock for " + location,
      );
    }
    const omittedProjection =
      !includeDev &&
      omittedBranch &&
      entry.dev &&
      !productionReachable.has(location);
    if (!omittedProjection) {
      treeIdentities.add(id);
      if (includeDev) {
        assert.ok(
          !treeLocations.has(location) || treeLocations.get(location) === id,
          "Installed dependency tree location conflicts",
        );
        treeLocations.set(location, id);
      }
    }
  }
  for (const [name, child] of Object.entries(node.dependencies ?? {}))
    await inspectTree(
      child,
      diagnostic.dependencies[name],
      false,
      omittedBranch,
    );
}
await inspectTree(tree, diagnosticTree, true);
for (const { problem, context, node, diagnostic, isRoot } of treeProblems)
  assert.ok(
    typeof problem === "string" &&
      retainedOptionalProblems.has(problem) &&
      (isRoot ||
        (diagnostic.extraneous === true &&
          problem === `extraneous: ${node.name}@${node.version} ${node.path}`)),
    "Installed dependency tree has unreconciled problems: " +
      context +
      " " +
      (typeof problem === "string"
        ? problem.slice(0, 256)
        : "invalid diagnostic"),
  );

const packages = [];
const gaps = [];
const usedSources = new Set();
const absentPackages = [];
const installedLocations = new Map();
let lockedPackageCount = 0;

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
            "Optional package absent without a demonstrated platform exclusion",
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
  assert.equal(
    manifest.name,
    entry.name ?? location.split("node_modules/").at(-1),
    "Installed dependency name differs from lock for " + location,
  );
  if (includeDev) {
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
          !usedSources.has(id) && absentPackages.some((p) => p.package === id),
      )
      .map((id) => ({
        package: id,
        state: absentPackages
          .filter((p) => p.package === id)
          .every((p) => p.state === "platform-inapplicable")
          ? "platform-inapplicable"
          : "not-installed-optional",
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
              libc: runtimeLibc,
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
