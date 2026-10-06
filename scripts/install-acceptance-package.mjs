import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export function acceptanceConsumerLock(manifest, lock, tarball, integrity) {
  assert.equal(lock.lockfileVersion, 3);
  assert.match(manifest.name, /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  assert.ok(path.isAbsolute(tarball));
  const spec = "file:" + tarball;
  const consumer = {
    name: "checktrail-acceptance-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: { [manifest.name]: spec },
  };
  const packages = {
    "": {
      name: consumer.name,
      version: consumer.version,
      dependencies: consumer.dependencies,
    },
    ["node_modules/" + manifest.name]: {
      version: manifest.version,
      resolved: spec,
      integrity,
      ...(manifest.license ? { license: manifest.license } : {}),
      dependencies: manifest.dependencies,
      ...(manifest.bin ? { bin: manifest.bin } : {}),
      ...(manifest.engines ? { engines: manifest.engines } : {}),
    },
  };
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name || entry.dev) continue;
    assert.ok(
      name.startsWith("node_modules/") &&
        !name.includes("\\") &&
        name.split("/").every((p) => p && p !== "." && p !== ".."),
    );
    assert.ok(!entry.link && !entry.inBundle);
    assert.equal(typeof entry.version, "string");
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    assert.ok(!Object.hasOwn(packages, name));
    packages[name] = globalThis.structuredClone(entry);
  }
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.equal(packages["node_modules/" + name]?.version, version);
  }
  return {
    manifest: consumer,
    lock: {
      name: consumer.name,
      version: consumer.version,
      lockfileVersion: 3,
      requires: true,
      packages,
    },
  };
}

export async function installAcceptancePackage(
  repository,
  tarball,
  consumer,
  { cache } = {},
) {
  const [manifest, lock, bytes] = await Promise.all([
    readFile(path.join(repository, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(repository, "package-lock.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(tarball),
  ]);
  const shipped = JSON.parse(
    execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  assert.deepEqual(
    shipped,
    manifest,
    "Packed manifest differs from locked source",
  );
  const integrity =
    "sha512-" + createHash("sha512").update(bytes).digest("base64");
  const prepared = acceptanceConsumerLock(shipped, lock, tarball, integrity);
  await assert.rejects(lstat(consumer), { code: "ENOENT" });
  const temporary = await mkdtemp(
    path.join(path.dirname(consumer), "locked-install-"),
  );
  let published = false;
  try {
    await writeFile(
      path.join(temporary, "package.json"),
      JSON.stringify(prepared.manifest),
      { flag: "wx" },
    );
    await writeFile(
      path.join(temporary, "package-lock.json"),
      JSON.stringify(prepared.lock),
      { flag: "wx" },
    );
    execFileSync(
      "npm",
      [
        "ci",
        "--offline",
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        ...(cache ? ["--cache", cache] : []),
      ],
      { cwd: temporary, stdio: "pipe" },
    );
    for (const [name, entry] of Object.entries(prepared.lock.packages)) {
      if (!name || entry.optional) continue;
      const installed = JSON.parse(
        await readFile(path.join(temporary, name, "package.json"), "utf8"),
      );
      assert.equal(
        installed.version,
        entry.version,
        "Installed version differs: " + name,
      );
    }
    await assert.rejects(lstat(consumer), { code: "ENOENT" });
    await rename(temporary, consumer);
    published = true;
    return {
      productionDependencyLockSha256: createHash("sha256")
        .update(JSON.stringify(prepared.lock))
        .digest("hex"),
      offlineProductionInstall: true,
      lifecycleScriptsExecuted: false,
    };
  } finally {
    if (!published) await rm(temporary, { recursive: true, force: true });
  }
}
