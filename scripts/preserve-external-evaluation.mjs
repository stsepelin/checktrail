import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { copyInstalledPackages } from "../dist/test/tool-fixture.js";

assert.equal(
  process.argv.length,
  3,
  "Pass an existing output parent directory",
);
const repository = fileURLToPath(new URL("../", import.meta.url));
const parent = await realpath(process.argv[2]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function files(directory, relative = "") {
  const result = [];
  const entries = await readdir(path.join(directory, relative), {
    withFileTypes: true,
  });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...(await files(directory, file)));
    else {
      assert.ok(entry.isFile(), "Only regular files may be preserved");
      result.push({
        file: file.split(path.sep).join("/"),
        sha256: hash(await readFile(path.join(directory, file))),
      });
    }
  }
  return result;
}
async function runtimeDigest(directory) {
  const digest = createHash("sha256");
  for (const item of await files(directory))
    digest.update(item.file).update("\0").update(item.sha256).update("\0");
  return digest.digest("hex");
}
const plan = JSON.parse(
  await readFile(
    path.join(repository, "scripts/external-evaluation-plan.json"),
    "utf8",
  ),
);
assert.equal(
  await runtimeDigest(path.join(repository, "dist/src")),
  plan.frozenVerifier.runtimeArtifactsSha256,
  "Build is not the declared frozen verifier",
);
assert.equal(
  hash(await readFile(path.join(repository, "package-lock.json"))),
  plan.frozenVerifier.packageLockSha256,
);
const metadata = JSON.parse(
  await readFile(path.join(repository, "package.json"), "utf8"),
);
const directory = await mkdtemp(
  path.join(parent, "external-evaluation-frozen-"),
);
try {
  const preserved = [
    "src",
    "dist/src",
    "dist/test/tool-fixture.js",
    "test/tool-fixture.ts",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "LICENSE",
    ...[
      "external-evaluation-plan.json",
      "external-evaluation-inputs.json",
      "external-evaluation-extract.mjs",
      "external-evaluation-evidence.mjs",
      "external-evaluation-worker.mjs",
      "measure-external-evaluation.mjs",
      "prepare-external-evaluation.mjs",
      "verify-external-evaluation-container.mjs",
    ].map((file) => `scripts/${file}`),
  ];
  for (const file of preserved) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await cp(path.join(repository, file), path.join(directory, file), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  assert.equal(
    await runtimeDigest(path.join(directory, "dist/src")),
    plan.frozenVerifier.runtimeArtifactsSha256,
  );
  const manifest = {
    schemaVersion: 1,
    purpose:
      "Original frozen external-evaluation runtime and measurement harness; no upstream case source or installed dependencies in the archive",
    frozenVerifier: plan.frozenVerifier,
    files: await files(directory),
  };
  await writeFile(
    path.join(directory, "preservation.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const archive = path.join(directory, "frozen-evaluation.tar.gz");
  execFileSync("tar", ["-czf", archive, ...preserved, "preservation.json"], {
    cwd: directory,
    stdio: "pipe",
    timeout: 30000,
  });
  await copyInstalledPackages(directory, [
    ...Object.keys(metadata.dependencies),
    "eslint",
    "espree",
  ]);
  assert.equal(
    await runtimeDigest(path.join(repository, "dist/src")),
    plan.frozenVerifier.runtimeArtifactsSha256,
  );
  process.stdout.write(
    JSON.stringify(
      {
        directory,
        archive,
        archiveSha256: hash(await readFile(archive)),
        manifestSha256: hash(
          await readFile(path.join(directory, "preservation.json")),
        ),
        frozenVerifier: plan.frozenVerifier,
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  await rm(directory, { recursive: true, force: true });
  throw error;
}
