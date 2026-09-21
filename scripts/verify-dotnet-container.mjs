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
    "checktrail-dotnet-test:10.0.401",
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
const sdk = execFileSync("docker", [...args, "dotnet", "--list-sdks"], {
  encoding: "utf8",
}).trim();
assert.equal(sdk, "10.0.401 [/usr/share/dotnet/sdk]");
const compiler = execFileSync(
  "docker",
  [
    ...args,
    "dotnet",
    "exec",
    "/usr/share/dotnet/sdk/10.0.401/Roslyn/bincore/csc.dll",
    "-version",
  ],
  { encoding: "utf8" },
).trim();
assert.equal(
  compiler,
  "5.9.0-1.26423.113 (e34a38d2ae1fc26406a317517196e55c68ff83ab)",
);
execFileSync(
  "docker",
  [...args, "node", "scripts/verify-required-native-tests.mjs", "dotnet"],
  {
    stdio: "inherit",
  },
);

const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-dotnet-package-"),
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
        'import {validate} from "@stsepelin/checktrail"; console.log(JSON.stringify(await validate("/workspace/examples/dotnet", {trusted: true})));',
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(library.outcome, "passed", JSON.stringify(library.checks));
  assert.equal(library.checks[0].id, "dotnet.csharp");
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
        "/workspace/examples/dotnet",
        "--trust-project",
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(cli.outcome, "passed");
  client = new Client(
    { name: "synthetic-dotnet-client", version: "1.0.0" },
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
        "/workspace/examples/dotnet",
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
    `${JSON.stringify({ image, sdk, compiler, network: "none", native: "passed", installation: "offline", library: "passed", cli: "passed", mcp: "passed" })}\n`,
  );
} finally {
  await client?.close();
  await rm(temporary, { recursive: true, force: true });
}
