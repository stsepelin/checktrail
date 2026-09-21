import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const repository = fileURLToPath(new URL("../", import.meta.url));
const image =
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const native = [
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
assert.equal(
  execFileSync("docker", [...native, "node", "--version"], {
    encoding: "utf8",
  }).trim(),
  "v22.23.2",
);
const tests = execFileSync(
  "docker",
  [...native, "node", "scripts/verify-required-native-tests.mjs", "review"],
  { encoding: "utf8", maxBuffer: 1024 * 1024 },
);
process.stdout.write(tests);
const temporary = await mkdtemp(
  path.join(tmpdir(), "repo-verifier-review-package-"),
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
  await cp(path.join(repository, "examples/review"), project, {
    recursive: true,
  });
  await mkdir(path.join(project, ".repo-verifier"));
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
  const context = JSON.parse(
    execFileSync(
      "docker",
      [
        ...installed,
        "node",
        "--input-type=module",
        "-e",
        'import {readFile} from "node:fs/promises"; import {createReviewContext} from "@stsepelin/repo-verifier"; console.log(JSON.stringify(await createReviewContext("/consumer/example",JSON.parse(await readFile("/consumer/example/selection.json","utf8")))));',
      ],
      { encoding: "utf8" },
    ),
  );
  const assessment = {
    schemaVersion: 1,
    contextDigest: context.contextDigest,
    reviewer: { kind: "human", name: "Synthetic example reviewer" },
    createdAt: "2026-09-19T00:00:00Z",
    usage: {
      inputTokens: null,
      outputTokens: null,
      elapsedMs: null,
      costUSD: null,
    },
    files: [
      {
        path: "catalog.mjs",
        disposition: "reviewed",
        note: "Synthetic fixture only",
      },
    ],
    observations: [
      {
        id: "example.suggestion",
        severity: "suggestion",
        claim:
          "Consider documenting the accepted label input type; this is an advisory suggestion.",
        citations: [
          {
            file: "catalog.mjs",
            startLine: 1,
            endLine: 1,
            quote: "export function duplicateLabel(label) {",
          },
        ],
      },
    ],
  };
  await writeFile(
    path.join(project, ".repo-verifier/context.json"),
    JSON.stringify(context),
  );
  await writeFile(
    path.join(project, ".repo-verifier/assessment.json"),
    JSON.stringify(assessment),
  );
  const binary =
    "/consumer/node_modules/@stsepelin/repo-verifier/dist/src/cli.js";
  const cliArgs = [
    ...installed,
    "node",
    binary,
    "review-receipt",
    "--root",
    "/consumer/example",
    "--context",
    ".repo-verifier/context.json",
    "--input",
    ".repo-verifier/assessment.json",
  ];
  const receipt = JSON.parse(
    execFileSync("docker", cliArgs, { encoding: "utf8" }),
  );
  assert.equal(receipt.freshness, "current");
  assert.equal(receipt.claimsVerified, false);
  assert.equal(receipt.citations.matched, 1);
  assert.ok(!JSON.stringify(receipt).includes("duplicateLabel"));
  client = new Client(
    { name: "synthetic-review-package", version: "1.0.0" },
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
        "--detailed",
        "--allow-review-source",
      ],
      stderr: "pipe",
    }),
  );
  const result = await client.callTool({
    name: "review_context",
    arguments: JSON.parse(
      await readFile(path.join(project, "selection.json"), "utf8"),
    ),
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, context);
  const received = await client.callTool({
    name: "review_receipt",
    arguments: {
      context: ".repo-verifier/context.json",
      input: ".repo-verifier/assessment.json",
    },
  });
  assert.equal(received.isError, undefined);
  assert.equal(received.structuredContent.claimsVerified, false);
  assert.equal(received.structuredContent.citations.matched, 1);
  assert.equal(
    (await client.callTool({ name: "validation_run", arguments: {} })).isError,
    true,
  );
  await writeFile(
    path.join(project, "catalog.mjs"),
    "export const changed = true;\n",
  );
  const stale = spawnSync("docker", cliArgs, { encoding: "utf8" });
  assert.equal(stale.status, 2, stale.stderr);
  assert.equal(JSON.parse(stale.stdout).freshness, "stale");
  process.stdout.write(
    JSON.stringify({
      image,
      node: "22.23.2",
      network: "none",
      native: "passed",
      installation: "offline",
      library: "passed",
      cli: "passed",
      mcp: "passed",
      stale: "detected",
      claimsVerified: false,
    }) + "\n",
  );
} finally {
  await client?.close();
  await rm(temporary, { recursive: true, force: true });
}
