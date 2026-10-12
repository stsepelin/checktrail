import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { reportSchema } from "../src/schemas.js";
import assert from "node:assert/strict";
import {
  access,
  readFile,
  writeFile,
  open,
  mkdir,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { z } from "zod";
import type { Check, CheckResult } from "../src/types.js";
import { evaluate } from "../src/evidence.js";
import { kotlinExtensionEvidenceSchema } from "../src/kotlin-extension-evidence.js";
import { createPlan, validate } from "../src/engine.js";
import {
  mixedKotlinFixture,
  kotlinExtensionsOptions as options,
  javaProducer,
  mixedKotlinConfig,
  kotlinGenerator,
  generatedKotlin,
  waitingKotlinGenerator,
} from "./kotlin-extensions-fixture.js";
test("kotlin-extensions fixed acceptance", options, async (t) => {
  const f = await mixedKotlinFixture(t);
  const planned = await createPlan(f.root);
  assert.equal(
    planned.plan.checks[0]!.commands.length,
    1,
    planned.plan.checks[0]!.unavailableReason ?? "Native invocation",
  );
  const report = await validate(f.root, {
    trusted: true,
    timeoutMs: 120000,
  });
  const check = report.checks[0]!;
  assert.equal(check.status, "passed", JSON.stringify(check));
  assert.equal(check.findingsComplete, true);
  const packet = JSON.parse(check.processes[0]!.stdout);
  assert.equal(packet.generatedClasses.length, 2);
  assert.equal(packet.java.classes.length, 1);
  assert.equal(packet.java.sources[0].parsed, 1);
  assert.equal(packet.kotlin.native.sources.length, 4);
  assert.equal(packet.kotlin.native.irFiles.length, 4);
  await assert.rejects(access(f.marker));
  assert.equal(
    await readFile(path.join(f.root, "build/classes/preserve"), "utf8"),
    "keep",
  );
});
test("kotlin-extensions broken acceptance", options, async (t) => {
  const f = await mixedKotlinFixture(t, {
    "producer/JavaProducer.java": javaProducer.replace(
      "return 5;",
      'return "wrong";',
    ),
  });
  const check = (
    await validate(f.root, {
      trusted: true,
      timeoutMs: 120000,
    })
  ).checks[0]!;
  assert.equal(check.status, "failed", JSON.stringify(check));
  const packet = JSON.parse(check.processes[0]!.stdout);
  assert.equal(packet.kotlin.native.exit, "OK");
  assert.equal(packet.java.success, false);
  assert.ok(
    (check.findings ?? []).some(
      (f) =>
        f.file === "producer/JavaProducer.java" &&
        f.line === 1 &&
        f.level === "error",
    ),
  );
  await assert.rejects(access(f.marker));
});

test(
  "kotlin-extensions near-miss acceptance",
  { ...options, timeout: 240000 },
  async (t) => {
    const f = await mixedKotlinFixture(t, {
      "producer/JavaProducer.java": javaProducer.replace(
        "public class",
        "@interface SuppressWarningsExtra {} @SuppressWarningsExtra public class",
      ),
    });
    const check = (await validate(f.root, { trusted: true, timeoutMs: 120000 }))
      .checks[0]!;
    assert.equal(check.status, "passed", JSON.stringify(check));
    const packet = JSON.parse(check.processes[0]!.stdout);
    assert.equal(packet.java.sources[0].declared.length, 2);
    assert.equal(packet.java.classes.length, 2);
    assert.ok(
      packet.java.sources[0].annotations.includes(
        "producer.SuppressWarningsExtra",
      ),
    );
    await assert.rejects(access(f.marker));
    const config = {
      ...mixedKotlinConfig,
      extensions: { ...mixedKotlinConfig.extensions, executeScripts: true },
    };
    await writeFile(
      path.join(f.root, "checktrail.kotlin.json"),
      JSON.stringify(config),
    );
    assert.equal((await createPlan(f.root)).plan.checks[0]!.commands.length, 0);
  },
);
test("kotlin-extensions prerequisite acceptance", options, async (t) => {
  const f = await mixedKotlinFixture(t);
  const file = path.join(f.root, mixedKotlinConfig.archive),
    handle = await open(file, "r+");
  const original = Buffer.alloc(1);
  try {
    await handle.read(original, 0, 1, 0);
    await handle.write(Buffer.from([original[0]! ^ 1]), 0, 1, 0);
  } finally {
    await handle.close();
  }
  try {
    assert.equal((await createPlan(f.root)).plan.checks[0]!.commands.length, 0);
    assert.equal(
      (await validate(f.root, { trusted: true })).checks[0]!.status,
      "unavailable",
    );
    await assert.rejects(access(f.marker));
  } finally {
    const restore = await open(file, "r+");
    try {
      await restore.write(original, 0, 1, 0);
    } finally {
      await restore.close();
    }
  }
  const previous = process.env.PATH,
    directory = path.join(f.root, ".checktrail/foreign-toolchain");
  await mkdir(directory);
  await writeFile(
    path.join(directory, "java"),
    '#!/bin/sh\nprintf "pretend selected version\\n"\n',
    { mode: 0o755 },
  );
  try {
    process.env.PATH = directory + path.delimiter + previous;
    assert.equal((await createPlan(f.root)).plan.checks[0]!.commands.length, 0);
    await assert.rejects(access(f.marker));
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
  await writeFile(
    path.join(f.root, "checktrail.kotlin.json"),
    JSON.stringify({
      ...mixedKotlinConfig,
      extensions: { ...mixedKotlinConfig.extensions, scripts: [] },
    }),
  );
  assert.equal((await createPlan(f.root)).plan.checks[0]!.commands.length, 0);
});
const nativeCheck = (check: CheckResult): Check => ({
  id: check.id,
  adapter: check.adapter,
  project: check.project,
  scope: check.scope,
  kind: "analysis",
  reason: "Selected native mixed Kotlin invocation",
  parser: "kotlin-json",
  commands: check.processes.map((p) => p.command),
});
const evaluated = (
  check: CheckResult,
  root: string,
  mutate: (packet: z.infer<typeof kotlinExtensionEvidenceSchema>) => void,
) => {
  const packet = kotlinExtensionEvidenceSchema.parse(
    JSON.parse(check.processes[0]!.stdout),
  );
  mutate(packet);
  return evaluate(
    nativeCheck(check),
    [{ ...check.processes[0]!, stdout: JSON.stringify(packet) }],
    root,
  );
};
test(
  "kotlin-extensions stale acceptance",
  { ...options, timeout: 240000 },
  async (t) => {
    const f = await mixedKotlinFixture(t);
    const check = (await validate(f.root, { trusted: true, timeoutMs: 120000 }))
      .checks[0]!;
    assert.equal(check.status, "passed", JSON.stringify(check));
    assert.equal(
      evaluate(nativeCheck(check), check.processes, f.root).status,
      "passed",
    );
    for (const file of [
      "producer/JavaProducer.java",
      "producer/KotlinProducer.kt",
      "scripts/Compile only.kts",
      "generators/BuildKotlinGenerator.java",
      "checktrail.kotlin.json",
    ]) {
      const absolute = path.join(f.root, file),
        original = await readFile(absolute);
      try {
        await writeFile(
          absolute,
          file.endsWith(".json")
            ? JSON.stringify({ ...mixedKotlinConfig, warningsAsErrors: true })
            : Buffer.concat([original, Buffer.from("\n// changed\n")]),
        );
        assert.equal(
          evaluate(nativeCheck(check), check.processes, f.root).status,
          "inconclusive",
          file,
        );
      } finally {
        await writeFile(absolute, original);
      }
    }
    assert.equal(
      evaluated(check, f.root, (p) => {
        p.requestDigest = "0".repeat(64);
      }).status,
      "inconclusive",
    );
    assert.equal(
      evaluated(check, f.root, (p) => {
        p.sources[0]!.sha256 = "0".repeat(64);
      }).status,
      "inconclusive",
    );
    assert.equal(
      evaluated(check, f.root, (p) => {
        p.generated[0]!.sourceSha256 = "0".repeat(64);
      }).status,
      "inconclusive",
    );
  },
);
test(
  "kotlin-extensions empty acceptance",
  { ...options, timeout: 240000 },
  async (t) => {
    const f = await mixedKotlinFixture(t);
    const check = (await validate(f.root, { trusted: true, timeoutMs: 120000 }))
      .checks[0]!;
    assert.equal(check.status, "passed", JSON.stringify(check));
    for (const change of [
      (p: Packet) => {
        p.generated = [];
      },
      (p: Packet) => {
        p.generated[0]!.outputs.pop();
      },
      (p: Packet) => {
        p.payloads.pop();
      },
      (p: Packet) => {
        p.generatedClasses.pop();
      },
      (p: Packet) => {
        p.generatedClasses[0]!.className = "policy.Foreign";
      },
      (p: Packet) => {
        p.generatedClasses[0]!.sourceFile = "Foreign.kt";
      },
      (p: Packet) => {
        p.generatedClasses[0]!.sha256 = "0".repeat(64);
      },
      (p: Packet) => {
        p.java = null;
      },
      (p: Packet) => {
        p.java!.sources = [];
      },
      (p: Packet) => {
        p.java!.classes = [];
      },
      (p: Packet) => {
        p.java!.classes[0]!.sourceFile = "Foreign.java";
      },
      (p: Packet) => {
        p.javaOutputAfter = [];
      },
      (p: Packet) => {
        p.kotlin.native!.irFiles.pop();
      },
      (p: Packet) => {
        p.invocations.pop();
      },
      (p: Packet) => {
        p.mirrored.completeForObservedStreams = false;
      },
    ])
      assert.equal(evaluated(check, f.root, change).status, "inconclusive");
    assert.equal(
      evaluate(
        nativeCheck(check),
        [{ ...check.processes[0]!, stdout: "{}" }],
        f.root,
      ).status,
      "inconclusive",
    );
    assert.equal(
      evaluate(
        nativeCheck(check),
        [{ ...check.processes[0]!, truncated: true }],
        f.root,
      ).status,
      "inconclusive",
    );
    await writeFile(
      path.join(f.root, "generators/BuildKotlinGenerator.java"),
      kotlinGenerator(generatedKotlin.replace("3", "unknown")),
    );
    const broken = (
      await validate(f.root, { trusted: true, timeoutMs: 120000 })
    ).checks[0]!;
    assert.equal(broken.status, "failed", JSON.stringify(broken));
    assert.ok(
      (broken.findings ?? []).some(
        (f) =>
          f.file === "generators/BuildKotlinGenerator.java" &&
          f.message.includes("src/main/kotlin/policy/Rules.kt:"),
      ),
    );
  },
);
type Packet = z.infer<typeof kotlinExtensionEvidenceSchema>;
test(
  "kotlin-extensions privacy acceptance",
  { ...options, timeout: 300000 },
  async (t) => {
    const f = await mixedKotlinFixture(t, {
      "producer/JavaProducer.java": javaProducer.replace(
        "return 5;",
        'return "wrong";',
      ),
    });
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const run = (trust: boolean, detailed: boolean) =>
      spawnSync(
        process.execPath,
        [
          cli,
          "run",
          "--root",
          f.root,
          ...(trust ? ["--trust-project"] : []),
          ...(detailed ? ["--detailed"] : []),
        ],
        { encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1048576 },
      );
    const denied = run(false, false);
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /trust/i);
    const detailed = run(true, true);
    assert.equal(detailed.status, 1, detailed.stderr);
    const report = reportSchema.parse(JSON.parse(detailed.stdout));
    assert.equal(report.checks[0]!.status, "failed");
    assert.ok(
      report.checks[0]!.findings!.some(
        (f) => f.file === "producer/JavaProducer.java",
      ),
    );
    const summary = run(true, false);
    assert.equal(summary.status, 1, summary.stderr);
    assert.ok(
      !summary.stdout.includes(f.root) &&
        !summary.stdout.includes("JavaProducer") &&
        !summary.stdout.includes('return "wrong"'),
    );
    for (const allow of [false, true]) {
      const client = new Client(
        { name: "synthetic-mixed-Kotlin-client", version: "1.0.0" },
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
              f.root,
              ...(allow ? ["--allow-execution"] : []),
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
        const result = await client.callTool({
          name: "validation_run",
          arguments: {},
        });
        if (!allow) assert.equal(result.isError, true);
        else {
          assert.notEqual(result.isError, true);
          assert.equal(
            (result.structuredContent as { outcome: string }).outcome,
            "failed",
          );
          assert.deepEqual(
            (result.structuredContent as { checks: unknown }).checks,
            JSON.parse(summary.stdout).checks,
          );
          assert.ok(
            !JSON.stringify(result).includes(f.root) &&
              !JSON.stringify(result).includes("JavaProducer"),
          );
        }
      } finally {
        await client.close();
      }
    }
    await assert.rejects(access(f.marker));
  },
);
test(
  "kotlin-extensions lifecycle acceptance",
  { ...options, timeout: 180000 },
  async (t) => {
    for (const mode of ["cancel", "timeout", "output"]) {
      const f = await mixedKotlinFixture(t),
        marker = path.join(f.root, ".checktrail/waiting");
      await writeFile(
        path.join(f.root, "generators/BuildKotlinGenerator.java"),
        waitingKotlinGenerator(mode),
      );
      await writeFile(
        path.join(f.root, "checktrail.json"),
        JSON.stringify({
          schemaVersion: 1,
          projects: [
            {
              path: ".",
              checks: ["jvm.kotlin"],
              environment: ["CHECKTRAIL_KOTLIN_WAITING"],
            },
          ],
        }),
      );
      const before = (await readdir("/tmp"))
          .filter((n) => n.startsWith("checktrail-command-"))
          .sort(),
        abort = new AbortController();
      const pending = validate(f.root, {
        trusted: true,
        timeoutMs: mode === "timeout" ? 10000 : 60000,
        signal: abort.signal,
        environment: { CHECKTRAIL_KOTLIN_WAITING: marker },
      });
      void pending.catch(() => {});
      let ids:
        | { parent: number; child: number; temporary: string; token: string }
        | undefined;
      try {
        const deadline = performance.now() + 8000;
        while (performance.now() < deadline) {
          try {
            ids = JSON.parse(await readFile(marker + ".ready", "utf8"));
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await delay(10);
        }
        assert.ok(
          ids,
          "The generator and detached child must be reached before the lifecycle trigger",
        );
        assert.equal(ids.token, mode);
        assert.ok(ids.parent > 1 && ids.child > 1 && ids.parent !== ids.child);
        for (const pid of [ids.parent, ids.child]) process.kill(pid, 0);
        await access(ids.temporary);
        if (mode === "cancel") abort.abort();
        if (mode === "output") await writeFile(marker + ".release", "release");
        const report = await pending,
          result = report.checks[0]!.processes[0]!;
        assert.equal(report.outcome, "incomplete");
        assert.equal(result.cancelled, mode === "cancel");
        assert.equal(result.timedOut, mode === "timeout");
        assert.equal(result.truncated, mode === "output");
        for (const pid of [ids.parent, ids.child]) {
          let alive = true;
          for (let i = 0; i < 300; i++) {
            try {
              process.kill(pid, 0);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH")
                throw error;
              alive = false;
              break;
            }
            await delay(10);
          }
          assert.equal(
            alive,
            false,
            "Every reached native descendant must be reaped",
          );
        }
        await assert.rejects(access(ids.temporary));
        assert.deepEqual(
          (await readdir("/tmp"))
            .filter((n) => n.startsWith("checktrail-command-"))
            .sort(),
          before,
        );
        assert.equal(
          await readFile(path.join(f.root, "build/classes/preserve"), "utf8"),
          "keep",
        );
        await assert.rejects(access(f.marker));
      } finally {
        abort.abort();
        await pending;
      }
    }
  },
);
test(
  "kotlin-extensions installed acceptance",
  { ...options, timeout: 600000 },
  async () => {
    if (process.env.CHECKTRAIL_KOTLIN_EXTENSIONS_INSTALLED === "1") {
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
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "kotlin-extensions",
    };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../scripts/verify-import-context-package.mjs",
            import.meta.url,
          ),
        ),
      ],
      { env, encoding: "utf8", timeout: 570000, maxBuffer: 4 * 1048576 },
    );
    assert.equal(child.status, 0, child.stderr);
    const receipt = JSON.parse(child.stdout);
    assert.equal(receipt.profile.required, 9);
    assert.equal(receipt.profile.passed, 9);
    assert.equal(receipt.profile.complete, true);
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.harnessOutsideInstalledPackage, true);
    if (process.env.CHECKTRAIL_KOTLIN_INSTALL_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_KOTLIN_INSTALL_RECEIPT,
        JSON.stringify(receipt),
        { flag: "wx" },
      );
  },
);
