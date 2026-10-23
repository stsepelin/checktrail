import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
import { runRequiredTests } from "./required-test-evidence.mjs";
import { attemptOutputCodeIdentity } from "./attempt-output-evidence.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const args = process.argv.slice(2);
assert.ok(
  args.length === 0 ||
    (args.length === 1 &&
      ["--metering", "--captures", "--artifacts"].includes(args[0])),
);
const metering = args[0] === "--metering";
const captures = args[0] === "--captures";
const artifacts = args[0] === "--artifacts";
const caseCount = artifacts ? 13 : 12;
const selectedProfile = artifacts
  ? "evaluation-physical-captures"
  : captures
    ? "evaluation-capture-declarations"
    : metering
      ? "evaluation-protocol-metering"
      : "evaluation-protocol-declarations";
const harnessFiles = artifacts
  ? [
      "dist/test/review-evaluation-artifacts.test.js",
      "dist/test/review-evaluation-artifacts-fixture.js",
      "dist/test/review-evaluation-captures-fixture.js",
      "dist/test/review-evaluation-metering-fixture.js",
      "dist/test/review-evaluation-protocol-fixture.js",
      "dist/test/helpers.js",
    ]
  : captures
    ? [
        "dist/test/review-evaluation-captures.test.js",
        "dist/test/review-evaluation-captures-fixture.js",
        "dist/test/review-evaluation-metering-fixture.js",
        "dist/test/review-evaluation-protocol-fixture.js",
        "scripts/check-evaluation-captures.mjs",
      ]
    : metering
      ? [
          "dist/test/review-evaluation-metering.test.js",
          "dist/test/review-evaluation-metering-fixture.js",
          "dist/test/review-evaluation-protocol-fixture.js",
          "scripts/check-evaluation-metering.mjs",
        ]
      : [
          "dist/test/review-evaluation-protocol.test.js",
          "dist/test/review-evaluation-protocol-fixture.js",
          "scripts/check-evaluation-protocol.mjs",
        ];
const expected = JSON.parse(
  await readFile(
    path.join(repository, "scripts/required-native-tests.json"),
    "utf8",
  ),
)[selectedProfile];
assert.equal(expected.length, caseCount);
assert.equal(new Set(expected.map((row) => row.name)).size, caseCount);
assert.ok(
  expected.every(
    (row) =>
      row.file ===
      (artifacts
        ? "dist/test/review-evaluation-artifacts.test.js"
        : captures
          ? "dist/test/review-evaluation-captures.test.js"
          : metering
            ? "dist/test/review-evaluation-metering.test.js"
            : "dist/test/review-evaluation-protocol.test.js"),
  ),
);
const inputFiles = [
  ...harnessFiles,
  "scripts/required-native-tests.json",
  "scripts/required-test-evidence.mjs",
  "scripts/attempt-output-evidence.mjs",
  "scripts/install-acceptance-package.mjs",
  "scripts/verify-evaluation-protocol-package.mjs",
  "package.json",
  "package-lock.json",
];
const inputIdentities = async () =>
  Promise.all(
    inputFiles.map(async (file) => [
      file,
      hash(await readFile(path.join(repository, file))),
    ]),
  );
const inputs = await inputIdentities();
const harnessSha256 = hash(JSON.stringify(inputs));
const sourceCode = await attemptOutputCodeIdentity(repository);
const executableSha256 = hash(await readFile(process.execPath));
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "checktrail-evaluation-protocol-installed-"),
);
try {
  const [packed] = JSON.parse(
    runAcceptanceNpm(
      [
        "pack",
        "--json",
        "--offline",
        "--ignore-scripts",
        "--pack-destination",
        temporary,
      ],
      {
        cwd: repository,
        encoding: "utf8",
        timeout: 60000,
        maxBuffer: 4 * 1048576,
      },
    ),
  );
  const tarball = path.join(temporary, packed.filename);
  const consumer = path.join(temporary, "consumer"),
    harness = path.join(temporary, "harness");
  const installation = await installAcceptancePackage(
    repository,
    tarball,
    consumer,
  );
  const installed = path.join(consumer, "node_modules/@stsepelin/checktrail");
  await mkdir(path.join(harness, "dist/test"), { recursive: true });
  await mkdir(path.join(harness, "scripts"));
  await writeFile(path.join(harness, "package.json"), '{"type":"module"}\n', {
    flag: "wx",
  });
  await symlink(
    path.join(installed, "dist/src"),
    path.join(harness, "dist/src"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(
    await realpath(path.join(harness, "dist/src")),
    await realpath(path.join(installed, "dist/src")),
  );
  for (const file of harnessFiles)
    await cp(path.join(repository, file), path.join(harness, file));
  const copiedInputs = async () =>
    Promise.all(
      inputFiles
        .slice(0, harnessFiles.length)
        .map(async (file) => [
          file,
          hash(await readFile(path.join(harness, file))),
        ]),
    );
  assert.deepEqual(await copiedInputs(), inputs.slice(0, harnessFiles.length));
  const installedCode = await attemptOutputCodeIdentity(installed);
  assert.equal(installedCode, sourceCode);
  process.env.CHECKTRAIL_EVALUATION_PROTOCOL_INSTALLED = "1";
  delete process.env.NODE_TEST_CONTEXT;
  const profile = await runRequiredTests(
    expected.map((row) => ({ ...row, file: path.join(harness, row.file) })),
    { timeoutMs: 120000 },
  );
  assert.equal(profile.complete, true, JSON.stringify(profile.problems));
  assert.equal(profile.required, caseCount);
  assert.equal(profile.passed, caseCount);
  assert.equal(profile.ledger.truncated, false);
  assert.equal(profile.ledger.cases.length, caseCount);
  assert.ok(profile.ledger.cases.every((row) => row.outcome === "passed"));
  assert.deepEqual(await inputIdentities(), inputs);
  assert.deepEqual(await copiedInputs(), inputs.slice(0, harnessFiles.length));
  assert.equal(await attemptOutputCodeIdentity(installed), installedCode);
  assert.equal(await attemptOutputCodeIdentity(repository), sourceCode);
  assert.equal(hash(await readFile(process.execPath)), executableSha256);
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      profile: selectedProfile,
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      nodeExecutableSha256: executableSha256,
      tarballSha256: hash(await readFile(tarball)),
      harnessSha256,
      compiledCodeSha256: installedCode,
      ...installation,
      harnessOutsideInstalledPackage: true,
      dependencyBytesInventoried: false,
      actualModuleLoadsTraced: false,
      protocolChronologyVerified: false,
      independentEvaluationProfileComplete: false,
      gateAComplete: false,
      inferenceExecuted: false,
      fieldEvaluationExecuted: false,
      profileEvidence: profile,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
