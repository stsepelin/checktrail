import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import { runRequiredTests } from "./required-test-evidence.mjs";
import { copyInstalledPackages } from "../dist/test/tool-fixture.js";
import {
  attemptHash,
  captureAttemptHarness,
  selectAttemptWholeRequirements,
  requireAttemptTerminalCases,
} from "./attempt-whole-evidence.mjs";
import {
  observeAttemptRuntime,
  checkAttemptRuntimeSelection,
  compactAttemptEngine,
} from "./attempt-runtime-evidence.mjs";
const repository = fileURLToPath(new URL("../", import.meta.url));
assert.equal(process.argv.length, 2);
const harnessBefore = await captureAttemptHarness(repository),
  { inputs } = harnessBefore;
const input = (file) => inputs.find((x) => x.file === file).bytes;
const requirements = selectAttemptWholeRequirements(
  JSON.parse(input("scripts/required-native-tests.json")),
  JSON.parse(input("docs/gate-a-profiles.v1.json")),
);
const slot =
  process.env.CHECKTRAIL_ATTEMPT_RUNTIME_ACTIVE === "1"
    ? process.env.CHECKTRAIL_ATTEMPT_RUNTIME_SLOT || null
    : null;
const runtime = await observeAttemptRuntime(slot),
  selectedRuntime = checkAttemptRuntimeSelection(
    JSON.parse(input("docs/gate-a-profiles.v1.json")),
    slot,
    runtime,
    process.env.CHECKTRAIL_ATTEMPT_RUNTIME_ACTIVE === "1" &&
      process.env.GITHUB_ACTIONS === "true",
  );
const sourceEngine = await captureCompiledEngine(
  path.join(repository, "dist/src"),
);
const temporary = await realpath(
  await mkdtemp(path.join(tmpdir(), "checktrail-attempt-whole-installed-")),
);
const previous = process.env.CHECKTRAIL_ATTEMPT_WHOLE_INSTALLED;
try {
  const [packed] = JSON.parse(
    runAcceptanceNpm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const tarball = path.join(temporary, packed.filename),
    tarballSha256 = attemptHash(await readFile(tarball));
  const consumer = path.join(temporary, "consumer"),
    harness = path.join(temporary, "harness");
  const installation = await installAcceptancePackage(
    repository,
    tarball,
    consumer,
  );
  const installed = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail/dist/src",
  );
  await mkdir(path.join(harness, "dist"), { recursive: true });
  await symlink(
    process.platform === "win32"
      ? installed
      : path.relative(path.join(harness, "dist"), installed),
    path.join(harness, "dist/src"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const { file, bytes } of inputs) {
    await mkdir(path.dirname(path.join(harness, file)), { recursive: true });
    await writeFile(path.join(harness, file), bytes, { flag: "wx" });
  }
  const lock = JSON.parse(input("package-lock.json")),
    externalSdkDependencies = {};
  await copyInstalledPackages(
    harness,
    ["@modelcontextprotocol/client"],
    path.join(repository, "node_modules"),
    ({ relative, version }) => {
      const name = relative.split(path.sep).join("/");
      assert.equal(version, lock.packages["node_modules/" + name].version);
      externalSdkDependencies[name] = version;
    },
  );
  assert.equal(
    externalSdkDependencies["@modelcontextprotocol/client"],
    "2.3.1",
  );
  process.env.CHECKTRAIL_ATTEMPT_WHOLE_INSTALLED = "1";
  const installedBefore = await captureCompiledEngine(installed);
  requireUnchangedCompiledEngine(sourceEngine, installedBefore);
  const profile = await runRequiredTests(
    requirements.map((x) => ({ ...x, file: path.join(harness, x.file) })),
    {
      timeoutMs: process.platform === "win32" ? 600000 : 300000,
      isolatedCaseWorkers: 1,
      onCaseProgress: (event) =>
        process.stderr.write(
          JSON.stringify({ profile: "attempt-archives-installed", ...event }) +
            "\n",
        ),
    },
  );
  assert.equal(profile.complete, true, JSON.stringify(profile.problems));
  requireAttemptTerminalCases(
    profile,
    requirements,
    attemptHash(input("dist/test/gate-attempt-archives.test.js")),
  );
  const compiledEngine = requireUnchangedCompiledEngine(
    installedBefore,
    await captureCompiledEngine(installed),
  );
  requireUnchangedCompiledEngine(
    sourceEngine,
    await captureCompiledEngine(path.join(repository, "dist/src")),
  );
  assert.equal(
    (await captureAttemptHarness(repository)).sha256,
    harnessBefore.sha256,
  );
  const { files, ...identity } = compiledEngine;
  assert.equal(files.length, identity.fileCount);
  assert.deepEqual(await observeAttemptRuntime(slot), runtime);
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      profile: "attempt-archives-whole-installed-v1",
      runtime,
      selectedRuntime,
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      nodeExecutableSha256: attemptHash(await readFile(process.execPath)),
      tarballSha256,
      requirementsSha256: attemptHash(JSON.stringify(requirements)),
      harnessSha256: harnessBefore.sha256,
      packageSha256: attemptHash(
        await readFile(
          path.join(
            consumer,
            "node_modules/@stsepelin/checktrail/package.json",
          ),
        ),
      ),
      ...installation,
      harnessOutsideInstalledPackage: true,
      externalSdkDependencies,
      compiledEngine: compactAttemptEngine(identity),
      profileEvidence: profile,
      gateAAttemptArchivesComplete: false,
      gateAComplete: false,
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
    }) + "\n",
  );
} finally {
  if (previous === undefined)
    delete process.env.CHECKTRAIL_ATTEMPT_WHOLE_INSTALLED;
  else process.env.CHECKTRAIL_ATTEMPT_WHOLE_INSTALLED = previous;
  await rm(temporary, { recursive: true, force: true });
}
