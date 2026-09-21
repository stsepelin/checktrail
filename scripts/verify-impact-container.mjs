import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const nodeImage =
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const gitImage =
  "composer@sha256:b09bccd91a78fe8a9ab4b33d707b862e8fe54fec17782e32683ad2a69c46867d";
const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-impact-container-"),
);
let container;
try {
  container = execFileSync("docker", ["create", nodeImage], {
    encoding: "utf8",
  }).trim();
  const node = path.join(temporary, "node");
  execFileSync("docker", ["cp", `${container}:/usr/local/bin/node`, node]);
  const report = JSON.parse(
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--mount",
        `type=bind,src=${repository},target=/workspace,readonly`,
        "--mount",
        `type=bind,src=${node},target=/usr/local/bin/node,readonly`,
        "--workdir",
        "/workspace",
        gitImage,
        "node",
        "scripts/measure-impact.mjs",
      ],
      {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"],
      },
    ),
  );
  assert.equal(report.environment.node, "22.23.2");
  assert.equal(report.environment.git, "git version 2.52.0");
  assert.equal(report.environment.platform, "linux");
  report.environment.containerImages = { node: nodeImage, git: gitImage };
  report.environment.network = "none";
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  if (container)
    execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  await rm(temporary, { recursive: true, force: true });
}
