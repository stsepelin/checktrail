import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  readFile,
  mkdir,
  mkdtemp,
  lstat,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url)),
  task = process.env.CHECKTRAIL_TEST_TASK ?? `yaml-context-${process.pid}`,
  tag = `checktrail-${task}:public`,
  destination = path.join(root, ".checktrail/yaml-context-runtime");
assert.equal(process.arch, "arm64");
assert.match(task, /^[a-z][a-z0-9-]{0,80}$/);
assert.equal(
  spawnSync("docker", ["image", "inspect", tag]).status,
  1,
  "Owned image tag already exists",
);
await assert.rejects(lstat(destination), (error) => error.code === "ENOENT");
await mkdir(path.dirname(destination), { recursive: true });
const temporary = await mkdtemp(
  path.join(path.dirname(destination), "yaml-preparation-"),
);
let image,
  built = false,
  complete = false;
try {
  execFileSync(
    "docker",
    [
      "build",
      "--network",
      "none",
      "--label",
      `checktrail.task=${task}`,
      "--file",
      "scripts/yaml-context-tools.Dockerfile",
      "--tag",
      tag,
      "scripts",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 4 * 1048576 },
  );
  built = true;
  const [actual] = JSON.parse(
    execFileSync("docker", ["image", "inspect", tag], { encoding: "utf8" }),
  );
  image = actual.Id;
  assert.equal(actual.Architecture, "arm64");
  assert.equal(actual.Config.Labels["checktrail.task"], task);
  const dockerfile = await readFile(
    path.join(root, "scripts/yaml-context-tools.Dockerfile"),
  );
  const identity = {
    task,
    tag,
    image,
    nodeBase:
      "public.ecr.aws/docker/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
    gitBase:
      "public.ecr.aws/docker/library/golang@sha256:ae5a2316d12f3e78fd99177dad452e6ad4f240af2d71d57b480c3477f250fec6",
    dockerfile: {
      bytes: dockerfile.length,
      sha256: createHash("sha256").update(dockerfile).digest("hex"),
    },
    buildNetwork: "none",
    publisherAndLicenseClosureVerified: false,
  };
  await writeFile(
    path.join(temporary, "identity.json"),
    JSON.stringify(identity, null, 2) + "\n",
    { flag: "wx" },
  );
  await rename(temporary, destination);
  complete = true;
  process.stdout.write(JSON.stringify(identity) + "\n");
} finally {
  if (!complete) {
    if (built) {
      const [owned] = JSON.parse(
        execFileSync("docker", ["image", "inspect", tag], { encoding: "utf8" }),
      );
      assert.equal(owned.Config.Labels["checktrail.task"], task);
      if (image) assert.equal(owned.Id, image);
      execFileSync("docker", ["image", "rm", tag], { stdio: "pipe" });
    }
    await rm(temporary, { recursive: true, force: true });
  }
}
