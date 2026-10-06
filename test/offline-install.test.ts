import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers.js";
const helperUrl = new URL(
  "../../scripts/install-acceptance-package.mjs",
  import.meta.url,
);
const { installAcceptancePackage, acceptanceConsumerLock } = (await import(
  helperUrl.href
)) as {
  installAcceptancePackage: (
    repository: string,
    tarball: string,
    consumer: string,
    options?: { cache: string },
  ) => Promise<{
    offlineProductionInstall: boolean;
    lifecycleScriptsExecuted: boolean;
  }>;
  acceptanceConsumerLock: (
    manifest: unknown,
    lock: unknown,
    tarball: string,
    integrity: string,
  ) => { manifest: unknown; lock: { packages: Record<string, unknown> } };
};
test("offline package acceptance uses tarball integrity without registry metadata and publishes only a complete locked install", async (t) => {
  const root = await fixture(t, {}),
    cache = path.join(root, "cache"),
    repository = path.join(root, "repository"),
    leaf = path.join(root, "leaf");
  await mkdir(repository);
  await mkdir(leaf);
  const marker = path.join(root, "lifecycle-marker");
  const leafManifest = {
    name: "original-offline-leaf",
    version: "1.2.3",
    scripts: {
      postinstall: `node -e 'require("fs").writeFileSync(${JSON.stringify(marker)},"ran")'`,
    },
  };
  await writeFile(
    path.join(leaf, "package.json"),
    JSON.stringify(leafManifest),
  );
  const pack = (cwd: string) => {
    const [artifact] = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", root],
        { cwd, encoding: "utf8" },
      ),
    ) as { filename: string }[];
    return path.join(root, artifact!.filename);
  };
  const leafTarball = pack(leaf);
  execFileSync(
    "npm",
    [
      "cache",
      "add",
      leafTarball,
      "--offline",
      "--ignore-scripts",
      "--cache",
      cache,
    ],
    { stdio: "pipe" },
  );
  const manifest = {
    name: "original-offline-reviewer",
    version: "0.1.0",
    dependencies: { "original-offline-leaf": "1.2.3" },
    devDependencies: { "original-dev-only": "9.0.0" },
  };
  const integrity =
    "sha512-" +
    createHash("sha512")
      .update(await readFile(leafTarball))
      .digest("base64");
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": {
        name: manifest.name,
        version: manifest.version,
        dependencies: manifest.dependencies,
        devDependencies: manifest.devDependencies,
      },
      "node_modules/original-offline-leaf": {
        version: "1.2.3",
        resolved:
          "https://registry.npmjs.org/original-offline-leaf/-/original-offline-leaf-1.2.3.tgz",
        integrity,
        hasInstallScript: true,
      },
      "node_modules/original-dev-only": {
        version: "9.0.0",
        dev: true,
        resolved:
          "https://registry.npmjs.org/original-dev-only/-/original-dev-only-9.0.0.tgz",
        integrity,
      },
    },
  };
  await writeFile(
    path.join(repository, "package.json"),
    JSON.stringify(manifest),
  );
  await writeFile(
    path.join(repository, "package-lock.json"),
    JSON.stringify(lock),
  );
  const tarball = pack(repository),
    previous = path.join(root, "previous");
  await mkdir(previous);
  await writeFile(
    path.join(previous, "package.json"),
    JSON.stringify({ private: true }),
  );
  const old = spawnSync(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--cache",
      cache,
      tarball,
    ],
    { cwd: previous, encoding: "utf8" },
  );
  assert.notEqual(old.status, 0);
  assert.match(old.stderr, /ENOTCACHED/);
  assert.match(old.stderr, /original-offline-leaf/);
  const consumer = path.join(root, "consumer"),
    result = await installAcceptancePackage(repository, tarball, consumer, {
      cache,
    });
  assert.equal(result.offlineProductionInstall, true);
  assert.equal(result.lifecycleScriptsExecuted, false);
  const installed = JSON.parse(
    await readFile(
      path.join(consumer, "node_modules/original-offline-leaf/package.json"),
      "utf8",
    ),
  ) as typeof leafManifest;
  assert.deepEqual(installed, leafManifest);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  await assert.rejects(
    readFile(
      path.join(consumer, "node_modules/original-dev-only/package.json"),
    ),
    { code: "ENOENT" },
  );
  await assert.rejects(
    installAcceptancePackage(repository, tarball, consumer, { cache }),
  );
  const before = await readdir(root),
    failed = path.join(root, "failed");
  const empty = path.join(root, "empty-cache");
  await mkdir(empty);
  await assert.rejects(
    installAcceptancePackage(repository, tarball, failed, { cache: empty }),
  );
  await assert.rejects(readFile(path.join(failed, "package.json")), {
    code: "ENOENT",
  });
  assert.deepEqual(
    (await readdir(root)).filter((x) => x !== "empty-cache"),
    before,
  );
  await writeFile(
    path.join(repository, "package.json"),
    JSON.stringify({ ...manifest, version: "0.2.0" }),
  );
  await assert.rejects(
    installAcceptancePackage(repository, tarball, failed, { cache }),
    /Packed manifest differs/,
  );
  assert.throws(() =>
    acceptanceConsumerLock(
      manifest,
      { ...lock, lockfileVersion: 2 },
      tarball,
      integrity,
    ),
  );
  assert.throws(() =>
    acceptanceConsumerLock(
      manifest,
      {
        ...lock,
        packages: {
          ...lock.packages,
          "node_modules/original-offline-leaf": {
            ...lock.packages["node_modules/original-offline-leaf"],
            version: "1.2.4",
          },
        },
      },
      tarball,
      integrity,
    ),
  );
  assert.throws(() =>
    acceptanceConsumerLock(
      manifest,
      {
        ...lock,
        packages: {
          ...lock.packages,
          "node_modules/original-offline-leaf": {
            ...lock.packages["node_modules/original-offline-leaf"],
            resolved: "https://untrusted.example/leaf.tgz",
          },
        },
      },
      tarball,
      integrity,
    ),
  );
});
