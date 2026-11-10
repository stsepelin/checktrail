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
export function selectMutationToolsLock(rootManifest, source) {
  assert.equal(source.lockfileVersion, 3);
  const developmentVersion = rootManifest.devDependencies?.vitest;
  assert.match(
    developmentVersion ?? "",
    /^\d+\.\d+\.\d+$/,
    "Development Vitest declaration must be exactly pinned",
  );
  assert.equal(
    source.packages[""]?.devDependencies?.vitest,
    developmentVersion,
    "Development Vitest lock root differs",
  );
  assert.equal(
    source.packages["node_modules/vitest"]?.version,
    developmentVersion,
    "Development Vitest lock version differs",
  );
  const alias = "vitest-native-mutation";
  const nativeKey = "node_modules/" + alias;
  const declaration = rootManifest.devDependencies?.[alias];
  assert.equal(
    declaration,
    "npm:vitest@5.0.5",
    "Native mutation Vitest role must retain its qualified exact pin",
  );
  assert.equal(
    source.packages[""]?.devDependencies?.[alias],
    declaration,
    "Native mutation Vitest lock root differs",
  );
  assert.equal(
    source.packages[nativeKey]?.name,
    "vitest",
    "Native mutation Vitest alias target differs",
  );
  assert.equal(
    source.packages[nativeKey]?.version,
    "5.0.5",
    "Native mutation Vitest alias version differs",
  );
  const canonical = "node_modules/vitest";
  const packages = {};
  for (const [key, entry] of Object.entries(source.packages)) {
    if (key === canonical || key.startsWith(canonical + "/node_modules/"))
      continue;
    const selectedKey =
      key === nativeKey || key.startsWith(nativeKey + "/node_modules/")
        ? canonical + key.slice(nativeKey.length)
        : key;
    assert.ok(
      !Object.hasOwn(packages, selectedKey),
      "Native mutation Vitest namespace collision",
    );
    packages[selectedKey] = entry;
  }
  return selectJavaScriptToolsLock(
    {
      ...rootManifest,
      dependencies: {
        vitest: "5.0.5",
        jest: rootManifest.devDependencies.jest,
      },
    },
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
