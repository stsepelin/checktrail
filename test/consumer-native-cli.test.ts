import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const entry = fileURLToPath(
  new URL(
    "../../scripts/verify-consumer-native-acceptance.mjs",
    import.meta.url,
  ),
);
test("native acceptance list is closed data for all nineteen families and eight shared project slots with no external executable lookup", () => {
  const result = spawnSync(process.execPath, [entry, "--list"], {
    env: { ...process.env, PATH: "" },
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 1048576,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const list = JSON.parse(result.stdout);
  assert.equal(list.executionInvoked, false);
  assert.equal(list.gateAComplete, false);
  assert.equal(list.scopes.length, 26);
  assert.equal(
    new Set(
      list.scopes.flatMap((scope: { families: string[] }) => scope.families),
    ).size,
    19,
  );
  assert.equal(
    list.scopes.filter(
      (scope: { acceptanceProfile: string }) =>
        scope.acceptanceProfile === "consumer-impact",
    ).length,
    8,
  );
  assert.equal(
    list.scopes.filter(
      (scope: { selectedClang: boolean }) => scope.selectedClang,
    ).length,
    1,
  );
});
test("native acceptance refuses unknown profiles invalid slots and extra arguments without publishing raw diagnostic bytes", () => {
  for (const args of [
    ["context-go", "unknown"],
    ["unknown", "native-linux-arm64-node22"],
    ["context-go", "native-linux-arm64-node22", "extra"],
  ]) {
    const result = spawnSync(process.execPath, [entry, ...args], {
      env: { ...process.env, PATH: "" },
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1048576,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Native consumer acceptance refused\n");
  }
});
