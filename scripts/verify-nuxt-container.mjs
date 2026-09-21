import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const image =
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const repository = fileURLToPath(new URL("../", import.meta.url));
const prepared = path.join(
  repository,
  ".repo-verifier",
  process.platform === "darwin" ? "nuxt-linux-tools" : "nuxt-tools",
);
await access(path.join(prepared, "node_modules/nuxt/package.json"));
const native = [
  "run",
  "--rm",
  "--network",
  "none",
  "--mount",
  `type=bind,src=${repository},target=/workspace,readonly`,
  "--mount",
  `type=bind,src=${prepared},target=/workspace/.repo-verifier/nuxt-tools,readonly`,
  "--workdir",
  "/workspace",
  image,
];
assert.equal(
  execFileSync("docker", [...native, "node", "--version"], {
    encoding: "utf8",
  }).trim(),
  "v22.23.2",
);
const output = execFileSync(
  "docker",
  [...native, "node", "scripts/verify-required-native-tests.mjs", "nuxt"],
  { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
);
process.stdout.write(output);
const temporary = await mkdtemp(
  path.join(tmpdir(), "repo-verifier-nuxt-package-"),
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
  const project = path.join(consumer, "example");
  await cp(path.join(repository, "examples/nuxt"), project, {
    recursive: true,
  });
  await cp(
    path.join(prepared, "node_modules"),
    path.join(project, "node_modules"),
    { recursive: true },
  );
  const installed = [
    "run",
    "--rm",
    "--interactive",
    "--network",
    "none",
    "--mount",
    `type=bind,src=${consumer},target=/consumer,readonly`,
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
        'import {validate} from "@stsepelin/repo-verifier"; console.log(JSON.stringify(await validate("/consumer/example",{trusted:true})));',
      ],
      { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
    ),
  );
  assert.equal(library.outcome, "passed", JSON.stringify(library.checks));
  assert.equal(library.checks[0].runtime.collections[0].entries.length, 3);
  const binary =
    "/consumer/node_modules/@stsepelin/repo-verifier/dist/src/cli.js";
  const cliArgs = [
    ...installed,
    "node",
    binary,
    "run",
    "--root",
    "/consumer/example",
    "--trust-project",
  ];
  const cli = JSON.parse(execFileSync("docker", cliArgs, { encoding: "utf8" }));
  assert.equal(cli.outcome, "passed");
  assert.equal(cli.checks[0].id, "javascript.nuxt-runtime");
  assert.ok(!JSON.stringify(cli).includes("/catalog"));
  const source = path.join(project, "app/plugins/late.ts");
  const original = await readFile(source, "utf8");
  assert.ok(original.includes('name: "late"'));
  await writeFile(source, original.replace('name: "late"', 'name: "changed"'));
  const broken = spawnSync("docker", cliArgs, { encoding: "utf8" });
  assert.equal(broken.status, 1, broken.stderr);
  assert.equal(JSON.parse(broken.stdout).outcome, "failed");
  await writeFile(source, original);
  client = new Client(
    { name: "synthetic-nuxt-package", version: "1.0.0" },
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
        "/consumer/example",
        "--allow-execution",
      ],
      stderr: "pipe",
    }),
  );
  const mcp = await client.callTool({ name: "validation_run", arguments: {} });
  assert.equal(mcp.isError, undefined);
  assert.equal(mcp.structuredContent.outcome, "passed");
  assert.deepEqual(mcp.structuredContent.checks, cli.checks);
  assert.ok(!JSON.stringify(mcp).includes("/catalog"));
  const denied = await client.callTool({
    name: "validation_run",
    arguments: { detailed: true },
  });
  assert.equal(denied.isError, true);
  process.stdout.write(
    JSON.stringify({
      image,
      node: "22.23.2",
      nuxt: "4.5.2",
      nitro: "2.13.4",
      network: "none",
      native: "passed",
      installation: "offline",
      library: "passed",
      cli: "passed",
      broken: "failed as expected",
      mcp: "passed",
    }) + "\n",
  );
} finally {
  await client?.close();
  await rm(temporary, { recursive: true, force: true });
}
