import { installAcceptancePackage } from "./install-acceptance-package.mjs";
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
  path.join(tmpdir(), "checktrail-laravel-cache-package-"),
);
try {
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--offline",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        temporary,
      ],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const tarball = path.join(temporary, packed.filename);
  const consumer = path.join(temporary, "consumer");
  await installAcceptancePackage(repository, tarball, consumer);
  const installed = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail/dist/src",
  );
  await mkdir(path.join(consumer, "dist/test"), { recursive: true });
  await symlink(
    path.relative(path.join(consumer, "dist"), installed),
    path.join(consumer, "dist/src"),
  );
  for (const file of ["laravel.test.js", "laravel-cache.test.js", "helpers.js"])
    await cp(
      path.join(repository, "dist/test", file),
      path.join(consumer, "dist/test", file),
    );
  await cp(
    path.join(repository, ".checktrail/laravel-tools"),
    path.join(consumer, ".checktrail/laravel-tools"),
    { recursive: true },
  );
  await cp(
    path.join(repository, "examples/frameworks/laravel"),
    path.join(consumer, "examples/frameworks/laravel"),
    { recursive: true },
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
    JSON.stringify({
      "laravel-cache": [...profiles["laravel-cache"], ...profiles.laravel],
    }),
  );
  const image = process.env.CHECKTRAIL_LARAVEL_CACHE_IMAGE;
  const output = image
    ? execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--read-only",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=512m",
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
          "laravel-cache",
        ],
        { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 240000 },
      )
    : execFileSync(
        process.execPath,
        ["scripts/verify-required-native-tests.mjs", "laravel-cache"],
        {
          cwd: consumer,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: 240000,
        },
      );
  const acceptance = JSON.parse(output);
  assert.equal(acceptance.complete, true);
  process.stdout.write(
    JSON.stringify({
      tarballSha256: createHash("sha256")
        .update(await readFile(tarball))
        .digest("hex"),
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
            rootFilesystemReadonly: true,
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
