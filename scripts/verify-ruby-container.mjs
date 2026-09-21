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
const image = installedImage(
  "ruby@sha256:79bf10b28c9d98b7b3cffda01aba8190aa1c1c48513d205ec93372a0e2f010e3",
);
const nodeImage = installedImage(
  "node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
);
const temporary = await mkdtemp(path.join(tmpdir(), "checktrail-ruby-"));
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
  const libraries = ["libstdc++.so.6", "libgcc_s.so.1"];
  for (const library of libraries)
    execFileSync("docker", [
      "cp",
      "-L",
      `${sourceContainer}:/usr/lib/${library}`,
      path.join(temporary, library),
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
    ...libraries.flatMap((library) => [
      "--mount",
      `type=bind,src=${path.join(temporary, library)},target=/usr/lib/${library},readonly`,
    ]),
    "--workdir",
    "/workspace",
    image,
  ];
  const rubyVersion = execFileSync(
    "docker",
    [...args, "ruby", "--disable-gems", "--version"],
    {
      encoding: "utf8",
    },
  ).split("\n")[0];
  const nodeVersion = execFileSync("docker", [...args, "node", "--version"], {
    encoding: "utf8",
  }).trim();
  process.stdout.write(
    `${JSON.stringify({ image, nodeImage, rubyVersion, nodeVersion, network: "none", fixtureFilesystem: "container" })}\n`,
  );
  execFileSync(
    "docker",
    [...args, "node", "scripts/verify-required-native-tests.mjs", "ruby"],
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
