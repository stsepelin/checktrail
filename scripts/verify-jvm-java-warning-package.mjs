import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { installAcceptancePackage } from "./install-acceptance-package.mjs";
import { runRequiredTests } from "./required-test-evidence.mjs";
const language = process.argv[2];
assert.ok(["kotlin", "scala"].includes(language));
assert.equal(process.argv.length, 3);
const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-java-warnings-package-"),
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
  for (const file of [
    `${language}-java-warning-policy.test.js`,
    `${language}-fixture.js`,
    "helpers.js",
  ])
    await cp(
      path.join(repository, "dist/test", file),
      path.join(consumer, "dist/test", file),
    );
  const acceptance = await runRequiredTests(
    [
      {
        file: path.join(
          consumer,
          "dist/test",
          `${language}-java-warning-policy.test.js`,
        ),
        name: `mixed ${language === "kotlin" ? "Kotlin" : "Scala"} retains source warnings when Java Werror fails compilation`,
      },
    ],
    { timeoutMs: 120000 },
  );
  assert.equal(acceptance.required, 1);
  assert.equal(acceptance.passed, 1);
  assert.equal(acceptance.complete, true);
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      language,
      tarballSha256: createHash("sha256")
        .update(await readFile(tarball))
        .digest("hex"),
      offlineProductionInstall: true,
      lifecycleScriptsExecuted: false,
      installedRuntimeEvaluated: true,
      installedCliEvaluated: false,
      harnessOutsideInstalledPackage: true,
      acceptance,
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
