import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir, access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { validate } from "../src/engine.js";
import { reportSchema } from "../src/schemas.js";
import { gradleFixture, gradleSources } from "./gradle-fixture.js";
const version = spawnSync("java", ["--version"], {
  encoding: "utf8",
  timeout: 10000,
});
const options = {
  skip:
    version.status === 0 &&
    version.stdout.startsWith("openjdk 25.0.4 ") &&
    version.stdout.includes("Temurin-25.0.4+7") &&
    process.env.CHECKTRAIL_GRADLE_CACHE
      ? false
      : "Pinned Gradle/JVM/dependency cache unavailable",
  timeout: 120000,
};
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
async function connect(root: string, allow: boolean) {
  const client = new Client(
    { name: "original-gradle-client", version: "1.0.0" },
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
          ...(allow ? ["--allow-execution"] : []),
        ],
        stderr: "pipe",
      }),
    );
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
test(
  "native Gradle CLI and negotiated MCP preserve failures privacy and operator-only trust",
  options,
  async (t) => {
    const { root } = await gradleFixture(t);
    await writeFile(
      path.join(root, "src/main/java/example/Counter.java"),
      gradleSources["src/main/java/example/Counter.java"].replace("n+1", "n-1"),
    );
    const invoke = (trusted: boolean, detailed: boolean) =>
      spawnSync(
        process.execPath,
        [
          cli,
          "run",
          "--root",
          root,
          ...(trusted ? ["--trust-project"] : []),
          ...(detailed ? ["--detailed"] : []),
        ],
        { encoding: "utf8", timeout: 30000 },
      );
    const denied = invoke(false, false);
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /trust/i);
    const result = invoke(true, true);
    assert.equal(result.status, 1, result.stderr);
    const report = reportSchema.parse(JSON.parse(result.stdout));
    assert.equal(report.outcome, "failed");
    assert.deepEqual(report.checks[0]!.tests, {
      total: 2,
      passed: 0,
      failed: 2,
      skipped: 0,
    });
    const summary = invoke(true, false);
    assert.equal(summary.status, 1, summary.stderr);
    const summarized = JSON.parse(summary.stdout);
    assert.equal(summarized.outcome, "failed");
    assert.ok(
      !summary.stdout.includes(root) &&
        !summary.stdout.includes("CounterTest") &&
        !summary.stdout.includes("expected:"),
    );
    const client = await connect(root, true);
    try {
      const native = await client.callTool({
        name: "validation_run",
        arguments: {},
      });
      assert.notEqual(native.isError, true);
      assert.equal(
        (native.structuredContent as { outcome: string }).outcome,
        "failed",
      );
      assert.deepEqual(
        (native.structuredContent as { checks: unknown }).checks,
        summarized.checks,
      );
      assert.ok(
        !JSON.stringify(native).includes(root) &&
          !JSON.stringify(native).includes("CounterTest"),
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
      await writeFile(
        path.join(root, "src/main/java/example/Counter.java"),
        gradleSources["src/main/java/example/Counter.java"],
      );
      const fixed = await client.callTool({
        name: "validation_run",
        arguments: {},
      });
      assert.equal(
        (fixed.structuredContent as { outcome: string }).outcome,
        "passed",
      );
    } finally {
      await client.close();
    }
    const untrusted = await connect(root, false);
    try {
      assert.equal(
        (await untrusted.callTool({ name: "validation_run", arguments: {} }))
          .isError,
        true,
      );
    } finally {
      await untrusted.close();
    }
  },
);
test(
  "native Gradle cancellation reaches the running test and removes owned descendants and temporary outputs",
  options,
  async (t) => {
    const { root } = await gradleFixture(t),
      marker = path.join(root, ".checktrail/started");
    await writeFile(
      path.join(root, "src/test/java/example/CounterTest.java"),
      'package example; import org.junit.jupiter.api.Test; public class CounterTest { @Test void waitForCancellation() throws Exception { var marker=java.nio.file.Path.of(System.getenv("CHECKTRAIL_GRADLE_STARTED")); var prepared=java.nio.file.Path.of(marker.toString()+".prepared"); var parent=ProcessHandle.current().parent().orElseThrow(); var arguments=java.util.Arrays.asList(parent.info().arguments().orElseThrow()); var main=arguments.indexOf("-jar"); var client=main>=0 && main+1<arguments.size() && java.nio.file.Path.of(arguments.get(main+1)).getFileName().toString().equals("gradle-gradle-cli-main-9.8.0.jar"); java.nio.file.Files.writeString(prepared,Long.toString(ProcessHandle.current().pid())+","+parent.pid()+","+client); java.nio.file.Files.move(prepared,marker); Thread.sleep(60000); } }',
    );
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: ".",
            checks: ["jvm.gradle-test"],
            environment: ["CHECKTRAIL_GRADLE_STARTED"],
          },
        ],
      }),
    );
    const commandTemporary = path.join(root, ".checktrail/cancel-temporary"),
      previousTemporary = process.env.TMPDIR;
    await mkdir(commandTemporary);
    process.env.TMPDIR = commandTemporary;
    t.after(() => {
      if (previousTemporary === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTemporary;
    });
    const before = (await readdir(commandTemporary))
        .filter((name) => name.startsWith("checktrail-command-"))
        .sort(),
      controller = new AbortController();
    const running = validate(root, {
      trusted: true,
      timeoutMs: 120000,
      signal: controller.signal,
      environment: { CHECKTRAIL_GRADLE_STARTED: marker },
    });
    let reached = false,
      pid = 0,
      buildPid = 0,
      client = false;
    const deadline = Date.now() + 30000;
    try {
      while (Date.now() < deadline) {
        try {
          const [nativePid, nativeParent, nativeRole] = (
            await readFile(marker, "utf8")
          ).split(",");
          pid = Number(nativePid);
          buildPid = Number(nativeParent);
          client = nativeRole === "true";
          reached =
            Number.isSafeInteger(pid) &&
            pid > 0 &&
            Number.isSafeInteger(buildPid) &&
            buildPid > 1;
          if (reached) break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(reached, true, "Native test reached before cancellation");
      assert.equal(
        client,
        true,
        "Native build stays in the owned client JVM before cancellation",
      );
    } finally {
      controller.abort();
      await running;
    }
    const report = await running;
    assert.equal(report.outcome, "incomplete");
    assert.ok(
      report.checks[0]!.processes.some((process) => process.cancelled),
      "Native cancellation remains a retained process result: " +
        JSON.stringify(report),
    );
    await assert.rejects(access(path.join(root, "build")));
    assert.deepEqual(
      (await readdir(commandTemporary))
        .filter((name) => name.startsWith("checktrail-command-"))
        .sort(),
      before,
    );
    for (const selected of [pid, buildPid]) {
      let alive = true;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          process.kill(selected, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            alive = false;
            break;
          }
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        alive,
        false,
        selected === pid
          ? "Native test descendant was reaped"
          : "Native Gradle client was reaped",
      );
    }
  },
);
