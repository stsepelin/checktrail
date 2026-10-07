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
const repository = fileURLToPath(new URL("../", import.meta.url));
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
  for (const file of ["process-tree.test.js", "helpers.js"])
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
    JSON.stringify({ "posix-cleanup": profiles["posix-cleanup"] }),
  );
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
        ],
        { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120000 },
      )
    : execFileSync(
        process.execPath,
        ["scripts/verify-required-native-tests.mjs", "posix-cleanup"],
        {
          cwd: consumer,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: 120000,
        },
      );
  const profile = JSON.parse(output);
  assert.equal(profile.complete, true);
  process.stdout.write(
    JSON.stringify({
      tarballSha256,
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
