import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

assert.equal(
  process.argv.length,
  4,
  "Usage: node scripts/verify-external-ruff-container.mjs PREPARED_INPUT_DIRECTORY PREPARED_LINUX_RUFF",
);
const repository = fileURLToPath(new URL("../", import.meta.url));
const inputs = await realpath(process.argv[2]);
const executable = await realpath(process.argv[3]);
const image =
  "sha256:50acdf79e4b3fcfafb4151579ac00b097382f64190481a1d69399efea05c9fed";
const args = [
  "run",
  "--rm",
  "--network",
  "none",
  "--mount",
  `type=bind,src=${repository},target=/workspace,readonly`,
  "--mount",
  `type=bind,src=${inputs},target=/inputs,readonly`,
  "--mount",
  `type=bind,src=${executable},target=/tools/ruff,readonly`,
  "--workdir",
  "/workspace",
  image,
];
assert.equal(
  execFileSync("docker", [...args, "node", "--version"], {
    encoding: "utf8",
    timeout: 10000,
  }).trim(),
  "v22.23.2",
);
const output = execFileSync(
  "docker",
  [
    ...args,
    "node",
    "scripts/measure-external-ruff.mjs",
    "/inputs",
    "/tools/ruff",
  ],
  {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
    timeout: 600000,
  },
);
const report = JSON.parse(output);
assert.equal(report.platform, "linux");
assert.equal(report.nodeVersion, "22.23.2");
process.stdout.write(output);
