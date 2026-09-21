import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

assert.equal(
  process.argv.length,
  3,
  "Usage: node scripts/verify-external-evaluation-container.mjs PREPARED_INPUT_DIRECTORY",
);
const repository = fileURLToPath(new URL("../", import.meta.url));
const inputs = await realpath(process.argv[2]);
const image =
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const args = [
  "run",
  "--rm",
  "--network",
  "none",
  "--mount",
  `type=bind,src=${repository},target=/workspace,readonly`,
  "--mount",
  `type=bind,src=${inputs},target=/inputs,readonly`,
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
  [...args, "node", "scripts/measure-external-evaluation.mjs", "/inputs"],
  {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
    timeout: 600000,
  },
);
const report = JSON.parse(output);
assert.equal(report.platform, "linux");
assert.equal(report.nodeVersion, "v22.23.2");
process.stdout.write(output);
