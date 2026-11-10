import assert from "node:assert/strict";
import {
  readFile,
  lstat,
  mkdir,
  mkdtemp,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { createHash } from "node:crypto";
import { selectJavaScriptToolsLock } from "./prepare-javascript-tools.mjs";
const nativeRoles = [
  {
    name: "vitest",
    label: "Vitest",
    alias: "vitest-native-mutation",
    version: "5.0.5",
  },
  {
    name: "jest",
    label: "Jest",
    alias: "jest-native-mutation",
    version: "30.5.2",
  },
];
export function selectMutationToolsLock(rootManifest, source) {
  assert.equal(source.lockfileVersion, 3);
  let packages = source.packages;
  const versions = {};
  for (const { name, label, alias, version } of nativeRoles) {
    const development = rootManifest.devDependencies?.[name];
    assert.match(
      development ?? "",
      /^\d+\.\d+\.\d+$/,
      `Development ${label} declaration must be exactly pinned`,
    );
    assert.equal(
      source.packages[""]?.devDependencies?.[name],
      development,
      `Development ${label} lock root differs`,
    );
    assert.equal(
      source.packages["node_modules/" + name]?.version,
      development,
      `Development ${label} lock version differs`,
    );
    const declaration = rootManifest.devDependencies?.[alias];
    assert.equal(
      declaration,
      `npm:${name}@${version}`,
      `Native mutation ${label} role must retain its qualified exact pin`,
    );
    assert.equal(
      source.packages[""]?.devDependencies?.[alias],
      declaration,
      `Native mutation ${label} lock root differs`,
    );
    const nativeKey = "node_modules/" + alias,
      canonical = "node_modules/" + name;
    assert.equal(
      source.packages[nativeKey]?.name,
      name,
      `Native mutation ${label} alias target differs`,
    );
    assert.equal(
      source.packages[nativeKey]?.version,
      version,
      `Native mutation ${label} alias version differs`,
    );
    const projected = {};
    for (const [key, entry] of Object.entries(packages)) {
      if (key === canonical || key.startsWith(canonical + "/node_modules/"))
        continue;
      const target =
        key === nativeKey || key.startsWith(nativeKey + "/node_modules/")
          ? canonical + key.slice(nativeKey.length)
          : key;
      assert.ok(
        !Object.hasOwn(projected, target),
        `Native mutation ${label} namespace collision`,
      );
      projected[target] = entry;
    }
    packages = projected;
    versions[name] = version;
  }
  return selectJavaScriptToolsLock(
    { ...rootManifest, dependencies: versions },
    { ...source, packages },
  );
}
async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url)),
    destination = path.join(root, ".checktrail/mutation-javascript-tools");
  const rootLock = await readFile(path.join(root, "package-lock.json"), "utf8"),
    rootManifest = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    ),
    { manifest, lock } = selectMutationToolsLock(
      rootManifest,
      JSON.parse(rootLock),
    );
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = await mkdtemp(
    path.join(path.dirname(destination), "mutation-tools-"),
  );
  let published = false;
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
    published = true;
  } finally {
    if (!published) await rm(temporary, { recursive: true, force: true });
  }
  process.stdout.write(
    JSON.stringify({
      rootLockSha256: createHash("sha256").update(rootLock).digest("hex"),
      selectedLockSha256: createHash("sha256")
        .update(JSON.stringify(lock))
        .digest("hex"),
      packages: Object.keys(lock.packages).length - 1,
      rangeResolutionPerformed: false,
    }) + "\n",
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
