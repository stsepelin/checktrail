import assert from "node:assert/strict";
import process from "node:process";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { assertLockedAcceptanceClient } from "./install-acceptance-package.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const root = process.env.CHECKTRAIL_CONTEXT_TARGET_ROOT ?? repository;
assert.ok(path.isAbsolute(root));
const selected = process.env.CHECKTRAIL_CONTEXT_RELEASE_PROOF;
assert.match(selected ?? "", /^\/[^\n]+\/proof\.json#sha256=[a-f0-9]{64}$/);
const expectedDigest = selected.split("#sha256=")[1];
const clientPackage = JSON.parse(
  await readFile(
    path.join(
      repository,
      "node_modules/@modelcontextprotocol/client/package.json",
    ),
    "utf8",
  ),
);
await assertLockedAcceptanceClient(repository, clientPackage.version);
const directory = await mkdtemp(
  path.join(await realpath(tmpdir()), "context-proof-transports-"),
);
try {
  const marker = "synthetic_context_source_boundary";
  await writeFile(
    path.join(directory, "first.py"),
    `def first(value):\n    return "${marker}"\n`,
  );
  await writeFile(
    path.join(directory, "second.py"),
    "def second(value):\n    return value * 2\n",
  );
  const selection = {
    schemaVersion: 6,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["first.py", "second.py"],
    supportFiles: [],
    topics: [],
  };
  await mkdir(path.join(directory, ".checktrail"));
  await writeFile(
    path.join(directory, ".checktrail/selection.json"),
    JSON.stringify(selection),
  );
  const cli = path.join(root, "dist/src/cli.js");
  const inspect = (response, detailed) => {
    const raw = JSON.stringify(response);
    assert.equal(raw.includes(marker), detailed);
    assert.equal(raw.includes(selected.split("#sha256=")[0]), false);
    if (detailed) {
      assert.equal(response.analysis.state, "collected");
      assert.equal(response.analysis.files.length, 2);
      assert.equal(
        response.analysis.runtimeArtifactProof.sha256,
        expectedDigest,
      );
    } else {
      assert.equal(response.format, "review-context-summary");
      assert.equal(response.sourceIncluded, false);
      assert.equal(response.selectedFiles, 2);
    }
  };
  let cliCalls = 0,
    mcpCalls = 0;
  for (const flags of [
    [],
    ["--detailed"],
    ["--detailed", "--allow-review-source"],
  ]) {
    const detailed = flags.includes("--allow-review-source");
    const output = execFileSync(
      process.execPath,
      [
        cli,
        "review-context",
        "--root",
        directory,
        "--input",
        ".checktrail/selection.json",
        ...flags,
      ],
      {
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    inspect(JSON.parse(output), detailed);
    cliCalls++;
    const client = new Client(
      { name: "synthetic-context-proof-client", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "serve", "--root", directory, ...flags],
      env: Object.fromEntries(
        Object.entries(process.env).filter(([, value]) => value !== undefined),
      ),
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const response = await client.callTool({
        name: "review_context",
        arguments: selection,
      });
      assert.equal(response.isError, undefined);
      inspect(response.structuredContent, detailed);
      mcpCalls++;
      for (const input of [
        { ...selection, runtimeArtifactProof: { sha256: expectedDigest } },
        { ...selection, CHECKTRAIL_CONTEXT_RELEASE_PROOF: selected },
        { ...selection, allowReviewSource: true },
      ]) {
        const refused = await client.callTool({
          name: "review_context",
          arguments: input,
        });
        assert.equal(
          refused.isError,
          true,
          "A request must not grant operator authority",
        );
        mcpCalls++;
      }
    } finally {
      await client.close();
    }
  }
  assert.equal(cliCalls, 3);
  assert.equal(mcpCalls, 12);
  process.stdout.write(
    JSON.stringify({
      state: "passed-context-proof-transports",
      cliCalls,
      mcpCalls,
      requestAuthorityPromoted: false,
      privateProofPathDisclosed: false,
      sourceOnlyWithOperatorGrant: true,
      modelCalls: 0,
    }) + "\n",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
