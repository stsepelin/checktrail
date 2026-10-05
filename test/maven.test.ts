import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { mavenEvidence } from "../src/maven-evidence.js";
import { mavenHash, verifyMavenTree } from "../src/maven.js";
import { fixture } from "./helpers.js";
import { mavenFixture, mavenPom, mavenSources } from "./maven-fixture.js";
const version = spawnSync("java", ["--version"], {
  encoding: "utf8",
  timeout: 10000,
});
const native =
  version.status === 0 &&
  version.stdout.startsWith("openjdk 25.0.4 ") &&
  version.stdout.includes("Temurin-25.0.4+7") &&
  Boolean(process.env.CHECKTRAIL_MAVEN_CACHE);
const options = {
  skip: native ? false : "Pinned Maven/JVM/dependency cache unavailable",
  timeout: 120000,
};
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });

test("Maven planning is data-only and unsupported prerequisites stay unavailable", async (t) => {
  const root = await fixture(t, {
    "pom.xml": mavenPom("<skipTests>true</skipTests>"),
    ...mavenSources,
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["jvm.maven-test"] }],
    }),
  });
  const { plan } = await createPlan(root);
  assert.equal(plan.checks[0]!.id, "jvm.maven-test");
  assert.equal(plan.checks[0]!.commands.length, 0);
  assert.match(plan.checks[0]!.unavailableReason!, /Prepare/);
  await assert.rejects(validate(root, { trusted: false }), /trust/);
  await assert.rejects(access(path.join(root, "target")));
});
test("Maven artifact manifests reject corruption, extras, missing files and links", async (t) => {
  const root = await fixture(t, { "artifact.jar": "public bytes" }),
    pins = [
      { path: "artifact.jar", bytes: 12, sha256: mavenHash("public bytes") },
    ];
  await verifyMavenTree(root, pins);
  await writeFile(path.join(root, "artifact.jar"), "wrong bytes!");
  await assert.rejects(verifyMavenTree(root, pins), /digest/);
  await writeFile(path.join(root, "artifact.jar"), "public bytes");
  await writeFile(path.join(root, "extra.jar"), "x");
  await assert.rejects(verifyMavenTree(root, pins), /inventory/);
  await rm(path.join(root, "extra.jar"));
  await rm(path.join(root, "artifact.jar"));
  await assert.rejects(verifyMavenTree(root, pins), /missing/);
  await symlink(path.join(root, "other.jar"), path.join(root, "artifact.jar"));
  await assert.rejects(verifyMavenTree(root, pins), /links/);
});
test(
  "native Maven detects an assertion regression and repaired scale controls from fresh outputs",
  options,
  async (t) => {
    const { root } = await mavenFixture(t);
    await mkdir(path.join(root, "target/surefire-reports"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "target/surefire-reports/TEST-stale.xml"),
      '<testsuite tests="2" failures="0" errors="0" skipped="0"><testcase name="stale1"/><testcase name="stale2"/></testsuite>',
    );
    // Engine inventory excludes target; the native run must not read this report.
    const good = await run(root);
    assert.equal(good.outcome, "passed", JSON.stringify(good.checks));
    assert.deepEqual(good.checks[0]!.tests, {
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
    });
    assert.equal(good.checks[0]!.findingsComplete, true);
    assert.equal(
      await readFile(
        path.join(root, "target/surefire-reports/TEST-stale.xml"),
        "utf8",
      ),
      '<testsuite tests="2" failures="0" errors="0" skipped="0"><testcase name="stale1"/><testcase name="stale2"/></testsuite>',
    );
    await assert.rejects(access(path.join(root, "target/classes")));
    await writeFile(
      path.join(root, "src/main/java/example/Counter.java"),
      mavenSources["src/main/java/example/Counter.java"].replace(
        "value + 1",
        "value + 2",
      ),
    );
    const broken = await run(root);
    assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
    assert.deepEqual(broken.checks[0]!.tests, {
      total: 2,
      passed: 0,
      failed: 2,
      skipped: 0,
    });
    await writeFile(
      path.join(root, "src/main/java/example/Counter.java"),
      mavenSources["src/main/java/example/Counter.java"],
    );
    assert.equal((await run(root)).outcome, "passed");
  },
);
test(
  "native Maven rejects test filtering, skip switches and omitted test classes",
  options,
  async (t) => {
    const { root, config } = await mavenFixture(t);
    for (const extra of [
      "<skipTests>true</skipTests>",
      "<includes><include>**/MissingTest.java</include></includes>",
      "<test>CounterTest#next</test>",
      "<rerunFailingTestsCount>1</rerunFailingTestsCount>",
    ]) {
      await writeFile(path.join(root, "pom.xml"), mavenPom(extra));
      const report = await run(root);
      assert.notEqual(report.outcome, "passed", extra);
      assert.equal(report.checks[0]!.findingsComplete, false);
    }
    await writeFile(path.join(root, "pom.xml"), mavenPom());
    await writeFile(
      path.join(root, "src/test/java/example/HiddenTest.java"),
      mavenSources["src/test/java/example/CounterTest.java"].replaceAll(
        "CounterTest",
        "HiddenTest",
      ),
    );
    assert.match(
      (await createPlan(root)).plan.checks[0]!.unavailableReason!,
      /each test source/,
    );
    await rm(path.join(root, "src/test/java/example/HiddenTest.java"));
    await writeFile(
      path.join(root, "checktrail.maven.json"),
      JSON.stringify({
        ...config,
        modules: [
          {
            ...config.modules[0]!,
            testClasses: [
              {
                file: "src/test/java/example/CounterTest.java",
                className: "example.MissingTest",
              },
            ],
          },
        ],
      }),
    );
    const missing = await run(root);
    assert.equal(missing.outcome, "incomplete");
    assert.equal(missing.checks[0]!.status, "inconclusive");
    await writeFile(
      path.join(root, "src/test/java/example/CounterTest.java"),
      "package example; class DeclarationOnly {}\n",
    );
    await writeFile(
      path.join(root, "src/test/java/example/Supporting.java"),
      mavenSources["src/test/java/example/CounterTest.java"].replace(
        "public class CounterTest",
        "class CounterTest",
      ),
    );
    await writeFile(
      path.join(root, "checktrail.maven.json"),
      JSON.stringify({
        ...config,
        modules: [
          {
            ...config.modules[0]!,
            supportTests: ["src/test/java/example/Supporting.java"],
          },
        ],
      }),
    );
    const misbound = await run(root);
    assert.equal(misbound.outcome, "incomplete");
    assert.equal(misbound.checks[0]!.status, "inconclusive");
  },
);
test(
  "native Maven retains disabled and empty-test evidence as incomplete",
  options,
  async (t) => {
    const { root } = await mavenFixture(t);
    await writeFile(
      path.join(root, "src/test/java/example/CounterTest.java"),
      mavenSources["src/test/java/example/CounterTest.java"].replace(
        "@Test void boundary()",
        '@org.junit.jupiter.api.Disabled("original control") @Test void boundary()',
      ),
    );
    const disabled = await run(root);
    assert.equal(
      disabled.outcome,
      "incomplete",
      JSON.stringify(disabled.checks),
    );
    assert.deepEqual(disabled.checks[0]!.tests, {
      total: 2,
      passed: 1,
      failed: 0,
      skipped: 1,
    });
    await writeFile(
      path.join(root, "src/test/java/example/CounterTest.java"),
      "package example; public class CounterTest {}",
    );
    const empty = await run(root);
    assert.notEqual(empty.outcome, "passed");
    assert.equal(empty.checks[0]!.findingsComplete, false);
    await writeFile(
      path.join(root, "src/test/java/example/CounterTest.java"),
      mavenSources["src/test/java/example/CounterTest.java"].replace(
        "public class CounterTest",
        '@org.junit.jupiter.api.Disabled("original all-skipped control") public class CounterTest',
      ),
    );
    const allSkipped = await run(root);
    assert.equal(allSkipped.outcome, "incomplete");
    assert.deepEqual(allSkipped.checks[0]!.tests, {
      total: 2,
      passed: 0,
      failed: 0,
      skipped: 2,
    });
    await writeFile(
      path.join(root, "src/test/java/example/CounterTest.java"),
      `package example;
      import static org.junit.jupiter.api.Assertions.*;
      public class CounterTest {
        @org.junit.jupiter.params.ParameterizedTest
        @org.junit.jupiter.params.provider.ValueSource(ints={-1,2})
        void scale(int input) { assertEquals(input+1,Counter.next(input)); }
        @org.junit.jupiter.api.TestFactory
        java.util.stream.Stream<org.junit.jupiter.api.DynamicTest> generated() {
          return java.util.stream.Stream.of(
            org.junit.jupiter.api.DynamicTest.dynamicTest("zero",()->assertEquals(0,Counter.next(-1))),
            org.junit.jupiter.api.DynamicTest.dynamicTest("positive",()->assertEquals(3,Counter.next(2))));
        }
      }`,
    );
    const generated = await run(root);
    assert.equal(generated.outcome, "passed", JSON.stringify(generated.checks));
    assert.deepEqual(generated.checks[0]!.tests, {
      total: 4,
      passed: 4,
      failed: 0,
      skipped: 0,
    });
  },
);
test(
  "native Maven binds every compiler input, plugin parameter and test terminal event",
  options,
  async (t) => {
    const { root } = await mavenFixture(t),
      report = await run(root);
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    const { plan } = await createPlan(root),
      check = plan.checks[0]!,
      original = report.checks[0]!.processes[0]!;
    const data = JSON.parse(original.stdout);
    const changes: [string, (value: typeof data) => void][] = [
      [
        "unknown native event",
        (v) => {
          v.events.splice(v.events.length - 1, 0, {
            type: "invented",
            module: null,
          });
        },
      ],
      [
        "malformed native skip flag",
        (v) => {
          v.events.find(
            (e: { type: string; goal: string }) =>
              e.type === "beforeMojo" && e.goal === "test",
          ).fields.skipTests = "false";
        },
      ],
      [
        "missing native skip flag",
        (v) => {
          delete v.events.find(
            (e: { type: string; goal: string }) =>
              e.type === "beforeMojo" && e.goal === "test",
          ).fields.skipTests;
        },
      ],

      [
        "foreign additional test classpath",
        (v) => {
          v.events
            .find(
              (e: { type: string; goal: string }) =>
                e.type === "beforeMojo" && e.goal === "test",
            )
            .fields.additionalClasspathElements.push("/outside/other.jar");
        },
      ],
      [
        "foreign native classpath",
        (v) => {
          v.events
            .find(
              (e: { type: string; goal: string }) =>
                e.type === "beforeMojo" && e.goal === "testCompile",
            )
            .classPath.push("/private/dependency.jar");
        },
      ],
      [
        "wrong native JUnit engine",
        (v) => {
          v.tests[0].engine = "/foreign/engine.jar";
        },
      ],
      [
        "wrong source receipt",
        (v) => {
          v.inputSha256 = "0".repeat(64);
        },
      ],
      [
        "missing compiler input",
        (v) => {
          v.modules[0].inputs.compile = [];
        },
      ],
      [
        "missing test terminal",
        (v) => {
          v.tests = v.tests.filter(
            (e: { type: string; test: boolean }) =>
              !(e.type === "finished" && e.test),
          );
        },
      ],
      [
        "wrong native source declaration",
        (v) => {
          v.events.find(
            (e: { type: string; goal: string }) =>
              e.type === "afterMojo" && e.goal === "testCompile",
          ).declarations[0].file = "/other/source.java";
        },
      ],
      [
        "wrong class source file",
        (v) => {
          for (const e of v.tests) if (e.className) e.sourceFile = "Other.java";
        },
      ],
      [
        "foreign class origin",
        (v) => {
          for (const e of v.tests)
            if (e.className) e.output = "/foreign/classes";
        },
      ],
      [
        "native skip flag",
        (v) => {
          v.events.find(
            (e: { type: string; goal: string }) =>
              e.type === "beforeMojo" && e.goal === "test",
          ).fields.skipTests = true;
        },
      ],
      [
        "XML disagreement",
        (v) => {
          v.modules[0].reports[0].xml = v.modules[0].reports[0].xml
            .replace('tests="2"', 'tests="3"')
            .replace(
              "</testsuite>",
              '<testcase name="native-disagreement" classname="example.CounterTest"/></testsuite>',
            );
        },
      ],
      [
        "unfinished native session",
        (v) => {
          v.events.pop();
        },
      ],
      [
        "successful exit contradicts assertion",
        (v) => {
          v.exitCode = 1;
        },
      ],
      [
        "duplicate node",
        (v) => {
          v.tests.splice(2, 0, v.tests[1]);
        },
      ],
      [
        "hierarchy cycle",
        (v) => {
          for (const e of v.tests)
            if (e.id && e.id === e.parent) e.parent = e.id;
          const node = v.tests.find(
            (e: { id?: string; parent?: string }) => e.id && e.parent,
          );
          for (const e of v.tests) if (e.id === node.id) e.parent = node.id;
        },
      ],
    ];
    for (const [name, change] of changes) {
      const mutated = structuredClone(data);
      change(mutated);
      assert.equal(
        mavenEvidence(check, [{ ...original, stdout: JSON.stringify(mutated) }])
          .status,
        "inconclusive",
        name,
      );
    }
  },
);
test(
  "native Maven classifies compiler failures separately from bootstrap errors and protects cache pins",
  options,
  async (t) => {
    const { root, config } = await mavenFixture(t);
    await writeFile(
      path.join(root, "src/main/java/example/Counter.java"),
      mavenSources["src/main/java/example/Counter.java"].replace(
        "value + 1",
        '"wrong"',
      ),
    );
    const compiler = await run(root);
    assert.equal(compiler.outcome, "failed", JSON.stringify(compiler.checks));
    assert.equal(compiler.checks[0]!.tests, undefined);
    assert.equal(compiler.checks[0]!.findingsComplete, false);
    const jar = path.join(
        root,
        config.repository,
        "org/junit/platform/junit-platform-engine/6.1.3/junit-platform-engine-6.1.3.jar",
      ),
      bytes = await readFile(jar);
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(jar, bytes);
    const plan = await createPlan(root);
    assert.match(plan.plan.checks[0]!.unavailableReason!, /digest/);
    assert.equal(plan.plan.checks[0]!.commands.length, 0);
  },
);

test(
  "native Maven successful planning preserves project data and rejects startup and environment overrides",
  options,
  async (t) => {
    const { root } = await mavenFixture(t),
      before = await readFile(path.join(root, "pom.xml"), "utf8"),
      plan = await createPlan(root);
    assert.equal(plan.plan.checks[0]!.unavailableReason, undefined);
    assert.equal(plan.plan.checks[0]!.commands.length, 1);
    await assert.rejects(access(path.join(root, "target")));
    assert.equal(await readFile(path.join(root, "pom.xml"), "utf8"), before);
    for (const name of [
      "MAVEN_ARGS",
      "MAVEN_HOME",
      "MAVEN_OPTS",
      "JAVA_HOME",
      "HOME",
      "BASH_ENV",
    ]) {
      await writeFile(
        path.join(root, "checktrail.json"),
        JSON.stringify({
          schemaVersion: 1,
          projects: [
            { path: ".", checks: ["jvm.maven-test"], environment: [name] },
          ],
        }),
      );
      await assert.rejects(
        createPlan(root, { environment: { [name]: "original-override" } }),
        /protected/,
      );
    }
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["jvm.maven-test"] }],
      }),
    );
    await mkdir(path.join(root, ".mvn"));
    await writeFile(path.join(root, ".mvn/maven.config"), "--projects hidden");
    const startup = await createPlan(root);
    assert.match(
      startup.plan.checks[0]!.unavailableReason!,
      /startup configuration/,
    );
    assert.equal(startup.plan.checks[0]!.commands.length, 0);
  },
);
