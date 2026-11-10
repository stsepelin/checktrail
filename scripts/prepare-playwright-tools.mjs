import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const inputs = [
  "scripts/playwright-tools/package.json",
  "scripts/playwright-tools/package-lock.json",
];
export async function readPlaywrightTools(
  repository = new URL("../", import.meta.url),
) {
  const [manifestBytes, lockBytes] = await Promise.all(
    inputs.map((file) => readFile(new URL(file, repository))),
  );
  const manifest = JSON.parse(manifestBytes),
    lock = JSON.parse(lockBytes);
  assert.equal(manifest.name, "checktrail-playwright-acceptance-tools");
  assert.equal(manifest.private, true);
  assert.deepEqual(Object.keys(manifest).sort(), [
    "dependencies",
    "name",
    "private",
    "version",
  ]);
  assert.deepEqual(Object.keys(manifest.dependencies), ["@playwright/test"]);
  const version = manifest.dependencies["@playwright/test"];
  assert.match(
    version,
    /^\d+\.\d+\.\d+$/,
    "Playwright fixture declaration must be exactly pinned",
  );
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].name, manifest.name);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.deepEqual(
    lock.packages[""].dependencies,
    manifest.dependencies,
    "Playwright fixture lock root must match its declaration",
  );
  const names = ["@playwright/test", "playwright", "playwright-core"];
  assert.deepEqual(
    Object.keys(lock.packages).sort(),
    ["", ...names.map((name) => "node_modules/" + name)].sort(),
    "Playwright fixture must contain its complete canonical package graph",
  );
  for (const name of names) {
    const entry = lock.packages["node_modules/" + name];
    assert.equal(
      entry.version,
      version,
      "Playwright fixture lock must match its declaration: " + name,
    );
    assert.ok(
      !entry.link && !entry.inBundle,
      "Playwright fixture packages must not be linked or bundled",
    );
    assert.match(
      entry.resolved,
      /^https:\/\/registry\.npmjs\.org\//,
      "Playwright fixture package must use the pinned registry",
    );
    assert.match(
      entry.integrity,
      /^sha512-[A-Za-z0-9+/]+={0,2}$/,
      "Playwright fixture integrity missing or malformed",
    );
    assert.equal(entry.name ?? name, name);
    assert.deepEqual(entry.optionalDependencies ?? {}, {});
    assert.deepEqual(entry.peerDependencies ?? {}, {});
  }
  assert.deepEqual(
    lock.packages["node_modules/@playwright/test"].dependencies,
    { playwright: version },
  );
  assert.deepEqual(lock.packages["node_modules/playwright"].dependencies, {
    "playwright-core": version,
  });
  assert.deepEqual(
    lock.packages["node_modules/playwright-core"].dependencies ?? {},
    {},
  );
  return { manifest, lock, manifestBytes, lockBytes };
}

export async function preparePlaywrightTools(
  destination = fileURLToPath(
    new URL("../.checktrail/playwright-tools", import.meta.url),
  ),
) {
  const { manifestBytes, lockBytes, manifest } = await readPlaywrightTools();
  // Validate both committed artifacts before publishing either one. Installation is separate.
  await mkdir(path.dirname(destination), { recursive: true });
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  const temporary = await mkdtemp(
    path.join(path.dirname(destination), "playwright-tools-"),
  );
  let committed = false;
  try {
    await writeFile(path.join(temporary, "package.json"), manifestBytes, {
      flag: "wx",
    });
    await writeFile(path.join(temporary, "package-lock.json"), lockBytes, {
      flag: "wx",
    });
    await rename(temporary, destination);
    committed = true;
  } finally {
    if (!committed) await rm(temporary, { recursive: true, force: true });
  }
  process.stdout.write(
    JSON.stringify({
      versions: manifest.dependencies,
      profileLockSha256: createHash("sha256").update(lockBytes).digest("hex"),
      rangeResolutionPerformed: false,
    }) + "\n",
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await preparePlaywrightTools();
