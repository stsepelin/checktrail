import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { runRequiredTests } from "./required-test-evidence.mjs";
import { windowsEnvironment } from "../dist/src/windows-process.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (b) => createHash("sha256").update(b).digest("hex");
export async function tasksRuntimeRequirements() {
  const profiles = JSON.parse(
    await readFile(
      path.join(root, "scripts/required-native-tests.json"),
      "utf8",
    ),
  );
  assert.equal(profiles["mcp-tasks"].length, 10);
  return [
    ...profiles["mcp-tasks"],
    {
      file: "dist/test/tasks-runtime-harness.test.js",
      name: "Tasks installed wrapper selects a bounded Windows aggregate allowance while preserving POSIX deadlines and failed child status",
    },
    ...(process.platform === "win32"
      ? [
          {
            file: "dist/test/tasks-runtime-harness.test.js",
            name: "Windows isolated harness namespace cleanup waits for native cwd release and reports exhausted locks",
          },
        ]
      : []),
    {
      file: "dist/test/mcp-validation-tasks.test.js",
      name: "Tasks fixture teardown closes every live SQLite server before removing its directories",
    },
    ...[
      "broken",
      "fixed",
      "near-miss",
      "prerequisite",
      "stale",
      "empty",
      "privacy",
      "lifecycle",
      "installed",
    ].map((kind) => ({
      file: "dist/test/gate-tasks-matrix.test.js",
      name: "tasks-matrix " + kind + " acceptance",
    })),
    {
      file: "dist/test/tasks-sdk-fallback.test.js",
      name: "Tasks-enabled servers retain ordinary native validation with pinned SDK modern and legacy clients",
    },
    ...[
      "Windows task ACL validation admits only the exact caller rule and actual caller or token owner",
      "Windows task ACL validation refuses each private-access boundary independently",
      ...(process.platform === "win32"
        ? [
            "native Windows task storage uses private ACLs for literal Unicode paths and native SQLite owner journals",
            "native Windows task storage refuses a publicly readable directory without changing its ACL or creating a database",
          ]
        : []),
    ].map((name) => ({ file: "dist/test/windows-task-access.test.js", name })),
  ];
}
async function treeHash(directory) {
  const parts = [];
  async function walk(relative) {
    for (const entry of (
      await readdir(path.join(directory, relative), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(file);
      else {
        assert.equal(entry.isFile(), true);
        parts.push([
          file.split(path.sep).join("/"),
          hash(await readFile(path.join(directory, file))),
        ]);
      }
    }
  }
  await walk("");
  return hash(JSON.stringify(parts));
}
export async function verifyTasksRuntime({
  slot = null,
  requireHostedIdentity = false,
} = {}) {
  const scope = JSON.parse(
    await readFile(path.join(root, "docs/gate-a-profiles.v1.json"), "utf8"),
  );
  if (slot !== null) {
    const selected = scope.runtimeProfiles.find((p) => p.id === slot);
    assert.ok(selected, "Unknown frozen runtime slot");
    assert.equal(process.platform, selected.platform);
    assert.equal(process.arch, selected.architecture);
    assert.equal(process.versions.node, selected.node);
  }
  const imageVersion = process.env.ImageVersion ?? null,
    imageOS = process.env.ImageOS ?? null;
  if (requireHostedIdentity) {
    assert.ok(imageVersion && /^20\d{6}\.\d+\.\d+$/.test(imageVersion));
    assert.ok(imageOS && /^[A-Za-z0-9-]+$/.test(imageOS));
  }
  const requirements = await tasksRuntimeRequirements();
  const harnessFiles = [
    ...new Set(requirements.map((x) => x.file)),
    "dist/test/helpers.js",
    "package.json",
    "docs/gate-a-profiles.v1.json",
    "scripts/verify-tasks-runtime.mjs",
    "dist/test/tasks-wire-fixture.js",
    "scripts/required-test-evidence.mjs",
    "scripts/required-native-tests.json",
    "scripts/tasks-runtime-evidence.mjs",
  ];
  const inputs = await Promise.all(
    harnessFiles.map(async (file) => [
      file,
      hash(await readFile(path.join(root, file))),
    ]),
  );
  const nodeExecutableSha256 = hash(await readFile(process.execPath));
  let systemPowerShell = null,
    systemPowerShellSha256 = null;
  if (process.platform === "win32") {
    const environment = windowsEnvironment(process.env);
    assert.ok(environment.SYSTEMROOT);
    systemPowerShell = await realpath(
      path.win32.join(
        environment.SYSTEMROOT,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
    );
    systemPowerShellSha256 = hash(await readFile(systemPowerShell));
  }
  const sourceBefore = await treeHash(path.join(root, "dist/src"));
  const startedAt = new Date().toISOString();
  const profile = await runRequiredTests(
    requirements.map((p) => ({ ...p, file: path.join(root, p.file) })),
    {
      timeoutMs: 600000,
      isolatedCaseWorkers: 1,
      onCaseProgress: (event) =>
        process.stderr.write(
          JSON.stringify({ profile: "tasks-runtime", ...event }) + "\n",
        ),
    },
  );
  assert.equal(profile.complete, true, JSON.stringify(profile.problems));
  assert.equal(profile.required, requirements.length);
  assert.equal(profile.passed, requirements.length);
  assert.equal(profile.ledger.truncated, false);
  assert.equal(profile.ledger.cases.length, requirements.length);
  assert.ok(profile.ledger.cases.every((c) => c.outcome === "passed"));
  assert.equal(await treeHash(path.join(root, "dist/src")), sourceBefore);
  const after = await Promise.all(
    harnessFiles.map(async (file) => [
      file,
      hash(await readFile(path.join(root, file))),
    ]),
  );
  assert.deepEqual(after, inputs);
  assert.equal(hash(await readFile(process.execPath)), nodeExecutableSha256);
  if (systemPowerShell !== null)
    assert.equal(
      hash(await readFile(systemPowerShell)),
      systemPowerShellSha256,
    );
  return {
    schemaVersion: 1,
    profile: "tasks-runtime-foundation-v1",
    runtime: {
      slot,
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      nodeExecutableSha256,
      systemPowerShellSha256,
      sqliteVersion: process.versions.sqlite ?? null,
      osRelease: os.release(),
      osVersion: os.version(),
      imageVersion,
      imageOS,
      hostedImageMetadataAttested: false,
    },
    startedAt,
    finishedAt: new Date().toISOString(),
    runtimeArtifactsSha256: sourceBefore,
    harnessSha256: hash(JSON.stringify(inputs)),
    inputSources: inputs,
    profileEvidence: profile,
    windowsPrivateStorageNativeVerified: process.platform === "win32",
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
    gateATasksMatrixComplete: false,
  };
}
