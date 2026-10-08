import assert from "node:assert/strict";
import {
  access,
  readdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { runProcess } from "../src/runner.js";
import { evaluate } from "../src/evidence.js";
import { createPlan, validate } from "../src/engine.js";
import {
  scalaFixture,
  nativeOptions,
  scalaConfig,
  fixedScala,
} from "./scala-fixture.js";
test(
  "native Scala accounts resolved declaration expression type and alias suppressions without matching identifier prefixes",
  nativeOptions,
  async (t) => {
    const root = await scalaFixture(t);
    for (const source of [
      'import scala.annotation.nowarn\nobject Original { @nowarn("msg=match may not be exhaustive") def n(x: Option[Int]): Int = x match { case Some(n) => n } }\n',
      'import scala.annotation.nowarn as Quiet\nobject Original { @Quiet("msg=match may not be exhaustive") def n(x: Option[Int]): Int = x match { case Some(n) => n } }\n',
      "object Original { def n(x: Option[Int]): Int = (x: @unchecked) match { case Some(n) => n } }\n",
      "import scala.unchecked as Quiet\nobject Original { def n(x: Option[Int]): Int = (x: @Quiet) match { case Some(n) => n } }\n",
      "import scala.annotation.unchecked.uncheckedVariance\nclass Original[+A] { var value: A @uncheckedVariance = null.asInstanceOf[A] }\n",
    ]) {
      await writeFile(path.join(root, "Original.scala"), source);
      const report = await validate(root, { trusted: true });
      assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
      assert.equal(report.checks[0]!.status, "inconclusive");
      const d = JSON.parse(report.checks[0]!.processes[0]!.stdout);
      assert.equal(d.native.errors, 0);
      assert.ok(
        d.native.sources.some((s: { annotations: string[] }) =>
          s.annotations.some((a) =>
            [
              "scala.annotation.nowarn",
              "scala.unchecked",
              "scala.annotation.unchecked.uncheckedVariance",
            ].includes(a),
          ),
        ),
      );
    }
  },
);
test(
  "native Scala retains partial syntax failures BOM and empty files and never executes application initialization",
  nativeOptions,
  async (t) => {
    const root = await scalaFixture(t, {
      "Original.scala": "object Original { def broken( }\n",
    });
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, false);
    assert.ok(
      report.checks[0]!.findings!.every((f) => f.file === "Original.scala"),
    );
    await writeFile(path.join(root, "Original.scala"), "\ufeff" + fixedScala);
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.ok(
      report.checks[0]!.findings!.some((f) =>
        f.message.includes("illegal character"),
      ),
    );
    await writeFile(path.join(root, "Original.scala"), "");
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    const d = JSON.parse(report.checks[0]!.processes[0]!.stdout);
    assert.ok(
      d.native.sources.some(
        (s: { bytes: number; compiled: number }) =>
          s.bytes === 0 && s.compiled === 1,
      ),
    );
    const marker = path.join(root, "executed");
    await writeFile(
      path.join(root, "Original.scala"),
      "object Original { val initializer = java.nio.file.Files.writeString(java.nio.file.Path.of(" +
        JSON.stringify(marker) +
        '),"unexpected") }\n',
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    await assert.rejects(access(marker), { code: "ENOENT" });
    await writeFile(
      path.join(root, "Original.scala"),
      Buffer.from([0xc3, 0x28]),
    );
    report = await validate(root, { trusted: true });
    assert.notEqual(report.outcome, "passed");
    assert.equal(report.checks[0]!.findingsComplete, false);
  },
);
test(
  "native Scala rejects changed artifacts links scripts mixed sources and empty selected scope",
  nativeOptions,
  async (t) => {
    const root = await scalaFixture(t),
      archive = path.join(root, scalaConfig.archive),
      bytes = await readFile(archive);
    await writeFile(archive, bytes.subarray(1));
    assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
    await writeFile(archive, bytes);
    await rm(archive);
    await writeFile(path.join(root, ".checktrail/real.zip"), bytes);
    await symlink("real.zip", archive);
    assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
    await rm(archive);
    await writeFile(archive, bytes);
    for (const [name, text] of [
      ["Other.kt", "class Other"],
      ["Other.java", "class Other {}"],
      ["NeverRun.sc", 'sys.error("never execute")'],
    ]) {
      await writeFile(path.join(root, name!), text!);
      assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
      await rm(path.join(root, name!));
    }
    await rm(path.join(root, "Original.scala"));
    await rm(path.join(root, "Another with spaces.scala"));
    assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
  },
);
test(
  "native Scala cancellation kills the reached compiler JVM and removes owned snapshots and runtime libraries",
  nativeOptions,
  async (t) => {
    const cancellationSource =
      fixedScala + "// original-cancellation-profile\n";
    const root = await scalaFixture(
        t,
        Object.fromEntries([
          ["Original.scala", cancellationSource],
          ...Array.from({ length: 200 }, (_, i) => [
            `Extra${i}.scala`,
            `object Extra${i} { val answer: Int = ${i} }\n`,
          ]),
        ]),
      ),
      controller = new AbortController();
    const check = (await createPlan(root)).plan.checks[0]!;
    const pending = runProcess(root, check.commands[0]!, {
      signal: controller.signal,
      timeoutMs: 120000,
      maxOutputBytes: 16 * 1024 * 1024,
    });
    let owned: string | undefined, jvm: string | undefined;
    try {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline && !owned) {
        for (const name of await readdir(tmpdir())) {
          if (!name.startsWith("checktrail-command-")) continue;
          const candidate = path.join(tmpdir(), name);
          try {
            for (const child of await readdir(candidate)) {
              if (!child.startsWith("checktrail-scala-")) continue;
              const source = await readFile(
                path.join(candidate, child, "snapshot/Original.scala"),
                "utf8",
              );
              if (source === cancellationSource) {
                owned = candidate;
                break;
              }
            }
          } catch {
            /* A concurrently exiting original process may remove its own evidence. */
          }
        }
        if (!owned) await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(owned, "Selected physical inputs must precede cancellation");
      while (Date.now() < deadline && !jvm) {
        for (const pid of await readdir("/proc")) {
          if (!/^\d+$/.test(pid)) continue;
          try {
            const cmd = await readFile(`/proc/${pid}/cmdline`, "utf8");
            if (
              cmd.includes("\0VerifierScala\0") &&
              cmd.includes(owned! + path.sep)
            ) {
              jvm = `/proc/${pid}`;
              break;
            }
          } catch {
            /* A concurrently exiting original process may remove its own evidence. */
          }
        }
        if (!jvm) await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(
        jvm,
        "A native selected-source compiler JVM must precede cancellation",
      );
      controller.abort();
      const result = await pending;
      assert.equal(result.cancelled, true);
      assert.equal(result.timedOut, false);
      const cancelled = evaluate(check, [result], root);
      assert.equal(cancelled.status, "inconclusive");
      assert.equal(cancelled.reason, "Execution was cancelled.");
      assert.notEqual(cancelled.findingsComplete, true);
      await assert.rejects(access(owned!), { code: "ENOENT" });
      let stopped = false;
      const stopDeadline = Date.now() + 2000;
      while (Date.now() < stopDeadline && !stopped) {
        try {
          const state = await readFile(path.join(jvm!, "stat"), "utf8");
          stopped = state.slice(state.lastIndexOf(")") + 2).startsWith("Z ");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          stopped = true;
        }
        if (!stopped) await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(
        stopped,
        true,
        "Owned compiler must stop before cleanup succeeds",
      );
    } finally {
      controller.abort();
      await pending;
    }
  },
);

test(
  "native Scala empty or comment-only declaration inventories remain incomplete after genuine frontend backend and source callbacks",
  nativeOptions,
  async (t) => {
    const root = await scalaFixture(t, {
      "Original.scala": "",
      "Another with spaces.scala": "// original empty declaration control\n",
    });
    const report = await validate(root, { trusted: true });
    assert.equal(
      report.checks[0]!.status,
      "inconclusive",
      JSON.stringify(report.checks),
    );
    assert.equal(report.checks[0]!.findingsComplete, false);
    const d = JSON.parse(report.checks[0]!.processes[0]!.stdout);
    assert.equal(d.native.errors, 0);
    assert.equal(d.native.completeStages, 1);
    assert.equal(d.native.declarations, 0);
    assert.ok(
      d.native.sources.every((s: { compiled: number }) => s.compiled === 1),
    );
  },
);
