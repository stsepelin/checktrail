import assert from "node:assert/strict";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { run } from "node:test";

const key = ({ file, name }) => JSON.stringify([file, name]);

async function resolveRequirements(requirements) {
  assert.ok(Array.isArray(requirements) && requirements.length > 0);
  const expected = await Promise.all(
    requirements.map(async ({ file, name }) => {
      assert.ok(
        typeof file === "string" && typeof name === "string" && name.length > 0,
      );
      const resolved = await realpath(file).catch((error) => {
        if (error.code === "ENOENT") return path.resolve(file);
        throw error;
      });
      return { file: resolved, name };
    }),
  );
  assert.equal(new Set(expected.map(key)).size, expected.length);
  return expected;
}

export async function runRequiredTests(
  requirements,
  { timeoutMs = 120000, additionalFiles = [] } = {},
) {
  assert.ok(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000,
    "Required test harness timeout must be bounded",
  );
  const expected = await resolveRequirements(requirements);
  assert.ok(Array.isArray(additionalFiles));
  const requiredFiles = new Set(expected.map((item) => item.file));
  const optionalFiles = await Promise.all(
    additionalFiles.map((file) => realpath(file)),
  );
  const files = [...new Set([...requiredFiles, ...optionalFiles])];
  const observed = new Map();
  const problems = [];
  let passed = 0;
  let optionalSkipped = 0;
  for await (const { type, data } of run({
    files,
    // Match node --test for the full suite; standalone profile batches keep
    // their existing sequential file execution. Every file is still isolated.
    concurrency: additionalFiles.length > 0 ? true : 1,
    timeout: timeoutMs,
    execArgv: [],
  })) {
    if (type !== "test:pass" && type !== "test:fail") continue;
    if (type === "test:fail") {
      const error = data.details?.error;
      problems.push({
        name: data.name,
        reason: "failed",
        ...(typeof error?.failureType === "string"
          ? { failureType: error.failureType }
          : {}),
        ...(typeof error?.code === "string" ? { code: error.code } : {}),
        ...(typeof error?.message === "string"
          ? { message: error.message.slice(0, 1000) }
          : {}),
      });
    }
    if (
      (data.skip !== undefined && data.skip !== false) ||
      (data.todo !== undefined && data.todo !== false)
    ) {
      const file = data.file ? path.resolve(data.file) : "";
      // Only explicit skips from additional, non-required files retain the
      // ordinary full suite's optional-tool semantics. Unknown origins fail.
      if (
        data.skip !== undefined &&
        data.skip !== false &&
        (data.todo === undefined || data.todo === false) &&
        optionalFiles.includes(file) &&
        !requiredFiles.has(file)
      ) {
        optionalSkipped++;
      } else {
        problems.push({ name: data.name, reason: "skipped-or-todo" });
      }
      continue;
    }
    if (type !== "test:pass" || data.details?.type === "suite") continue;
    passed++;
    const id = key({
      file: data.file ? path.resolve(data.file) : "",
      name: data.name,
    });
    observed.set(id, (observed.get(id) ?? 0) + 1);
  }
  for (const item of expected) {
    const count = observed.get(key(item)) ?? 0;
    if (count !== 1)
      problems.push({
        name: item.name,
        reason:
          count === 0 ? "required-test-not-passed" : "duplicate-required-test",
      });
  }
  return {
    passed,
    required: expected.length,
    problems,
    complete: problems.length === 0,
    ...(additionalFiles.length > 0
      ? { files: files.length, optionalSkipped }
      : {}),
  };
}

// A batch shares one execution, not saved evidence from an earlier run.
export async function runRequiredProfiles(profiles, selection, options = {}) {
  assert.ok(Array.isArray(selection) && selection.length > 0);
  assert.equal(new Set(selection).size, selection.length, "Duplicate profile");
  const selected = [];
  const requirements = new Map();
  // Resolve every profile before executing any test file. Do not deduplicate
  // malformed requirements within a profile into a seemingly valid manifest.
  for (const profile of selection) {
    assert.ok(
      typeof profile === "string" && Object.hasOwn(profiles, profile),
      "Unknown required native test profile",
    );
    const expected = await resolveRequirements(profiles[profile]);
    selected.push({ profile, required: expected.length });
    for (const item of expected) requirements.set(key(item), item);
  }
  const report = await runRequiredTests([...requirements.values()], options);
  return { profiles: selected, ...report };
}
