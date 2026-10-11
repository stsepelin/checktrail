import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
import { runRequiredTests } from "./required-test-evidence.mjs";
import { attemptOutputCodeIdentity } from "./attempt-output-evidence.mjs";
import {
  taskArchiveRequirements,
  taskArchiveTestFiles,
} from "./task-archive-evidence.mjs";
const repository = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const testFiles = taskArchiveTestFiles;
const inputFiles = [
  ...testFiles.map(([f]) => "dist/test/" + f),
  "dist/test/helpers.js",
  "dist/test/tasks-wire-fixture.js",
  "scripts/required-native-tests.json",
  "scripts/task-archive-evidence.mjs",
  "scripts/attempt-output-evidence.mjs",
  "scripts/required-test-evidence.mjs",
  "scripts/verify-task-archives-package.mjs",
];
const inputs = await Promise.all(
  inputFiles.map(async (file) => ({
    file,
    bytes: await readFile(path.join(repository, file)),
  })),
);
const requirements = (await taskArchiveRequirements(repository)).map((x) => ({
  ...x,
  file: path.relative(repository, x.file),
}));
const harnessSha256 = hash(
  JSON.stringify(inputs.map((x) => [x.file, hash(x.bytes)])),
);
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-task-archives-installed-"),
);
try {
  const [packed] = JSON.parse(
    runAcceptanceNpm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const tarball = path.join(temporary, packed.filename),
    tarballSha256 = hash(await readFile(tarball));
  const consumer = path.join(temporary, "consumer"),
    harness = path.join(temporary, "harness");
  const installation = await installAcceptancePackage(
    repository,
    tarball,
    consumer,
  );
  const installed = path.join(consumer, "node_modules/@stsepelin/checktrail");
  await mkdir(path.join(harness, "dist/test"), { recursive: true });
  await symlink(
    path.join(consumer, "node_modules"),
    path.join(harness, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await symlink(
    path.relative(path.join(harness, "dist"), path.join(installed, "dist/src")),
    path.join(harness, "dist/src"),
  );
  await symlink(
    path.relative(harness, path.join(installed, "docs")),
    path.join(harness, "docs"),
  );
  await cp(
    path.join(repository, "package.json"),
    path.join(harness, "package.json"),
  );
  for (const { file, bytes } of inputs) {
    const target = path.join(harness, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }

  const installedCode = await attemptOutputCodeIdentity(installed);
  assert.equal(installedCode, await attemptOutputCodeIdentity(repository));
  const profile = await runRequiredTests(
    requirements.map((x) => ({ ...x, file: path.join(harness, x.file) })),
    { timeoutMs: 300000, isolatedCaseWorkers: 1 },
  );
  assert.equal(
    profile.complete,
    true,
    "Fresh installed durable task archive controls failed: " +
      JSON.stringify(profile.problems),
  );
  assert.equal(profile.required, requirements.length);
  assert.equal(profile.ledger.truncated, false);
  assert.equal(profile.ledger.cases.length, requirements.length);
  assert.ok(profile.ledger.cases.every((c) => c.outcome === "passed"));
  assert.equal(
    hash(
      JSON.stringify(
        await Promise.all(
          inputFiles.map(async (file) => [
            file,
            hash(await readFile(path.join(repository, file))),
          ]),
        ),
      ),
    ),
    harnessSha256,
  );
  assert.equal(installedCode, await attemptOutputCodeIdentity(installed));
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      profile: "durable-task-report-archives-v1",
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      nodeExecutableSha256: hash(await readFile(process.execPath)),
      tarballSha256,
      harnessSha256,
      ...installation,
      compiledCodeSha256: installedCode,
      harnessOutsideInstalledPackage: true,
      attemptArchivesGateAcceptanceComplete: false,
      selectedDurableTaskReportRetention: true,
      completeDurableAttemptArchiveAcceptance: false,
      nativeWindowsArchiveAcceptance: false,
      wholeNativeCallFamilyMigrated: false,
      inferenceExecuted: false,
      fieldEvaluationExecuted: false,
      profileEvidence: profile,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
