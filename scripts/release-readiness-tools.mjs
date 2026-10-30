// Operator-only preparation for synthetic upgrade tests. Importing this module
// does not install tools or execute the older package.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runAcceptanceNpm } from "./install-acceptance-package.mjs";
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  mutationBoundedBytes,
  mutationDependencies,
} from "../dist/src/mutation-native-copy.js";
import { requestPinnedArtifactBytes } from "./request-pinned-artifact.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const inputs = new URL("./release-readiness-tools/", import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const releaseToolsDirectory = path.join(
  repository,
  ".checktrail/release-readiness-tools",
);
async function protect(directory, created) {
  if (process.platform === "win32") {
    const { ensureWindowsTaskAccess } =
      await import("../dist/src/windows-task-access.js");
    ensureWindowsTaskAccess(directory, "directory", created);
  }
}
export async function releaseToolsInputs() {
  const [pinBytes, manifest, lock] = await Promise.all(
    ["baseline.json", "package.json", "package-lock.json"].map((name) =>
      readFile(new URL(name, inputs)),
    ),
  );
  const pin = JSON.parse(pinBytes.toString("utf8"));
  assert.equal(pin.schemaVersion, 1);
  assert.equal(
    hash(manifest),
    pin.toolsManifestSha256,
    "Legacy tool manifest pin differs",
  );
  assert.equal(
    hash(lock),
    pin.toolsLockfileSha256,
    "Legacy tool dependency lock pin differs",
  );
  const graph = JSON.parse(lock.toString("utf8"));
  assert.equal(
    graph.packages["node_modules/@stsepelin/checktrail"].version,
    pin.version,
  );
  assert.equal(
    graph.packages["node_modules/@stsepelin/checktrail"].integrity,
    pin.integrity,
  );
  return { pin, manifest, lock, pinSha256: hash(pinBytes) };
}
function verifyArchive(bytes, pin) {
  assert.equal(bytes.length, pin.bytes, "Older package byte count differs");
  assert.equal(hash(bytes), pin.sha256, "Older package archive bytes differ");
  assert.equal(createHash("sha1").update(bytes).digest("hex"), pin.sha1);
  assert.equal(
    "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    pin.integrity,
  );
}
/** Captures the selected actual dependency bytes. This is not an independent
 * archive-to-installation attestation. Retain the returned snapshot before any
 * fixture execution and supply it when checking that those inputs stayed fresh. */
async function captureReleaseTools(directory) {
  const { pin, manifest, lock, pinSha256 } = await releaseToolsInputs();
  const root = await realpath(directory);
  assert.equal(
    root,
    directory,
    "Legacy tools must use their canonical owned directory",
  );
  assert.equal((await lstat(root)).isDirectory(), true);
  await protect(root, false);
  const [actualManifest, actualLock, archive, packageManifest, license] =
    await Promise.all([
      readRegular(root, "package.json", 65536),
      readRegular(root, "package-lock.json", 2 * 1048576),
      readRegular(root, "baseline.tgz", 8 * 1048576),
      readRegular(
        root,
        "node_modules/@stsepelin/checktrail/package.json",
        65536,
      ),
      readRegular(root, "node_modules/@stsepelin/checktrail/LICENSE", 65536),
    ]);
  assert.deepEqual(
    actualManifest,
    manifest,
    "Prepared legacy tool manifest changed",
  );
  assert.deepEqual(actualLock, lock, "Prepared legacy dependency lock changed");
  verifyArchive(archive, pin);
  assert.equal(
    hash(packageManifest),
    pin.manifestSha256,
    "Installed older package manifest differs",
  );
  assert.equal(
    hash(license),
    pin.licenseSha256,
    "Installed older package license differs",
  );
  const selected = await mutationDependencies(root, "node_modules", () => true);
  const observation = {
    schemaVersion: 1,
    profile: "synthetic-release-readiness-tools-v1",
    baselineVersion: pin.version,
    baselineArchiveSha256: hash(archive),
    pinSha256,
    lockfileSha256: hash(lock),
    dependencyFingerprint: selected.fingerprint,
    dependencyEntries: selected.entries.length,
    dependencyBytesMatchRegistryArchivesIndependentlyVerified: false,
    producerSourceBuildVerified: false,
  };
  return observation;
}
async function readRegular(root, relative, maximum) {
  const entry = await lstat(path.join(root, relative));
  assert.ok(
    entry.isFile() && !entry.isSymbolicLink(),
    "Legacy tool input must be a regular non-link file",
  );
  return mutationBoundedBytes(root, relative, maximum);
}
export async function observeReleaseTools(
  directory = releaseToolsDirectory,
  expected,
) {
  const observation = await captureReleaseTools(directory);
  const receipt = JSON.parse(
    (await readRegular(directory, "receipt.json", 8192)).toString("utf8"),
  );
  assert.deepEqual(
    observation,
    receipt,
    "Legacy preparation receipt or selected bytes changed",
  );
  if (expected !== undefined)
    assert.deepEqual(
      observation,
      expected,
      "Selected legacy dependency bytes changed",
    );
  return observation;
}
export async function prepareReleaseTools({
  directory = releaseToolsDirectory,
  offlineDependencies = false,
  fetchImpl = globalThis.fetch,
  invokeNpm = (args, options) => runAcceptanceNpm(args, options),
} = {}) {
  assert.equal(typeof offlineDependencies, "boolean");
  const { pin, manifest, lock } = await releaseToolsInputs();
  assert.ok(
    path.isAbsolute(directory),
    "Legacy preparation directory must be absolute",
  );
  const parent = path.dirname(directory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  assert.equal(
    await realpath(parent),
    parent,
    "Release tool parent must be canonical",
  );
  await assert.rejects(lstat(directory), { code: "ENOENT" });
  const temporary = await mkdtemp(
    path.join(parent, ".prepare-release-readiness-"),
  );
  try {
    await protect(temporary, true);
    const archive = await requestPinnedArtifactBytes(
      { asset: pin.tarball, bytes: pin.bytes },
      {
        fetchImpl: (asset, request) =>
          fetchImpl(asset, { ...request, redirect: "error" }),
      },
    );
    verifyArchive(archive, pin);
    await Promise.all([
      writeFile(path.join(temporary, "package.json"), manifest, {
        flag: "wx",
        mode: 0o600,
      }),
      writeFile(path.join(temporary, "package-lock.json"), lock, {
        flag: "wx",
        mode: 0o600,
      }),
      writeFile(path.join(temporary, "baseline.tgz"), archive, {
        flag: "wx",
        mode: 0o600,
      }),
    ]);
    await invokeNpm(
      [
        "ci",
        ...(offlineDependencies ? ["--offline"] : []),
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      {
        cwd: temporary,
        encoding: "utf8",
        timeout: 180000,
        maxBuffer: 4 * 1048576,
      },
    );
    const observed = await captureReleaseTools(await realpath(temporary));
    await writeFile(
      path.join(temporary, "receipt.json"),
      JSON.stringify(observed) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await observeReleaseTools(await realpath(temporary), observed);
    await rename(temporary, directory);
    return {
      directory,
      observation: observed,
      baselineExecuted: false,
      lifecycleScriptsExecuted: false,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
