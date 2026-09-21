import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const image = execFileSync(
  "docker",
  ["image", "inspect", "checktrail-external-test:1", "--format", "{{.Id}}"],
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
function nativeSuite(arguments_, requiredNames) {
  const output = execFileSync(
    "docker",
    [
      ...arguments_,
      "node",
      "--test",
      "--test-reporter=tap",
      "dist/test/external-adapter.test.js",
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  for (const name of requiredNames) {
    const line = output
      .split("\n")
      .find(
        (line) =>
          /^ok [0-9]+ - /.test(line) &&
          line.slice(line.indexOf(" - ") + 3) === name,
      );
    assert.ok(line, `Required native test did not run: ${name}`);
  }
  process.stdout.write(output);
}
const nodeVersion = execFileSync("docker", [...args, "node", "--version"], {
  encoding: "utf8",
}).trim();
const pythonVersion = execFileSync(
  "docker",
  [...args, "python3", "--version"],
  { encoding: "utf8" },
).trim();
const goVersion = execFileSync("docker", [...args, "go", "version"], {
  encoding: "utf8",
}).trim();
assert.equal(nodeVersion, "v22.23.2");
assert.equal(pythonVersion, "Python 3.12.13");
assert.match(goVersion, /^go version go1\.26\.5 linux\/(?:arm64|amd64)$/);
nativeSuite(args, [
  "external Python adapters use the same protocol without importing project startup modules",
  "compiled native adapters report real broken and fixed source through the same protocol",
  "external MCP adapters are startup-only and summary reports omit bundle paths and delegated tool metadata",
]);
const bundle = "/workspace/examples/external-adapter/bundle/adapter.json";
const reference = {
  path: bundle,
  sha256: createHash("sha256")
    .update(
      await readFile(
        path.join(repository, "examples/external-adapter/bundle/adapter.json"),
      ),
    )
    .digest("hex"),
};
const option = `${bundle}#sha256=${reference.sha256}`;

const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-external-package-"),
);
let client;
let nodeContainer;
try {
  const nodeImage =
    "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
  const phpImage =
    "composer@sha256:b09bccd91a78fe8a9ab4b33d707b862e8fe54fec17782e32683ad2a69c46867d";
  nodeContainer = execFileSync("docker", ["create", nodeImage], {
    encoding: "utf8",
  }).trim();
  const node = path.join(temporary, "node");
  execFileSync("docker", ["cp", `${nodeContainer}:/usr/local/bin/node`, node]);
  const phpArgs = [
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
    phpImage,
  ];
  const phpVersion = execFileSync(
    "docker",
    [...phpArgs, "php", "-n", "--version"],
    { encoding: "utf8" },
  ).split("\n")[0];
  assert.match(phpVersion, /^PHP 8\.5\.6 /);
  nativeSuite(phpArgs, [
    "external PHP adapters report real source findings through the same protocol",
    "external cancellation kills a running adapter child and cleans its verified temporary bundle",
  ]);
  process.stdout.write(
    execFileSync(
      "docker",
      [...phpArgs, "node", "--test", "dist/test/fetch-pack.test.js"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    ),
  );
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
        `import {validate} from "@stsepelin/checktrail"; console.log(JSON.stringify(await validate("/workspace/examples/external-adapter/project", {trusted: true, externalAdapters: [${JSON.stringify(reference)}]})));`,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(library.outcome, "passed", JSON.stringify(library.checks));
  assert.equal(library.checks[0].id, "external.example-lines.whitespace");
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
        "/workspace/examples/external-adapter/project",
        "--trust-project",
        "--adapter",
        option,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(cli.outcome, "passed");
  process.stdout.write(
    execFileSync(
      "docker",
      [
        ...installed.slice(0, -1),
        "--mount",
        `type=bind,src=${node},target=/usr/local/bin/node,readonly`,
        "--env",
        "CHECKTRAIL_TEST_PACKAGE=/consumer/node_modules/@stsepelin/checktrail",
        phpImage,
        "node",
        "--test",
        "/workspace/dist/test/fetch-pack.test.js",
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    ),
  );
  client = new Client(
    { name: "synthetic-external-client", version: "1.0.0" },
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
        "/workspace/examples/external-adapter/project",
        "--allow-execution",
        "--adapter",
        option,
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
    `${JSON.stringify({ image, phpImage, nodeVersion, pythonVersion, goVersion, phpVersion, network: "none", native: "passed", installation: "offline", library: "passed", cli: "passed", mcp: "passed", packDistribution: "local HTTPS, source and installed package passed" })}\n`,
  );
} finally {
  await client?.close();
  if (nodeContainer)
    execFileSync("docker", ["rm", "-f", nodeContainer], { stdio: "ignore" });
  await rm(temporary, { recursive: true, force: true });
}
