import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
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
import { mavenHash, verifyMavenTree } from "../dist/src/maven.js";
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const ruby =
    "ruby@sha256:79bf10b28c9d98b7b3cffda01aba8190aa1c1c48513d205ec93372a0e2f010e3",
  node =
    "node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const task = process.env.CHECKTRAIL_TEST_TASK || `ruby-tools-${process.pid}`;
assert.match(task, /^[a-z][a-z0-9-]{0,80}$/);
const tag = `checktrail-${task}:public`,
  destination = path.join(root, ".checktrail/ruby-tools-runtime");
await mkdir(path.dirname(destination), { recursive: true });
assert.equal(
  await realpath(path.dirname(destination)),
  path.dirname(destination),
);
await assert.rejects(lstat(destination), { code: "ENOENT" });
const temporary = await mkdtemp(
    path.join(path.dirname(destination), "ruby-tools-runtime-preparation-"),
  ),
  artifacts = path.join(temporary, "artifacts");
const packages = [
  "binutils-2.45.1-r1.apk",
  "g++-15.2.0-r5.apk",
  "gcc-15.2.0-r5.apk",
  "gmp-6.3.0-r4.apk",
  "isl26-0.26-r2.apk",
  "jansson-2.15.0-r0.apk",
  "libatomic-15.2.0-r5.apk",
  "libgcc-15.2.0-r5.apk",
  "libgcc-static-15.2.0-r5.apk",
  "libgomp-15.2.0-r5.apk",
  "libstdc++-15.2.0-r5.apk",
  "libstdc++-dev-15.2.0-r5.apk",
  "make-4.4.1-r4.apk",
  "mpc1-1.3.1-r1.apk",
  "mpfr4-4.2.2-r0.apk",
  "musl-1.2.6-r2.apk",
  "musl-dev-1.2.6-r2.apk",
  "zlib-1.3.2-r0.apk",
  "zstd-libs-1.5.7-r2.apk",
];
let built = false,
  completed = false;
const docker = (args, options = {}) =>
  execFileSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    ...options,
  });
try {
  try {
    docker(["image", "inspect", tag]);
    assert.fail(
      "The runtime image tag already exists; preparation cannot overwrite it",
    );
  } catch (error) {
    assert.ok(
      error.status && /No such image/.test(error.stderr?.toString() || ""),
      "The runtime image tag must be absent",
    );
  }
  await mkdir(artifacts);
  docker(["pull", ruby]);
  docker(["pull", node]);
  docker([
    "run",
    "--rm",
    "--init",
    "--cpus",
    "2",
    "--memory",
    "2g",
    "--network",
    "bridge",
    "--label",
    `checktrail.task=${task}`,
    "--mount",
    `type=bind,src=${artifacts},target=/artifacts`,
    ruby,
    "sh",
    "-ec",
    "apk update; apk fetch --recursive --output /artifacts gcc=15.2.0-r5 g++=15.2.0-r5 make=4.4.1-r4 musl-dev=1.2.6-r2",
  ]);
  assert.deepEqual(
    (await readdir(artifacts)).sort(),
    [...packages].sort(),
    "The pinned compiler closure changed",
  );
  const files = [];
  for (const file of packages) {
    const target = path.join(artifacts, file),
      stat = await lstat(target);
    assert.ok(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size > 0 &&
        stat.size <= 64 * 1024 * 1024,
    );
    const bytes = await readFile(target);
    files.push({ path: file, bytes: bytes.length, sha256: mavenHash(bytes) });
  }
  await verifyMavenTree(artifacts, files);
  const raw = docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--label",
    `checktrail.task=${task}`,
    ruby,
    "sh",
    "-ec",
    "ruby --disable-gems --version; apk --print-arch; cat /etc/alpine-release",
  ]);
  const [rubyVersion, architecture, alpine] = raw.trim().split("\n");
  assert.match(rubyVersion, /^ruby 4\.0\.7 /);
  assert.ok(["aarch64", "x86_64"].includes(architecture));
  assert.equal(alpine, "3.24.2");
  docker([
    "build",
    "--network",
    "none",
    "--build-context",
    `toolchain=${artifacts}`,
    "--file",
    "scripts/ruby-tools.Dockerfile",
    "--tag",
    tag,
    "--label",
    `checktrail.task=${task}`,
    "scripts",
  ]);
  built = true;
  await verifyMavenTree(artifacts, files);
  const [image] = JSON.parse(docker(["image", "inspect", tag]));
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(image.Config.Labels["checktrail.task"], task);
  const actual = docker([
    "run",
    "--rm",
    "--init",
    "--network",
    "none",
    "--cpus",
    "2",
    "--memory",
    "2g",
    "--label",
    `checktrail.task=${task}`,
    image.Id,
    "sh",
    "-ec",
    "node --version; ruby --disable-gems --version; gcc -dumpfullversion; make --version",
  ]);
  const lines = actual.trim().split("\n");
  assert.equal(lines[0], "v22.23.2");
  assert.match(lines[1], /^ruby 4\.0\.7 /);
  assert.equal(lines[2], "15.2.0");
  assert.equal(lines[3], "GNU Make 4.4.1");
  const identity = {
    schemaVersion: 1,
    image: image.Id,
    tag,
    task,
    ruby,
    node,
    rubyVersion,
    architecture,
    alpine,
    nodeVersion: lines[0],
    gccVersion: lines[2],
    makeVersion: lines[3],
    files,
    apkSignatureChecksDisabled: false,
    buildNetwork: "none",
    publisherAndLicenseClosureVerified: false,
  };
  await writeFile(
    path.join(temporary, "identity.json"),
    JSON.stringify(identity, null, 2) + "\n",
    { flag: "wx" },
  );
  await rename(temporary, destination);
  completed = true;
  process.stdout.write(
    JSON.stringify({
      image: image.Id,
      tag,
      architecture,
      compilerArchives: files.length,
      buildNetwork: "none",
      apkSignatureChecksDisabled: false,
      publisherAndLicenseClosureVerified: false,
    }) + "\n",
  );
} finally {
  if (!completed) {
    await rm(temporary, { recursive: true, force: true });
    if (built) {
      const [owned] = JSON.parse(docker(["image", "inspect", tag]));
      assert.equal(owned.Config.Labels["checktrail.task"], task);
      docker(["image", "rm", tag]);
    }
  }
}
