import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const image = execFileSync(
  "docker",
  ["image", "inspect", "repo-verifier-java-test:25.0.4", "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
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
const java = execFileSync("docker", [...args, "java", "--version"], {
  encoding: "utf8",
}).trim();
assert.match(
  java,
  /^openjdk 25\.0\.4 2026-07-21 LTS\nOpenJDK Runtime Environment Temurin-25\.0\.4\+7 /,
);
assert.equal(
  execFileSync("docker", [...args, "javac", "--version"], {
    encoding: "utf8",
  }).trim(),
  "javac 25.0.4",
);
execFileSync(
  "docker",
  [...args, "node", "scripts/verify-required-native-tests.mjs", "java"],
  {
    stdio: "inherit",
  },
);

const temporary = await mkdtemp(
  path.join(tmpdir(), "repo-verifier-java-package-"),
);
let client;
try {
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const consumer = path.join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      path.join(temporary, packed.filename),
    ],
    { cwd: consumer, stdio: "pipe" },
  );
  const installed = [
    "run",
    "--rm",
    "--interactive",
    "--network",
    "none",
    "--mount",
    `type=bind,src=${consumer},target=/consumer,readonly`,
    "--mount",
    `type=bind,src=${repository},target=/workspace,readonly`,
    "--workdir",
    "/consumer",
    image,
  ];
  const library = JSON.parse(
    execFileSync(
      "docker",
      [
        ...installed,
        "node",
        "--input-type=module",
        "-e",
        'import {validate} from "@stsepelin/repo-verifier"; console.log(JSON.stringify(await validate("/workspace/examples/java", {trusted: true})));',
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(library.outcome, "passed", JSON.stringify(library.checks));
  assert.equal(library.checks[0].id, "jvm.javac");
  const binary =
    "/consumer/node_modules/@stsepelin/repo-verifier/dist/src/cli.js";
  const cli = JSON.parse(
    execFileSync(
      "docker",
      [
        ...installed,
        "node",
        binary,
        "run",
        "--root",
        "/workspace/examples/java",
        "--trust-project",
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(cli.outcome, "passed");
  client = new Client(
    { name: "synthetic-java-client", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StdioClientTransport({
      command: "docker",
      args: [
        ...installed,
        "node",
        binary,
        "serve",
        "--root",
        "/workspace/examples/java",
        "--allow-execution",
      ],
      stderr: "pipe",
    }),
  );
  const mcp = await client.callTool({ name: "validation_run", arguments: {} });
  assert.equal(mcp.isError, undefined);
  assert.equal(mcp.structuredContent.outcome, "passed");
  assert.deepEqual(mcp.structuredContent.checks, cli.checks);
  assert.ok(!JSON.stringify(mcp).includes("/workspace"));
  process.stdout.write(
    `${JSON.stringify({ image, java, network: "none", native: "passed", installation: "offline", library: "passed", cli: "passed", mcp: "passed" })}\n`,
  );
} finally {
  await client?.close();
  await rm(temporary, { recursive: true, force: true });
}
