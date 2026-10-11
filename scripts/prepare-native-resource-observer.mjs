import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
assert.ok(
  ["linux", "darwin"].includes(process.platform),
  "Native resource observer platform unavailable",
);
assert.equal(
  process.argv.length,
  3,
  "Expected a private empty output directory",
);
const directory = path.resolve(process.argv[2]);
assert.equal(
  await realpath(directory),
  directory,
  "Output directory must not follow symlinks",
);
const stat = await lstat(directory);
assert.ok(
  stat.isDirectory() &&
    stat.uid === process.getuid() &&
    (stat.mode & 0o077) === 0,
  "Output directory must be private and caller owned",
);
assert.deepEqual(
  await readdir(directory),
  [],
  "Output directory must be empty before preparation",
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = fileURLToPath(
  new URL("./native-resource-observer.c", import.meta.url),
);
const compiler = await realpath("/usr/bin/cc");
const sourceSha256 = hash(await readFile(source)),
  compilerSha256 = hash(await readFile(compiler));
const version = spawnSync(compiler, ["--version"], {
  encoding: "utf8",
  timeout: 10000,
  maxBuffer: 65536,
});
assert.equal(
  version.status,
  0,
  "Native resource observer compiler unavailable",
);
assert.ok(!version.error && !version.signal && version.stdout.trim());
const compilerVersion = version.stdout.split(/\r?\n/)[0];
const staging = await mkdtemp(path.join(directory, ".observer-staging-"));
try {
  const binary = path.join(staging, "observer");
  const arguments_ = [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    source,
    "-o",
    binary,
  ];
  const built = spawnSync(compiler, arguments_, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 65536,
  });
  assert.equal(built.status, 0, built.stderr);
  assert.ok(
    !built.error && !built.signal,
    "Native resource observer compile did not complete",
  );
  const binaryStat = await lstat(binary);
  assert.ok(
    binaryStat.isFile() &&
      !binaryStat.isSymbolicLink() &&
      binaryStat.nlink === 1 &&
      binaryStat.uid === process.getuid() &&
      binaryStat.size > 0 &&
      binaryStat.size <= 16 * 1024 * 1024,
  );
  assert.equal(
    hash(await readFile(source)),
    sourceSha256,
    "Observer source changed during compilation",
  );
  assert.equal(
    hash(await readFile(compiler)),
    compilerSha256,
    "Observer compiler changed during compilation",
  );
  const receipt = {
    schemaVersion: 1,
    platform: process.platform,
    architecture: process.arch,
    sourceSha256,
    compilerSha256,
    compilerVersion,
    binarySha256: hash(await readFile(binary)),
    binaryPath: "native-resource-observer/observer",
    compilerSdkClosureVerified: false,
    completeNativeArtifactClosure: false,
  };
  await writeFile(
    path.join(staging, "build.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  assert.deepEqual(
    (await readdir(staging)).sort(),
    ["build.json", "observer"],
    "Observer publication contains unexpected artifacts",
  );
  assert.deepEqual(
    (await readdir(directory)).sort(),
    [path.basename(staging)],
    "Output directory changed before publication",
  );
  await rename(staging, path.join(directory, "native-resource-observer"));
  process.stdout.write(JSON.stringify(receipt) + "\n");
} finally {
  await rm(staging, { recursive: true, force: true });
}
