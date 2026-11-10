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
const {
  installAcceptancePackage,
  acceptanceConsumerLock,
  assertLockedAcceptanceClient,
} = (await import(helperUrl.href)) as {
  installAcceptancePackage: (
    repository: string,
    tarball: string,
    consumer: string,
    options?: { cache: string },
  ) => Promise<{
    offlineProductionInstall: boolean;
    lifecycleScriptsExecuted: boolean;
  }>;
  assertLockedAcceptanceClient: (
    repository: string,
    observedVersion: string,
  ) => Promise<void>;
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

  // Internally consistent lock metadata must still be checked against the
  // installed tarball manifest before publication. The cached leaf remains
  // 1.2.3 while this synthetic registry record claims 1.2.4.
  const mismatchManifest = {
    ...manifest,
    dependencies: { "original-offline-leaf": "1.2.4" },
  };
  const mismatchLock = {
    ...lock,
    packages: {
      ...lock.packages,
      "": { ...lock.packages[""], dependencies: mismatchManifest.dependencies },
      "node_modules/original-offline-leaf": {
        ...lock.packages["node_modules/original-offline-leaf"],
        version: "1.2.4",
        resolved:
          "https://registry.npmjs.org/original-offline-leaf/-/original-offline-leaf-1.2.4.tgz",
      },
    },
  };
  await writeFile(
    path.join(repository, "package.json"),
    JSON.stringify(mismatchManifest),
  );
  await writeFile(
    path.join(repository, "package-lock.json"),
    JSON.stringify(mismatchLock),
  );
  const mismatchTarball = pack(repository),
    mismatchConsumer = path.join(root, "version-mismatch");
  const beforeMismatch = await readdir(root);
  await assert.rejects(
    installAcceptancePackage(repository, mismatchTarball, mismatchConsumer, {
      cache,
    }),
    /Installed version differs: node_modules\/original-offline-leaf/,
  );
  await assert.rejects(readFile(path.join(mismatchConsumer, "package.json")), {
    code: "ENOENT",
  });
  assert.deepEqual(await readdir(root), beforeMismatch);
});

test("acceptance client selection binds exact declared locked installed and observed versions without a historical literal", async (t) => {
  const name = "@modelcontextprotocol/client";
  const root = await fixture(t, {});
  await mkdir(path.join(root, "node_modules", name), { recursive: true });
  const candidate = (version: string) => ({
    manifest: {
      devDependencies: { [name]: version } as Record<string, string>,
    },
    lock: {
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { [name]: version } as Record<string, string> },
        "node_modules/@modelcontextprotocol/client": { version },
      },
    },
    installed: { name: name as string, version },
  });
  const write = async (state: ReturnType<typeof candidate>) => {
    await Promise.all([
      writeFile(
        path.join(root, "package.json"),
        JSON.stringify(state.manifest),
      ),
      writeFile(
        path.join(root, "package-lock.json"),
        JSON.stringify(state.lock),
      ),
      writeFile(
        path.join(root, "node_modules", name, "package.json"),
        JSON.stringify(state.installed),
      ),
    ]);
  };
  for (const version of ["2.3.1", "2.4.0"]) {
    await write(candidate(version));
    await assertLockedAcceptanceClient(root, version);
  }
  const cases: {
    label: string;
    mutate: (state: ReturnType<typeof candidate>) => void;
    observed?: string;
    message: RegExp;
  }[] = [
    {
      label: "coherent range metadata",
      mutate: (state) => {
        state.manifest.devDependencies[name] = "^2.4.0";
        state.lock.packages[""].devDependencies[name] = "^2.4.0";
        state.lock.packages[
          "node_modules/@modelcontextprotocol/client"
        ].version = "^2.4.0";
        state.installed.version = "^2.4.0";
      },
      observed: "^2.4.0",
      message: /exactly pinned/,
    },
    {
      label: "missing declaration",
      mutate: (state) => {
        delete state.manifest.devDependencies[name];
      },
      message: /exactly pinned/,
    },
    {
      label: "old lock format",
      mutate: (state) => {
        state.lock.lockfileVersion = 2;
      },
      message: /lockfile v3/,
    },
    {
      label: "stale lock root",
      mutate: (state) => {
        state.lock.packages[""].devDependencies[name] = "2.3.1";
      },
      message: /lock root/,
    },
    {
      label: "missing lock declaration",
      mutate: (state) => {
        delete state.lock.packages[""].devDependencies[name];
      },
      message: /lock root/,
    },
    {
      label: "stale lock package",
      mutate: (state) => {
        state.lock.packages[
          "node_modules/@modelcontextprotocol/client"
        ].version = "2.3.1";
      },
      message: /lock entry/,
    },
    {
      label: "missing lock package",
      mutate: (state) => {
        Reflect.deleteProperty(
          state.lock.packages,
          "node_modules/@modelcontextprotocol/client",
        );
      },
      message: /lock entry/,
    },
    {
      label: "foreign installed package",
      mutate: (state) => {
        state.installed.name = "other-client";
      },
      message: /package name/,
    },
    {
      label: "stale installed version",
      mutate: (state) => {
        state.installed.version = "2.3.1";
      },
      message: /installed version/,
    },
    {
      label: "stale observed version",
      mutate: () => {},
      observed: "2.3.1",
      message: /observed version/,
    },
    {
      label: "unselected newer version",
      mutate: () => {},
      observed: "2.5.0",
      message: /observed version/,
    },
  ];
  for (const item of cases) {
    const state = candidate("2.4.0");
    item.mutate(state);
    await write(state);
    await assert.rejects(
      assertLockedAcceptanceClient(root, item.observed ?? "2.4.0"),
      item.message,
      item.label,
    );
  }
  await write(candidate("2.4.0"));
  await assertLockedAcceptanceClient(root, "2.4.0");
});
