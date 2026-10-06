import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { gradlePacketSchema } from "../src/gradle-evidence.js";
import { gradleFixture, gradleSources } from "./gradle-fixture.js";
const skip = process.env.CHECKTRAIL_GRADLE_CACHE
  ? false
  : "Prepared Gradle toolchain profile unavailable";
test(
  "native Gradle accounts for independent and dependent module failures and rejects undeclared siblings",
  { skip },
  async (t) => {
    const fs = await import("node:fs/promises"),
      { root, config } = await gradleFixture(t);
    await fs.rm(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "settings.gradle"),
      "rootProject.name='original-module-controls'\ninclude 'core', 'app', 'independent'\n",
    );
    await writeFile(
      path.join(root, "build.gradle"),
      "allprojects { group='example'; version='1.0.0' }\n",
    );
    config.modules = [
      { path: ".", kind: "aggregator", testClasses: [], supportTests: [] },
    ];
    for (const module of ["core", "app", "independent"]) {
      for (const [file, bytes] of Object.entries(gradleSources)) {
        const destination = path.join(root, module, file);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, bytes);
      }
      await writeFile(
        path.join(root, module, "build.gradle"),
        (await import("./gradle-fixture.js")).gradleBuild(
          module === "app"
            ? "dependencies { implementation project(':core') }"
            : "",
        ),
      );
      config.modules.push({
        path: module,
        kind: "java",
        testClasses: [
          {
            file: "src/test/java/example/CounterTest.java",
            className: "example.CounterTest",
          },
        ],
        supportTests: [],
      });
    }
    await writeFile(
      path.join(root, "checktrail.gradle.json"),
      JSON.stringify(config),
    );
    const core = path.join(root, "core/src/main/java/example/Counter.java"),
      independent = path.join(
        root,
        "independent/src/main/java/example/Counter.java",
      );
    await writeFile(
      core,
      gradleSources["src/main/java/example/Counter.java"].replace("n+1", "n-1"),
    );
    const broken = await validate(root, { trusted: true, timeoutMs: 120000 });
    assert.equal(
      broken.checks[0]!.status,
      "failed",
      JSON.stringify(broken.checks[0]),
    );
    assert.deepEqual(broken.checks[0]!.tests, {
      total: 6,
      passed: 4,
      failed: 2,
      skipped: 0,
    });
    assert.equal(broken.checks[0]!.findingsComplete, true);
    await writeFile(
      independent,
      gradleSources["src/main/java/example/Counter.java"].replace("n+1", "n-1"),
    );
    await writeFile(
      core,
      gradleSources["src/main/java/example/Counter.java"].replace(
        "n+1",
        "unresolved",
      ),
    );
    const partial = await validate(root, { trusted: true, timeoutMs: 120000 });
    assert.equal(
      partial.checks[0]!.status,
      "failed",
      JSON.stringify(partial.checks[0]),
    );
    assert.deepEqual(partial.checks[0]!.tests, {
      total: 2,
      passed: 0,
      failed: 2,
      skipped: 0,
    });
    const packet = gradlePacketSchema.parse(
      JSON.parse(partial.checks[0]!.processes[0]!.stdout),
    );
    assert.equal(
      packet.events.some(
        (event) =>
          event.type === "taskStarted" && event.task.path === ":app:test",
      ),
      false,
      "Dependent app test cannot run after its core compiler prerequisite fails",
    );
    assert.equal(
      packet.events.filter(
        (event) =>
          event.type === "testFinished" && event.task === ":independent:test",
      ).length,
      2,
      "Independent failing tests still run under continue-on-failure",
    );
    assert.equal(partial.checks[0]!.findingsComplete, false);
    await writeFile(core, gradleSources["src/main/java/example/Counter.java"]);
    await writeFile(
      independent,
      gradleSources["src/main/java/example/Counter.java"],
    );
    const repaired = await validate(root, { trusted: true, timeoutMs: 120000 });
    assert.equal(
      repaired.checks[0]!.status,
      "passed",
      JSON.stringify(repaired.checks[0]),
    );
    assert.deepEqual(repaired.checks[0]!.tests, {
      total: 6,
      passed: 6,
      failed: 0,
      skipped: 0,
    });
    await fs.mkdir(path.join(root, "hidden"));
    await writeFile(
      path.join(root, "hidden/build.gradle"),
      "// original undeclared sibling\n",
    );
    const undeclared = await createPlan(root);
    assert.equal(undeclared.plan.checks[0]!.commands.length, 0);
    assert.match(
      undeclared.plan.checks[0]!.unavailableReason!,
      /each inventoried/,
    );
    await fs.rm(path.join(root, "hidden"), { recursive: true });
    await fs.mkdir(path.join(root, "src/main/java"), { recursive: true });
    await writeFile(
      path.join(root, "src/main/java/Hidden.java"),
      "class Hidden {}\n",
    );
    const hidden = await createPlan(root);
    assert.equal(hidden.plan.checks[0]!.commands.length, 0);
    assert.match(hidden.plan.checks[0]!.unavailableReason!, /Aggregator/);
  },
);
test(
  "native Gradle executes original Java projects declared by Kotlin DSL without admitting mixed compiler source",
  { skip },
  async (t) => {
    const fs = await import("node:fs/promises"),
      { root } = await gradleFixture(t);
    await fs.rename(
      path.join(root, "settings.gradle"),
      path.join(root, "settings.gradle.kts"),
    );
    await writeFile(
      path.join(root, "settings.gradle.kts"),
      'rootProject.name = "original-kotlin-dsl"\n',
    );
    await fs.rename(
      path.join(root, "build.gradle"),
      path.join(root, "build.gradle.kts"),
    );
    await writeFile(
      path.join(root, "build.gradle.kts"),
      `plugins { java }
repositories { maven { url = uri(System.getProperty("checktrail.repository")) } }
dependencies { testImplementation("org.junit.jupiter:junit-jupiter:6.1.3"); testRuntimeOnly("org.junit.platform:junit-platform-launcher:6.1.3") }
tasks.withType<JavaCompile>().configureEach { options.encoding = "UTF-8"; options.release = 17 }
tasks.test { useJUnitPlatform() }
`,
    );
    const valid = await validate(root, { trusted: true, timeoutMs: 120000 });
    assert.equal(
      valid.checks[0]!.status,
      "passed",
      JSON.stringify(valid.checks[0]),
    );
    assert.equal(valid.checks[0]!.tests!.passed, 2);
    await fs.mkdir(path.join(root, "src/main/kotlin"), { recursive: true });
    await writeFile(
      path.join(root, "src/main/kotlin/Hidden.kt"),
      "class Hidden\n",
    );
    const mixed = await createPlan(root);
    assert.equal(mixed.plan.checks[0]!.commands.length, 0);
    assert.match(mixed.plan.checks[0]!.unavailableReason!, /Mixed JVM/);
  },
);

test(
  "native Gradle protects client JVM settings against project daemon overrides",
  { skip },
  async (t) => {
    const { root } = await gradleFixture(t),
      bytes =
        "org.gradle.jvmargs=-Xmx96m\norg.gradle.java.home=/original-missing-jvm\norg.gradle.daemon=true\n";
    await writeFile(path.join(root, "gradle.properties"), bytes);
    const report = await validate(root, { trusted: true, timeoutMs: 120000 });
    assert.equal(
      report.checks[0]!.status,
      "passed",
      JSON.stringify(report.checks[0]),
    );
    assert.deepEqual(report.checks[0]!.tests, {
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
    });
    assert.equal(
      await readFile(path.join(root, "gradle.properties"), "utf8"),
      bytes,
    );
  },
);
