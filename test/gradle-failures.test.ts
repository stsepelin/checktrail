import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { gradleFixture, gradleSources } from "./gradle-fixture.js";
const native = Boolean(process.env.CHECKTRAIL_GRADLE_CACHE),
  skip = native ? false : "Prepared Gradle toolchain profile unavailable";
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
