import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { installAcceptancePackage } from "./install-acceptance-package.mjs";
import { runRequiredTests } from "./required-test-evidence.mjs";
const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-init-publication-package-"),
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
  const install = await installAcceptancePackage(repository, tarball, consumer);
  const installed = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail/dist/src",
  );
  await mkdir(path.join(consumer, "dist/test"), { recursive: true });
  await symlink(
    path.relative(path.join(consumer, "dist"), installed),
    path.join(consumer, "dist/src"),
    "dir",
  );
  for (const file of ["onboarding.test.js", "helpers.js"])
    await cp(
      path.join(repository, "dist/test", file),
      path.join(consumer, "dist/test", file),
    );
  const profiles = JSON.parse(
    await readFile(
      path.join(repository, "scripts/required-native-tests.json"),
      "utf8",
    ),
  );
  const report = await runRequiredTests(
    profiles["init-publication"].map((entry) => ({
      ...entry,
      file: path.join(consumer, entry.file),
    })),
    {
      timeoutMs: 45000,
    },
  );
  assert.equal(report.complete, true, JSON.stringify(report));
  process.stdout.write(
    JSON.stringify({
      profile: "init-publication",
      tarballSha256: createHash("sha256")
        .update(await readFile(tarball))
        .digest("hex"),
      ...install,
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      ...report,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
