import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const prepared = JSON.parse(
  await readFile(
    path.join(root, ".checktrail/ruby-tools-runtime/identity.json"),
    "utf8",
  ),
);
assert.match(prepared.image, /^sha256:[a-f0-9]{64}$/);
assert.match(prepared.task, /^[a-z][a-z0-9-]{0,80}$/);
const [image] = JSON.parse(
  execFileSync("docker", ["image", "inspect", prepared.image], {
    encoding: "utf8",
  }),
);
assert.equal(image.Config.Labels["checktrail.task"], prepared.task);
execFileSync(
  "docker",
  [
    "run",
    "--rm",
    "--init",
    "--network",
    "bridge",
    "--cpus",
    "2",
    "--memory",
    "3g",
    "--label",
    `checktrail.task=${prepared.task}`,
    "--mount",
    `type=bind,src=${root},target=/workspace`,
    "--workdir",
    "/workspace",
    prepared.image,
    "node",
    "scripts/prepare-ruby-tools-dependencies.mjs",
  ],
  { stdio: "inherit" },
);
