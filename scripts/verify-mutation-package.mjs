import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
import { runRequiredTests } from "./required-test-evidence.mjs";
import { copyInstalledPackages } from "../dist/test/tool-fixture.js";
const family = process.env.CHECKTRAIL_MUTATION_FAMILY;
assert.ok(["vitest", "jest", "pytest", "phpunit"].includes(family));
const repository = fileURLToPath(new URL("../", import.meta.url));
const profileName = "mutation-" + family;
const requirements = JSON.parse(
  await readFile(
    path.join(repository, "scripts/required-native-tests.json"),
    "utf8",
  ),
)[profileName];
assert.equal(requirements.length, 9);
const inputs = [
  "gate-mutation-runners.test.js",
  "mutation-native-fixture.js",
  "mutation-native-lifecycle-fixture.js",
  "helpers.js",
  "tool-fixture.js",
];
// Resolve all harness inputs before packing or copying any of them.
const files = await Promise.all(
  inputs.map(async (file) => ({
    file,
    bytes: await readFile(path.join(repository, "dist/test", file)),
  })),
);
const sourceHarnessSha256 = createHash("sha256")
  .update(
    JSON.stringify(
      files.map((v) => [
        v.file,
        createHash("sha256").update(v.bytes).digest("hex"),
      ]),
    ),
  )
  .digest("hex");
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-mutation-installed-"),
);
try {
  const [packed] = JSON.parse(
    runAcceptanceNpm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const tarball = path.join(temporary, packed.filename),
    tarballSha256 = createHash("sha256")
      .update(await readFile(tarball))
      .digest("hex");
  const consumer = path.join(temporary, "consumer"),
    installed = path.join(
      consumer,
      "node_modules/@stsepelin/checktrail/dist/src",
    ),
    harness = path.join(temporary, "harness");
  const installation = await installAcceptancePackage(
    repository,
    tarball,
    consumer,
  );
  await mkdir(path.join(harness, "dist/test"), { recursive: true });
  await symlink(
    path.relative(path.join(harness, "dist"), installed),
    path.join(harness, "dist/src"),
  );
  await cp(
    path.join(repository, "package.json"),
    path.join(harness, "package.json"),
  );
  for (const { file, bytes } of files) {
    const target = path.join(harness, "dist/test", file);
    await (
      await import("node:fs/promises")
    ).writeFile(target, bytes, { flag: "wx" });
  }
  await copyInstalledPackages(
    harness,
    ["@modelcontextprotocol/client"],
    path.join(repository, "node_modules"),
  );
  const selected =
    family === "pytest"
      ? ".checktrail/python-extension-tools"
      : family === "phpunit"
        ? ".checktrail/php-tools/vendor"
        : ".checktrail/mutation-javascript-tools";
  await mkdir(path.dirname(path.join(harness, selected)), { recursive: true });
  await cp(path.join(repository, selected), path.join(harness, selected), {
    recursive: true,
    verbatimSymlinks: true,
  });
  const original = process.env.CHECKTRAIL_MUTATION_INSTALLED;
  process.env.CHECKTRAIL_MUTATION_INSTALLED = "1";
  let profile;
  try {
    profile = await runRequiredTests(
      requirements.map((item) => ({
        ...item,
        file: path.join(harness, item.file),
      })),
      { timeoutMs: 1200000, isolatedCaseWorkers: 1 },
    );
  } finally {
    if (original === undefined)
      delete process.env.CHECKTRAIL_MUTATION_INSTALLED;
    else process.env.CHECKTRAIL_MUTATION_INSTALLED = original;
  }
  assert.equal(
    profile.complete,
    true,
    "Fresh installed native mutation acceptance failed: " +
      JSON.stringify(profile.problems),
  );
  assert.equal(profile.passed, 9);
  assert.deepEqual(
    files.map((v) => createHash("sha256").update(v.bytes).digest("hex")),
    await Promise.all(
      inputs.map(async (file) =>
        createHash("sha256")
          .update(await readFile(path.join(repository, "dist/test", file)))
          .digest("hex"),
      ),
    ),
  );
  process.stdout.write(
    JSON.stringify({
      family,
      tarballSha256,
      sourceHarnessSha256,
      ...installation,
      harnessOutsideInstalledPackage: true,
      profile,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
