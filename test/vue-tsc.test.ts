import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { validate, createPlan } from "../src/engine.js";
import { fixture } from "./helpers.js";
import { copyInstalledPackages } from "./tool-fixture.js";

const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["javascript.vue-tsc"] }],
});
const config = {
  compilerOptions: {
    strict: true,
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    types: [],
    noCheck: true,
    incremental: true,
  },
  vueCompilerOptions: { strictTemplates: true },
  include: ["src/**/*.vue", "src/**/*.ts"],
};
const good =
  '<script setup lang="ts">const value: number = 42;</script><template>{{ value.toFixed(2) }}</template>\n';

test(
  "native Vue type checking detects script and template errors, rejects excluded files and prevents disabled template checks",
  { timeout: 60_000 },
  async (t) => {
    const root = await fixture(t, {
      "package.json": "{}",
      "checktrail.json": policy,
      "tsconfig.json": JSON.stringify(config),
      "src/Example Component.vue": good,
    });
    await copyInstalledPackages(root, ["vue-tsc", "typescript", "vue"]);
    const passed = await validate(root, { trusted: true });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.equal(passed.sourceChanged, false);
    await assert.rejects(access(path.join(root, "tsconfig.tsbuildinfo")));
    await assert.rejects(
      access(path.join(root, "src/Example Component.vue.js")),
    );
    for (const source of [
      good.replace("= 42", '= "bad"'),
      good.replace("value.toFixed(2)", "value.toUpperCase()"),
    ]) {
      await writeFile(path.join(root, "src/Example Component.vue"), source);
      const failed = await validate(root, { trusted: true });
      assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
      assert.match(failed.checks[0]!.processes[0]!.stdout, /TS(?:2322|2339)/);
    }
    await writeFile(path.join(root, "src/Example Component.vue"), good);
    await writeFile(
      path.join(root, "Excluded.vue"),
      good.replace("= 42", '= "bad"'),
    );
    const excluded = await validate(root, { trusted: true });
    assert.equal(excluded.checks[0]!.processes[0]!.exitCode, 0);
    assert.equal(excluded.outcome, "incomplete");
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ ...config, extends: "./base.json" }),
    );
    await writeFile(
      path.join(root, "base.json"),
      JSON.stringify({ vueCompilerOptions: { skipTemplateCodegen: true } }),
    );
    const disabled = await validate(root, { trusted: true });
    assert.notEqual(disabled.outcome, "passed");
    assert.match(
      disabled.checks[0]!.processes[0]!.stderr,
      /skipTemplateCodegen/,
    );
  },
);

test("Vue compiler planning requires local tooling and does not execute it", async (t) => {
  const root = await fixture(t, {
    "package.json": "{}",
    "checktrail.json": policy,
    "tsconfig.json": JSON.stringify(config),
    "src/App.vue": good,
  });
  assert.equal(
    (await validate(root, { trusted: true })).checks[0]!.status,
    "unavailable",
  );
  await writeFile(path.join(root, "tsconfig.json"), "{ invalid json");
  assert.equal(
    (await createPlan(root)).plan.checks[0]!.id,
    "javascript.vue-tsc",
  );
});
