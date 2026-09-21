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
  [
    "image",
    "inspect",
    "checktrail-actionlint-test:1.7.12",
    "--format",
    "{{.Id}}",
  ],
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
const version = execFileSync("docker", [...args, "actionlint", "-version"], {
  encoding: "utf8",
}).trim();
assert.match(version, /^1\.7\.12\n/);
execFileSync(
  "docker",
  [...args, "node", "scripts/verify-required-native-tests.mjs", "actionlint"],
  {
    stdio: "inherit",
  },
);

const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-actionlint-package-"),
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
        'import {validate} from "@stsepelin/checktrail"; console.log(JSON.stringify(await validate("/workspace/examples/actionlint", {trusted: true})));',
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(library.outcome, "passed", JSON.stringify(library.checks));
  assert.equal(library.checks[0].id, "infrastructure.actionlint");
  const binary = "/consumer/node_modules/@stsepelin/checktrail/dist/src/cli.js";
  const cli = JSON.parse(
    execFileSync(
      "docker",
      [
        ...installed,
        "node",
        binary,
        "run",
        "--root",
        "/workspace/examples/actionlint",
        "--trust-project",
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(cli.outcome, "passed");
  client = new Client(
    { name: "synthetic-actionlint-client", version: "1.0.0" },
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
        "/workspace/examples/actionlint",
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
    `${JSON.stringify({ image, version, network: "none", native: "passed", installation: "offline", library: "passed", cli: "passed", mcp: "passed" })}\n`,
  );
} finally {
  await client?.close();
  await rm(temporary, { recursive: true, force: true });
}
