import process from "node:process";
import { URL } from "node:url";
// Explicit operator preparation for the original public fixture; never called by planning or execution.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyMavenTree } from "../dist/src/maven.js";
const repository = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(repository, ".checktrail"),
  destination = path.join(cache, "maven-dependencies");
await assert.rejects(lstat(destination), { code: "ENOENT" });
assert.equal(await (await import("node:fs/promises")).realpath(cache), cache);
assert.ok(
  typeof process.getuid === "function" && typeof process.getgid === "function",
  "Dependency preparation requires a POSIX host user identity",
);
const containerUser = `${process.getuid()}:${process.getgid()}`;
const temporary = await mkdtemp(path.join(cache, ".maven-dependencies-"));
try {
  const workspace = path.join(temporary, "workspace"),
    artifacts = path.join(temporary, "artifacts");
  await mkdir(artifacts);
  await cp(path.join(repository, "examples/maven"), workspace, {
    recursive: true,
  });
  const image =
    process.env.CHECKTRAIL_MAVEN_IMAGE ?? "checktrail-maven-test:3.10.0";
  const output = execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--init",
      "--user",
      containerUser,
      "--cpus",
      "2",
      "--memory",
      "2g",
      "--mount",
      `type=bind,src=${workspace},target=/workspace`,
      "--mount",
      `type=bind,src=${artifacts},target=/artifacts`,
      "--workdir",
      "/workspace",
      "--env",
      "HOME=/workspace/.preparation-home",
      "--env",
      "MAVEN_OPTS=-Duser.home=/workspace/.preparation-home",
      ...(process.env.CHECKTRAIL_TEST_TASK
        ? ["--label", "checktrail.task=" + process.env.CHECKTRAIL_TEST_TASK]
        : []),
      image,
      "mvn",
      "--batch-mode",
      "--no-transfer-progress",
      "--strict-checksums",
      "-Dmaven.repo.local=/artifacts",
      "test",
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120000 },
  );
  await rm(path.join(artifacts, ".locks"), { recursive: true, force: true });
  const files = [];
  let total = 0;
  const walk = async (prefix) => {
    for (const item of await readdir(path.join(artifacts, prefix), {
      withFileTypes: true,
    })) {
      const relative = path.posix.join(prefix, item.name),
        file = path.join(artifacts, relative);
      assert.equal(item.isSymbolicLink(), false);
      if (item.isDirectory()) {
        await walk(relative);
        continue;
      }
      assert.equal(item.isFile(), true);
      if (item.name.endsWith(".lastUpdated")) {
        await rm(file);
        continue;
      }
      const bytes = await readFile(file);
      total += bytes.length;
      assert.ok(
        bytes.length > 0 &&
          bytes.length <= 32 * 1024 * 1024 &&
          total <= 256 * 1024 * 1024 &&
          files.length < 4096,
      );
      files.push({
        path: relative,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  await walk("");
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  await verifyMavenTree(artifacts, files);
  const data = JSON.stringify({ schemaVersion: 1, files }, null, 2) + "\n";
  // Publish the verified artifact tree and its manifest together.
  await writeFile(path.join(temporary, "repository.json"), data, {
    flag: "wx",
    mode: 0o600,
  });
  await rm(workspace, { recursive: true });
  await rename(temporary, destination);
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      repositorySha256: createHash("sha256").update(data).digest("hex"),
      files: files.length,
      bytes: total,
      preparationNetworkAllowed: true,
      originalFixtureExecuted: true,
      consoleSha256: createHash("sha256").update(output).digest("hex"),
      publisherSignaturesVerified: false,
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
