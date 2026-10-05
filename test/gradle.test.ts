import assert from "node:assert/strict";
import { readFile, writeFile, access, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { gradleEvidence, gradlePacketSchema } from "../src/gradle-evidence.js";
import { gradleProtectedEnvironment } from "../src/gradle.js";
import { fixture } from "./helpers.js";
import { gradleFixture, gradleSources } from "./gradle-fixture.js";
const native = Boolean(process.env.CHECKTRAIL_GRADLE_CACHE),
  skip = native ? false : "Prepared Gradle toolchain profile unavailable";
test("Gradle planning requires explicit activation and bounded complete source prerequisites", async (t) => {
  const root = await fixture(t, {
    "settings.gradle": "rootProject.name='original-counter'\n",
    "build.gradle":
      "throw new RuntimeException('planning executed build code')\n",
    ...gradleSources,
  });
  let planned = await createPlan(root);
  assert.equal(
    planned.plan.checks.some((c) => c.id === "jvm.gradle-test"),
    false,
  );
  await writeFile(
    path.join(root, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["jvm.gradle-test"] }],
    }),
  );
  planned = await createPlan(root);
  assert.equal(planned.plan.checks[0]!.id, "jvm.gradle-test");
  assert.equal(planned.plan.checks[0]!.commands.length, 0);
  assert.match(planned.plan.checks[0]!.unavailableReason!, /inventoried/);
  const report = await validate(root, { trusted: true });
  assert.equal(report.checks[0]!.status, "unavailable");
  assert.equal(report.checks[0]!.processes.length, 0);
});
test(
  "native Gradle compiles fresh inputs and catches repaired assertion and scale boundaries",
  { skip },
  async (t) => {
    const { root } = await gradleFixture(t);
    await writeFile(
      path.join(root, "src/main/java/example/Counter.java"),
      gradleSources["src/main/java/example/Counter.java"].replace("n+1", "n-1"),
    );
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(path.join(root, "build/test-results/test"), { recursive: true }),
    );
    const stale = path.join(root, "build/test-results/test/TEST-stale.xml");
    await writeFile(stale, "stale original report");
    const broken = await validate(root, { trusted: true, timeoutMs: 120000 });
    assert.equal(
      broken.checks[0]!.status,
      "failed",
      JSON.stringify(broken.checks[0]),
    );
    assert.deepEqual(broken.checks[0]!.tests, {
      total: 2,
      passed: 0,
      failed: 2,
      skipped: 0,
    });
    assert.equal(await readFile(stale, "utf8"), "stale original report");
    await writeFile(
      path.join(root, "src/main/java/example/Counter.java"),
      gradleSources["src/main/java/example/Counter.java"],
    );
    const repaired = await validate(root, { trusted: true, timeoutMs: 120000 });
    assert.equal(
      repaired.checks[0]!.status,
      "passed",
      JSON.stringify(repaired.checks[0]),
    );
    assert.deepEqual(repaired.checks[0]!.tests, {
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
    });
    await assert.rejects(access(path.join(root, "build/classes/java/test")), {
      code: "ENOENT",
    });
  },
);
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
test(
  "native Gradle planning reads successful project data without executing build code",
  { skip },
  async (t) => {
    const { root } = await gradleFixture(t);
    await writeFile(
      path.join(root, "build.gradle"),
      "new File('planning-tripwire').text='executed'\nthrow new RuntimeException('planning must not execute')\n",
    );
    const plan = await createPlan(root);
    assert.equal(plan.plan.checks[0]!.commands.length, 1);
    await assert.rejects(access(path.join(root, "planning-tripwire")), {
      code: "ENOENT",
    });
    await assert.rejects(access(path.join(root, "build")), { code: "ENOENT" });
    assert.equal((await readdir(root)).includes(".gradle"), false);
  },
);

test(
  "native Gradle retains disabled and empty execution and supports parameterized dynamic controls",
  { skip },
  async (t) => {
    const disabled = await gradleFixture(t);
    await writeFile(
      path.join(disabled.root, "src/test/java/example/CounterTest.java"),
      gradleSources["src/test/java/example/CounterTest.java"].replace(
        "@Test void next()",
        "@org.junit.jupiter.api.Disabled @Test void next()",
      ),
    );
    const partial = await validate(disabled.root, {
      trusted: true,
      timeoutMs: 120000,
    });
    assert.equal(
      partial.checks[0]!.status,
      "inconclusive",
      JSON.stringify(partial.checks[0]),
    );
    assert.deepEqual(partial.checks[0]!.tests, {
      total: 2,
      passed: 1,
      failed: 0,
      skipped: 1,
    });
    const all = await gradleFixture(t);
    await writeFile(
      path.join(all.root, "src/test/java/example/CounterTest.java"),
      gradleSources["src/test/java/example/CounterTest.java"].replace(
        "public class CounterTest",
        "@org.junit.jupiter.api.Disabled public class CounterTest",
      ),
    );
    const skipped = await validate(all.root, {
      trusted: true,
      timeoutMs: 120000,
    });
    assert.equal(
      skipped.checks[0]!.status,
      "inconclusive",
      JSON.stringify(skipped.checks[0]),
    );
    assert.deepEqual(skipped.checks[0]!.tests, {
      total: 2,
      passed: 0,
      failed: 0,
      skipped: 2,
    });
    const empty = await gradleFixture(t);
    await writeFile(
      path.join(empty.root, "src/test/java/example/CounterTest.java"),
      "package example; public class CounterTest {}\n",
    );
    const missing = await validate(empty.root, {
      trusted: true,
      timeoutMs: 120000,
    });
    assert.notEqual(missing.checks[0]!.status, "passed");
    assert.equal(missing.checks[0]!.findingsComplete, false);
    const dynamic = await gradleFixture(t);
    await writeFile(
      path.join(dynamic.root, "src/test/java/example/CounterTest.java"),
      'package example; import static org.junit.jupiter.api.Assertions.*; public class CounterTest { @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(ints={-1,2}) void values(int value){assertEquals(value+1,Counter.next(value));} @org.junit.jupiter.api.TestFactory java.util.stream.Stream<org.junit.jupiter.api.DynamicTest> generated(){return java.util.stream.Stream.of(org.junit.jupiter.api.DynamicTest.dynamicTest("boundary",()->assertEquals(0,Counter.next(-1))),org.junit.jupiter.api.DynamicTest.dynamicTest("normal",()->assertEquals(3,Counter.next(2))));} }',
    );
    const completed = await validate(dynamic.root, {
      trusted: true,
      timeoutMs: 120000,
    });
    assert.equal(
      completed.checks[0]!.status,
      "passed",
      JSON.stringify(completed.checks[0]),
    );
    assert.deepEqual(completed.checks[0]!.tests, {
      total: 4,
      passed: 4,
      failed: 0,
      skipped: 0,
    });
  },
);
test(
  "native Gradle rejects an actual wrong test-source binding and accepts its repaired declaration",
  { skip },
  async (t) => {
    const { root, config } = await gradleFixture(t);
    await writeFile(
      path.join(root, "src/test/java/example/CounterTest.java"),
      "package example; class Supporting {}\n",
    );
    await writeFile(
      path.join(root, "src/test/java/example/Other.java"),
      gradleSources["src/test/java/example/CounterTest.java"].replace(
        "public class CounterTest",
        "class CounterTest",
      ),
    );
    config.modules[0]!.supportTests = ["src/test/java/example/Other.java"];
    await writeFile(
      path.join(root, "checktrail.gradle.json"),
      JSON.stringify(config),
    );
    const wrong = await validate(root, { trusted: true, timeoutMs: 120000 });
    assert.equal(
      wrong.checks[0]!.status,
      "inconclusive",
      JSON.stringify(wrong.checks[0]),
    );
    config.modules[0]!.testClasses[0]!.file =
      "src/test/java/example/Other.java";
    config.modules[0]!.supportTests = [
      "src/test/java/example/CounterTest.java",
    ];
    await writeFile(
      path.join(root, "checktrail.gradle.json"),
      JSON.stringify(config),
    );
    const repaired = await validate(root, { trusted: true, timeoutMs: 120000 });
    assert.equal(
      repaired.checks[0]!.status,
      "passed",
      JSON.stringify(repaired.checks[0]),
    );
    assert.equal(repaired.checks[0]!.tests!.passed, 2);
  },
);
test(
  "native Gradle classifies compiler failures without attributing infrastructure or cache failures as defects",
  { skip },
  async (t) => {
    const { root } = await gradleFixture(t);
    await writeFile(
      path.join(root, "src/main/java/example/Counter.java"),
      gradleSources["src/main/java/example/Counter.java"].replace(
        "n+1",
        "unresolved",
      ),
    );
    const compiler = await validate(root, { trusted: true, timeoutMs: 120000 });
    assert.equal(
      compiler.checks[0]!.status,
      "failed",
      JSON.stringify(compiler.checks[0]),
    );
    assert.equal(compiler.checks[0]!.findingsComplete, false);
    assert.equal(compiler.checks[0]!.tests, undefined);
    await writeFile(
      path.join(root, "src/main/java/example/Counter.java"),
      gradleSources["src/main/java/example/Counter.java"],
    );
    await writeFile(
      path.join(root, "settings.gradle"),
      "throw new org.gradle.api.GradleException('original bootstrap control')\n",
    );
    const infrastructure = await validate(root, {
      trusted: true,
      timeoutMs: 120000,
    });
    assert.notEqual(infrastructure.checks[0]!.status, "failed");
    assert.notEqual(infrastructure.checks[0]!.status, "passed");
    assert.equal(infrastructure.checks[0]!.findingsComplete, false);
    const jar = path.join(
      root,
      ".checktrail/maven-dependencies/artifacts/org/junit/jupiter/junit-jupiter-api/6.1.3/junit-jupiter-api-6.1.3.jar",
    );
    await writeFile(
      jar,
      Buffer.concat([await readFile(jar), Buffer.from("corrupt")]),
    );
    const plan = await createPlan(root);
    assert.equal(plan.plan.checks[0]!.commands.length, 0);
    assert.match(plan.plan.checks[0]!.unavailableReason!, /pinned files/);
  },
);
