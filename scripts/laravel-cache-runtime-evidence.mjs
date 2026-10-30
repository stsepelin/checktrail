import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const laravelCacheSelection = Object.freeze([
  "laravel",
  "laravel-cache",
]);
export const laravelCacheHarnessFiles = Object.freeze([
  "package.json",
  "package-lock.json",
  "dist/test/laravel.test.js",
  "dist/test/laravel-cache.test.js",
  "dist/test/helpers.js",
  "scripts/required-native-tests.json",
  "scripts/required-test-evidence.mjs",
  "scripts/compiled-engine-evidence.mjs",
  "scripts/install-acceptance-package.mjs",
  "scripts/laravel-cache-runtime-evidence.mjs",
  "scripts/verify-laravel-cache.mjs",
  "scripts/verify-laravel-cache-package.mjs",
  "examples/frameworks/laravel/composer.json",
  "examples/frameworks/laravel/checktrail.json",
  "examples/frameworks/laravel/wiring.php",
  "examples/frameworks/laravel/config/app.php",
  "examples/frameworks/laravel/checktrail.laravel.json",
  "examples/frameworks/laravel/bootstrap/providers.php",
  "examples/frameworks/laravel/bootstrap/app.php",
  ".checktrail/laravel-tools/composer.json",
  ".checktrail/laravel-tools/composer.lock",
  ".checktrail/laravel-tools/vendor/composer/installed.json",
]);
export const laravelCacheDigest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export async function captureLaravelCacheInputs(root) {
  return Promise.all(
    laravelCacheHarnessFiles.map(async (file) => [
      file,
      laravelCacheDigest(await readFile(path.join(root, file))),
    ]),
  );
}
// These selected framework files and executable bytes are observations, not a
// complete dependency, loaded-module, operating-system or license closure.
export async function observeLaravelCacheRuntime(root) {
  const {
    laravelAssemblyRuntimePins: pins,
    laravelAssemblyVersions: versions,
  } = await import(
    pathToFileURL(path.join(root, "dist/src/laravel-assembly-runtime-pins.js"))
      .href
  );
  const vendor = path.join(root, ".checktrail/laravel-tools/vendor");
  const installed = JSON.parse(
    await readFile(path.join(vendor, "composer/installed.json"), "utf8"),
  );
  const observedVersions = Object.fromEntries(
    installed.packages
      .filter((item) => Object.hasOwn(versions, item.name))
      .map((item) => [item.name, item.version]),
  );
  assert.deepEqual(
    observedVersions,
    versions,
    "Selected Laravel cache framework versions differ",
  );
  assert.ok(pins.length > 0, "Selected Laravel cache runtime files are empty");
  const selectedRuntimeBytes = await Promise.all(
    pins.map(async (pin) => {
      const bytes = await readFile(path.join(vendor, pin.directory, pin.file));
      assert.equal(
        bytes.length,
        pin.bytes,
        "Selected Laravel cache runtime file size differs",
      );
      assert.equal(
        laravelCacheDigest(bytes),
        pin.sha256,
        "Selected Laravel cache runtime file bytes differ",
      );
      return { ...pin };
    }),
  );
  const php = JSON.parse(
    execFileSync(
      "php",
      [
        "-r",
        'echo json_encode(["version"=>PHP_VERSION,"binary"=>PHP_BINARY,"sqlite"=>in_array("sqlite",PDO::getAvailableDrivers(),true)]);',
      ],
      { encoding: "utf8", timeout: 10000, maxBuffer: 16384 },
    ),
  );
  assert.equal(typeof php.version, "string");
  assert.ok(path.isAbsolute(php.binary));
  assert.equal(
    php.sqlite,
    true,
    "Laravel cache acceptance requires native SQLite",
  );
  const phpBytes = await readFile(php.binary),
    nodeBytes = await readFile(process.execPath);
  return {
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    nodeExecutableSha256: laravelCacheDigest(nodeBytes),
    php: php.version,
    phpExecutableSha256: laravelCacheDigest(phpBytes),
    sqlite: php.sqlite,
    versions: observedVersions,
    selectedRuntimeBytes,
    wholeDependencyClosureVerified: false,
    publisherLicenseClosureVerified: false,
  };
}
export function requireLaravelCacheAccounting(evidence, profiles) {
  const requirements = laravelCacheSelection.flatMap(
    (profile) => profiles[profile],
  );
  assert.equal(
    requirements.length,
    9,
    "Laravel cache foundation must retain all nine cases",
  );
  assert.equal(evidence.complete, true, JSON.stringify(evidence.problems));
  assert.deepEqual(
    evidence.profiles,
    laravelCacheSelection.map((profile) => ({
      profile,
      required: profiles[profile].length,
    })),
  );
  assert.equal(evidence.required, requirements.length);
  assert.equal(evidence.passed, requirements.length);
  assert.equal(evidence.ledger.truncated, false);
  assert.equal(evidence.ledger.cases.length, requirements.length);
  assert.ok(evidence.ledger.cases.every((item) => item.outcome === "passed"));
  assert.deepEqual(
    evidence.ledger.cases.map((item) => item.name).sort(),
    requirements.map((item) => item.name).sort(),
  );
}
