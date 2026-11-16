import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  baselineSha256,
  captureBaselineSourceExecution,
} from "./preserved-baseline-evidence.mjs";
import { baselineRuntimeBinding } from "./preserved-baseline-fresh-coordinator.mjs";
import {
  nativeBaselineBindings,
  requireControllerSelection,
} from "./preserved-native-baseline-bindings.mjs";

export async function captureControllerSourceScope(
  repository,
  cohortName,
  selection,
) {
  const registry = JSON.parse(
    await readFile(
      path.join(repository, "scripts/preserved-baseline-cohorts.v1.json"),
      "utf8",
    ),
  );
  assert.ok(
    Object.hasOwn(registry.cohorts, cohortName),
    "Unknown source cohort",
  );
  const cohort = registry.cohorts[cohortName];
  requireControllerSelection(cohortName, selection, cohort);
  assert.equal(registry.baseline.file, "docs/gate-a-native-baseline.v1.json");
  const frozenBytes = await readFile(
    path.join(repository, registry.baseline.file),
  );
  assert.equal(
    createHash("sha256").update(frozenBytes).digest("hex"),
    baselineSha256,
    "Frozen source baseline bytes changed",
  );
  assert.equal(registry.baseline.sha256, baselineSha256);
  const frozen = JSON.parse(frozenBytes);
  const current = JSON.parse(
    await readFile(
      path.join(repository, "scripts/required-native-tests.json"),
      "utf8",
    ),
  );
  const profiles = Object.fromEntries(
    selection.map((profile) => {
      assert.ok(Object.hasOwn(current, profile) && current[profile].length > 0);
      return [profile, current[profile]];
    }),
  );
  const baselineSelection =
    cohortName === "external-adapters" ? selection : cohort.profiles;
  const baselineProfiles = Object.fromEntries(
    baselineSelection.map((profile) => {
      assert.ok(Object.hasOwn(frozen, profile) && frozen[profile].length > 0);
      for (const row of frozen[profile])
        assert.ok(
          selection.some((source) =>
            current[source].some(
              (candidate) =>
                row.file === candidate.file && row.name === candidate.name,
            ),
          ),
          "Original native command omitted a frozen callback",
        );
      return [profile, frozen[profile]];
    }),
  );
  const runtime =
    cohortName === "packaged-review"
      ? cohort
      : nativeBaselineBindings[cohortName];
  return {
    baseline: {
      cohort,
      profiles: baselineProfiles,
      selection: baselineSelection,
      identities: {
        registrySha256: createHash("sha256")
          .update(
            await readFile(
              path.join(
                repository,
                "scripts/preserved-baseline-cohorts.v1.json",
              ),
            ),
          )
          .digest("hex"),
        baselineSha256,
        requiredNativeTestsSha256: createHash("sha256")
          .update(
            await readFile(
              path.join(repository, "scripts/required-native-tests.json"),
            ),
          )
          .digest("hex"),
      },
    },
    sourceScope: {
      profiles,
      selection,
      additionalFiles: [],
      baselineProfiles,
      baselineSelection,
      binding: baselineRuntimeBinding(runtime),
      sourceContract: { kind: "required-profiles", maxTerminalEvents: 4096 },
    },
  };
}

export async function captureOriginalControllerSource(
  repository,
  cohortName,
  selection,
) {
  repository = await realpath(repository);
  const { sourceScope } = await captureControllerSourceScope(
    repository,
    cohortName,
    selection,
  );
  return captureBaselineSourceExecution({
    root: repository,
    ...sourceScope,
    execute: () => executeOriginalControllerScript(repository, selection),
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const capture = await captureOriginalControllerSource(
    fileURLToPath(new URL("../", import.meta.url)),
    process.argv[2],
    process.argv.slice(3),
  );
  process.stdout.write(JSON.stringify(capture) + "\n");
}

export function executeOriginalControllerScript(
  repository,
  selection,
  invoke = spawnSync,
) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = invoke(
    process.execPath,
    ["scripts/verify-required-native-tests.mjs", ...selection],
    {
      cwd: repository,
      env,
      encoding: "utf8",
      timeout: 660000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  process.stderr.write(child.stderr ?? "");
  if (child.error || child.status !== 0)
    process.stderr.write(child.stdout ?? "");
  assert.equal(child.error, undefined, "Original source process failed");
  assert.equal(child.status, 0, "Original source cohort failed");
  return JSON.parse(child.stdout);
}
