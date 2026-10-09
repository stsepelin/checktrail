import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { mavenHash } from "../dist/src/maven.js";
import { cppSupportedVersion, cppToolNames } from "../dist/src/cpp-native.js";
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const base =
  "public.ecr.aws/docker/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const task = process.env.CHECKTRAIL_TEST_TASK || `cpp-tools-${process.pid}`;
assert.equal(
  process.arch,
  "arm64",
  "This native acceptance profile requires ARM64",
);
assert.match(task, /^[a-z][a-z0-9-]{0,80}$/);
const tag = `checktrail-${task}:public`,
  destination = path.join(root, ".checktrail/cpp-tools-runtime");
await mkdir(path.dirname(destination), { recursive: true });
assert.equal(
  await realpath(path.dirname(destination)),
  path.dirname(destination),
);
await assert.rejects(lstat(destination), { code: "ENOENT" });
const manifest = JSON.parse(
  await readFile(path.join(root, "scripts/cpp-tools-archives.json"), "utf8"),
);
assert.equal(
  new Set(manifest.archives.map((p) => p.path)).size,
  manifest.archives.length,
);
const docker = (args) =>
  execFileSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
try {
  docker(["image", "inspect", tag]);
  assert.fail("Runtime tag already exists");
} catch (error) {
  assert.ok(
    error.status && /No such image/.test(error.stderr?.toString() || ""),
    "Runtime tag must be absent",
  );
}
const temporary = await mkdtemp(
  path.join(path.dirname(destination), "cpp-tools-preparation-"),
);
let built = false,
  completed = false;
try {
  await mkdir(path.join(temporary, "artifacts"));
  const local = process.env.CHECKTRAIL_CPP_APK_DIRECTORY
    ? await realpath(path.resolve(process.env.CHECKTRAIL_CPP_APK_DIRECTORY))
    : undefined;
  const observed = [];
  for (let offset = 0; offset < manifest.archives.length; offset += 4) {
    const rows = await Promise.all(
      manifest.archives.slice(offset, offset + 4).map(async (pin) => {
        assert.match(pin.path, /^[A-Za-z0-9_+.-]+\.apk$/);
        assert.match(pin.sha256, /^[a-f0-9]{64}$/);
        assert.ok(
          Number.isSafeInteger(pin.bytes) &&
            pin.bytes > 0 &&
            pin.bytes <= 64 * 1024 * 1024,
        );
        let bytes, asset;
        if (local) {
          const file = path.join(local, pin.path),
            stat = await lstat(file);
          assert.ok(
            stat.isFile() &&
              !stat.isSymbolicLink() &&
              stat.size === pin.bytes &&
              (await realpath(file)) === file,
          );
          bytes = await readFile(file);
          asset = "operator-prepared-archive";
        } else {
          for (const repository of manifest.repositories) {
            const url = repository + pin.path,
              response = await globalThis.fetch(url, {
                signal: globalThis.AbortSignal.timeout(120000),
              });
            if (response.status === 404) continue;
            assert.equal(response.status, 200);
            assert.ok(response.body);
            let count = 0;
            const chunks = [];
            for await (const chunk of response.body) {
              count += chunk.length;
              assert.ok(count <= pin.bytes);
              chunks.push(Buffer.from(chunk));
            }
            bytes = Buffer.concat(chunks);
            asset = url;
            break;
          }
        }
        assert.ok(bytes, "Pinned archive unavailable");
        assert.equal(bytes.length, pin.bytes);
        assert.equal(mavenHash(bytes), pin.sha256);
        await writeFile(path.join(temporary, "artifacts", pin.path), bytes, {
          flag: "wx",
        });
        return { ...pin, asset };
      }),
    );
    observed.push(...rows);
  }
  if (process.env.CHECKTRAIL_CPP_BASE_PREPARED !== "1") docker(["pull", base]);
  const [baseImage] = JSON.parse(docker(["image", "inspect", base]));
  assert.equal(baseImage.Architecture, "arm64");
  docker([
    "build",
    "--network",
    "none",
    "--label",
    `checktrail.task=${task}`,
    "--file",
    "scripts/cpp-tools.Dockerfile",
    "--tag",
    tag,
    temporary,
  ]);
  built = true;
  const [image] = JSON.parse(docker(["image", "inspect", tag]));
  assert.equal(image.Config.Labels["checktrail.task"], task);
  assert.equal(image.Architecture, "arm64");
  const versions = [];
  for (const name of ["node", ...cppToolNames]) {
    const args =
      name === "clang" || name === "clang++"
        ? ["--no-default-config", "--version"]
        : ["--version"];
    const output = docker([
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
      name,
      ...args,
    ]);
    assert.ok(
      name === "node"
        ? output === "v22.23.2\n"
        : cppSupportedVersion(name, output),
    );
    versions.push({ name, output });
  }
  const identity = {
    task,
    tag,
    image: image.Id,
    base,
    archives: observed,
    nativeVersions: versions,
    buildNetwork: "none",
    packageSignaturesDisabled: false,
    publisherAndLicenseClosureVerified: false,
  };
  await writeFile(
    path.join(temporary, "identity.json"),
    JSON.stringify(identity, null, 2) + "\n",
    { flag: "wx" },
  );
  await rename(temporary, destination);
  completed = true;
  process.stdout.write(JSON.stringify(identity) + "\n");
} finally {
  if (!completed) {
    if (built) docker(["image", "rm", tag]);
    await rm(temporary, { recursive: true, force: true });
  }
}
