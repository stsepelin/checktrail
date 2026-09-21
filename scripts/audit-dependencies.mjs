import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const lockBytes = await readFile(path.join(root, "package-lock.json"));
const lock = JSON.parse(lockBytes);
const sources = JSON.parse(
  await readFile(new URL("./license-sources.json", import.meta.url), "utf8"),
);
const tree = JSON.parse(
  execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  }),
);
const treeIdentities = new Set();
function inspectTree(node) {
  assert.ok(
    !node.problems?.length,
    "Installed production dependency tree has problems",
  );
  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    treeIdentities.add(`${name}@${child.version}`);
    inspectTree(child);
  }
}
inspectTree(tree);
const packages = [];
const gaps = [];
const usedSources = new Set();
for (const [location, entry] of Object.entries(lock.packages).sort(([a], [b]) =>
  a.localeCompare(b, "en"),
)) {
  if (!location || entry.dev) continue;
  assert.match(location, /^node_modules\//);
  assert.ok(!path.isAbsolute(location) && !location.split("/").includes(".."));
  const directory = path.join(root, location);
  assert.equal(
    await realpath(directory),
    directory,
    "Production package must not resolve through an external symlink",
  );
  const manifest = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
  const id = `${manifest.name}@${manifest.version}`;
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
    if (!/^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(name)) continue;
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
    assert.match(source.notice, /^docs\/licenses\/[^/]+\.txt$/);
    const bytes = await readFile(path.join(root, source.notice));
    assert.equal(
      hash(bytes),
      source.sha256,
      `Pinned upstream notice changed for ${id}`,
    );
    notices.push({
      file: source.notice,
      provenance: "pinned-upstream-notice",
      source: source.source,
      upstreamManifestVersion: source.upstreamManifestVersion,
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
  packages.push({
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    location,
    resolved: entry.resolved,
    declaredIntegrity: entry.integrity,
    notices,
  });
}
assert.deepEqual(
  new Set(packages.map((item) => `${item.name}@${item.version}`)),
  treeIdentities,
  "Production lock and installed tree identities differ",
);
assert.deepEqual(
  usedSources,
  new Set(Object.keys(sources)),
  "An upstream notice fallback no longer describes an installed production package",
);
process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      provenance: "installed-metadata-and-lockfile-audit",
      scope: "production-npm-dependencies",
      complete: gaps.length === 0,
      lockfileSHA256: hash(lockBytes),
      packageCount: packages.length,
      gaps,
      packages,
      limitations: [
        "Declared integrity is recorded, not recomputed over installed package contents",
        "License declarations and notice presence do not establish legal compliance",
        "Development dependencies, native toolchains and container images are outside this audit",
      ],
    },
    null,
    2,
  )}\n`,
);
process.exitCode = gaps.length ? 2 : 0;
