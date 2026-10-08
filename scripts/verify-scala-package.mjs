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
  path.join(tmpdir(), "checktrail-scala-package-"),
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
    "scala.test.js",
    "scala-fixture.js",
    "scala-surfaces.test.js",
    "scala-boundaries.test.js",
    "scala-dependencies.test.js",
    "helpers.js",
  ])
    await cp(
      path.join(repository, "dist/test", file),
      path.join(consumer, "dist/test", file),
    );
  // The official client is acceptance-harness material, not a production dependency.
  // Its core dependency resolves to the freshly installed production SDK core.
  const clientManifest = JSON.parse(
    await readFile(
      path.join(
        repository,
        "node_modules/@modelcontextprotocol/client/package.json",
      ),
      "utf8",
    ),
  );
  assert.equal(clientManifest.version, "2.3.0");
  const lock = JSON.parse(
    await readFile(path.join(repository, "package-lock.json"), "utf8"),
  );
  const acceptanceClientDependencies = {};
  const copyAcceptanceDependency = async (name) => {
    if (
      name === "@modelcontextprotocol/core" ||
      name === "zod" ||
      Object.hasOwn(acceptanceClientDependencies, name)
    )
      return;
    const source = path.join(repository, "node_modules", name);
    const manifest = JSON.parse(
      await readFile(path.join(source, "package.json"), "utf8"),
    );
    assert.equal(
      manifest.version,
      lock.packages["node_modules/" + name].version,
    );
    // This prepared lock profile is hoisted. Nested dependencies need a separate harness profile.
    const nested = await import("node:fs/promises");
    await assert.rejects(nested.lstat(path.join(source, "node_modules")), {
      code: "ENOENT",
    });
    acceptanceClientDependencies[name] = manifest.version;
    const destination = path.join(consumer, "dist/node_modules", name);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      await copyAcceptanceDependency(dependency);
  };
  await copyAcceptanceDependency("@modelcontextprotocol/client");
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
      scala: profiles.scala,
    }),
  );
  const image = process.env.CHECKTRAIL_SCALA_IMAGE;
  const output = image
    ? execFileSync(
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
          "--workdir",
          "/consumer",
          image,
          "node",
          "scripts/verify-required-native-tests.mjs",
          "scala",
        ],
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
      )
    : execFileSync(
        process.execPath,
        ["scripts/verify-required-native-tests.mjs", "scala"],
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
      acceptanceClientVersion: clientManifest.version,
      acceptanceClientDependencies,
      acceptanceClientCopiedOutsideInstalledPackage: true,
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
