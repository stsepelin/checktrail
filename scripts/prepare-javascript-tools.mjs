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
  function declaredTool(name) {
    const version = rootManifest.devDependencies?.[name];
    assert.match(
      version ?? "",
      /^\d+\.\d+\.\d+$/,
      "Tool declaration must be exactly pinned: " + name,
    );
    const entry = source.packages["node_modules/" + name];
    assert.equal(
      entry?.version,
      version,
      "Tool lock must match its declaration: " + name,
    );
    return entry;
  }
  // The repository linter may advance independently of the frozen native API profile.
  declaredTool("eslint");
  const nativeAlias = "eslint-native-profile";
  const nativeKey = "node_modules/" + nativeAlias;
  const nativeDeclaration = rootManifest.devDependencies?.[nativeAlias];
  const nativeMatch = /^npm:eslint@(\d+\.\d+\.\d+)$/.exec(
    nativeDeclaration ?? "",
  );
  assert.ok(
    nativeMatch,
    "Native ESLint alias must exactly pin the eslint package",
  );
  const nativeVersion = nativeMatch[1];
  assert.equal(
    source.packages[""]?.devDependencies?.[nativeAlias],
    nativeDeclaration,
    "Native ESLint alias lock root differs from declaration",
  );
  assert.equal(
    source.packages[nativeKey]?.name,
    "eslint",
    "Native ESLint alias target differs",
  );
  assert.equal(
    source.packages[nativeKey]?.version,
    nativeVersion,
    "Native ESLint alias lock version differs from declaration",
  );
  const nativeConfigArray = declaredTool("@eslint/config-array").version;
  assert.equal(
    source.packages[""].devDependencies?.["@eslint/config-array"],
    nativeConfigArray,
    "Native config-array lock root differs from declaration",
  );
  const canonicalKey = (key) =>
    key === nativeKey || key.startsWith(nativeKey + "/node_modules/")
      ? "node_modules/eslint" + key.slice(nativeKey.length)
      : key;
  const owners = new Map();
  const linter = declaredTool("typescript-eslint");
  const parserVersion = linter.dependencies?.["@typescript-eslint/parser"];
  assert.match(
    parserVersion ?? "",
    /^\d+\.\d+\.\d+$/,
    "TypeScript ESLint parser dependency must be exactly pinned",
  );
  const dependencies = {
    ...rootManifest.dependencies,
    eslint: nativeVersion,
    "@eslint/config-array": nativeConfigArray,
    "@typescript-eslint/parser": parserVersion,
    "@types/node": declaredTool("@types/node").version,
    vite: "8.3.0",
    "@modelcontextprotocol/client": declaredTool("@modelcontextprotocol/client")
      .version,
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
    if (name === "eslint") return nativeKey;
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
    if (name === "@eslint/config-array")
      assert.equal(
        source.packages[key]?.version,
        nativeConfigArray,
        "Native config-array resolution differs from frozen role",
      );
    const destination = canonicalKey(key);
    if (Object.hasOwn(packages, destination)) {
      assert.equal(
        owners.get(destination),
        key,
        "Projected native tool lock collision",
      );
      return;
    }
    owners.set(destination, key);
    const original = source.packages[key];
    assert.ok(!original.link && !original.inBundle);
    assert.match(original.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(original.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    const entry = globalThis.structuredClone(original);
    delete entry.dev;
    delete entry.devOptional;
    packages[destination] = entry;
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
    sources: Object.fromEntries(owners),
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
