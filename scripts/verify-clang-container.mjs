import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

const image = execFileSync(
  "docker",
  [
    "image",
    "inspect",
    "repo-verifier-clang-test:22.1.3",
    "--format",
    "{{.Id}}",
  ],
  { encoding: "utf8" },
).trim();
if (!/^sha256:[a-f0-9]{64}$/.test(image))
  throw new Error("Prepare the pinned Clang fixture image first");
const repository = fileURLToPath(new URL("../", import.meta.url));
const args = [
  "run",
  "--rm",
  "--network",
  "none",
  "--mount",
  `type=bind,src=${repository},target=/workspace,readonly`,
  "--workdir",
  "/workspace",
  image,
];
const clang = execFileSync(
  "docker",
  [...args, "clang", "--no-default-config", "--version"],
  { encoding: "utf8" },
).trim();
if (!clang.startsWith("Alpine clang version 22.1.3\n"))
  throw new Error(
    "Unexpected native fixture compiler; native tests must not be skipped",
  );
const cpp = execFileSync(
  "docker",
  [...args, "clang++", "--no-default-config", "--version"],
  { encoding: "utf8" },
).trim();
if (cpp !== clang) throw new Error("C and C++ fixture compilers must match");
const node = execFileSync("docker", [...args, "node", "--version"], {
  encoding: "utf8",
}).trim();
process.stdout.write(
  `${JSON.stringify({ image, clang, node, network: "none", fixtureFilesystem: "container" })}\n`,
);
execFileSync(
  "docker",
  [...args, "node", "scripts/verify-required-native-tests.mjs", "clang"],
  {
    stdio: "inherit",
  },
);
