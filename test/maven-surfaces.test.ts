import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir, access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { validate, createPlan } from "../src/engine.js";
import { reportSchema } from "../src/schemas.js";
import { mavenFixture, mavenPom, mavenSources } from "./maven-fixture.js";
const version = spawnSync("java", ["--version"], {
  encoding: "utf8",
  timeout: 10000,
});
const options = {
  skip:
    version.status === 0 &&
    version.stdout.startsWith("openjdk 25.0.4 ") &&
    version.stdout.includes("Temurin-25.0.4+7") &&
    process.env.CHECKTRAIL_MAVEN_CACHE
      ? false
      : "Pinned Maven/JVM/dependency cache unavailable",
  timeout: 120000,
};
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
async function connect(root: string, allow: boolean) {
  const client = new Client(
    { name: "original-maven-client", version: "1.0.0" },
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
  "native Maven CLI and negotiated MCP preserve failures privacy and operator-only trust",
  options,
  async (t) => {
    const { root } = await mavenFixture(t);
    await writeFile(
      path.join(root, "src/main/java/example/Counter.java"),
      mavenSources["src/main/java/example/Counter.java"].replace(
        "value + 1",
        "value + 2",
      ),
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
        mavenSources["src/main/java/example/Counter.java"],
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
  "native Maven accounts for every declared reactor module and refuses hidden siblings",
  options,
  async (t) => {
    const { root, config } = await mavenFixture(t);
    await writeFile(
      path.join(root, "pom.xml"),
      '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>original-reactor</artifactId><version>1.0.0</version><packaging>pom</packaging><modules><module>first</module><module>second</module></modules></project>',
    );
    const modules: {
      path: string;
      packaging: string;
      testClasses: { file: string; className: string }[];
      supportTests: string[];
    }[] = [{ path: ".", packaging: "pom", testClasses: [], supportTests: [] }];
    for (const name of ["first", "second"]) {
      await mkdir(path.join(root, name, "src/main/java/example"), {
        recursive: true,
      });
      await mkdir(path.join(root, name, "src/test/java/example"), {
        recursive: true,
      });
      await writeFile(
        path.join(root, name, "pom.xml"),
        mavenPom().replace("original-counter", `original-${name}`),
      );
      for (const [file, text] of Object.entries(mavenSources))
        await writeFile(path.join(root, name, file), text);
      modules.push({ ...config.modules[0]!, path: name });
    }
    // Remove the old root sources before declaring it as an aggregator.
    const { rm } = await import("node:fs/promises");
    await rm(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "checktrail.maven.json"),
      JSON.stringify({ ...config, modules }),
    );
    await mkdir(path.join(root, "src/main/java"), { recursive: true });
    await writeFile(
      path.join(root, "src/main/java/Orphan.java"),
      "class Orphan {}\n",
    );
    assert.match(
      (await createPlan(root)).plan.checks[0]!.unavailableReason!,
      /Aggregator Java/,
    );
    await rm(path.join(root, "src"), { recursive: true });
    const good = await validate(root, { trusted: true, timeoutMs: 120000 });
    assert.equal(good.outcome, "passed", JSON.stringify(good.checks));
    assert.deepEqual(good.checks[0]!.tests, {
      total: 4,
      passed: 4,
      failed: 0,
      skipped: 0,
    });
    await writeFile(
      path.join(root, "first/src/main/java/example/Counter.java"),
      mavenSources["src/main/java/example/Counter.java"].replace(
        "value + 1",
        "value + 2",
      ),
    );
    const broken = await validate(root, { trusted: true, timeoutMs: 120000 });
    assert.equal(broken.outcome, "failed");
    assert.deepEqual(broken.checks[0]!.tests, {
      total: 4,
      passed: 2,
      failed: 2,
      skipped: 0,
    });
    await writeFile(
      path.join(root, "second/pom.xml"),
      mavenPom()
        .replace("original-counter", "original-second")
        .replace(
          "<dependencies>",
          "<dependencies><dependency><groupId>example</groupId><artifactId>original-first</artifactId><version>1.0.0</version></dependency>",
        ),
    );
    const blocked = await validate(root, { trusted: true, timeoutMs: 120000 });
    assert.equal(blocked.outcome, "failed");
    assert.equal(blocked.checks[0]!.findingsComplete, false);
    assert.deepEqual(blocked.checks[0]!.tests, {
      total: 2,
      passed: 0,
      failed: 2,
      skipped: 0,
    });
    await writeFile(
      path.join(root, "checktrail.maven.json"),
      JSON.stringify({ ...config, modules: modules.slice(0, 2) }),
    );
    assert.match(
      (await createPlan(root)).plan.checks[0]!.unavailableReason!,
      /every inventoried Maven module/,
    );
  },
);
test(
  "native Maven cancellation reaches the running test and removes owned descendants and temporary outputs",
  options,
  async (t) => {
    const { root } = await mavenFixture(t),
      marker = path.join(root, ".checktrail/started");
    await writeFile(
      path.join(root, "src/test/java/example/CounterTest.java"),
      'package example; import org.junit.jupiter.api.Test; public class CounterTest { @Test void waitForCancellation() throws Exception { var marker=java.nio.file.Path.of(System.getenv("CHECKTRAIL_MAVEN_STARTED")); var prepared=java.nio.file.Path.of(marker.toString()+".prepared"); java.nio.file.Files.writeString(prepared,Long.toString(ProcessHandle.current().pid())); java.nio.file.Files.move(prepared,marker); Thread.sleep(60000); } }',
    );
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: ".",
            checks: ["jvm.maven-test"],
            environment: ["CHECKTRAIL_MAVEN_STARTED"],
          },
        ],
      }),
    );
    const before = (await readdir("/tmp"))
        .filter((name) => name.startsWith("checktrail-command-"))
        .sort(),
      controller = new AbortController();
    const running = validate(root, {
      trusted: true,
      timeoutMs: 120000,
      signal: controller.signal,
      environment: { CHECKTRAIL_MAVEN_STARTED: marker },
    });
    let reached = false,
      pid = 0;
    const deadline = Date.now() + 30000;
    try {
      while (Date.now() < deadline) {
        try {
          pid = Number(await readFile(marker, "utf8"));
          reached = Number.isSafeInteger(pid) && pid > 0;
          if (reached) break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(reached, true, "Native test reached before cancellation");
    } finally {
      controller.abort();
      await running;
    }
    const report = await running;
    assert.equal(report.outcome, "incomplete");
    assert.ok(report.checks[0]!.processes.some((process) => process.cancelled));
    await assert.rejects(access(path.join(root, "target")));
    assert.deepEqual(
      (await readdir("/tmp"))
        .filter((name) => name.startsWith("checktrail-command-"))
        .sort(),
      before,
    );
    let alive = true;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          alive = false;
          break;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(alive, false, "Native test descendant was reaped");
  },
);
