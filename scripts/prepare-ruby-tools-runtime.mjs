import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
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
    "public.ecr.aws/docker/library/ruby@sha256:79bf10b28c9d98b7b3cffda01aba8190aa1c1c48513d205ec93372a0e2f010e3",
  node =
    "public.ecr.aws/docker/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
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
  const manifest = JSON.parse(
    await readFile(path.join(root, "scripts/ruby-tools-archives.json"), "utf8"),
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.alpine, alpine);
  const selected = manifest.architectures[architecture];
  assert.equal(
    selected.repository,
    `https://dl-cdn.alpinelinux.org/alpine/v3.24/main/${architecture}/`,
  );
  assert.equal(selected.archives.length, packages.length);
  assert.deepEqual(
    selected.archives.map((pin) => pin.path).sort(),
    [...packages].sort(),
    "The pinned compiler closure changed",
  );
  const local = process.env.CHECKTRAIL_RUBY_APK_DIRECTORY
    ? await realpath(path.resolve(process.env.CHECKTRAIL_RUBY_APK_DIRECTORY))
    : undefined;
  const files = [];
  for (let offset = 0; offset < selected.archives.length; offset += 4) {
    const rows = await Promise.allSettled(
      selected.archives.slice(offset, offset + 4).map(async (pin) => {
        assert.match(pin.path, /^[A-Za-z0-9_+.-]+\.apk$/);
        assert.match(pin.sha256, /^[a-f0-9]{64}$/);
        assert.ok(
          Number.isSafeInteger(pin.bytes) &&
            pin.bytes > 0 &&
            pin.bytes <= 64 * 1024 * 1024,
        );
        let bytes;
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
        } else {
          // Retrieve every original signed APK by exact URL. Resolving current indexes
          // would replace transitive revisions even when compiler roots are pinned.
          const response = await globalThis.fetch(
            selected.repository + pin.path,
            {
              redirect: "error",
              signal: globalThis.AbortSignal.timeout(60000),
            },
          );
          assert.equal(response.status, 200);
          assert.ok(response.body);
          let count = 0;
          const chunks = [];
          for await (const chunk of response.body) {
            count += chunk.length;
            assert.ok(
              count <= pin.bytes,
              "Pinned compiler archive exceeded its byte bound",
            );
            chunks.push(Buffer.from(chunk));
          }
          bytes = Buffer.concat(chunks);
        }
        assert.equal(bytes.length, pin.bytes);
        assert.equal(mavenHash(bytes), pin.sha256);
        await writeFile(path.join(artifacts, pin.path), bytes, {
          flag: "wx",
          mode: 0o600,
        });
        return { path: pin.path, bytes: pin.bytes, sha256: pin.sha256 };
      }),
    );
    // Settle every download before cleaning the owned staging tree on failure.
    for (const row of rows) {
      if (row.status === "rejected") throw row.reason;
      files.push(row.value);
    }
  }
  assert.deepEqual(
    (await readdir(artifacts)).sort(),
    [...packages].sort(),
    "The pinned compiler closure changed",
  );
  await verifyMavenTree(artifacts, files);
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
    compilerArchiveManifestSha256: mavenHash(
      await readFile(path.join(root, "scripts/ruby-tools-archives.json")),
    ),
    transitiveIndexResolution: false,
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
