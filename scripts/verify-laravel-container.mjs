import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

function installedImage(name) {
  const digest = execFileSync(
    "docker",
    ["image", "inspect", name, "--format", "{{.Id}}"],
    { encoding: "utf8" },
  ).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest))
    throw new Error("Expected an installed image digest");
  return digest;
}
const image = installedImage("composer:2");
const nodeImage = installedImage("node:22-alpine");
const temporary = await mkdtemp(path.join(tmpdir(), "checktrail-laravel-"));
const repository = fileURLToPath(new URL("../", import.meta.url));
let sourceContainer;
try {
  sourceContainer = execFileSync("docker", ["create", nodeImage], {
    encoding: "utf8",
  }).trim();
  const node = path.join(temporary, "node");
  execFileSync("docker", [
    "cp",
    `${sourceContainer}:/usr/local/bin/node`,
    node,
  ]);
  const args = [
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
    image,
  ];
  const phpVersion = execFileSync("docker", [...args, "php", "--version"], {
    encoding: "utf8",
  }).split("\n")[0];
  const nodeVersion = execFileSync("docker", [...args, "node", "--version"], {
    encoding: "utf8",
  }).trim();
  process.stdout.write(
    `${JSON.stringify({ image, nodeImage, phpVersion, nodeVersion, network: "none", fixtureFilesystem: "container" })}\n`,
  );
  execFileSync(
    "docker",
    [...args, "node", "scripts/verify-required-native-tests.mjs", "laravel"],
    { stdio: "inherit" },
  );
} finally {
  try {
    if (sourceContainer)
      execFileSync("docker", ["rm", "-f", sourceContainer], { stdio: "pipe" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
