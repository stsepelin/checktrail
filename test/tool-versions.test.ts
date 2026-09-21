import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { identifyTool } from "../src/tool-versions.js";
import { projectReport } from "../src/output.js";
import type { ProcessResult, ToolSpec } from "../src/types.js";
import { copyInstalledPackages } from "./tool-fixture.js";
import { fixture, nodeManifest, passingTest } from "./helpers.js";

test("tool identities are detailed evidence and summaries omit package paths and versions", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "sum.test.js": passingTest,
  });
  const plan = await createPlan(root);
  assert.deepEqual(plan.plan.checks[0]!.tools, [
    { name: "node", source: "engine-runtime" },
  ]);
  const report = await validate(root, { trusted: true });
  assert.deepEqual(report.checks[0]!.tools, [
    {
      name: "node",
      source: "engine-runtime",
      version: process.versions.node,
      status: "identified",
    },
  ]);
  assert.ok(!JSON.stringify(projectReport(report, false)).includes('"tools"'));
});

test("package version metadata must match its tool and valid check output cannot mask missing identity", async (t) => {
  const root = await fixture(t, {
    "package.json": "{}",
    "tsconfig.json": JSON.stringify({ compilerOptions: { types: [] } }),
    "value.ts": "export const value = 1;",
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["javascript.typescript"] }],
    }),
  });
  await copyInstalledPackages(root, ["typescript"]);
  assert.equal((await validate(root, { trusted: true })).outcome, "passed");
  for (const contents of [
    '{"name":"wrong","version":"6.0.3"}',
    '{"name":"typescript","version":"unknown"}',
  ]) {
    await writeFile(
      path.join(root, "node_modules/typescript/package.json"),
      contents,
    );
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.checks[0]!.tools?.[1]!.status, "inconclusive");
  }
  await writeFile(
    path.join(root, "node_modules/typescript/package.json"),
    "{broken",
  );
  const broken = await validate(root, { trusted: true });
  assert.equal(broken.outcome, "failed");
  assert.equal(broken.checks[0]!.tools?.[1]!.status, "inconclusive");
  assert.match(
    broken.checks[0]!.processes[0]!.stderr,
    /Invalid package config/,
  );
});

test("native version identity rejects partial, malformed and nonzero output", async () => {
  const command = {
    executable: "synthetic-tool",
    args: ["--version"],
    cwd: ".",
  };
  const base: ProcessResult = {
    command,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    cancelled: false,
    truncated: false,
  };
  for (const [name, stdout, version] of [
    ["go", "go version go1.27.1 linux/arm64\n", "1.27.1"],
    ["dotnet", "10.0.401\n", "10.0.401"],
    [
      "java",
      "openjdk 25.0.4 2026-07-21 LTS\nOpenJDK Runtime Environment Temurin-25.0.4+7 (build 25.0.4+7-LTS)\nOpenJDK 64-Bit Server VM Temurin-25.0.4+7 (build 25.0.4+7-LTS, mixed mode, sharing)",
      "25.0.4",
    ],
    [
      "clang",
      "Apple clang version 21.0.0 (clang-2100.3.34.2)\nTarget: arm64-apple-darwin25.6.0\nThread model: posix\nInstalledDir: /toolchain/bin\n",
      "21.0.0",
    ],
    [
      "clang++",
      "Alpine clang version 22.1.3\nTarget: aarch64-alpine-linux-musl\nThread model: posix\nInstalledDir: /usr/lib/llvm22/bin\n",
      "22.1.3",
    ],
    ["rustc", "rustc 1.98.1 (48a229cea 2026-09-01)\n", "1.98.1"],
    ["cargo", "cargo 1.98.1 (797e8a9bc 2026-08-05)\n", "1.98.1"],
    [
      "ruby",
      "ruby 4.0.7 (2026-09-01 revision abcdef) [aarch64-linux-musl]\n",
      "4.0.7",
    ],
    [
      "ruby",
      "ruby 2.6.10p210 (2022-04-12 revision 67958) [universal.arm64e-darwin25]\n",
      "2.6.10",
    ],
    [
      "swift",
      "Apple Swift version 6.4 (swiftlang-6.4.0.34.1 clang-2100.3.34.1)\nTarget: arm64-apple-macosx26.0\n",
      "6.4",
    ],
    ["python", "Python 3.12.13\n", "3.12.13"],
    ["php", "PHP 8.4.23 (cli)\nCopyright text\n", "8.4.23"],
    ["ruff", "ruff 0.16.8\n", "0.16.8"],
    ["pytest", "9.1.1\n", "9.1.1"],
    ["mypy", "2.3.1\n", "2.3.1"],
    ["pint", "Pint 1.32.1\n", "1.32.1"],
    ["pest", "  Pest Testing Framework 5.2.1.  \n", "5.2.1"],
  ]) {
    const tool: ToolSpec = { name: name!, source: "version-command", command };
    const good = { ...base, stdout: stdout! };
    assert.equal(
      (await identifyTool("/synthetic", tool, async () => good)).version,
      version,
    );
    for (const patch of [
      { exitCode: 1 },
      { timedOut: true },
      { cancelled: true },
      { truncated: true },
      { stderr: "warning" },
      { stdout: "unknown" },
    ])
      assert.equal(
        (
          await identifyTool("/synthetic", tool, async () => ({
            ...good,
            ...patch,
          }))
        ).status,
        "inconclusive",
      );
    assert.equal(
      (await identifyTool("/synthetic", tool, async () => undefined)).status,
      "inconclusive",
    );
    assert.equal(
      (
        await identifyTool("/synthetic", tool, async () => ({
          ...base,
          exitCode: null,
          errorCode: "ENOENT",
        }))
      ).status,
      "unavailable",
    );
  }
});

test("Swift driver banners are bounded native identity evidence and Rust tool names are not interchangeable", async () => {
  const command = {
    executable: "synthetic-tool",
    args: ["--version"],
    cwd: ".",
  };
  const result: ProcessResult = {
    command,
    exitCode: 0,
    signal: null,
    stdout:
      "Apple Swift version 6.4 (synthetic-build)\nTarget: arm64-apple-macosx26.0\n",
    stderr: "swift-driver version: 1.168.6 ",
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    truncated: false,
  };
  const tool: ToolSpec = { name: "swift", source: "version-command", command };
  assert.equal(
    (await identifyTool("/synthetic", tool, async () => result)).version,
    "6.4",
  );
  assert.equal(
    (
      await identifyTool("/synthetic", tool, async () => ({
        ...result,
        stderr: result.stderr + "unrelated warning",
      }))
    ).status,
    "inconclusive",
  );
  assert.equal(
    (
      await identifyTool(
        "/synthetic",
        { ...tool, name: "rustc" },
        async () => ({
          ...result,
          stdout: "cargo 1.98.1 (797e8a9bc 2026-08-05)",
          stderr: "",
        }),
      )
    ).status,
    "inconclusive",
  );
});
