import assert from "node:assert/strict";
import { writeFile, access, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { gradleFixture, gradleSources } from "./gradle-fixture.js";
const native = Boolean(process.env.CHECKTRAIL_GRADLE_CACHE),
  skip = native ? false : "Prepared Gradle toolchain profile unavailable";
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
