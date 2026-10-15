import assert from "node:assert/strict";
import {
  access,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { evaluate } from "../src/evidence.js";
import { runProcess } from "../src/runner.js";
import { projectReport } from "../src/output.js";
import { spotbugsExtensionsEvidenceSchema } from "../src/spotbugs-extensions-contract.js";
import { detektExtensionsEvidenceSchema } from "../src/detekt-extensions-evidence.js";
import {
  analyzerFixture,
  originalAnalyzerSource,
  originalAnalyzerGenerator,
} from "./spotbugs-extensions-fixture.js";
import { nativeSpotbugs } from "./spotbugs-fixture.js";
import {
  fullDetektFixture,
  fullDetektOptions,
  originalTypedBroken,
  originalTypedFixed,
  originalTypedNearMiss,
} from "./detekt-extensions-fixture.js";
import { jvmWaitingGenerator } from "./jvm-wrappers-fixture.js";
const skip =
  nativeSpotbugs && !fullDetektOptions.skip
    ? false
    : "Prepared pinned native analyzer runtime unavailable";
const options = { skip, timeout: 300000 };
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
const brief = (value: { status: string; reason: string }) =>
  JSON.stringify({ status: value.status, reason: value.reason });
async function pair(t: TestContext, broken = false, near = false) {
  const spot = await analyzerFixture(t, broken, near),
    detekt = await fullDetektFixture(
      t,
      broken
        ? originalTypedBroken
        : near
          ? originalTypedNearMiss
          : originalTypedFixed,
    );
  return [spot.root, detekt] as const;
}
test("jvm-analyzer-extensions broken acceptance", options, async (t) => {
  const [spot, detekt] = await pair(t, true),
    s = (await run(spot)).checks[0]!,
    d = (await run(detekt)).checks[0]!;
  assert.equal(s.status, "failed", brief(s));
  assert.equal(d.status, "failed", brief(d));
  assert.equal(s.findingsComplete, true);
  assert.equal(d.findingsComplete, true);
  assert.deepEqual(
    s.findings
      ?.filter((f) => f.ruleId.endsWith("/CHECKTRAIL_UNSAFE_VALUE"))
      .map((f) => f.file)
      .sort(),
    [
      "application/src/main/java/demo/Original.java",
      "generators/OriginalGenerator.java",
    ],
  );
  assert.ok(
    d.findings?.some(
      (f) =>
        f.ruleId.endsWith("/UnnecessarySafeCall") &&
        f.file === "Original.kt" &&
        f.line === 1,
    ),
  );
  assert.ok(
    d.findings?.some(
      (f) =>
        f.ruleId === "kotlin/UNNECESSARY_SAFE_CALL" && f.file === "Original.kt",
    ),
  );
});
test("jvm-analyzer-extensions fixed acceptance", options, async (t) => {
  const [spot, detekt] = await pair(t, true);
  await writeFile(
    path.join(spot, "application/src/main/java/demo/Original.java"),
    originalAnalyzerSource(false),
  );
  await writeFile(
    path.join(spot, "generators/OriginalGenerator.java"),
    originalAnalyzerGenerator(false),
  );
  await writeFile(path.join(detekt, "Original.kt"), originalTypedFixed);
  for (const root of [spot, detekt]) {
    const result = (await run(root)).checks[0]!;
    assert.equal(result.status, "passed", brief(result));
    assert.equal(result.findingsComplete, true);
    assert.deepEqual(result.findings, []);
    if (result.id === "jvm.spotbugs") {
      const p = spotbugsExtensionsEvidenceSchema.parse(
        JSON.parse(result.processes[0]!.stdout),
      );
      assert.equal(p.generated.length, 1);
      assert.equal(p.modules.length, 2);
      assert.equal(p.analysis!.stats.length, 3);
      assert.equal(p.analysis!.bugs.length, 0);
      assert.equal(p.plugins.length, 1);
    } else {
      const p = detektExtensionsEvidenceSchema.parse(
        JSON.parse(result.processes[0]!.stdout),
      );
      assert.equal(p.native!.typed.length, 2);
      assert.ok(p.native!.rules.some((r) => r.requiresAnalysisApi));
      assert.ok(
        p.native!.typed.every(
          (s) => s.sdk.length > 1 && s.symbols.every((v) => v === "SOURCE"),
        ),
      );
    }
  }
});
test("jvm-analyzer-extensions near-miss acceptance", options, async (t) => {
  const [spot, detekt] = await pair(t, false, true);
  await writeFile(
    path.join(detekt, "SuppressAdditional.kt"),
    "annotation class SuppressAdditional(val rule: String)\n",
  );
  await writeFile(
    path.join(detekt, "Original.kt"),
    '@SuppressAdditional("UNNECESSARY_SAFE_CALL")\n' + originalTypedNearMiss,
  );
  for (const root of [spot, detekt]) {
    const result = (await run(root)).checks[0]!;
    assert.equal(result.status, "passed", brief(result));
    assert.equal(result.findingsComplete, true);
  }
  await writeFile(path.join(detekt, "Original.kts"), "val original = 1\n");
  assert.equal(
    (await createPlan(detekt)).plan.checks[0]!.commands.length,
    0,
    "Full Analysis API script sources remain visibly unsupported",
  );
  const config = JSON.parse(
    await readFile(path.join(spot, "checktrail.spotbugs.json"), "utf8"),
  );
  config.extensions.jpms.pop();
  await writeFile(
    path.join(spot, "checktrail.spotbugs.json"),
    JSON.stringify(config),
  );
  assert.equal(
    (await createPlan(spot)).plan.checks[0]!.commands.length,
    0,
    "Mixed named and unnamed cohorts cannot silently share a module path",
  );
});
async function flip(file: string, callback: () => Promise<void>) {
  const handle = await open(file, "r+");
  const byte = Buffer.alloc(1);
  await handle.read(byte, 0, 1, 0);
  const original = byte[0]!;
  try {
    await handle.write(Buffer.from([original ^ 1]), 0, 1, 0);
    await callback();
  } finally {
    await handle.write(Buffer.from([original]), 0, 1, 0);
    await handle.close();
  }
}
test("jvm-analyzer-extensions prerequisite acceptance", options, async (t) => {
  const f = await analyzerFixture(t),
    detekt = await fullDetektFixture(t);
  for (const [root, relative] of [
    [f.root, ".checktrail/spotbugs.tgz"],
    [f.root, ".checktrail/rules.jar"],
    [detekt, ".checktrail/detekt.jar"],
    [detekt, ".checktrail/kotlin.zip"],
  ]) {
    // Kotlin's selected archive path is read from configuration, not guessed.
    const actual =
      relative === ".checktrail/kotlin.zip"
        ? (JSON.parse(
            await readFile(path.join(root!, "checktrail.detekt.json"), "utf8"),
          ).types.kotlinArchive as string)
        : relative!;
    await flip(path.join(root!, actual), async () => {
      const check = (await createPlan(root!)).plan.checks[0]!;
      assert.equal(check.commands.length, 0, actual);
      assert.ok(check.unavailableReason);
      const result = (await run(root!)).checks[0]!;
      assert.equal(result.status, "unavailable", actual);
      assert.equal(result.processes.length, 0);
    });
  }
  await assert.rejects(access(f.marker));
});
test("jvm-analyzer-extensions stale acceptance", options, async (t) => {
  const [spot, detekt] = await pair(t);
  for (const root of [spot, detekt]) {
    const check = (await createPlan(root)).plan.checks[0]!,
      result = (await run(root)).checks[0]!;
    assert.equal(result.status, "passed", brief(result));
    const file = path.join(
        root,
        check.id === "jvm.spotbugs"
          ? "application/src/main/java/demo/Original.java"
          : "Original.kt",
      ),
      before = await readFile(file);
    try {
      await writeFile(
        file,
        Buffer.concat([before, Buffer.from("\n// original changed source\n")]),
      );
      assert.equal(
        evaluate(check, result.processes, root).status,
        "inconclusive",
      );
    } finally {
      await writeFile(file, before);
    }
    const config = path.join(
        root,
        check.id === "jvm.spotbugs"
          ? "checktrail.java.json"
          : "checktrail.detekt.json",
      ),
      previous = await readFile(config);
    try {
      await writeFile(config, Buffer.concat([previous, Buffer.from("\n")]));
      assert.equal(
        evaluate(check, result.processes, root).status,
        "inconclusive",
        "Exact physical policy bytes bind the receipt even if normalized JSON is equivalent",
      );
    } finally {
      await writeFile(config, previous);
    }
  }
});
test("jvm-analyzer-extensions empty acceptance", options, async (t) => {
  const [spot, detekt] = await pair(t);
  for (const root of [spot, detekt]) {
    const check = (await createPlan(root)).plan.checks[0]!,
      result = (await run(root)).checks[0]!,
      process = result.processes[0]!;
    assert.equal(result.status, "passed", brief(result));
    for (const stdout of ["", "{}", process.stdout.slice(0, -1)])
      assert.equal(
        evaluate(check, [{ ...process, stdout }], root).findingsComplete,
        false,
      );
    for (const change of [
      { truncated: true },
      { cancelled: true },
      { timedOut: true },
      { exitCode: 2 },
    ])
      assert.notEqual(
        evaluate(check, [{ ...process, ...change }], root).findingsComplete,
        true,
      );
    const p = JSON.parse(process.stdout);
    if (check.id === "jvm.spotbugs") p.analysis.stats = [];
    else p.native.typed = [];
    assert.equal(
      evaluate(check, [{ ...process, stdout: JSON.stringify(p) }], root)
        .findingsComplete,
      false,
    );
  }
});
test("jvm-analyzer-extensions privacy acceptance", options, async (t) => {
  for (const root of await pair(t)) {
    const report = await run(root);
    assert.equal(report.outcome, "passed");
    assert.ok(!JSON.stringify(projectReport(report, false)).includes(root));
    const denied = spawnSync(process.execPath, [cli, "run", "--root", root], {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /trust/i);
    for (const detailed of [false, true]) {
      const args = ["--root", root, ...(detailed ? ["--detailed"] : [])],
        cliRun = spawnSync(
          process.execPath,
          [cli, "run", ...args, "--trust-project", "--timeout-ms", "120000"],
          { encoding: "utf8", timeout: 150000, maxBuffer: 4 * 1048576 },
        );
      assert.equal(cliRun.status, 0, cliRun.stderr);
      assert.equal(JSON.parse(cliRun.stdout).outcome, "passed");
      assert.equal(cliRun.stdout.includes(root), detailed);
      const client = new Client(
        { name: "original-jvm-analyzer-client", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      try {
        await client.connect(
          new StdioClientTransport({
            env: {
              TMPDIR: tmpdir(),
              TMP: tmpdir(),
              TEMP: tmpdir(),
              ...(process.env.JAVA_HOME
                ? { JAVA_HOME: process.env.JAVA_HOME }
                : {}),
            },
            command: process.execPath,
            args: [
              cli,
              "serve",
              ...args,
              "--allow-execution",
              "--timeout-ms",
              "120000",
            ],
            stderr: "pipe",
          }),
        );
        const response = await client.callTool({
          name: "validation_run",
          arguments: {},
        });
        assert.notEqual(response.isError, true);
        assert.equal(
          (response.structuredContent as { outcome: string }).outcome,
          "passed",
        );
        assert.equal(JSON.stringify(response).includes(root), detailed);
        assert.equal(
          (
            await client.callTool({
              name: "validation_run",
              arguments: { trusted: true },
            })
          ).isError,
          true,
        );
      } finally {
        await client.close();
      }
    }
    const untrusted = new Client(
      { name: "original-jvm-analyzer-denied", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await untrusted.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [cli, "serve", "--root", root],
          stderr: "pipe",
        }),
      );
      assert.equal(
        (await untrusted.callTool({ name: "validation_run", arguments: {} }))
          .isError,
        true,
      );
    } finally {
      await untrusted.close();
    }
  }
});
async function gone(pid: number) {
  for (let n = 0; n < 300; n++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return;
    }
    await delay(10);
  }
  assert.fail("Reached native process must be reaped: " + pid);
}
test("jvm-analyzer-extensions lifecycle acceptance", options, async (t) => {
  for (const mode of ["cancel", "timeout", "output"]) {
    const f = await analyzerFixture(t),
      marker = path.join(f.root, ".checktrail/waiting");
    await writeFile(
      path.join(f.root, "generators/OriginalGenerator.java"),
      jvmWaitingGenerator(mode)
        .replaceAll("gen.BuildJavaGenerator", "generator.OriginalGenerator")
        .replace("package gen;", "package generator;")
        .replace("class BuildJavaGenerator", "class OriginalGenerator"),
    );
    await writeFile(
      path.join(f.root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: ".",
            checks: ["jvm.spotbugs"],
            environment: ["CHECKTRAIL_JVM_WAITING"],
          },
        ],
      }),
    );
    const before = (await readdir(tmpdir()))
        .filter((n) => n.startsWith("checktrail-command-"))
        .sort(),
      abort = new AbortController(),
      pending = validate(f.root, {
        trusted: true,
        timeoutMs: mode === "timeout" ? 15000 : 60000,
        signal: abort.signal,
        environment: { CHECKTRAIL_JVM_WAITING: marker },
      });
    void pending.catch(() => {});
    let ids:
      | { parent: number; child: number; temporary: string; token: string }
      | undefined;
    try {
      const deadline = performance.now() + 11000;
      while (performance.now() < deadline) {
        try {
          ids = JSON.parse(await readFile(marker + ".ready", "utf8"));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await delay(10);
        }
      }
      assert.ok(
        ids,
        "Native generator and detached Java child must reach the trigger",
      );
      assert.equal(ids.token, mode);
      assert.notEqual(ids.parent, ids.child);
      process.kill(ids.parent, 0);
      process.kill(ids.child, 0);
      await access(ids.temporary);
      if (mode === "cancel") abort.abort();
      else if (mode === "output")
        await writeFile(marker + ".release", "release");
      const report = await pending,
        result = report.checks[0]!.processes[0]!;
      assert.equal(report.outcome, "incomplete");
      assert.equal(result.cancelled, mode === "cancel");
      assert.equal(result.timedOut, mode === "timeout");
      assert.equal(result.truncated, mode === "output");
      for (const pid of [ids.parent, ids.child]) await gone(pid);
      await assert.rejects(access(ids.temporary));
      assert.deepEqual(
        (await readdir(tmpdir()))
          .filter((n) => n.startsWith("checktrail-command-"))
          .sort(),
        before,
      );
    } finally {
      abort.abort();
      await pending;
      await rm(f.root, { recursive: true, force: true });
    }
  }
  for (const mode of ["cancel", "timeout", "output"]) {
    const source =
      mode === "output"
        ? Array.from(
            { length: 200 },
            (_, i) =>
              `fun originalNormalize${i}(value: String): String = value?.trim() ?: ""`,
          ).join("\n") + "\n"
        : originalTypedFixed;
    const root = await fullDetektFixture(t, source),
      before = (await readdir(tmpdir()))
        .filter((n) => n.startsWith("checktrail-command-"))
        .sort(),
      abort = new AbortController(),
      check = (await createPlan(root)).plan.checks[0]!,
      pending = runProcess(root, check.commands[0]!, {
        timeoutMs: mode === "timeout" ? 15000 : 60000,
        maxOutputBytes: mode === "output" ? 4096 : 2 * 1048576,
        signal: abort.signal,
      });
    void pending.catch(() => {});
    let reached: { pid: number; temporary: string } | undefined;
    try {
      const deadline = performance.now() + 11000;
      while (!reached && performance.now() < deadline) {
        for (const pid of (await readdir("/proc")).filter((n) =>
          /^[1-9][0-9]*$/.test(n),
        )) {
          try {
            const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split(
              "\0",
            );
            const modeIndex = args.indexOf("--analysis-mode");
            if (
              modeIndex < 0 ||
              args[modeIndex + 1] !== "full" ||
              !args.includes("--jdk-home")
            )
              continue;
            const cwd = await readlink(`/proc/${pid}/cwd`),
              temporary = path.dirname(cwd);
            if (
              !path.basename(cwd).startsWith("checktrail-detekt-full-") ||
              !path.basename(temporary).startsWith("checktrail-command-")
            )
              continue;
            reached = { pid: Number(pid), temporary };
            break;
          } catch (error) {
            if (
              !["ENOENT", "EACCES", "ESRCH"].includes(
                (error as NodeJS.ErrnoException).code ?? "",
              )
            )
              throw error;
          }
        }
        if (!reached) await delay(5);
      }
      assert.ok(
        reached,
        "The pinned full detekt JVM must launch before the lifecycle trigger",
      );
      process.kill(reached.pid, 0);
      await access(reached.temporary);
      if (mode === "cancel") abort.abort();
      if (mode === "timeout") process.kill(reached.pid, "SIGSTOP");
      const result = await pending;
      assert.notEqual(evaluate(check, [result], root).status, "passed");
      assert.notEqual(evaluate(check, [result], root).findingsComplete, true);
      assert.equal(result.cancelled, mode === "cancel");
      assert.equal(result.timedOut, mode === "timeout");
      assert.equal(result.truncated, mode === "output");
      await gone(reached.pid);
      await assert.rejects(access(reached.temporary));
      assert.deepEqual(
        (await readdir(tmpdir()))
          .filter((n) => n.startsWith("checktrail-command-"))
          .sort(),
        before,
      );
    } finally {
      abort.abort();
      await pending;
      await rm(root, { recursive: true, force: true });
    }
  }
});
test(
  "jvm-analyzer-extensions installed acceptance",
  { skip, timeout: 600000 },
  async () => {
    if (process.env.CHECKTRAIL_JVM_ANALYZER_EXTENSIONS_INSTALLED === "1") {
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
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "jvm-analyzer-extensions",
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
    if (process.env.CHECKTRAIL_JVM_ANALYZER_INSTALL_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_JVM_ANALYZER_INSTALL_RECEIPT,
        JSON.stringify(receipt),
        { flag: "wx" },
      );
  },
);
