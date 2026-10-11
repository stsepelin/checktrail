import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
import { runRequiredTests } from "./required-test-evidence.mjs";
import { copyInstalledPackages } from "../dist/test/tool-fixture.js";
const repository = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const testFiles = [
  ["consumer-imports.test.js", 8],
  ["git-selection.test.js", 6],
  ["impact.test.js", 3],
];
const inputFiles = [
  ...testFiles.map(([f]) => "dist/test/" + f),
  ...["helpers.js", "git-fixture.js"].map((f) => "dist/test/" + f),
  ...[
    "impact-fixture.mjs",
    "impact-worker.mjs",
    "impact-corpus-v2.json",
    "impact-corpus.json",
    "impact-metrics.mjs",
  ].map((f) => "scripts/" + f),
];
const inputs = await Promise.all(
  inputFiles.map(async (file) => ({
    file,
    bytes: await readFile(path.join(repository, file)),
  })),
);
const requirements = [];
for (const [file, total] of testFiles) {
  const text = inputs
    .find((x) => x.file === "dist/test/" + file)
    .bytes.toString("utf8");
  const names = [...text.matchAll(/\btest\(\s*"([^"\n]+)"/g)].map((m) => m[1]);
  assert.equal(names.length, total, file);
  assert.equal(new Set(names).size, total, file);
  for (const name of names)
    requirements.push({ file: "dist/test/" + file, name });
}
assert.equal(requirements.length, 17);
const harnessSha256 = hash(
  JSON.stringify(inputs.map((x) => [x.file, hash(x.bytes)])),
);
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-consumer-installed-"),
);
try {
  const [packed] = JSON.parse(
    runAcceptanceNpm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const tarball = path.join(temporary, packed.filename),
    tarballSha256 = hash(await readFile(tarball));
  const consumer = path.join(temporary, "consumer"),
    harness = path.join(temporary, "harness");
  const installation = await installAcceptancePackage(
    repository,
    tarball,
    consumer,
  );
  const installed = path.join(consumer, "node_modules/@stsepelin/checktrail");
  await mkdir(path.join(harness, "dist/test"), { recursive: true });
  await symlink(
    path.relative(path.join(harness, "dist"), path.join(installed, "dist/src")),
    path.join(harness, "dist/src"),
  );
  await symlink(
    path.relative(harness, path.join(installed, "docs")),
    path.join(harness, "docs"),
  );
  await cp(
    path.join(repository, "package.json"),
    path.join(harness, "package.json"),
  );
  for (const { file, bytes } of inputs) {
    const target = path.join(harness, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }
  await copyInstalledPackages(
    harness,
    ["@modelcontextprotocol/client"],
    path.join(repository, "node_modules"),
  );
  const profile = await runRequiredTests(
    requirements.map((x) => ({ ...x, file: path.join(harness, x.file) })),
    { timeoutMs: 300000, isolatedCaseWorkers: 1 },
  );
  assert.equal(
    profile.complete,
    true,
    "Fresh installed impact foundation failed: " +
      JSON.stringify(profile.problems),
  );
  assert.equal(profile.required, requirements.length);
  assert.equal(profile.ledger.truncated, false);
  assert.equal(profile.ledger.cases.length, requirements.length);
  assert.ok(profile.ledger.cases.every((c) => c.outcome === "passed"));
  assert.equal(
    hash(
      JSON.stringify(
        await Promise.all(
          inputFiles.map(async (file) => [
            file,
            hash(await readFile(path.join(repository, file))),
          ]),
        ),
      ),
    ),
    harnessSha256,
  );
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      profile: "captured-node-consumer-impact-foundation",
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      nodeExecutableSha256: hash(await readFile(process.execPath)),
      tarballSha256,
      harnessSha256,
      ...installation,
      harnessOutsideInstalledPackage: true,
      nativePerLanguageGateAcceptanceComplete: false,
      profileEvidence: profile,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
