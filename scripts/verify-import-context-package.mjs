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
import { installAcceptancePackage } from "./install-acceptance-package.mjs";
const profile =
  process.env.CHECKTRAIL_IMPORT_CONTEXT_PROFILE ?? "import-context";
assert.ok(
  [
    "import-context",
    "import-history",
    "selected-syntax-context",
    "review-context-limits",
    "host-session-readiness",
  ].includes(profile),
);
if (profile === "review-context-limits")
  process.env.CHECKTRAIL_CONTEXT_LIMITS_INSTALLED = "1";
if (profile === "host-session-readiness")
  process.env.CHECKTRAIL_HOST_SESSION_INSTALLED = "1";
const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-import-context-package-"),
);
try {
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const tarball = path.join(temporary, packed.filename),
    consumer = path.join(temporary, "consumer");
  const tarballSha256 = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
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
  for (const file of [
    "import-context.test.js",
    "review-polyglot.test.js",
    "review-context-limits.test.js",
    "review-polyglot-fixture.js",
    "import-history.test.js",
    "git-fixture.js",
    "helpers.js",
    "gate-host-session-readiness.test.js",
    "review-host-process-fixture.js",
    "review-workflow-fixture.js",
  ])
    await cp(
      path.join(repository, "dist/test", file),
      path.join(consumer, "dist/test", file),
    );
  const lock = JSON.parse(
    await readFile(path.join(repository, "package-lock.json"), "utf8"),
  );
  const dependencies = {};
  async function copyClientDependency(name) {
    if (Object.hasOwn(dependencies, name)) return;
    const manifest = JSON.parse(
      await readFile(
        path.join(repository, "node_modules", name, "package.json"),
        "utf8",
      ),
    );
    const entry = lock.packages["node_modules/" + name];
    assert.equal(manifest.version, entry.version);
    const destination = path.join(consumer, "node_modules", name);
    const existing = await readFile(
      path.join(destination, "package.json"),
      "utf8",
    )
      .then(JSON.parse)
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
    if (existing) {
      assert.equal(existing.version, manifest.version);
      return;
    }
    dependencies[name] = manifest.version;
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(repository, "node_modules", name), destination, {
      recursive: true,
    });
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      await copyClientDependency(dependency);
  }
  await copyClientDependency("@modelcontextprotocol/client");
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
      [profile]: profiles[profile],
    }),
  );
  const selectedImage = process.env.CHECKTRAIL_IMPORT_CONTEXT_IMAGE;
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
          "--network",
          "none",
          ...(profile === "review-context-limits"
            ? ["--env", "CHECKTRAIL_CONTEXT_LIMITS_INSTALLED=1"]
            : []),
          ...(profile === "host-session-readiness"
            ? ["--env", "CHECKTRAIL_HOST_SESSION_INSTALLED=1"]
            : []),
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
          profile,
        ],
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
      )
    : execFileSync(
        process.execPath,
        ["scripts/verify-required-native-tests.mjs", profile],
        { cwd: consumer, encoding: "utf8", maxBuffer: 1024 * 1024 },
      );
  const acceptance = JSON.parse(output);
  assert.equal(acceptance.complete, true);
  process.stdout.write(
    JSON.stringify({
      tarballSha256,
      offlineProductionInstall: true,
      lifecycleScriptsExecuted: false,
      installedCliEvaluated: profile !== "host-session-readiness",
      installedRuntimeEvaluated: true,
      harnessOutsideInstalledPackage: true,
      acceptanceClientDependencies: dependencies,
      profile: acceptance,
      environment: image
        ? {
            image,
            network: "none",
            consumerMount: "readonly",
            rootFilesystemReadonly: true,
            temporaryFilesystemMiB: 256,
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
