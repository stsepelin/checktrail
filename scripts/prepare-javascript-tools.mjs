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
function selectLockedTools(manifest, source) {
  const { dependencies } = manifest;
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
export function selectQualifiedJavaScriptToolsLock(manifest, source) {
  assert.equal(manifest.name, "checktrail-javascript-acceptance-tools");
  assert.equal(manifest.private, true);
  assert.equal(source.lockfileVersion, 3);
  assert.equal(source.name, manifest.name);
  assert.equal(source.version, manifest.version);
  assert.deepEqual(
    source.packages[""]?.dependencies,
    manifest.dependencies,
    "Qualified tool lock root must match its declarations",
  );
  assert.ok(
    Object.keys(manifest.dependencies ?? {}).length > 0,
    "Qualified tool profile must not be empty",
  );
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.match(
      version,
      /^\d+\.\d+\.\d+$/,
      "Qualified tool declaration must be exactly pinned: " + name,
    );
    assert.equal(
      source.packages["node_modules/" + name]?.version,
      version,
      "Qualified tool lock must match its declaration: " + name,
    );
  }
  return selectLockedTools(manifest, source);
}

export const qualifiedJavaScriptToolInputs = [
  "scripts/javascript-tools/package.json",
  "scripts/javascript-tools/package-lock.json",
];

export async function readQualifiedJavaScriptTools(
  repository = new URL("../", import.meta.url),
) {
  const [manifestBytes, lockBytes] = await Promise.all(
    qualifiedJavaScriptToolInputs.map((file) =>
      readFile(new URL(file, repository)),
    ),
  );
  return {
    ...selectQualifiedJavaScriptToolsLock(
      JSON.parse(manifestBytes),
      JSON.parse(lockBytes),
    ),
    profileLockSha256: createHash("sha256").update(lockBytes).digest("hex"),
  };
}

export async function prepareJavaScriptTools(destination) {
  const { manifest, lock, profileLockSha256 } =
    await readQualifiedJavaScriptTools();
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
      profileLockSha256,
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
  await prepareJavaScriptTools(
    fileURLToPath(new URL("../.checktrail/javascript-tools", import.meta.url)),
  );
