import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
test(
  "Linux Python SDK preparation preserves exact pins, rejects unsafe archives and withholds completion on failed native probes",
  { skip: process.platform === "win32" },
  () => {
    const result = spawnSync(
      "python3",
      ["-I", "-B", "scripts/test-python-host-sdk.py"],
      { cwd: repository, encoding: "utf8", timeout: 30000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /Ran [1-9][0-9]* tests/);
    assert.doesNotMatch(result.stderr, /skipped=/);
  },
);
test("Go workspace CI retains Python3.13.5 and prepares its pinned Ubuntu24 SDK before the unchanged setup action on Ubuntu26 ARM", async () => {
  const source = await readFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const job = source
    .split("\n  go-workspaces-arm64:")[1]!
    .split("\n  php-context-arm64:")[0]!;
  assert.match(job, /runs-on: ubuntu-26\.04-arm/);
  assert.match(job, /python-version: "3\.13\.5"/);
  const preparation = job.indexOf("node scripts/prepare-python-host-sdk.mjs");
  const setup = job.indexOf("actions/setup-python@");
  assert.ok(preparation >= 0 && preparation < setup);
  assert.match(
    job,
    /verify-consumer-native-acceptance\.mjs context-python native-linux-arm64-node22/,
  );
  assert.match(
    job,
    /CHECKTRAIL_IMPORT_CONTEXT_PROFILE=context-python node scripts\/verify-import-context-package\.mjs/,
  );
  const pin = JSON.parse(
    await readFile(
      new URL("../../scripts/python-ubuntu26-arm64.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(pin.version, "3.13.5");
  assert.equal(pin.producerOS, "Ubuntu 24.04");
  assert.equal(pin.hostOS, "Ubuntu 26.04");
  assert.equal(pin.publisherUbuntu26SupportClaimed, false);
  assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  const inputs = JSON.parse(
    await readFile(
      new URL("../../scripts/ci-native-inputs.json", import.meta.url),
      "utf8",
    ),
  );
  for (const file of [
    "scripts/test-python-host-sdk.py",
    "scripts/prepare-python-host-sdk.mjs",
    "scripts/install-python-host-sdk.py",
    "scripts/python-ubuntu26-arm64.json",
    "test/python-host-sdk.test.ts",
  ])
    assert.deepEqual(inputs[file], ["go-workspaces-arm64"]);
});
