import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const prepared =
  process.env.CHECKTRAIL_PYRIGHT_PACKAGE ??
  path.join(repository, ".checktrail/pyright-tools/package");
const image = execFileSync(
  "docker",
  [
    "image",
    "inspect",
    process.env.CHECKTRAIL_PYRIGHT_IMAGE ??
      "checktrail-pyright-tools:required-v1",
    "--format",
    "{{.Id}}",
  ],
  { encoding: "utf8" },
).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const args = [
  "run",
  "--rm",
  "--network",
  "none",
  "--mount",
  `type=bind,src=${repository},target=/workspace,readonly`,
  "--mount",
  `type=bind,src=${prepared},target=/tools/pyright,readonly`,
  "--workdir",
  "/workspace",
  "--env",
  "CHECKTRAIL_PYRIGHT_PACKAGE=/tools/pyright",
  image,
];
const node = execFileSync("docker", [...args, "node", "--version"], {
  encoding: "utf8",
}).trim();
const python = execFileSync("docker", [...args, "python3", "--version"], {
  encoding: "utf8",
}).trim();
assert.equal(node, "v22.23.2");
process.stdout.write(
  JSON.stringify({
    image,
    node,
    python,
    network: "none",
    mount: "read-only",
    profile: "original-synthetic-pyright",
  }) + "\n",
);
process.stdout.write(
  execFileSync(
    "docker",
    [...args, "node", "scripts/verify-required-native-tests.mjs", "pyright"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  ),
);
