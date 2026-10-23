import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
import { copyInstalledPackages } from "../dist/test/tool-fixture.js";
assert.equal(process.argv.length, 3, "Expected selected runtime slot");
const slot = process.argv[2],
  root = fileURLToPath(new URL("../", import.meta.url));
const hash = (b) => createHash("sha256").update(b).digest("hex");
const scope = JSON.parse(
  await readFile(path.join(root, "docs/gate-a-profiles.v1.json"), "utf8"),
);
const selected = scope.runtimeProfiles.find((p) => p.id === slot);
assert.ok(selected, "Unknown selected runtime slot");
assert.equal(process.platform, selected.platform);
assert.equal(process.arch, selected.architecture);
assert.equal(process.versions.node, selected.node);
const files = [
  "package.json",
  "package-lock.json",
  "docs/gate-a-profiles.v1.json",
  "dist/test/gate-multi-candidate-workflow.test.js",
  "dist/test/review-workflow-findings-fixture.js",
  "dist/test/review-workflow-fixture.js",
  "dist/test/helpers.js",
  "dist/test/tool-fixture.js",
  "scripts/review-runtime-evidence.mjs",
  "scripts/verify-review-runtime.mjs",
  "scripts/verify-review-runtime-package.mjs",
  "scripts/verify-import-context-package.mjs",
  "scripts/install-acceptance-package.mjs",
  "scripts/prepare-javascript-tools.mjs",
  "scripts/native-acceptance-diagnostics.mjs",
  "scripts/required-native-tests.json",
  "scripts/required-test-evidence.mjs",
  "scripts/compiled-engine-evidence.mjs",
];
const inputs = await Promise.all(
  files.map(async (file) => ({
    file,
    bytes: await readFile(path.join(root, file)),
  })),
);
const harnessSha256 = hash(
  JSON.stringify(inputs.map((x) => [x.file, hash(x.bytes)])),
);
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-review-runtime-installed-"),
);
try {
  const [packed] = JSON.parse(
    runAcceptanceNpm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: root, encoding: "utf8" },
    ),
  );
  const tarball = path.join(temporary, packed.filename),
    tarballSha256 = hash(await readFile(tarball));
  const consumer = path.join(temporary, "consumer"),
    harness = path.join(temporary, "harness");
  const installation = await installAcceptancePackage(root, tarball, consumer);
  await mkdir(path.join(harness, "dist/test"), { recursive: true });
  const installed = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail/dist/src",
  );
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
  const sourceLock = JSON.parse(
    await readFile(path.join(root, "package-lock.json"), "utf8"),
  );
  const externalSdkClientDependencies = {};
  await copyInstalledPackages(
    harness,
    ["@modelcontextprotocol/client"],
    path.join(root, "node_modules"),
    ({ relative, version }) => {
      const location = relative.split(path.sep).join("/");
      assert.equal(
        version,
        sourceLock.packages["node_modules/" + location].version,
      );
      externalSdkClientDependencies[location] = version;
    },
  );
  const env = { ...process.env, CHECKTRAIL_MULTI_WORKFLOW_INSTALLED: "1" };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const result = spawnSync(
    process.execPath,
    ["scripts/verify-review-runtime.mjs", slot],
    {
      cwd: harness,
      env,
      encoding: "utf8",
      timeout: process.platform === "win32" ? 550000 : 170000,
      maxBuffer: 4 * 1048576,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, (result.stdout + result.stderr).slice(-4000));
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.required, 9);
  assert.equal(evidence.passed, 9);
  assert.equal(evidence.runtime.slot, slot);
  assert.equal(evidence.installedEvidence, null);
  assert.deepEqual(
    await Promise.all(
      files.map(async (file) => [
        file,
        hash(await readFile(path.join(root, file))),
      ]),
    ),
    inputs.map((x) => [x.file, hash(x.bytes)]),
  );
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      tarballSha256,
      harnessSha256,
      ...installation,
      harnessOutsideInstalledPackage: true,
      externalSdkClientDependencies,
      profile: evidence,
    }) + "\n",
  );
} finally {
  await rm(temporary, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 30 : 0,
    retryDelay: 100,
  });
}
