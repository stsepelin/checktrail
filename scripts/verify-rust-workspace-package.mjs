import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
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
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-rust-workspace-package-"),
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
  await mkdir(consumer);
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    { cwd: consumer, stdio: "pipe" },
  );
  const installed = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail/dist/src",
  );
  for (const name of ["server", "core"]) {
    const manifest = JSON.parse(
      await readFile(
        path.join(
          consumer,
          `node_modules/@modelcontextprotocol/${name}/package.json`,
        ),
        "utf8",
      ),
    );
    assert.equal(manifest.version, "2.3.0");
  }
  // The acceptance harness is outside the installed package. Its src link points
  // to shipped bytes, so internal imports and the CLI both exercise that install.
  await mkdir(path.join(consumer, "dist/test"), { recursive: true });
  await symlink(
    path.relative(path.join(consumer, "dist"), installed),
    path.join(consumer, "dist/src"),
  );
  for (const file of [
    "rust-workspace.test.js",
    "rust-workspace-fixture.js",
    "rust-workspace-surfaces.test.js",
    "helpers.js",
  ])
    await cp(
      path.join(repository, "dist/test", file),
      path.join(consumer, "dist/test", file),
    );
  await mkdir(path.join(consumer, "scripts"));
  for (const file of [
    "verify-required-native-tests.mjs",
    "required-test-evidence.mjs",
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
    JSON.stringify({ "rust-workspace": profiles["rust-workspace"] }),
  );
  const image = process.env.CHECKTRAIL_RUST_WORKSPACE_IMAGE;
  const output = image
    ? execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--cpus",
          "2",
          "--memory",
          "2g",
          "--mount",
          `type=bind,src=${consumer},target=/consumer,readonly`,
          "--workdir",
          "/consumer",
          image,
          "node",
          "scripts/verify-required-native-tests.mjs",
          "rust-workspace",
        ],
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
      )
    : execFileSync(
        process.execPath,
        ["scripts/verify-required-native-tests.mjs", "rust-workspace"],
        { cwd: consumer, encoding: "utf8", maxBuffer: 1024 * 1024 },
      );
  const acceptance = JSON.parse(output);
  assert.equal(acceptance.complete, true);
  process.stdout.write(
    JSON.stringify({
      tarballSha256,
      offlineProductionInstall: true,
      lifecycleScriptsExecuted: false,
      installedCliEvaluated: true,
      installedRuntimeEvaluated: true,
      harnessOutsideInstalledPackage: true,
      profile: acceptance,
      environment: image
        ? {
            image,
            network: "none",
            consumerMount: "readonly",
            rootFilesystemReadonly: false,
          }
        : {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
          },
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
      windowsVerified: false,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
