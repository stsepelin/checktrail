import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { swiftExtensionsEvidence } from "../src/swift-extensions-evidence.js";
import { swiftExtensionsPacketSchema } from "../src/swift-extensions-native.js";
import { mavenHash } from "../src/maven.js";
import { projectReport } from "../src/output.js";
import { runProcess } from "../src/runner.js";
import type { ProcessResult } from "../src/types.js";
import {
  swiftExtensionsFixture,
  swiftExtensionsNative as native,
} from "./swift-extensions-fixture.js";
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
const summary = (report: Awaited<ReturnType<typeof run>>) =>
  JSON.stringify(
    report.checks.map((c) => ({
      id: c.id,
      status: c.status,
      reason: c.reason,
      processes: c.processes.map((p) => ({
        exit: p.exitCode,
        stderr: p.stderr.slice(-1000),
        timedOut: p.timedOut,
        truncated: p.truncated,
      })),
    })),
  );
const expected = (mode: string, broken = false) =>
  mode === "xctest"
    ? { total: 3, passed: broken ? 1 : 3, failed: broken ? 2 : 0, skipped: 0 }
    : { total: 4, passed: broken ? 1 : 4, failed: broken ? 3 : 0, skipped: 0 };
const packet = (report: Awaited<ReturnType<typeof run>>) =>
  swiftExtensionsPacketSchema.parse(
    JSON.parse(report.checks[0]!.processes[0]!.stdout),
  );
function rewrite(
  process: ProcessResult,
  edit: (packet: ReturnType<typeof swiftExtensionsPacketSchema.parse>) => void,
) {
  const value = swiftExtensionsPacketSchema.parse(JSON.parse(process.stdout));
  edit(value);
  return { ...process, stdout: JSON.stringify(value) };
}
async function breakProducer(root: string) {
  const file = path.join(
      root,
      "Packages/Producer/Sources/OriginalProducer/Producer.swift",
    ),
    original = await readFile(file, "utf8");
  assert.equal(original.split("value + 1").length, 2);
  await writeFile(file, original.replace("value + 1", "value + 2"));
  return { file, original };
}
test("swift-extensions broken acceptance", native, async (t) => {
  for (const mode of ["xctest", "testing"]) {
    const { root } = await swiftExtensionsFixture(t, mode);
    await breakProducer(root);
    const report = await run(root);
    assert.equal(report.outcome, "failed", summary(report));
    assert.equal(report.checks[0]!.status, "failed", summary(report));
    assert.deepEqual(report.checks[0]!.tests, expected(mode, true));
    assert.equal(report.checks[0]!.findings?.length, mode === "xctest" ? 2 : 3);
    if (mode === "testing") {
      const check = (await createPlan(root)).plan.checks[0]!;
      for (const symbol of ["fail", "originalAdjacent"]) {
        const changed = rewrite(report.checks[0]!.processes[0]!, (p) => {
          const artifact = p.artifacts.find((a) => a.path === "events.jsonl")!;
          artifact.text = artifact.text
            .split("\n")
            .map((line) => {
              if (!line) return line;
              const event = JSON.parse(line);
              if (
                event.payload.kind === "issueRecorded" &&
                event.payload.messages.length === 2
              )
                event.payload.messages[1].symbol = symbol;
              return JSON.stringify(event);
            })
            .join("\n");
          artifact.sha256 = mavenHash(artifact.text);
        });
        assert.equal(
          swiftExtensionsEvidence(check, [changed], root).status,
          "inconclusive",
        );
      }
    }
    assert.ok(
      report.checks[0]!.findings?.every(
        (f) =>
          f.file?.startsWith("Tests/OriginalConsumerTests/") &&
          Number(f.line) > 0,
      ),
    );
  }
});
test("swift-extensions fixed acceptance", native, async (t) => {
  for (const mode of ["xctest", "testing"]) {
    const { root } = await swiftExtensionsFixture(t, mode),
      { file, original } = await breakProducer(root);
    try {
      assert.equal((await run(root)).outcome, "failed");
    } finally {
      await writeFile(file, original);
    }
    const report = await run(root);
    assert.equal(report.outcome, "passed", summary(report));
    assert.deepEqual(report.checks[0]!.tests, expected(mode));
  }
});
test("swift-extensions near-miss acceptance", native, async (t) => {
  for (const mode of ["build", "xctest", "testing", "swiftlint"]) {
    const { root } = await swiftExtensionsFixture(t, mode);
    const file = path.join(
      root,
      "Packages/Producer/Sources/OriginalProducer/Producer.swift",
    );
    await writeFile(
      file,
      (await readFile(file, "utf8")) +
        "\n// value + 2 is original adjacent prose, not executed code.\n",
    );
    const report = await run(root);
    assert.equal(report.outcome, "passed", summary(report));
    const data = packet(report);
    assert.equal(data.config.packages.length, 2);
    assert.equal(
      data.artifacts.filter((a) => a.path.startsWith("sdk/")).length,
      5,
    );
    assert.equal(
      data.artifacts.filter((a) => a.path.endsWith("OriginalGenerated.swift"))
        .length,
      1,
    );
    assert.equal(
      data.sdkBeforeSha256,
      mavenHash(JSON.stringify(data.config.sdk)),
    );
    assert.equal(data.sdkBeforeSha256, data.sdkAfterSha256);
    assert.ok(data.tools.every((t) => t.sha256 === t.afterSha256));
    assert.ok(report.checks[0]!.tools?.every((t) => t.status === "identified"));
    if (mode === "xctest" || mode === "testing")
      assert.deepEqual(report.checks[0]!.tests, expected(mode));
  }
});
test("swift-extensions prerequisite acceptance", native, async (t) => {
  const { root, config } = await swiftExtensionsFixture(t, "build"),
    manifest = path.join(root, "Package.swift"),
    original = await readFile(manifest, "utf8"),
    marker = path.join(root, ".checktrail-unexpected-manifest");
  await writeFile(
    manifest,
    original.replace(
      "import PackageDescription",
      "import PackageDescription\nimport Foundation\nlet originalMarker=FileManager.default.createFile(atPath:" +
        JSON.stringify(marker) +
        ",contents:Data())",
    ),
  );
  const planned = await createPlan(root);
  assert.equal(planned.plan.checks.length, 1);
  assert.equal(planned.plan.checks[0]!.commands.length, 1);
  await assert.rejects(access(marker));
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await assert.rejects(access(marker));
  const directory = await mkdtemp(
      path.join(tmpdir(), "swift-extension-prerequisite-"),
    ),
    previous = process.env.PATH;
  try {
    await writeFile(
      path.join(directory, "swiftc"),
      '#!/bin/sh\nprintf "%s\\n" "Swift version 6.2.2 (original unsupported runtime)" "Target: aarch64-unknown-linux-gnu"\n',
    );
    await chmod(path.join(directory, "swiftc"), 0o755);
    process.env.PATH = directory;
    const report = await run(root);
    assert.equal(report.checks[0]!.status, "unavailable", summary(report));
    assert.equal(report.checks[0]!.processes[0]!.exitCode, 0);
    await assert.rejects(access(marker));
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
  const policy = path.join(root, "checktrail.swift-extensions.json"),
    before = await readFile(policy, "utf8");
  try {
    const changed = structuredClone(config);
    changed.sdk[0]!.sha256 = "0".repeat(64);
    await writeFile(policy, JSON.stringify(changed));
    const report = await run(root);
    assert.equal(report.checks[0]!.status, "unavailable", summary(report));
    assert.equal(report.checks[0]!.processes[0]!.exitCode, 0);
    await assert.rejects(access(marker));
  } finally {
    await writeFile(policy, before);
    await writeFile(manifest, original);
  }
  for (const edit of [
    (x: typeof config) => {
      x.packages[0]!.dependencies[0]!.path = "Packages/Adjacent";
    },
    (x: typeof config) => {
      x.packages[0]!.targets[0]!.plugins = ["AdjacentPlugin"];
    },
    (x: typeof config) => {
      x.packages[0]!.identity = "adjacent";
    },
  ]) {
    const changed = structuredClone(config);
    edit(changed);
    try {
      await writeFile(policy, JSON.stringify(changed));
      const { plan } = await createPlan(root);
      assert.equal(plan.checks[0]!.commands.length, 0);
      assert.ok(plan.checks[0]!.unavailableReason);
    } finally {
      await writeFile(policy, before);
    }
  }
});
test("swift-extensions stale acceptance", native, async (t) => {
  const { root } = await swiftExtensionsFixture(t),
    report = await run(root);
  assert.equal(report.outcome, "passed", summary(report));
  const { plan } = await createPlan(root),
    check = plan.checks[0]!,
    process = report.checks[0]!.processes[0]!;
  assert.equal(
    swiftExtensionsEvidence(check, [process], root).status,
    "passed",
  );
  for (const file of [
    "Package.swift",
    "Packages/Producer/Package.swift",
    "Packages/Producer/Sources/OriginalProducer/Producer.swift",
    "Tools/OriginalGenerator/main.swift",
    "Plugins/OriginalGenerate/plugin.swift",
    "Tests/OriginalConsumerTests/QuantityTestingTests.swift",
    "checktrail.swift-extensions.json",
  ]) {
    const target = path.join(root, file),
      before = await readFile(target);
    try {
      await writeFile(target, Buffer.concat([before, Buffer.from("\n")]));
      assert.equal(
        swiftExtensionsEvidence(check, [process], root).status,
        "inconclusive",
        file,
      );
    } finally {
      await writeFile(target, before);
    }
  }
  const extra = path.join(root, "OriginalAdjacent.bin");
  try {
    await writeFile(extra, Buffer.from([0, 255]));
    assert.equal(
      swiftExtensionsEvidence(check, [process], root).status,
      "inconclusive",
    );
  } finally {
    await rm(extra);
  }
  assert.equal(
    swiftExtensionsEvidence(check, [process], root).status,
    "passed",
  );
  for (const edit of [
    (p: ReturnType<typeof packet>) => {
      p.tools[0]!.afterSha256 = "0".repeat(64);
    },
    (p: ReturnType<typeof packet>) => {
      p.sdkAfterSha256 = "0".repeat(64);
    },
    (p: ReturnType<typeof packet>) => {
      p.config.sdk[0]!.bytes++;
    },
  ])
    assert.equal(
      swiftExtensionsEvidence(check, [rewrite(process, edit)], root).status,
      "inconclusive",
    );
});
test("swift-extensions empty acceptance", native, async (t) => {
  const { root } = await swiftExtensionsFixture(t),
    report = await run(root);
  assert.equal(report.outcome, "passed", summary(report));
  const { plan } = await createPlan(root),
    check = plan.checks[0]!,
    process = report.checks[0]!.processes[0]!;
  assert.equal(
    swiftExtensionsEvidence(check, [process]).status,
    "inconclusive",
  );
  assert.equal(swiftExtensionsEvidence(check, [], root).status, "inconclusive");
  for (const changed of [
    { ...process, stdout: "" },
    { ...process, stdout: "{}" },
    { ...process, cancelled: true },
    { ...process, timedOut: true },
    { ...process, truncated: true },
    { ...process, exitCode: 1 },
    { ...process, stderr: "unexpected native error" },
  ])
    assert.equal(
      swiftExtensionsEvidence(check, [changed], root).status,
      "inconclusive",
    );
  for (const edit of [
    (p: ReturnType<typeof packet>) => {
      p.receipts.pop();
    },
    (p: ReturnType<typeof packet>) => {
      p.generatedAfter = [];
    },
    (p: ReturnType<typeof packet>) => {
      const r = p.receipts.find((r) => r.phase === "build")!;
      r.stdout = r.stdout
        .split("\n")
        .filter(
          (l) =>
            !l.includes("-primary-file " + p.workspace + "/Packages/Producer/"),
        )
        .join("\n");
      r.stdoutSha256 = mavenHash(r.stdout);
    },
    (p: ReturnType<typeof packet>) => {
      const r = p.receipts.find((r) => r.phase === "sdk:OriginalProducer")!;
      r.stderr = r.stderr
        .split("\n")
        .filter(
          (l) => !l.includes("to virtual file '/usr/include/SwiftGlibc.h'"),
        )
        .join("\n");
      r.stderrSha256 = mavenHash(r.stderr);
    },
    (p: ReturnType<typeof packet>) => {
      const r = p.receipts.find((r) => r.phase === "describe:project")!;
      const v = JSON.parse(r.stdout);
      v.products = v.products.filter(
        (product: { name: string }) => product.name !== "OriginalGenerator",
      );
      r.stdout = JSON.stringify(v);
      r.stdoutSha256 = mavenHash(r.stdout);
    },
    (p: ReturnType<typeof packet>) => {
      const r = p.artifacts.find(
        (r) => r.path === "sdk/OriginalConsumerTests.json",
      )!;
      const v = JSON.parse(r.text);
      for (const module of v.modules)
        if (module.details)
          for (const details of Object.values(module.details) as {
            macroDependencies?: { moduleName: string }[];
          }[])
            if (details.macroDependencies)
              details.macroDependencies = details.macroDependencies.filter(
                (m) => m.moduleName !== "TestingMacros",
              );
      r.text = JSON.stringify(v);
      r.sha256 = mavenHash(r.text);
    },
    (p: ReturnType<typeof packet>) => {
      const r = p.receipts.find((r) => r.phase === "list")!;
      r.stdout = r.stdout.trimEnd().split("\n").slice(1).join("\n") + "\n";
      r.stdoutSha256 = mavenHash(r.stdout);
    },
    (p: ReturnType<typeof packet>) => {
      p.artifacts.pop();
    },
    (p: ReturnType<typeof packet>) => {
      p.receipts.find((r) => r.phase === "list")!.stdout = "";
    },
    (p: ReturnType<typeof packet>) => {
      const a = p.artifacts.find((a) =>
        a.path.endsWith("OriginalGenerated.swift"),
      )!;
      a.text = "";
      a.sha256 = mavenHash("");
    },
    (p: ReturnType<typeof packet>) => {
      const r = p.receipts.find((r) => r.phase === "sdk:OriginalConsumer")!;
      r.stderr = r.stderr.replaceAll(
        "/usr/include/SwiftGlibc.h",
        "/usr/include/SwiftGlibcAdjacent.h",
      );
      r.stderrSha256 = mavenHash(r.stderr);
    },
  ])
    assert.equal(
      swiftExtensionsEvidence(check, [rewrite(process, edit)], root).status,
      "inconclusive",
    );
  for (const mode of ["xctest", "testing"]) {
    const { root: skippedRoot } = await swiftExtensionsFixture(t, mode);
    const file = path.join(
        skippedRoot,
        mode === "xctest"
          ? "Tests/OriginalConsumerTests/QuantityXCTests.swift"
          : "Tests/OriginalConsumerTests/QuantityTestingTests.swift",
      ),
      before = await readFile(file, "utf8");
    try {
      await writeFile(
        file,
        mode === "xctest"
          ? before.replace(
              /func (test\w+)\(\) \{/g,
              'func $1() throws { throw XCTSkip("original selected skip");',
            )
          : before
              .replaceAll(
                "@Test ",
                '@Test(.disabled("original selected skip")) ',
              )
              .replace(
                "@Test(arguments:",
                '@Test(.disabled("original selected skip"), arguments:',
              ),
      );
      const skipped = await run(skippedRoot);
      assert.notEqual(skipped.outcome, "passed", summary(skipped));
      assert.equal(skipped.checks[0]!.status, "inconclusive", summary(skipped));
    } finally {
      await writeFile(file, before);
    }
  }
});
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
test("swift-extensions privacy acceptance", native, async (t) => {
  const { root } = await swiftExtensionsFixture(t, "xctest"),
    file = path.join(root, "Tests/OriginalConsumerTests/QuantityXCTests.swift"),
    before = await readFile(file, "utf8"),
    canary = "original_swift_extension_synthetic_canary";
  await writeFile(
    file,
    before.replace(
      "XCTAssertEqual(Array(OriginalConsumer.values(2)),[3,5])",
      "XCTAssertEqual(Array(OriginalConsumer.values(2)),[99,5]," +
        JSON.stringify(canary) +
        ")",
    ),
  );
  const report = await run(root);
  assert.equal(report.outcome, "failed", summary(report));
  assert.ok(
    !JSON.stringify(projectReport(report, false)).includes(root) &&
      !JSON.stringify(projectReport(report, false)).includes(canary),
  );
  assert.ok(JSON.stringify(projectReport(report, true)).includes(canary));
  for (const detailed of [false, true]) {
    const r = spawnSync(
      process.execPath,
      [
        cli,
        "run",
        "--root",
        root,
        "--trust-project",
        "--timeout-ms",
        "120000",
        ...(detailed ? ["--detailed"] : []),
      ],
      { encoding: "utf8", timeout: 150000, maxBuffer: 4 * 1048576 },
    );
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout.includes(root), detailed);
    assert.equal(r.stdout.includes(canary), detailed);
  }
  for (const detailed of [false, true]) {
    const client = new Client(
      { name: "original-swift-extension-client", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            cli,
            "serve",
            "--root",
            root,
            "--allow-execution",
            ...(detailed ? ["--detailed"] : []),
          ],
          stderr: "pipe",
        }),
      );
      assert.equal(
        (
          await client.callTool({
            name: "validation_run",
            arguments: { trusted: true },
          })
        ).isError,
        true,
      );
      const r = await client.callTool(
        { name: "validation_run", arguments: { timeoutMs: 120000 } },
        { timeout: 150000 },
      );
      assert.notEqual(r.isError, true);
      assert.equal(
        (r.structuredContent as { outcome: string }).outcome,
        "failed",
      );
      assert.equal(JSON.stringify(r).includes(root), detailed);
      assert.equal(JSON.stringify(r).includes(canary), detailed);
    } finally {
      await client.close();
    }
  }
});
test("swift-extensions lifecycle acceptance", native, async (t) => {
  for (const mode of ["cancel", "timeout", "output"] as const) {
    const { root } = await swiftExtensionsFixture(t, "build"),
      file = path.join(root, "Package.swift"),
      before = await readFile(file, "utf8"),
      marker = path.join(root, ".checktrail", "OriginalLifecycle.json"),
      owner = await mkdtemp(path.join(tmpdir(), "swift-extension-lifecycle-")),
      previous = process.env.TMPDIR,
      abort = new AbortController();
    const source =
      'import PackageDescription\nimport Foundation\nlet child=Process(); child.executableURL=URL(fileURLWithPath:"/bin/sleep");child.arguments=[' +
      JSON.stringify(mode === "output" ? "1" : "120") +
      '];try child.run();let record:[String:Any] = ["pid":child.processIdentifier,"helper":ProcessInfo.processInfo.processIdentifier,"scratch":ProcessInfo.processInfo.environment["TMPDIR"]!,"owner":ProcessInfo.processInfo.environment["CHECKTRAIL_TEMP"]!];try FileManager.default.createDirectory(atPath:' +
      JSON.stringify(path.dirname(marker)) +
      ",withIntermediateDirectories:true);try JSONSerialization.data(withJSONObject:record).write(to:URL(fileURLWithPath:" +
      JSON.stringify(marker) +
      "));child.waitUntilExit()";
    assert.equal(before.split("import PackageDescription").length, 2);
    await writeFile(file, before.replace("import PackageDescription", source));
    process.env.TMPDIR = owner;
    let pending: ReturnType<typeof runProcess> | undefined;
    try {
      const { plan } = await createPlan(root);
      pending = runProcess(root, plan.checks[0]!.commands[0]!, {
        timeoutMs: mode === "timeout" ? 30000 : 120000,
        maxOutputBytes: mode === "output" ? 1024 : 4 * 1048576,
        signal: abort.signal,
      });
      let record:
        | { pid: number; helper: number; scratch: string; owner: string }
        | undefined;
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        try {
          record = JSON.parse(await readFile(marker, "utf8"));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(record, "Native Swift manifest child was not reached");
      assert.ok(record.pid > 0 && record.helper > 0);
      assert.ok(
        record.scratch.startsWith(record.owner + path.sep) &&
          record.owner.startsWith(owner + path.sep),
      );
      if (mode !== "output")
        for (const pid of [record.pid, record.helper]) process.kill(pid, 0);
      if (mode === "cancel") abort.abort();
      const result = await pending;
      assert.equal(result.cancelled, mode === "cancel");
      assert.equal(result.timedOut, mode === "timeout");
      assert.equal(result.truncated, mode === "output");
      assert.equal(
        swiftExtensionsEvidence(plan.checks[0]!, [result], root).status,
        "inconclusive",
      );
      await assert.rejects(access(record.scratch), { code: "ENOENT" });
      assert.deepEqual(await readdir(owner), []);
      for (const pid of [record.pid, record.helper])
        await assert.rejects(readFile(`/proc/${pid}/cmdline`), {
          code: "ENOENT",
        });
    } finally {
      abort.abort();
      if (pending) await pending;
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      await writeFile(file, before);
      await rm(marker, { force: true });
      await rm(owner, { recursive: true, force: true });
    }
  }
});
test("swift-extensions installed acceptance", native, async () => {
  if (process.env.CHECKTRAIL_SWIFT_EXTENSIONS_INSTALLED === "1") {
    assert.match(
      await realpath(
        fileURLToPath(new URL("../src/engine.js", import.meta.url)),
      ),
      /node_modules\/@stsepelin\/checktrail\/dist\/src\/engine\.js$/,
    );
    return;
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "swift-extensions",
  };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          "../../scripts/verify-import-context-package.mjs",
          import.meta.url,
        ),
      ),
    ],
    { env, encoding: "utf8", timeout: 1170000, maxBuffer: 4 * 1048576 },
  );
  assert.equal(r.error, undefined, r.error?.message ?? "");
  assert.equal(r.status, 0, r.stderr.slice(-3000));
  const receipt = JSON.parse(r.stdout);
  assert.equal(receipt.profile.required, 9);
  assert.equal(receipt.profile.passed, 9);
  assert.equal(receipt.profile.complete, true);
  assert.equal(receipt.offlineProductionInstall, true);
  assert.equal(receipt.harnessOutsideInstalledPackage, true);
  if (process.env.CHECKTRAIL_SWIFT_EXTENSIONS_INSTALL_RECEIPT)
    await writeFile(
      process.env.CHECKTRAIL_SWIFT_EXTENSIONS_INSTALL_RECEIPT,
      JSON.stringify(receipt),
    );
});
