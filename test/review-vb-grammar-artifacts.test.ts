import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
test("supplemental VB parser artifacts retain exact source, notice and package bindings", () => {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["scripts/audit-context-vb-grammar.mjs"],
    { cwd: repository, encoding: "utf8", timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.artifactBindingsComplete, true);
  assert.equal(report.sourceNoticeVerified, true);
  assert.equal(report.buildToolNoticeClosureVerified, false);
  assert.equal(report.semanticContextComplete, false);
  assert.equal(report.gateAComplete, false);
});
