import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const profile = path.join(root, "scripts/php-review-tools");
const vendor = path.join(root, ".checktrail/php-review-tools/vendor");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const lockBytes = await readFile(path.join(profile, "composer.lock"));
const lock = JSON.parse(lockBytes);
const installed = JSON.parse(
  await readFile(path.join(vendor, "composer/installed.json"), "utf8"),
);
assert.equal(lock["packages-dev"].length, 0);
assert.equal(installed.packages.length, lock.packages.length);
const entries = new Map(installed.packages.map((entry) => [entry.name, entry]));
assert.equal(entries.size, installed.packages.length);
const packages = [];
const gaps = [];
for (const entry of lock.packages) {
  assert.match(entry.name, /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/);
  const actual = entries.get(entry.name);
  assert.ok(actual, `Missing installed package: ${entry.name}`);
  for (const key of ["version", "license", "source", "dist"])
    assert.deepEqual(
      actual[key],
      entry[key],
      `Metadata mismatch: ${entry.name} ${key}`,
    );
  if (entry.source) {
    assert.match(entry.source.reference, /^[a-f0-9]{40}$/);
    assert.equal(new URL(entry.source.url).protocol, "https:");
  }
  assert.match(entry.dist.reference, /^[a-f0-9]{40}$/);
  assert.equal(new URL(entry.dist.url).protocol, "https:");
  const directory = path.join(vendor, entry.name);
  assert.equal(await realpath(directory), directory);
  assert.equal(
    path.resolve(vendor, "composer", actual["install-path"]),
    directory,
  );
  const notices = [];
  for (const file of (await readdir(directory)).sort()) {
    if (
      !/^(?:licen[cs]e|copying|notice)(?:[.-]|$)|^ThirdPartyNoticeText\.txt$/i.test(
        file,
      )
    )
      continue;
    const full = path.join(directory, file);
    const stat = await lstat(full);
    assert.ok(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size > 0 &&
        stat.size <= 1024 * 1024,
    );
    const bytes = await readFile(full);
    notices.push({
      file,
      bytes: bytes.length,
      sha256: hash(bytes),
      source: "installed-package",
    });
  }
  if (!notices.length) gaps.push(entry.name);
  packages.push({
    name: entry.name,
    version: entry.version,
    licenses: entry.license,
    source: entry.source ?? null,
    sourceMetadataAvailable: Boolean(entry.source),
    dist: entry.dist,
    notices,
  });
}
const complete = gaps.length === 0;
process.stdout.write(
  JSON.stringify({
    complete,
    lockSha256: hash(lockBytes),
    manifestSha256: hash(await readFile(path.join(profile, "composer.json"))),
    lockedPackages: lock.packages.length,
    installedPackages: installed.packages.length,
    gaps,
    packages,
    scope:
      "Installed Composer metadata and root notice files for the original synthetic PHP review test profile",
    artifactAuthenticationEstablished: false,
    licenseLegalAssessmentPerformed: false,
    projectLifecycleScriptsRequired: false,
  }) + "\n",
);
process.exitCode = complete ? 0 : 1;
