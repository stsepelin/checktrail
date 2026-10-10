import { pullPinnedImage } from "./pull-pinned-image.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
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
import { Buffer } from "node:buffer";
import { mavenHash } from "../dist/src/maven.js";
const root = await realpath(fileURLToPath(new URL("../", import.meta.url))),
  swift =
    "public.ecr.aws/docker/library/swift@sha256:6dd90eb2359663a2cde8f03e9951f488b23134b3b8fce20e9dcb6cada75dd803",
  node =
    "public.ecr.aws/docker/library/node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9",
  asset =
    "https://github.com/realm/SwiftLint/releases/download/0.65.1/swiftlint_linux_arm64.zip",
  archiveSha256 =
    "9ffa52f478e6d8eb485d37d14715ffac90abc81c58f3370d598bf75be05605f8",
  task = process.env.CHECKTRAIL_TEST_TASK || `swift-tools-${process.pid}`;
assert.equal(
  process.arch,
  "arm64",
  "This native acceptance profile requires ARM64",
);
assert.match(task, /^[a-z][a-z0-9-]{0,80}$/);
const tag = `checktrail-${task}:public`,
  destination = path.join(root, ".checktrail/swift-extensions-runtime");
await mkdir(path.dirname(destination), { recursive: true });
assert.equal(
  await realpath(path.dirname(destination)),
  path.dirname(destination),
);
await assert.rejects(lstat(destination), { code: "ENOENT" });
const temporary = await mkdtemp(
  path.join(path.dirname(destination), "swift-tools-preparation-"),
);
let built = false,
  completed = false;
const docker = (args, options = {}) =>
  execFileSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
try {
  try {
    docker(["image", "inspect", tag]);
    assert.fail("Runtime tag already exists");
  } catch (error) {
    assert.ok(
      error.status && /No such image/.test(error.stderr?.toString() || ""),
      "Runtime tag must be absent",
    );
  }
  const archive = path.join(temporary, "swiftlint.zip"),
    artifacts = path.join(temporary, "artifacts");
  let bytes;
  if (process.env.CHECKTRAIL_SWIFTLINT_ARCHIVE) {
    const file = path.resolve(process.env.CHECKTRAIL_SWIFTLINT_ARCHIVE),
      stat = await lstat(file);
    assert.ok(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size === 64444529 &&
        (await realpath(file)) === file,
    );
    bytes = await readFile(file);
  } else {
    const response = await globalThis.fetch(asset, {
      signal: globalThis.AbortSignal.timeout(120000),
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      assert.ok(total <= 64444529);
      chunks.push(Buffer.from(chunk));
    }
    bytes = Buffer.concat(chunks);
  }
  assert.equal(bytes.length, 64444529);
  assert.equal(mavenHash(bytes), archiveSha256);
  await writeFile(archive, bytes, { flag: "wx" });
  await mkdir(artifacts);
  const list = execFileSync("unzip", ["-Z1", archive], {
    encoding: "utf8",
    maxBuffer: 65536,
  })
    .trimEnd()
    .split("\n");
  assert.deepEqual(
    list.sort(),
    ["LICENSE", "LICENSE.mimalloc", "swiftlint", "swiftlint-static"].sort(),
  );
  execFileSync("unzip", ["-q", archive, "-d", artifacts], { stdio: "pipe" });
  assert.deepEqual((await readdir(artifacts)).sort(), list);
  const files = [];
  for (const file of list) {
    const target = path.join(artifacts, file),
      stat = await lstat(target);
    assert.ok(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size > 0 &&
        stat.size < 128 * 1024 * 1024,
    );
    const content = await readFile(target);
    files.push({
      path: file,
      bytes: content.length,
      sha256: mavenHash(content),
    });
  }
  assert.equal(
    files.find((f) => f.path === "swiftlint").sha256,
    "4c02101342ad8e82ac57e702cbc50ff626268bd08f66735e0ce5cec0c0a29a57",
  );
  assert.equal(
    files.find((f) => f.path === "swiftlint-static").sha256,
    "ecd5fceee78248088c596242c1f585944ba9ca9de2b92d246fd6e43a54b1fea4",
  );
  await pullPinnedImage(swift);
  await pullPinnedImage(node);
  docker(
    [
      "build",
      "--network",
      "none",
      "--label",
      `checktrail.task=${task}`,
      "--file",
      "scripts/swift-extensions-tools.Dockerfile",
      "--tag",
      tag,
      temporary,
    ],
    { stdio: "pipe" },
  );
  built = true;
  const [image] = JSON.parse(docker(["image", "inspect", tag]));
  assert.equal(image.Config.Labels["checktrail.task"], task);
  assert.equal(image.Architecture, "arm64");
  const versions = docker([
    "run",
    "--rm",
    "--init",
    "--network",
    "none",
    "--label",
    `checktrail.task=${task}`,
    image.Id,
    "sh",
    "-ec",
    "node --version; swiftc --version; swift package --version; swiftlint version; swiftlint-static version",
  ]);
  assert.equal(
    versions,
    "v22.23.2\nSwift version 6.2.3 (swift-6.2.3-RELEASE)\nTarget: aarch64-unknown-linux-gnu\nSwift Package Manager - Swift 6.2.3\n0.65.1\n0.65.1\n",
  );
  const sdk = JSON.parse(
    docker([
      "run",
      "--rm",
      "--init",
      "--network",
      "none",
      "--read-only",
      "--user",
      "1000:1000",
      "--cpus",
      "2",
      "--memory",
      "512m",
      "--pids-limit",
      "128",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m",
      "--label",
      `checktrail.task=${task}`,
      "--mount",
      `type=bind,src=${root},target=/workspace,readonly`,
      image.Id,
      "node",
      "/workspace/scripts/collect-swift-extensions-sdk.mjs",
    ]),
  );
  assert.ok(
    sdk.pins.length > 0 &&
      sdk.pins.length <= 4096 &&
      sdk.bytes <= 512 * 1024 * 1024,
  );
  assert.equal(sdk.wholeRuntimeClosureVerified, false);
  const sdkText = JSON.stringify(sdk, null, 2) + "\n";
  await writeFile(path.join(temporary, "sdk.json"), sdkText, { flag: "wx" });
  await rm(archive);
  const identity = {
    task,
    tag,
    image: image.Id,
    swift,
    node,
    asset,
    archiveSha256,
    artifacts: files,
    nativeVersions: versions,
    nativeSdk: {
      file: "sdk.json",
      sha256: mavenHash(sdkText),
      files: sdk.pins.length,
      bytes: sdk.bytes,
      wholeRuntimeClosureVerified: false,
    },
    npmVersion: docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--label",
      `checktrail.task=${task}`,
      image.Id,
      "npm",
      "--version",
    ]).trim(),
    buildNetwork: "none",
    publisherAndLicenseClosureVerified: false,
  };
  assert.equal(identity.npmVersion, "10.9.8");
  await writeFile(
    path.join(temporary, "identity.json"),
    JSON.stringify(identity, null, 2) + "\n",
    { flag: "wx" },
  );
  // This directory contains public tool artifacts and the synthetic SDK manifest.
  // mkdtemp starts at 0700; the read-only UID 1000 acceptance mount needs traversal.
  await chmod(path.join(temporary, "sdk.json"), 0o644);
  await chmod(temporary, 0o755);
  await rename(temporary, destination);
  completed = true;
  process.stdout.write(JSON.stringify(identity) + "\n");
} finally {
  if (!completed) {
    if (built) docker(["image", "rm", tag]);
    await rm(temporary, { recursive: true, force: true });
  }
}
