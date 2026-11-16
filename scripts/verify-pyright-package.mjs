import { copyInstalledPackages } from "../dist/test/tool-fixture.js";
import {
  installAcceptancePackage,
  assertLockedAcceptanceClient,
} from "./install-acceptance-package.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
assert.equal(process.argv.length, 2);
const prepared = path.resolve(
  process.env.CHECKTRAIL_PYRIGHT_PACKAGE ??
    path.join(repository, ".checktrail/pyright-tools/node_modules/pyright"),
);
const compilerManifest = JSON.parse(
  await readFile(path.join(prepared, "package.json"), "utf8"),
);
assert.equal(compilerManifest.name, "pyright");
assert.equal(compilerManifest.version, "1.1.414");
await access(path.join(prepared, "index.js"));
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-pyright-package-"),
);
try {
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const tarball = path.join(temporary, packed.filename);
  const tarballSha256 = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  const consumer = path.join(temporary, "consumer");
  await installAcceptancePackage(repository, tarball, consumer);
  const installed = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail/dist/src",
  );
  // The acceptance harness is outside the installed package. Its src link points
  // to shipped bytes, so internal imports and the CLI both exercise that install.
  await mkdir(path.join(consumer, "dist/test"), { recursive: true });
  await symlink(
    path.relative(path.join(consumer, "dist"), installed),
    path.join(consumer, "dist/src"),
  );
  for (const file of [
    "pyright.test.js",
    "pyright-evidence.test.js",
    "helpers.js",
  ])
    await cp(
      path.join(repository, "dist/test", file),
      path.join(consumer, "dist/test", file),
    );
  // The official client is acceptance-harness material, not a production dependency.
  // Its matching core remains in its harness namespace, separate from production.
  const clientManifest = JSON.parse(
    await readFile(
      path.join(
        repository,
        "node_modules/@modelcontextprotocol/client/package.json",
      ),
      "utf8",
    ),
  );
  await assertLockedAcceptanceClient(repository, clientManifest.version);
  const lock = JSON.parse(
    await readFile(path.join(repository, "package-lock.json"), "utf8"),
  );
  const acceptanceClientDependencies = {};
  await copyInstalledPackages(
    path.join(consumer, "dist"),
    ["@modelcontextprotocol/client"],
    path.join(repository, "node_modules"),
    ({ relative, version }) => {
      const location = relative.split(path.sep).join("/");
      assert.equal(typeof version, "string");
      assert.equal(version, lock.packages["node_modules/" + location].version);
      acceptanceClientDependencies[location] = version;
    },
  );
  await mkdir(path.join(consumer, "scripts"));
  for (const file of [
    "verify-required-native-tests.mjs",
    "required-test-evidence.mjs",
    "compiled-engine-evidence.mjs",
  ])
    await cp(
      path.join(repository, "scripts", file),
      path.join(consumer, "scripts", file),
    );
  const profiles = JSON.parse(
    await readFile(
      path.join(repository, "scripts/required-native-tests.json"),
      "utf8",
    ),
  );
  await writeFile(
    path.join(consumer, "scripts/required-native-tests.json"),
    JSON.stringify({
      pyright: profiles.pyright,
    }),
  );
  const image = execFileSync(
    "docker",
    [
      "image",
      "inspect",
      process.env.CHECKTRAIL_PYRIGHT_IMAGE ??
        "checktrail-pyright-tools:required-v1",
      "--format",
      "{{.Id}}",
    ],
    { encoding: "utf8" },
  ).trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const output = execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--init",
      "--network",
      "none",
      "--cpus",
      "2",
      "--memory",
      "2g",
      "--mount",
      `type=bind,src=${consumer},target=/consumer,readonly`,
      "--mount",
      `type=bind,src=${prepared},target=/tools/pyright,readonly`,
      "--workdir",
      "/consumer",
      "--env",
      "CHECKTRAIL_PYRIGHT_PACKAGE=/tools/pyright",
      image,
      "node",
      "scripts/verify-required-native-tests.mjs",
      "pyright",
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  const acceptance = JSON.parse(output);
  assert.equal(acceptance.required, 7);
  assert.equal(acceptance.passed, 7);
  assert.deepEqual(acceptance.problems, []);
  assert.equal(acceptance.complete, true);
  process.stdout.write(
    JSON.stringify({
      tarballSha256,
      offlineProductionInstall: true,
      lifecycleScriptsExecuted: false,
      installedCliEvaluated: true,
      installedRuntimeEvaluated: true,
      harnessOutsideInstalledPackage: true,
      acceptanceClientVersion: clientManifest.version,
      acceptanceClientDependencies,
      acceptanceClientCopiedOutsideInstalledPackage: true,
      profile: acceptance,
      environment: {
        image,
        network: "none",
        consumerMount: "readonly",
        compilerMount: "readonly",
        rootFilesystemReadonly: false,
      },
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
      windowsVerified: false,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
