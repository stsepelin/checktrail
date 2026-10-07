import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { gradleEvidence, gradlePacketSchema } from "../src/gradle-evidence.js";
import { gradleProtectedEnvironment } from "../src/gradle.js";
import { gradleFixture } from "./gradle-fixture.js";
const native = Boolean(process.env.CHECKTRAIL_GRADLE_CACHE),
  skip = native ? false : "Prepared Gradle toolchain profile unavailable";
test(
  "native Gradle rejects filtered skipped modified task and omitted source evidence",
  { skip },
  async (t) => {
    for (const extra of [
      "test { enabled=false }",
      "test { onlyIf { false } }",
      "test { filter { includeTestsMatching 'example.CounterTest.next' } }",
      "test { ignoreFailures=true }",
      "test { exclude '**/CounterTest.class' }",
      "compileJava { exclude '**/Counter.java' }",
      "test { doFirst { println('extra task action') } }",
    ]) {
      const { root } = await gradleFixture(t, extra);
      const report = await validate(root, { trusted: true, timeoutMs: 120000 });
      assert.notEqual(report.checks[0]!.status, "passed", extra);
    }
    const { root, config } = await gradleFixture(t);
    config.modules[0]!.testClasses = [];
    await writeFile(
      path.join(root, "checktrail.gradle.json"),
      JSON.stringify(config),
    );
    const plan = await createPlan(root);
    assert.equal(plan.plan.checks[0]!.commands.length, 0);
    assert.match(
      plan.plan.checks[0]!.unavailableReason!,
      /declared test classes/,
    );
  },
);
test(
  "native Gradle binds source declarations classpaths native task identities and every terminal",
  { skip },
  async (t) => {
    const { root } = await gradleFixture(t);
    const report = await validate(root, { trusted: true, timeoutMs: 120000 }),
      result = report.checks[0]!,
      check = (await createPlan(root)).plan.checks[0]!;
    assert.equal(result.status, "passed", JSON.stringify(result));
    const baseline = gradlePacketSchema.parse(
      JSON.parse(result.processes[0]!.stdout),
    );
    const mutate = (name: string, edit: (packet: typeof baseline) => void) => {
      const packet = structuredClone(baseline);
      edit(packet);
      const outcome = gradleEvidence(check, [
        { ...result.processes[0]!, stdout: JSON.stringify(packet) },
      ]);
      assert.equal(outcome.status, "inconclusive", name);
    };
    mutate("wrong source receipt", (p) => {
      p.inputSha256 = "0".repeat(64);
    });
    mutate("wrong repository manifest receipt", (p) => {
      p.repositoryManifest += "\n";
    });
    mutate("forged additional artifact", (p) => {
      p.artifacts.push("invented.jar");
    });
    mutate("escaping artifact", (p) => {
      p.artifacts.push("../../outside.jar");
    });
    mutate("detached build process", (p) => {
      p.launcherPid++;
    });
    mutate("wrong configured distribution", (p) => {
      p.distribution = "/wrong/distribution";
      for (const event of p.events)
        if (event.type === "init") event.home = p.distribution;
    });
    mutate("unfinished JUnit plan", (p) => {
      p.tests = p.tests.filter((event) => event.type !== "planFinished");
    });
    mutate("unfinished native build", (p) => {
      p.events = p.events.filter((e) => e.type !== "close");
    });
    mutate("foreign native task", (p) => {
      p.events.find((e) => e.type === "graph")!.tasks[0]!.path = ":foreign";
    });
    mutate("missing native compiler input", (p) => {
      for (const e of p.events) {
        const tasks =
          e.type === "graph"
            ? e.tasks
            : e.type === "taskStarted"
              ? [e.task]
              : e.type === "taskFinished"
                ? [e.snapshot]
                : [];
        for (const task of tasks)
          if (task.role === "compile" && task.path === ":compileJava")
            task.source = [];
      }
    });
    mutate("foreign native classpath", (p) => {
      for (const e of p.events) {
        const tasks =
          e.type === "graph"
            ? e.tasks
            : e.type === "taskStarted"
              ? [e.task]
              : e.type === "taskFinished"
                ? [e.snapshot]
                : [];
        for (const task of tasks)
          if (task.role === "test" && task.path === ":test")
            task.classpath.push("/outside.jar");
      }
    });
    mutate("wrong actual source declaration", (p) => {
      p.modules[0]!.declarations[0]!.file = "/wrong.java";
    });
    mutate("wrong class source file", (p) => {
      for (const e of p.tests)
        if ("className" in e && e.className !== null)
          e.sourceFile = "Wrong.java";
    });
    mutate("wrong JUnit engine", (p) => {
      (p.tests[0] as { engine: string }).engine = "/wrong-engine.jar";
    });
    mutate("duplicate native terminal", (p) => {
      p.tests.splice(
        p.tests.length - 1,
        0,
        structuredClone(p.tests.find((e) => e.type === "finished" && e.test)!),
      );
    });
    mutate("missing native terminal", (p) => {
      const i = p.tests.findIndex((e) => e.type === "finished" && e.test);
      p.tests.splice(i, 1);
    });
    mutate("missing Gradle suite terminal", (p) => {
      const i = p.events.findIndex(
        (e) => e.type === "suiteFinished" && e.parent !== null,
      );
      p.events.splice(i, 1);
    });
    mutate("wrong Gradle suite identity", (p) => {
      p.events.find((e) => e.type === "suiteFinished")!.id = "invented";
    });
    mutate("native Gradle JUnit count disagreement", (p) => {
      for (const event of p.events)
        if (event.type === "suiteFinished" && event.parent === null)
          event.tests = 99;
    });
    mutate("native XML name disagreement", (p) => {
      p.modules[0]!.reports[0]!.xml = p.modules[0]!.reports[0]!.xml.replace(
        'name="next()"',
        'name="foreign()"',
      );
    });
    mutate("unknown native event", (p) => {
      (p.events as unknown[]).push({ type: "foreign" });
    });
    mutate("contradictory native exit", (p) => {
      p.exitCode = 1;
    });
    await assert.rejects(validate(root, { trusted: false }), /trust/);
    for (const name of gradleProtectedEnvironment) {
      await writeFile(
        path.join(root, "checktrail.json"),
        JSON.stringify({
          schemaVersion: 1,
          projects: [
            { path: ".", checks: ["jvm.gradle-test"], environment: [name] },
          ],
        }),
      );
      await assert.rejects(
        createPlan(root, { environment: { [name]: "untrusted override" } }),
        /protected adapter settings/,
      );
    }
  },
);
