import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { copyInstalledPackages } from "../dist/test/tool-fixture.js";
import { readQualifiedJavaScriptTools } from "./prepare-javascript-tools.mjs";
import { readPlaywrightTools } from "./prepare-playwright-tools.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const qualifiedProjects = new Set([
  "node-test",
  "typescript",
  "typescript-build",
  "eslint",
  "vitest",
  "jest",
]);
const frameworkProjects = new Set(["vue-tsc"]);
export const qualifiedSmokePackages = [
  "typescript",
  "eslint",
  "vitest",
  "vite",
  "jest",
];
export const frameworkSmokePackages = ["typescript", "vue-tsc", "vue"];

export function smokeProjectPath(name) {
  assert.ok(
    qualifiedProjects.has(name) ||
      frameworkProjects.has(name) ||
      name === "playwright",
    "Unknown smoke project role",
  );
  return (
    (qualifiedProjects.has(name)
      ? "smoke-tools/qualified-js/"
      : name === "playwright"
        ? "smoke-tools/qualified-playwright/"
        : "smoke-tools/root-frameworks/") + name
  );
}

export async function captureSmokeProductionGraph(consumer) {
  const bytes = await readFile(path.join(consumer, "package-lock.json"));
  const lock = JSON.parse(bytes);
  const manifests = [];
  for (const [location, entry] of Object.entries(lock.packages).sort(
    ([a], [b]) => a.localeCompare(b, "en"),
  )) {
    try {
      const manifest = await readFile(
        path.join(consumer, location, "package.json"),
      );
      manifests.push({
        location,
        sha256: createHash("sha256").update(manifest).digest("hex"),
      });
    } catch (error) {
      if (error.code !== "ENOENT" || !entry.optional) throw error;
      manifests.push({ location, state: "absent-optional" });
    }
  }
  return {
    lockSha256: createHash("sha256").update(bytes).digest("hex"),
    manifests,
  };
}

function effectiveDeclarations(metadata) {
  const record = (field) => {
    const value = metadata[field] ?? {};
    assert.ok(
      value && typeof value === "object" && !Array.isArray(value),
      "Invalid smoke dependency declarations",
    );
    return value;
  };
  const required = record("dependencies"),
    optional = record("optionalDependencies"),
    peers = record("peerDependencies"),
    peerMeta = record("peerDependenciesMeta");
  const dependencyRanges = new Map([
    ...Object.entries(required),
    ...Object.entries(optional),
  ]);
  const dependencies = [...dependencyRanges]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([name, range]) => {
      assert.equal(typeof range, "string", "Invalid smoke dependency range");
      return { name, range, optional: Object.hasOwn(optional, name) };
    });
  const peerDependencies = Object.entries(peers)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([name, range]) => {
      assert.equal(typeof range, "string", "Invalid smoke peer range");
      const optional = peerMeta[name]?.optional;
      assert.ok(
        optional === undefined || typeof optional === "boolean",
        "Invalid smoke peer optional declaration",
      );
      return { name, range, optional: optional === true };
    });
  return { dependencies, peerDependencies };
}

// Reuse the existing resolver, including its optional-dependency handling. Every
// planned identity is checked before the copier writes into a private namespace.
export async function copySmokeToolGraph(
  destination,
  { modules, packages, lock },
) {
  assert.ok(path.isAbsolute(modules));
  assert.equal(
    await realpath(modules),
    modules,
    "Smoke tool source must be canonical",
  );
  assert.equal(lock.lockfileVersion, 3);
  assert.ok(
    Array.isArray(packages) &&
      packages.length > 0 &&
      new Set(packages).size === packages.length,
  );
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = await mkdtemp(
    path.join(path.dirname(destination), "smoke-tools-"),
  );
  let published = false;
  const copied = [];
  try {
    await copyInstalledPackages(
      temporary,
      packages,
      modules,
      async (item) => {
        const location =
          "node_modules/" + item.relative.split(path.sep).join("/");
        const entry = lock.packages[location];
        assert.ok(
          entry && typeof entry.version === "string",
          "Smoke dependency is outside the selected lock: " + location,
        );
        assert.equal(
          item.version,
          entry.version,
          "Smoke dependency version differs from lock: " + location,
        );
        assert.equal(
          await realpath(item.source),
          item.source,
          "Smoke package source must be canonical",
        );
        const manifest = JSON.parse(
          await readFile(path.join(item.source, "package.json"), "utf8"),
        );
        assert.equal(
          manifest.name,
          entry.name ?? location.split("node_modules/").at(-1),
          "Smoke dependency name differs from lock: " + location,
        );
        assert.deepEqual(
          effectiveDeclarations(manifest),
          effectiveDeclarations(entry),
          "Smoke dependency declarations differ from lock: " + location,
        );
        copied.push({ location, name: manifest.name, version: item.version });
      },
      { includePeers: true, lockedPackages: lock.packages },
    );
    await rename(temporary, destination);
    published = true;
    return { packages: copied };
  } finally {
    if (!published) await rm(temporary, { recursive: true, force: true });
  }
}

export async function preparePackageSmokeTools(consumer, source = repository) {
  const before = await captureSmokeProductionGraph(consumer);
  const qualified = await readQualifiedJavaScriptTools(
    pathToFileURL(source + path.sep),
  );
  const playwright = await readPlaywrightTools(
    pathToFileURL(source + path.sep),
  );
  const rootLock = JSON.parse(
    await readFile(path.join(source, "package-lock.json"), "utf8"),
  );
  const destination = path.join(consumer, "smoke-tools");
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  const staging = await mkdtemp(path.join(consumer, "smoke-tools-staging-"));
  let published = false;
  try {
    const result = {
      qualified: await copySmokeToolGraph(path.join(staging, "qualified-js"), {
        modules: await realpath(
          path.join(source, ".checktrail/javascript-tools/node_modules"),
        ),
        packages: qualifiedSmokePackages,
        lock: qualified.lock,
      }),
      frameworks: await copySmokeToolGraph(
        path.join(staging, "root-frameworks"),
        {
          modules: await realpath(path.join(source, "node_modules")),
          packages: frameworkSmokePackages,
          lock: rootLock,
        },
      ),
      playwright: await copySmokeToolGraph(
        path.join(staging, "qualified-playwright"),
        {
          modules: await realpath(
            path.join(source, ".checktrail/playwright-tools/node_modules"),
          ),
          packages: ["@playwright/test"],
          lock: playwright.lock,
        },
      ),
      qualifiedProfileLockSha256: qualified.profileLockSha256,
      playwrightProfileLockSha256: createHash("sha256")
        .update(playwright.lockBytes)
        .digest("hex"),
    };
    assert.deepEqual(
      await captureSmokeProductionGraph(consumer),
      before,
      "Smoke preparation changed the installed production graph",
    );
    await assert.rejects(lstat(destination), { code: "ENOENT" });
    await rename(staging, destination);
    published = true;
    return result;
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}
