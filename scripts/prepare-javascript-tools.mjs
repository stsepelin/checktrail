import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  mkdtemp,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { createHash } from "node:crypto";
export function selectJavaScriptToolsLock(rootManifest, source) {
  assert.equal(source.lockfileVersion, 3);
  const dependencies = {
    ...rootManifest.dependencies,
    eslint: "10.11.0",
    "@typescript-eslint/parser": "8.71.0",
    vite: "8.3.0",
    "@modelcontextprotocol/client": "2.3.0",
  };
  const manifest = {
    name: "checktrail-javascript-acceptance-tools",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies,
  };
  const packages = {
    "": { name: manifest.name, version: manifest.version, dependencies },
  };
  function resolve(name, from = "") {
    const segments = from.split("/");
    const candidates = [];
    while (segments.length) {
      candidates.push(segments.join("/") + "/node_modules/" + name);
      segments.pop();
      if (segments.at(-1) === "node_modules") segments.pop();
    }
    candidates.push("node_modules/" + name);
    return candidates.find((key) => Object.hasOwn(source.packages, key));
  }
  function visit(name, from = "", optional = false) {
    const key = resolve(name, from);
    if (!key) {
      assert.ok(optional, "Missing locked required tool dependency " + name);
      return;
    }
    if (Object.hasOwn(packages, key)) return;
    const original = source.packages[key];
    assert.ok(!original.link && !original.inBundle);
    assert.match(original.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(original.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    const entry = globalThis.structuredClone(original);
    delete entry.dev;
    delete entry.devOptional;
    packages[key] = entry;
    for (const dependency of Object.keys(entry.dependencies ?? {}))
      visit(
        dependency,
        key,
        Object.hasOwn(entry.optionalDependencies ?? {}, dependency),
      );
    for (const dependency of Object.keys(entry.optionalDependencies ?? {}))
      visit(dependency, key, true);
    for (const dependency of Object.keys(entry.peerDependencies ?? {}))
      visit(
        dependency,
        key,
        entry.peerDependenciesMeta?.[dependency]?.optional === true,
      );
  }
  for (const [name, version] of Object.entries(dependencies)) {
    visit(name);
    assert.equal(packages["node_modules/" + name].version, version);
  }
  return {
    manifest,
    lock: {
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages,
    },
  };
}
async function main() {
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const destination = path.join(repository, ".checktrail/javascript-tools");
  const source = JSON.parse(
    await readFile(path.join(repository, "package-lock.json"), "utf8"),
  );
  const rootManifest = JSON.parse(
    await readFile(path.join(repository, "package.json"), "utf8"),
  );
  const { manifest, lock } = selectJavaScriptToolsLock(rootManifest, source);
  // Resolve all artifacts before writing either one; npm ci installs these exact locked versions separately.
  await mkdir(path.dirname(destination), { recursive: true });
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  const temporary = await mkdtemp(
    path.join(path.dirname(destination), "javascript-tools-"),
  );
  let committed = false;
  try {
    await writeFile(
      path.join(temporary, "package.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx" },
    );
    await writeFile(
      path.join(temporary, "package-lock.json"),
      JSON.stringify(lock, null, 2) + "\n",
      { flag: "wx" },
    );
    await rename(temporary, destination);
    committed = true;
  } finally {
    if (!committed) await rm(temporary, { recursive: true, force: true });
  }
  process.stdout.write(
    JSON.stringify({
      packages: Object.keys(lock.packages).length - 1,
      rootLockSha256: createHash("sha256")
        .update(JSON.stringify(source))
        .digest("hex"),
      selectedLockSha256: createHash("sha256")
        .update(JSON.stringify(lock))
        .digest("hex"),
      versions: manifest.dependencies,
      rangeResolutionPerformed: false,
    }) + "\n",
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
