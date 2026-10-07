import assert from "node:assert/strict";
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPlan, validate } from "../src/engine.js";
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
