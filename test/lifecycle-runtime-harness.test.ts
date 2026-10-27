import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";

test("lifecycle runtime admission refuses wrong slots, missing foundations and changed harnesses while retaining unqualified development evidence", async (t) => {
  const repository = new URL("../../", import.meta.url);
  const { lifecycleHarnessFiles } = await import(
    new URL("scripts/lifecycle-runtime-evidence.mjs", repository).href
  );
  // fixture() uses mkdtemp and registers cleanup; repository files are read-only inputs.
  const fixtureRoot = await fixture(t, {
    "dist/src/original.js": "export const original = 1;\n",
  });
  if (process.platform === "win32") {
    // Admission bookkeeping uses the actual native ACL implementation, even in
    // this explicitly synthetic collector fixture.
    await cp(
      new URL("dist/src/", repository),
      path.join(fixtureRoot, "dist/src"),
      { recursive: true },
    );
    await symlink(
      fileURLToPath(new URL("node_modules/", repository)),
      path.join(fixtureRoot, "node_modules"),
      "junction",
    );
  }
  for (const file of lifecycleHarnessFiles) {
    const target = path.join(fixtureRoot, file);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(new URL(file, repository), target);
  }
  const allRequirements = JSON.parse(
    await readFile(
      path.join(fixtureRoot, "scripts/required-native-tests.json"),
      "utf8",
    ),
  ) as Record<string, Array<{ file: string; name: string }>>;
  const requirements = allRequirements["lifecycle-platforms"]!;
  const foundationProfiles =
    process.platform === "win32"
      ? ["windows-process", "physical-process-output"]
      : ["posix-cleanup", "posix-owner"];
  const foundationRows = foundationProfiles.flatMap(
    (profile) => allRequirements[profile]!,
  );
  const foundationMarker = path.join(fixtureRoot, "foundation-reached.jsonl");
  for (const file of new Set(foundationRows.map((row) => row.file))) {
    assert.match(file, /^dist\/test\/[a-z0-9-]+\.test\.js$/);
    const target = path.resolve(fixtureRoot, file);
    assert.equal(
      path.relative(fixtureRoot, target).split(path.sep).join("/"),
      file,
    );
    await mkdir(path.dirname(target), { recursive: true });
    await rm(target, { force: true }); // Unlink only this owned fixture file before exclusive publication.
    await writeFile(
      target,
      "import {test} from 'node:test';import {appendFileSync} from 'node:fs';\n" +
        foundationRows
          .filter((row) => row.file === file)
          .map(
            (row) =>
              `test(${JSON.stringify(row.name)},()=>appendFileSync(${JSON.stringify(foundationMarker)},${JSON.stringify(row.name + "\n")}));`,
          )
          .join("\n"),
      { flag: "wx" },
    );
  }
  assert.equal(requirements.length, 9);
  assert.equal(new Set(requirements.map((row) => row.file)).size, 1);
  const marker = path.join(fixtureRoot, "body-reached.jsonl");
  const receiptTemplate = path.join(
    fixtureRoot,
    "original-installed-template.json",
  );
  await writeFile(
    path.join(fixtureRoot, requirements[0]!.file),
    "import {test} from 'node:test';import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';\n" +
      requirements
        .map((row) =>
          row.name.endsWith(" installed acceptance")
            ? `test(${JSON.stringify(row.name)},()=>{appendFileSync(${JSON.stringify(marker)},${JSON.stringify(row.name + "\n")});if(process.env.CHECKTRAIL_LIFECYCLE_INSTALL_RECEIPT&&process.env.ORIGINAL_INSTALLED_TEMPLATE)writeFileSync(process.env.CHECKTRAIL_LIFECYCLE_INSTALL_RECEIPT,readFileSync(process.env.ORIGINAL_INSTALLED_TEMPLATE),{flag:'wx',mode:0o600});});`
            : `test(${JSON.stringify(row.name)},()=>appendFileSync(${JSON.stringify(marker)},${JSON.stringify(row.name + "\n")}));`,
        )
        .join("\n"),
  );
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  delete env.GITHUB_ACTIONS;
  delete env.CHECKTRAIL_LIFECYCLE_RUNTIME_SLOT;
  delete env.CHECKTRAIL_LIFECYCLE_INSTALLED;
  delete env.CHECKTRAIL_LIFECYCLE_INSTALL_RECEIPT;
  delete env.ORIGINAL_INSTALLED_TEMPLATE;
  for (const slot of [
    "original-unknown-slot",
    process.platform === "win32" ? "ci-linux-node22" : "windows-node22",
  ]) {
    await rm(marker, { force: true });
    await rm(foundationMarker, { force: true });
    const refused = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "scripts/verify-lifecycle-platforms.mjs"), slot],
      { cwd: fixtureRoot, env, encoding: "utf8", timeout: 30000 },
    );
    assert.equal(refused.error, undefined);
    assert.equal(refused.status, 1);
    assert.match(
      refused.stderr,
      slot === "original-unknown-slot"
        ? /Unknown selected runtime slot/
        : /Selected runtime platform differs/,
    );
    assert.doesNotMatch(
      refused.stderr,
      /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/,
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    await assert.rejects(readFile(foundationMarker), { code: "ENOENT" });
  }
  // Obtain the fixture's real collector identities with the recursion guard set.
  // These stub callbacks test envelope admission only, never native qualification.
  const bootstrap = spawnSync(
    process.execPath,
    [path.join(fixtureRoot, "scripts/verify-lifecycle-platforms.mjs")],
    {
      cwd: fixtureRoot,
      env: { ...env, CHECKTRAIL_LIFECYCLE_INSTALLED: "1" },
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 4 * 1048576,
    },
  );
  assert.equal(bootstrap.error, undefined);
  assert.equal(bootstrap.status, 0, bootstrap.stdout + bootstrap.stderr);
  const childEvidence = JSON.parse(bootstrap.stdout);
  const template = {
    schemaVersion: 1,
    profile: "lifecycle-platforms-installed-v1",
    offlineProductionInstall: true,
    lifecycleScriptsExecuted: false,
    harnessOutsideInstalledPackage: true,
    tarballSha256: "a".repeat(64),
    productionDependencyLockSha256: "b".repeat(64),
    compiledEngine: childEvidence.compiledEngine,
    harnessSha256: childEvidence.harnessSha256,
    evidence: childEvidence,
  };
  await writeFile(receiptTemplate, JSON.stringify(template));
  env.ORIGINAL_INSTALLED_TEMPLATE = receiptTemplate;
  await rm(marker, { force: true });
  await rm(foundationMarker, { force: true });
  const development = spawnSync(
    process.execPath,
    [path.join(fixtureRoot, "scripts/verify-lifecycle-platforms.mjs")],
    {
      cwd: fixtureRoot,
      env,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 4 * 1048576,
    },
  );
  assert.equal(development.error, undefined);
  assert.equal(development.status, 0, development.stdout + development.stderr);
  const packet = JSON.parse(development.stdout);
  assert.equal(packet.complete, true);
  assert.equal(packet.installed, false);
  assert.deepEqual(packet.installedEvidence, template);
  assert.equal(packet.required, 9);
  assert.equal(packet.passed, 9);
  assert.equal(
    packet.completionScope,
    "whole-profile-and-selected-platform-foundation",
  );
  assert.equal(packet.foundation.complete, true);
  assert.deepEqual(
    packet.foundation.profiles,
    foundationProfiles.map((profile) => ({
      profile,
      required: allRequirements[profile]!.length,
    })),
  );
  assert.equal(packet.foundation.required, foundationRows.length);
  assert.equal(packet.foundation.passed, foundationRows.length);
  assert.equal(packet.foundation.ledger.truncated, false);
  assert.equal(packet.foundation.ledger.cases.length, foundationRows.length);
  assert.ok(
    packet.foundation.ledger.cases.every(
      (row: { outcome: string }) => row.outcome === "passed",
    ),
  );
  assert.deepEqual(
    (await readFile(foundationMarker, "utf8")).trim().split("\n").sort(),
    foundationRows.map((row) => row.name).sort(),
  );
  assert.equal(packet.runtime.slot, null);
  assert.equal(packet.selectedRuntime, null);
  assert.equal(packet.runtime.selectedRuntime, null);
  assert.equal(packet.runtime.node, process.versions.node);
  assert.equal(packet.runtime.platform, process.platform);
  assert.equal(packet.runtime.architecture, process.arch);
  assert.equal(packet.harnessInputsUnchanged, true);
  assert.equal(packet.inputSources.length, lifecycleHarnessFiles.length);
  assert.equal(packet.gateAComplete, false);
  assert.equal(packet.inferenceInvoked, false);
  assert.equal(packet.fieldEvaluationExecuted, false);
  assert.deepEqual(
    (await readFile(marker, "utf8")).trim().split("\n").sort(),
    requirements.map((row) => row.name).sort(),
  );

  const missingEnv = { ...env };
  delete missingEnv.ORIGINAL_INSTALLED_TEMPLATE;
  const noInstallation = spawnSync(
    process.execPath,
    [path.join(fixtureRoot, "scripts/verify-lifecycle-platforms.mjs")],
    {
      cwd: fixtureRoot,
      env: missingEnv,
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 4 * 1048576,
    },
  );
  assert.equal(noInstallation.error, undefined);
  assert.equal(noInstallation.status, 1);
  assert.equal(noInstallation.stdout, "");
  assert.match(noInstallation.stderr, /ENOENT/);
  assert.doesNotMatch(
    noInstallation.stderr,
    /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/,
  );

  const shadowFiles = [
    requirements[0]!.file,
    ...new Set(foundationRows.map((row) => row.file)),
  ];
  const sibling = await fixture(
    t,
    Object.fromEntries(
      shadowFiles.map((file) => [
        file,
        "throw Error('Original shadow harness must never execute');\n",
      ]),
    ),
  );
  await rm(marker, { force: true });
  await rm(foundationMarker, { force: true });
  const otherDirectory = spawnSync(
    process.execPath,
    [path.join(fixtureRoot, "scripts/verify-lifecycle-platforms.mjs")],
    {
      cwd: sibling,
      env,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 4 * 1048576,
    },
  );
  assert.equal(otherDirectory.error, undefined);
  assert.equal(
    otherDirectory.status,
    0,
    otherDirectory.stdout + otherDirectory.stderr,
  );
  const otherPacket = JSON.parse(otherDirectory.stdout);
  assert.equal(otherPacket.complete, true);
  assert.deepEqual(otherPacket.foundation.profiles, packet.foundation.profiles);
  assert.deepEqual(
    (await readFile(foundationMarker, "utf8")).trim().split("\n").sort(),
    foundationRows.map((row) => row.name).sort(),
  );
  assert.equal(otherPacket.harnessSha256, packet.harnessSha256);
  assert.equal(
    otherPacket.compiledEngine.treeSha256,
    packet.compiledEngine.treeSha256,
  );
  assert.deepEqual(
    (await readFile(marker, "utf8")).trim().split("\n").sort(),
    requirements.map((row) => row.name).sort(),
  );

  // Successful whole-case callbacks cannot excuse a missing platform foundation.
  const omitted = foundationRows[0]!;
  const foundationFile = path.join(fixtureRoot, omitted.file);
  const foundationBefore = await readFile(foundationFile, "utf8");
  await writeFile(
    foundationFile,
    foundationBefore.replace(
      JSON.stringify(omitted.name),
      JSON.stringify(omitted.name + " adjacent"),
    ),
  );
  try {
    const missing = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "scripts/verify-lifecycle-platforms.mjs")],
      {
        cwd: fixtureRoot,
        env,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 4 * 1048576,
      },
    );
    assert.equal(missing.error, undefined);
    assert.equal(missing.status, 1, missing.stdout + missing.stderr);
    const refused = JSON.parse(missing.stdout);
    assert.equal(refused.passed, 9);
    assert.equal(refused.required, 9);
    assert.equal(refused.complete, false);
    assert.equal(refused.foundation.complete, false);
    assert.ok(
      refused.foundation.problems.some(
        (item: { name: string }) => item.name === omitted.name,
      ),
    );
  } finally {
    await writeFile(foundationFile, foundationBefore);
  }

  // A passing native test cannot certify supporting harness bytes it changed.
  const support = path.join(
    fixtureRoot,
    "dist/test/lifecycle-platforms-boundaries.js",
  );
  const supportBefore = await readFile(support);
  const callback = path.join(fixtureRoot, requirements[0]!.file);
  const callbackBefore = await readFile(callback, "utf8");
  const first = JSON.stringify(requirements[0]!.name);
  await rm(marker, { force: true });
  await writeFile(
    callback,
    callbackBefore
      .replace(
        `test(${first},()=>appendFileSync`,
        `test(${first},()=>{appendFileSync(${JSON.stringify(support)},"\\n// Original changed supporting harness.\\n");return appendFileSync`,
      )
      .replace(
        `${JSON.stringify(requirements[0]!.name + "\n")}));`,
        `${JSON.stringify(requirements[0]!.name + "\n")});});`,
      ),
  );
  try {
    const stale = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "scripts/verify-lifecycle-platforms.mjs")],
      {
        cwd: fixtureRoot,
        env,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 4 * 1048576,
      },
    );
    assert.equal(stale.error, undefined);
    assert.equal(stale.status, 1, stale.stdout + stale.stderr);
    assert.match(
      stale.stderr,
      /Lifecycle harness bytes changed during acceptance/,
    );
    assert.doesNotMatch(
      stale.stderr,
      /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/,
    );
    assert.deepEqual(
      (await readFile(marker, "utf8")).trim().split("\n").sort(),
      requirements.map((row) => row.name).sort(),
    );
  } finally {
    await writeFile(support, supportBefore);
  }
});

test("lifecycle foundation selection admits only the declared native platforms", async () => {
  const { lifecycleFoundationSelection } = await import(
    new URL("../../scripts/lifecycle-runtime-evidence.mjs", import.meta.url)
      .href
  );
  for (const platform of ["linux", "darwin"])
    assert.deepEqual(lifecycleFoundationSelection(platform), [
      "posix-cleanup",
      "posix-owner",
    ]);
  assert.deepEqual(lifecycleFoundationSelection("win32"), [
    "windows-process",
    "physical-process-output",
  ]);
  for (const platform of ["freebsd", "linux-extra", "windows", ""])
    assert.throws(
      () => lifecycleFoundationSelection(platform),
      /Unsupported lifecycle platform/,
    );
});

test(
  "lifecycle readiness preserves early rejected and incomplete native outcomes before any body marker",
  { timeout: 60000 },
  async (t) => {
    const { access } = await import("node:fs/promises");
    const { validate } = await import("../src/engine.js");
    const { lifecycleProject, lifecycleExecute } =
      await import("./lifecycle-platforms-fixture.js");
    for (const mode of ["untrusted", "empty"] as const) {
      const project = await lifecycleProject(t);
      if (mode === "empty")
        await writeFile(path.join(project.root, project.file), "");
      await assert.rejects(
        lifecycleExecute(project, (signal) =>
          validate(project.root, {
            trusted: mode !== "untrusted",
            timeoutMs: 15000,
            signal,
          }),
        ),
        mode === "untrusted"
          ? /execution rejected before body readiness:.*operator trust/
          : /execution completed before body readiness:.*incomplete.*inconclusive/,
      );
      for (const file of [
        project.marker,
        project.release,
        ...[0, 1].map((i) => path.join(project.control, "child-" + i)),
      ])
        await assert.rejects(access(file), { code: "ENOENT" });
    }
  },
);
