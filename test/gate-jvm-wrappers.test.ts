import assert from "node:assert/strict";
import {
  access,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { evaluate } from "../src/evidence.js";
import { projectReport } from "../src/output.js";
import { runProcess } from "../src/runner.js";
import { jvmWrapperPins } from "../src/jvm-wrapper-pins.js";
import { jvmExtensionPacketSchema } from "../src/jvm-workspace-extensions.js";
import type { z } from "zod";
import type { CheckResult } from "../src/types.js";
import { createPlan, validate } from "../src/engine.js";
import {
  jvmAtomic,
  jvmDecision,
  jvmGenerator,
  jvmWaitingGenerator,
  jvmOriginal,
  jvmWrappersSkip as skip,
} from "./jvm-wrappers-fixture.js";
import type { JvmKind } from "../src/jvm-extensions.js";
const kinds: JvmKind[] = ["maven", "gradle"];
test("jvm-wrappers fixed acceptance", { skip, timeout: 240000 }, async (t) => {
  for (const kind of kinds) {
    const f = await jvmOriginal(t, kind, true);
    const planned = await createPlan(f.root);
    assert.equal(
      planned.plan.checks[0]!.commands.length,
      1,
      planned.plan.checks[0]!.unavailableReason ?? "Selected native invocation",
    );
    const report = await validate(f.root, { trusted: true, timeoutMs: 120000 });
    const check = report.checks[0]!;
    assert.equal(check.status, "passed", JSON.stringify(check));
    assert.equal(check.findingsComplete, true);
    assert.deepEqual(check.tests, {
      total: 4,
      passed: 4,
      failed: 0,
      skipped: 0,
    });
    const packet = JSON.parse(check.processes[0]!.stdout);
    assert.equal(packet.extensions.generated.length, 1);
    assert.equal(packet.extensions.generatedClasses.length, 2);
    assert.equal(packet.extensions.modules.length, 2);
    assert.equal(
      packet.extensions.generatedClasses[0].className,
      "policy.Rules",
    );
    assert.equal(
      await readFile(path.join(f.root, "policy", f.output, "preserve"), "utf8"),
      "keep",
    );
  }
});

type Native = {
  extensions: z.infer<typeof jvmExtensionPacketSchema>;
  distribution: string;
  workspace: string;
  launcherPid: number;
  events: {
    type: string;
    processId?: number;
    wrapperAncestors?: number[];
    projects?: { sourceSets?: { name: string; java: string[] }[] }[];
    task?: { source?: string[] };
  }[];
  tests: { type: string; test?: boolean; status?: string }[];
  modules: {
    path: string;
    inputs?: { compile: string[]; testCompile: string[] };
    reports: unknown[];
  }[];
};
const receipt = (check: CheckResult): Native =>
  JSON.parse(check.processes[0]!.stdout) as Native;
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
const nativeOptions = { skip, timeout: 240000 };
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("jvm-wrappers broken acceptance", nativeOptions, async (t) => {
  for (const kind of kinds) {
    const f = await jvmOriginal(t, kind);
    const result = await run(f.root),
      check = result.checks[0]!;
    assert.equal(check.status, "failed", JSON.stringify(check));
    assert.equal(check.findingsComplete, true);
    assert.deepEqual(check.tests, {
      total: 4,
      passed: 3,
      failed: 1,
      skipped: 0,
    });
    const packet = receipt(check);
    assert.equal(packet.extensions.modules.length, 2);
    assert.equal(
      packet.extensions.generatedClasses[0]!.sourceFile,
      "Rules.java",
    );
    assert.match(check.processes[0]!.stderr, /identifier_boundary/);
  }
});
test("jvm-wrappers near-miss acceptance", nativeOptions, async (t) => {
  for (const kind of kinds) {
    const f = await jvmOriginal(t, kind, true, false);
    await jvmAtomic(
      path.join(f.root, "generators/BuildJavaGenerator.java"),
      jvmGenerator(
        jvmDecision(true).replace(
          'value.startsWith("grant:")',
          'value.equals("grant:read")',
        ),
      ),
    );
    const result = await run(f.root),
      check = result.checks[0]!;
    assert.equal(check.status, "passed", JSON.stringify(check));
    assert.deepEqual(check.tests, {
      total: 4,
      passed: 4,
      failed: 0,
      skipped: 0,
    });
    assert.equal(receipt(check).extensions.modules.length, 0);
    assert.equal(receipt(check).extensions.generatedClasses.length, 2);
    await writeFile(
      path.join(f.root, "policy/src/main/java/module-info.java"),
      "open module unsupported.policy {exports policy;}\n",
    );
    const planned = await createPlan(f.root);
    assert.equal(planned.plan.checks[0]!.commands.length, 0);
  }
});
test("jvm-wrappers prerequisite acceptance", nativeOptions, async (t) => {
  for (const kind of kinds) {
    const f = await jvmOriginal(t, kind, true);
    const generator = path.join(f.root, "generators/BuildJavaGenerator.java");
    await jvmAtomic(
      generator,
      jvmGenerator(jvmDecision(true)).replace(
        "Path output=",
        'Files.writeString(Path.of(System.getenv("CHECKTRAIL_JVM_PREREQUISITE_MARKER")),"executed");Path output=',
      ),
    );
    const marker = path.join(f.root, ".checktrail/imported");
    for (const pin of jvmWrapperPins.filter((p) => p.kind === kind)) {
      const file = path.join(f.root, pin.path),
        original = await readFile(file),
        changed = Buffer.from(original);
      changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
      await writeFile(file, changed);
      try {
        const planned = await createPlan(f.root);
        assert.equal(
          planned.plan.checks[0]!.commands.length,
          0,
          "Every selected wrapper artifact must bind exact bytes: " + pin.path,
        );
        const result = await validate(f.root, {
          trusted: true,
          environment: { CHECKTRAIL_JVM_PREREQUISITE_MARKER: marker },
        });
        assert.equal(result.checks[0]!.status, "unavailable");
        await assert.rejects(access(marker));
      } finally {
        await writeFile(file, original);
      }
    }
    const archive = path.join(f.root, f.config.extensions!.archive),
      handle = await open(archive, "r+");
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, 0);
    const original = byte[0]!;
    byte[0] = byte[0]! ^ 1;
    await handle.write(byte, 0, 1, 0);
    await handle.close();
    try {
      assert.equal(
        (await createPlan(f.root)).plan.checks[0]!.commands.length,
        0,
        "Distribution ZIP must bind exact bytes",
      );
    } finally {
      const restore = await open(archive, "r+");
      try {
        await restore.write(Buffer.from([original]), 0, 1, 0);
      } finally {
        await restore.close();
      }
    }
    const selected = jvmWrapperPins.find(
        (p) => p.kind === kind && p.path.endsWith(".jar"),
      )!,
      jar = path.join(f.root, selected.path),
      bytes = await readFile(jar);
    await rm(jar);
    await symlink(
      path.join(f.root, kind === "maven" ? "mvnw" : "gradlew"),
      jar,
    );
    try {
      assert.equal(
        (await createPlan(f.root)).plan.checks[0]!.commands.length,
        0,
        "Selected wrapper JAR cannot be a link",
      );
    } finally {
      await rm(jar);
      await writeFile(jar, bytes);
    }
    assert.equal((await createPlan(f.root)).plan.checks[0]!.commands.length, 1);
  }
});
test("jvm-wrappers stale acceptance", nativeOptions, async (t) => {
  for (const kind of kinds) {
    const f = await jvmOriginal(t, kind, true),
      plan = (await createPlan(f.root)).plan.checks[0]!,
      result = await run(f.root),
      check = result.checks[0]!,
      process = check.processes[0]!;
    assert.equal(check.status, "passed", JSON.stringify(check));
    assert.equal(evaluate(plan, [process], f.root).status, "passed");
    const mutations: ((p: Native) => void)[] = [
      (p) => {
        p.extensions.wrapper.originalSha256 = "0".repeat(64);
      },
      (p) => {
        p.extensions.wrapper.stagedSha256 = "0".repeat(64);
      },
      (p) => {
        p.extensions.wrapper.archiveSha256 = "0".repeat(64);
      },
      (p) => {
        p.extensions.generated[0]!.sourceSha256 = "0".repeat(64);
      },
      (p) => {
        p.extensions.generated[0]!.outputs[0]!.className = "policy.Foreign";
      },
      (p) => {
        p.extensions.generatedClasses[0]!.className = "policy.Foreign";
      },
      (p) => {
        p.extensions.generatedClasses[0]!.sourceFile = "Foreign.java";
      },
      (p) => {
        p.extensions.modules[1]!.name = "original.foreign";
      },
      (p) => {
        p.extensions.modules[1]!.requires = ["java.base"];
      },
      (p) => {
        p.extensions.modules[0]!.exports = [];
      },
      (p) => {
        p.distribution = path.join(f.root, "caller-owned-distribution");
      },
      (p) => {
        if (kind === "maven")
          p.modules.find((m) => m.path === "policy")!.inputs!.compile =
            p.modules
              .find((m) => m.path === "policy")!
              .inputs!.compile.filter((file) => !file.endsWith("/Rules.java"));
        else
          p.events
            .find((e) => e.type === "projects")!
            .projects!.flatMap((m) => m.sourceSets ?? [])
            .forEach((set) => {
              set.java = set.java.filter(
                (file) => !file.endsWith("/Rules.java"),
              );
            });
      },
      (p) => {
        if (kind === "gradle")
          p.events.find((e) => e.type === "init")!.wrapperAncestors = [
            p.launcherPid + 100000,
          ];
        else p.launcherPid += 100000;
      },
    ];
    for (const mutate of mutations) {
      const packet = receipt(check);
      mutate(packet);
      assert.notEqual(
        evaluate(plan, [{ ...process, stdout: JSON.stringify(packet) }], f.root)
          .status,
        "passed",
      );
    }
    await jvmAtomic(
      path.join(f.root, "generators/BuildJavaGenerator.java"),
      jvmGenerator(jvmDecision(false)),
    );
    const stale = await runProcess(f.root, plan.commands[0]!, {
      timeoutMs: 60000,
    });
    assert.equal(stale.exitCode, 2);
    assert.equal(evaluate(plan, [stale], f.root).status, "error");
    assert.doesNotMatch(stale.stderr, /identifier_boundary/);
  }
});
test("jvm-wrappers empty acceptance", nativeOptions, async (t) => {
  for (const kind of kinds) {
    const f = await jvmOriginal(t, kind, true),
      plan = (await createPlan(f.root)).plan.checks[0]!,
      result = await run(f.root),
      check = result.checks[0]!,
      process = check.processes[0]!;
    assert.equal(check.status, "passed", JSON.stringify(check));
    const omissions: ((p: Native) => void)[] = [
      (p) => {
        p.extensions.generated = [];
      },
      (p) => {
        p.extensions.generatedClasses = [];
      },
      (p) => {
        p.extensions.modules = [];
      },
      (p) => {
        p.tests = [];
      },
      (p) => {
        p.events = p.events.filter((e) => e.type !== "close");
      },
      (p) => {
        p.modules[1]!.reports = [];
      },
    ];
    for (const omit of omissions) {
      const packet = receipt(check);
      omit(packet);
      assert.notEqual(
        evaluate(plan, [{ ...process, stdout: JSON.stringify(packet) }], f.root)
          .status,
        "passed",
      );
    }
    for (const stdout of ["", "{}", process.stdout.slice(0, -1)])
      assert.notEqual(
        evaluate(plan, [{ ...process, stdout }], f.root).status,
        "passed",
      );
    const test = path.join(
      f.root,
      "consumer/src/test/java/checks/ConsumerTest.java",
    );
    await jvmAtomic(
      test,
      (await readFile(test, "utf8")).replaceAll(
        "@Test",
        "@org.junit.jupiter.api.Disabled @Test",
      ),
    );
    const skipped = await run(f.root);
    assert.notEqual(skipped.outcome, "passed");
    assert.ok(skipped.checks[0]!.tests!.skipped > 0);
  }
});
test(
  "jvm-wrappers privacy acceptance",
  { skip, timeout: 360000 },
  async (t) => {
    for (const kind of kinds) {
      const f = await jvmOriginal(t, kind, true),
        report = await run(f.root);
      assert.equal(report.outcome, "passed");
      const summary = JSON.stringify(projectReport(report, false));
      assert.ok(
        !summary.includes(f.root) &&
          !summary.includes("Rules.java") &&
          !summary.includes("PolicyTest"),
      );
      const denied = spawnSync(
        process.execPath,
        [cli, "run", "--root", f.root],
        { encoding: "utf8", timeout: 30000 },
      );
      assert.equal(denied.status, 2);
      assert.match(denied.stderr, /trust/i);
      for (const detailed of [false, true]) {
        const args = ["--root", f.root, ...(detailed ? ["--detailed"] : [])],
          child = spawnSync(
            process.execPath,
            [cli, "run", ...args, "--trust-project", "--timeout-ms", "120000"],
            { encoding: "utf8", timeout: 150000, maxBuffer: 2 * 1048576 },
          );
        assert.equal(child.status, 0, child.stderr);
        assert.equal(JSON.parse(child.stdout).outcome, "passed");
        assert.equal(child.stdout.includes(f.root), detailed);
        const client = new Client(
          { name: "original-jvm-wrapper-client", version: "1" },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } },
        );
        try {
          await client.connect(
            new StdioClientTransport({
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
          assert.equal(JSON.stringify(response).includes(f.root), detailed);
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
        { name: "original-jvm-wrapper-denied", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      try {
        await untrusted.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [cli, "serve", "--root", f.root],
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
  },
);
test(
  "jvm-wrappers installed acceptance",
  { skip, timeout: 600000 },
  async () => {
    if (process.env.CHECKTRAIL_JVM_WRAPPERS_INSTALLED === "1") {
      const actual = await realpath(
        fileURLToPath(new URL("../src/engine.js", import.meta.url)),
      );
      assert.match(
        actual,
        /node_modules\/@stsepelin\/checktrail\/dist\/src\/engine\.js$/,
      );
      return;
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "jvm-wrappers",
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
    if (process.env.CHECKTRAIL_JVM_INSTALL_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_JVM_INSTALL_RECEIPT,
        JSON.stringify(receipt),
        { flag: "wx" },
      );
  },
);

test(
  "jvm-wrappers lifecycle acceptance",
  { skip, timeout: 300000 },
  async (t) => {
    for (const kind of kinds)
      for (const mode of ["cancel", "timeout", "output"]) {
        const f = await jvmOriginal(t, kind, true),
          marker = path.join(f.root, ".checktrail/waiting");
        await jvmAtomic(
          path.join(f.root, "generators/BuildJavaGenerator.java"),
          jvmWaitingGenerator(mode),
        );
        await jvmAtomic(
          path.join(f.root, "checktrail.json"),
          JSON.stringify({
            schemaVersion: 1,
            projects: [
              {
                path: ".",
                checks: [
                  kind === "maven" ? "jvm.maven-test" : "jvm.gradle-test",
                ],
                environment: ["CHECKTRAIL_JVM_WAITING"],
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
          timeoutMs: mode === "timeout" ? 25000 : 60000,
          signal: abort.signal,
          environment: { CHECKTRAIL_JVM_WAITING: marker },
        });
        void pending.catch(() => {});
        let ids:
          | { parent: number; child: number; temporary: string; token: string }
          | undefined;
        try {
          const deadline = performance.now() + 20000;
          while (performance.now() < deadline) {
            try {
              ids = JSON.parse(await readFile(marker + ".ready", "utf8"));
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
              await delay(10);
            }
          }
          assert.ok(
            ids,
            "Native generator and detached Java child must be reached before the lifecycle trigger",
          );
          assert.equal(ids.token, mode);
          assert.ok(
            ids.parent > 1 && ids.child > 1 && ids.parent !== ids.child,
          );
          process.kill(ids.parent, 0);
          process.kill(ids.child, 0);
          assert.ok(path.isAbsolute(ids.temporary));
          assert.match(path.basename(ids.temporary), /^checktrail-command-/);
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
              "Every reached native Java descendant must be reaped",
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
            await readFile(
              path.join(f.root, "policy", f.output, "preserve"),
              "utf8",
            ),
            "keep",
          );
        } finally {
          abort.abort();
          await pending;
          await rm(f.root, { recursive: true, force: true });
        }
      }
  },
);
