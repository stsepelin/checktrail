import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const destination = path.join(repository, ".checktrail/framework-tools");
const exists = await access(destination).then(
  () => true,
  () => false,
);
assert.equal(
  exists,
  false,
  "Preparation requires a new owned public tool directory",
);
await mkdir(destination, { recursive: true });
const image =
  "python@sha256:6d43704baacd1bfbe7c295d7f13079d5d8104ed33568873133f8fc69980419df";
const task =
  process.env.CHECKTRAIL_TEST_TASK ?? `fastapi-prepare-${process.pid}`;
assert.match(task, /^[a-z][a-z0-9-]{0,80}$/);
execFileSync("docker", ["pull", image], { stdio: "inherit", timeout: 120000 });
execFileSync(
  "docker",
  [
    "run",
    "--rm",
    "--init",
    "--cpus",
    "2",
    "--memory",
    "2g",
    "--pids-limit",
    "256",
    "--label",
    "checktrail.task=" + task,
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--mount",
    `type=bind,src=${destination},target=/prepared`,
    "--mount",
    `type=bind,src=${path.join(repository, "scripts/framework-tools.requirements.txt")},target=/requirements.txt,readonly`,
    image,
    "python3",
    "-I",
    "-m",
    "pip",
    "--isolated",
    "install",
    "--disable-pip-version-check",
    "--only-binary=:all:",
    "--no-cache-dir",
    "--no-compile",
    "--target",
    "/prepared",
    "-r",
    "/requirements.txt",
  ],
  { stdio: "inherit", timeout: 180000 },
);
