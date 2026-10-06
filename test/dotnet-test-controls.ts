import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { validate } from "../src/engine.js";
import type { CheckResult } from "../src/types.js";
export const available =
  !!process.env.CHECKTRAIL_DOTNET_BUILD_CACHE &&
  spawnSync("dotnet", ["--list-sdks"], { encoding: "utf8" }).stdout?.includes(
    "10.0.401 [",
  );
export const native = {
  skip: available
    ? false
    : "Pinned native .NET SDK/dependency cache not selected",
  timeout: 240000,
};
export const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
export const explanation = (result: CheckResult) =>
  JSON.stringify({
    status: result.status,
    reason: result.reason,
    stderr: result.processes.map((p) => p.stderr.slice(0, 512)),
  });
export const expect = (result: CheckResult, status: string) =>
  assert.equal(result.status, status, explanation(result));
export async function replace(
  root: string,
  file: string,
  old: string,
  value: string,
) {
  const original = await readFile(path.join(root, file), "utf8");
  assert.equal(
    original.split(old).length,
    2,
    "One exact source anchor: " + file,
  );
  await writeFile(path.join(root, file), original.replace(old, value));
  return original;
}
