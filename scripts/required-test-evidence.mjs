import assert from "node:assert/strict";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { run } from "node:test";

export async function runRequiredTests(requirements) {
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
  const key = ({ file, name }) => JSON.stringify([file, name]);
  assert.equal(new Set(expected.map(key)).size, expected.length);
  const observed = new Map();
  const problems = [];
  let passed = 0;
  for await (const { type, data } of run({
    files: [...new Set(expected.map((item) => item.file))],
    concurrency: 1,
    timeout: 120000,
    execArgv: [],
  })) {
    if (type !== "test:pass" && type !== "test:fail") continue;
    if (type === "test:fail")
      problems.push({ name: data.name, reason: "failed" });
    if (
      (data.skip !== undefined && data.skip !== false) ||
      (data.todo !== undefined && data.todo !== false)
    ) {
      problems.push({ name: data.name, reason: "skipped-or-todo" });
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
  };
}
