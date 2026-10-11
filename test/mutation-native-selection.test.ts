import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";
test("mutation acceptance rejects cohort substitution and aggregate reuse before executing a case", async (t) => {
  const names = [
    "broken",
    "fixed",
    "near-miss",
    "prerequisite",
    "stale",
    "empty",
    "privacy",
    "lifecycle",
    "installed",
  ].map((caseName) => "mutation-runners " + caseName + " acceptance");
  const selected = ["vitest", "jest", "pytest", "phpunit"];
  const requirements = Object.fromEntries(
    [...selected.map((f) => "mutation-" + f), "mutation-runners"].map(
      (profile) => [
        profile,
        names.map((name) => ({ file: "dist/test/original.test.js", name })),
      ],
    ),
  );
  const scripts = await Promise.all(
    ["verify-required-native-tests.mjs", "required-test-evidence.mjs"].map(
      async (name) => [
        "scripts/" + name,
        await readFile(
          fileURLToPath(new URL("../../scripts/" + name, import.meta.url)),
          "utf8",
        ),
      ],
    ),
  );
  const root = await fixture(t, {
    "package.json": '{"type":"module"}',
    ...Object.fromEntries(scripts),
    "scripts/required-native-tests.json": JSON.stringify(requirements),
    "dist/test/original.test.js": `import{test}from'node:test';import{appendFileSync}from'node:fs';appendFileSync(process.env.ORIGINAL_MUTATION_SELECTION_MARKER,'entered\\n');for(const name of ${JSON.stringify(names)})test(name,()=>{});`,
    marker: "",
  });
  const marker = path.join(root, "marker"),
    script = path.join(root, "scripts/verify-required-native-tests.mjs");
  const invoke = (selection: string[], family?: string) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ORIGINAL_MUTATION_SELECTION_MARKER: marker,
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.CHECKTRAIL_MUTATION_FAMILY;
    if (family !== undefined) env.CHECKTRAIL_MUTATION_FAMILY = family;
    return spawnSync(process.execPath, [script, ...selection], {
      env,
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1048576,
    });
  };
  for (const args of [
    { selection: ["mutation-vitest"] },
    { selection: ["mutation-vitest"], family: "jest" },
    { selection: ["mutation-runners"], family: "vitest" },
    { selection: ["mutation-vitest", "mutation-jest"], family: "vitest" },
  ]) {
    await writeFile(marker, "");
    const result = invoke(args.selection, args.family);
    assert.notEqual(result.status, 0);
    assert.equal(
      await readFile(marker, "utf8"),
      "",
      "Rejected cohort must not execute project/test code",
    );
  }
  for (const family of selected) {
    await writeFile(marker, "");
    const result = invoke(["mutation-" + family], family);
    assert.equal(
      result.status,
      0,
      result.stderr || JSON.stringify(JSON.parse(result.stdout).problems),
    );
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.profile, "mutation-" + family);
    assert.equal(receipt.required, 9);
    assert.equal(receipt.passed, 9);
    assert.equal(receipt.complete, true);
    assert.equal(
      (await readFile(marker, "utf8")).split("entered").length - 1,
      9,
      "Each declared case executes in a fresh worker",
    );
  }
});
