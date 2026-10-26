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
const root = fileURLToPath(new URL("../", import.meta.url)),
  hash = (b) => createHash("sha256").update(b).digest("hex");
assert.ok(process.argv.length === 2 || process.argv.length === 3);
const files = [
  "package.json",
  "package-lock.json",
  "dist/test/tool-fixture.js",
  "docs/gate-a-profiles.v1.json",
  "dist/test/mcp-validation-tasks.test.js",
  "dist/test/tasks-runtime-harness.test.js",
  "dist/test/tasks-wire-fixture.js",
  "dist/test/gate-tasks-matrix.test.js",
  "dist/test/windows-task-access.test.js",
  "dist/test/tasks-sdk-fallback.test.js",
  "dist/test/helpers.js",
  "scripts/required-native-tests.json",
  "scripts/required-test-evidence.mjs",
  "scripts/tasks-runtime-evidence.mjs",
  "scripts/verify-tasks-runtime.mjs",
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
  path.join(tmpdir(), "checktrail-tasks-runtime-installed-"),
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
  const installed = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail/dist/src",
  );
  await mkdir(path.join(harness, "dist/test"), { recursive: true });
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
      assert.equal(typeof version, "string");
      assert.equal(
        version,
        sourceLock.packages["node_modules/" + location].version,
      );
      externalSdkClientDependencies[location] = version;
    },
  );
  // The AST wiring control uses the pinned production TypeScript dependency.
  await copyInstalledPackages(
    harness,
    ["typescript"],
    path.join(consumer, "node_modules"),
  );
  const env = { ...process.env };
  env.CHECKTRAIL_TASKS_MATRIX_INSTALLED = "1";
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const result = spawnSync(
    process.execPath,
    ["scripts/verify-tasks-runtime.mjs", ...process.argv.slice(2)],
    {
      cwd: harness,
      env,
      encoding: "utf8",
      timeout: 1200000,
      maxBuffer: 4 * 1048576,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, (result.stdout + result.stderr).slice(-2800));
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.profileEvidence.complete, true);
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
      profile: "tasks-runtime-foundation-installed-v1",
      tarballSha256,
      harnessSha256,
      ...installation,
      harnessOutsideInstalledPackage: true,
      pinnedExternalSdkClient:
        sourceLock.packages["node_modules/@modelcontextprotocol/client"]
          .version,
      externalSdkClientDependencies,
      evidence,
      gateATasksMatrixComplete: false,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
