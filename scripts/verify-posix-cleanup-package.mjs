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
import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
assert.ok(
  ["darwin", "linux"].includes(process.platform),
  "POSIX cleanup acceptance requires macOS or Linux",
);
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
const repository = fileURLToPath(new URL("../", import.meta.url));
const sourceEngine = await captureCompiledEngine(
  path.join(repository, "dist/src"),
);
const harnessFiles = [
  "dist/test/process-tree.test.js",
  "dist/test/posix-owner.test.js",
  "dist/test/runner.test.js",
  "dist/test/process-output.test.js",
  "dist/test/helpers.js",
  "scripts/verify-required-native-tests.mjs",
  "scripts/required-test-evidence.mjs",
  "scripts/compiled-engine-evidence.mjs",
  "scripts/required-native-tests.json",
  "scripts/verify-posix-cleanup-package.mjs",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const harnessIdentity = async () =>
  hash(
    JSON.stringify(
      await Promise.all(
        harnessFiles.map(async (file) => [
          file,
          hash(await readFile(path.join(repository, file))),
        ]),
      ),
    ),
  );
const harnessSha256 = await harnessIdentity();
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-posix-package-"),
);
try {
  const [packed] = JSON.parse(
    runAcceptanceNpm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const tarball = path.join(temporary, packed.filename),
    consumer = path.join(temporary, "consumer");
  const tarballSha256 = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  const installation = await installAcceptancePackage(
    repository,
    tarball,
    consumer,
  );
  await mkdir(path.join(consumer, "dist/test"), { recursive: true });
  await symlink(
    path.relative(
      path.join(consumer, "dist"),
      path.join(consumer, "node_modules/@stsepelin/checktrail/dist/src"),
    ),
    path.join(consumer, "dist/src"),
  );
  for (const file of [
    "process-tree.test.js",
    "posix-owner.test.js",
    "runner.test.js",
    "process-output.test.js",
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
      "posix-cleanup": profiles["posix-cleanup"],
      "posix-owner": profiles["posix-owner"],
    }),
  );
  const installedRoot = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail/dist/src",
  );
  const installedBefore = await captureCompiledEngine(installedRoot);
  requireUnchangedCompiledEngine(sourceEngine, installedBefore);
  const selectedImage = process.env.CHECKTRAIL_POSIX_IMAGE;
  const image = selectedImage
    ? execFileSync(
        "docker",
        ["image", "inspect", selectedImage, "--format", "{{.Id}}"],
        { encoding: "utf8" },
      ).trim()
    : null;
  if (image) assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const output = image
    ? execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--init",
          "--network",
          "none",
          "--read-only",
          "--cpus",
          "2",
          "--memory",
          "2g",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=256m",
          ...(process.env.CHECKTRAIL_TEST_TASK
            ? ["--label", "checktrail.task=" + process.env.CHECKTRAIL_TEST_TASK]
            : []),
          "--mount",
          `type=bind,src=${consumer},target=/consumer,readonly`,
          "--workdir",
          "/consumer",
          image,
          "node",
          "scripts/verify-required-native-tests.mjs",
          "posix-cleanup",
          "posix-owner",
        ],
        { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120000 },
      )
    : execFileSync(
        process.execPath,
        [
          "scripts/verify-required-native-tests.mjs",
          "posix-cleanup",
          "posix-owner",
        ],
        {
          cwd: consumer,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: 120000,
        },
      );
  const profile = JSON.parse(output);
  assert.equal(profile.complete, true);
  assert.deepEqual(profile.profiles, [
    { profile: "posix-cleanup", required: profiles["posix-cleanup"].length },
    { profile: "posix-owner", required: profiles["posix-owner"].length },
  ]);
  assert.equal(profile.ledger.truncated, false);
  assert.ok(profile.ledger.cases.every((c) => c.outcome === "passed"));
  requireUnchangedCompiledEngine(
    installedBefore,
    await captureCompiledEngine(installedRoot),
  );
  const compiledEngine = requireUnchangedCompiledEngine(
    sourceEngine,
    await captureCompiledEngine(path.join(repository, "dist/src")),
  );
  assert.equal(await harnessIdentity(), harnessSha256);
  process.stdout.write(
    JSON.stringify({
      tarballSha256,
      harnessSha256,
      compiledEngine,
      ...installation,
      harnessOutsideInstalledPackage: true,
      installedRuntimeEvaluated: true,
      installedCliEvaluated: false,
      installedMcpEvaluated: false,
      profile,
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
      qualityGate: "not-assessed",
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
