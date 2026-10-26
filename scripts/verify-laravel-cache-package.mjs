import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import {
  laravelCacheHarnessFiles,
  laravelCacheDigest,
  captureLaravelCacheInputs,
  requireLaravelCacheAccounting,
} from "./laravel-cache-runtime-evidence.mjs";
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
const inputs = await Promise.all(
  laravelCacheHarnessFiles.map(async (file) => ({
    file,
    bytes: await readFile(path.join(repository, file)),
  })),
);
const inputSources = inputs.map((item) => [
  item.file,
  laravelCacheDigest(item.bytes),
]);
const harnessSha256 = laravelCacheDigest(JSON.stringify(inputSources));
const sourceEngine = await captureCompiledEngine(
  path.join(repository, "dist/src"),
);
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-laravel-cache-package-"),
);
try {
  const [packed] = JSON.parse(
    runAcceptanceNpm(
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
  const installation = await installAcceptancePackage(
    repository,
    tarball,
    consumer,
  );
  const installed = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail/dist/src",
  );
  const installedBefore = await captureCompiledEngine(installed);
  requireUnchangedCompiledEngine(sourceEngine, installedBefore);
  const harness = path.join(temporary, "harness");
  await mkdir(path.join(harness, "dist"), { recursive: true });
  await symlink(
    path.relative(path.join(harness, "dist"), installed),
    path.join(harness, "dist/src"),
  );
  for (const { file, bytes } of inputs) {
    const target = path.join(harness, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }
  // Vendor files are prepared from the selected public Composer fixture. The
  // selected files and versions are checked by the native controller as well.
  await cp(
    path.join(repository, ".checktrail/laravel-tools/vendor"),
    path.join(harness, ".checktrail/laravel-tools/vendor"),
    { recursive: true },
  );
  const profiles = JSON.parse(
    await readFile(
      path.join(repository, "scripts/required-native-tests.json"),
      "utf8",
    ),
  );
  const selectedImage = process.env.CHECKTRAIL_LARAVEL_CACHE_IMAGE;
  const image = selectedImage
    ? execFileSync(
        "docker",
        ["image", "inspect", selectedImage, "--format", "{{.Id}}"],
        { encoding: "utf8" },
      ).trim()
    : undefined;
  if (image) assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const output = image
    ? execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--init",
          "--read-only",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=512m",
          "--network",
          "none",
          "--cpus",
          "2",
          "--memory",
          "2g",
          "--pids-limit",
          "256",
          ...(process.env.CHECKTRAIL_TEST_TASK
            ? ["--label", "checktrail.task=" + process.env.CHECKTRAIL_TEST_TASK]
            : []),
          "--mount",
          `type=bind,src=${temporary},target=/acceptance,readonly`,
          "--workdir",
          "/acceptance/harness",
          image,
          "node",
          "scripts/verify-laravel-cache.mjs",
        ],
        { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 330000 },
      )
    : execFileSync(process.execPath, ["scripts/verify-laravel-cache.mjs"], {
        cwd: harness,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 330000,
      });
  const acceptance = JSON.parse(output);
  requireLaravelCacheAccounting(acceptance, profiles);
  assert.equal(
    acceptance.harnessSha256,
    harnessSha256,
    "Installed Laravel cache harness differs",
  );
  requireUnchangedCompiledEngine(installedBefore, acceptance.compiledEngine);
  requireUnchangedCompiledEngine(
    installedBefore,
    await captureCompiledEngine(installed),
  );
  const compiledEngine = requireUnchangedCompiledEngine(
    sourceEngine,
    await captureCompiledEngine(path.join(repository, "dist/src")),
  );
  assert.deepEqual(
    await captureLaravelCacheInputs(repository),
    inputSources,
    "Source Laravel cache harness changed during installed acceptance",
  );
  assert.deepEqual(
    await captureLaravelCacheInputs(harness),
    inputSources,
    "Installed Laravel cache harness changed during acceptance",
  );
  process.stdout.write(
    JSON.stringify({
      tarballSha256: createHash("sha256")
        .update(await readFile(tarball))
        .digest("hex"),
      installation,
      harnessSha256,
      inputSources,
      harnessInputsUnchanged: true,
      compiledEngine,
      sourceInstalledEngineBytesMatch: true,
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
      wholeDependencyClosureVerified: false,
      publisherLicenseClosureVerified: false,
      gateAComplete: false,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
