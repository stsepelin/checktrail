import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
const { sourceBoundaryInputs } = await import(
  new URL("../../scripts/ci-source-boundaries.mjs", import.meta.url).href
);
const { buildNativeInputs, planNativeJobs } = await import(
  new URL("../../scripts/ci-impact.mjs", import.meta.url).href
);
const file = "src/original-runner.ts";
function fixture() {
  return {
    "scripts/ci-source-boundaries.json": JSON.stringify({
      schemaVersion: 1,
      scope: "declared-standalone-subprocess-runners",
      boundaries: [
        {
          file,
          profiles: ["original-native"],
          testFiles: ["test/original-component.test.ts"],
          references: [
            { file: "src/original.ts", kind: "module-url", count: 1 },
          ],
        },
      ],
    }),
    "src/original.ts":
      "throw Error('Source construction must never execute'); export const selected=new URL('./original-runner.js',import.meta.url);",
    "src/original-runner.ts":
      "throw Error('Standalone runner must never execute during planning');",
    "src/adjacent.ts": "export const untouched=1;",
    "test/original-component.test.ts": "export const component=1;",
    "test/original-native.test.ts": "export const native='original';",
    "test/adjacent-native.test.ts": "export const native='adjacent';",
    "scripts/original.mjs":
      "node scripts/verify-required-native-tests.mjs original-native",
    "scripts/adjacent.mjs":
      "node scripts/verify-required-native-tests.mjs adjacent-native",
  } as Record<string, string>;
}
const requirements = {
  "original-native": [
    { file: "dist/test/original-native.test.js", name: "original control" },
  ],
  "adjacent-native": [
    { file: "dist/test/adjacent-native.test.js", name: "adjacent control" },
  ],
};
const inputs = {
  "test/original-native.test.ts": ["original-job"],
  "test/adjacent-native.test.ts": ["adjacent-job"],
};
const jobs = ["original-job", "adjacent-job"];
async function collect(files: Record<string, string>) {
  return sourceBoundaryInputs({
    files: Object.keys(files),
    requirements,
    jobs,
    inputs,
    readText: async (file: string) => {
      assert.ok(Object.hasOwn(files, file));
      return files[file];
    },
  });
}

test("CI source boundaries bind exact subprocess callers and all recorded native consumers without executing source", async () => {
  const files = fixture();
  assert.deepEqual(await collect(files), {
    [file]: ["original-job"],
  });
  const workflow = {
    jobs: {
      "original-job": { steps: [{ run: "node scripts/original.mjs" }] },
      "adjacent-job": { steps: [{ run: "node scripts/adjacent.mjs" }] },
    },
  };
  const actual = await buildNativeInputs({
    workflow,
    requirements,
    files: Object.keys(files),
    readText: async (file: string) => files[file],
  });
  const plan = planNativeJobs({
    jobs,
    inputs: actual,
    changed: [file],
    eventName: "pull_request",
    baseline: null,
    contractCurrent: true,
    sourceBoundaries: JSON.parse(files["scripts/ci-source-boundaries.json"]!)
      .boundaries,
  });
  assert.equal(plan.mode, "affected");
  assert.deepEqual(plan.selected, {
    "original-job": true,
    "adjacent-job": false,
  });
  assert.ok(plan.sharedTestFiles.includes("dist/test/original-native.test.js"));
  assert.ok(
    plan.sharedTestFiles.includes("dist/test/original-component.test.js"),
  );
  assert.ok(
    !plan.sharedTestFiles.includes("dist/test/adjacent-native.test.js"),
  );
  for (const changed of [
    "src/runner.ts",
    "src/original.ts",
    "src/new-runner.ts",
    "scripts/ci-source-boundaries.json",
  ])
    assert.equal(
      planNativeJobs({
        jobs,
        inputs: actual,
        changed: [changed],
        eventName: "pull_request",
        baseline: null,
        contractCurrent: true,
      }).mode,
      "full",
    );
  const sharedConsumers = await sourceBoundaryInputs({
    files: Object.keys(files),
    requirements,
    jobs,
    inputs: { ...inputs, "test/original-native.test.ts": jobs },
    readText: async (file: string) => files[file],
  });
  assert.deepEqual(sharedConsumers[file], jobs.toSorted());
});

test("CI source boundary guards reject new imports duplicate callers encoded aliases dynamic resolution and missing profile consumers", async () => {
  const variants: Array<(files: Record<string, string>) => void> = [
    (files) => {
      files["src/adjacent.ts"] = "import './original-runner.js';";
    },
    (files) => {
      files["src/adjacent.ts"] = "export * from './original-runner.js';";
    },
    (files) => {
      files["src/adjacent.ts"] =
        "export const p=import('./original-runner.js');";
    },
    (files) => {
      files["src/adjacent.ts"] =
        "export const p=new URL('./%6friginal-runner.js',import.meta.url);";
    },
    (files) => {
      files["src/adjacent.ts"] =
        "export const p=new URL('./ORIGINAL-RUNNER.js',import.meta.url);";
    },
    (files) => {
      files["src/adjacent.ts"] =
        "export const p=new URL('./ORIGINAL-RUNNER.JS',import.meta.url);";
    },
    (files) => {
      files["src/adjacent.ts"] =
        "export const p=new URL('../else/original-runner.js',import.meta.url);";
    },
    (files) => {
      files["src/original.ts"] +=
        "export const duplicate=new URL('./original-runner.js',import.meta.url);";
    },
    (files) => {
      files["src/adjacent.ts"] =
        "export const p=new URL(`./${family}-runner.js`,import.meta.url);";
    },
    (files) => {
      files["src/adjacent.ts"] = "export const p=kind+'-runner.js';";
    },
    (files) => {
      delete files["test/original-component.test.ts"];
    },
    (files) => {
      const data = JSON.parse(files["scripts/ci-source-boundaries.json"]!);
      data.boundaries[0].testFiles = [
        "test/adjacent-native.test.ts",
        "test/adjacent-native.test.ts",
      ];
      files["scripts/ci-source-boundaries.json"] = JSON.stringify(data);
    },
    (files) => {
      delete files["src/original.ts"];
    },
    (files) => {
      delete files["src/original-runner.ts"];
    },
    (files) => {
      files["scripts/ci-source-boundaries.json"] = "{";
    },
    (files) => {
      const data = JSON.parse(files["scripts/ci-source-boundaries.json"]!);
      data.boundaries[0].profiles = ["unknown-native"];
      files["scripts/ci-source-boundaries.json"] = JSON.stringify(data);
    },
    (files) => {
      const data = JSON.parse(files["scripts/ci-source-boundaries.json"]!);
      data.boundaries[0].references[0].count = 0;
      files["scripts/ci-source-boundaries.json"] = JSON.stringify(data);
    },
    (files) => {
      const data = JSON.parse(files["scripts/ci-source-boundaries.json"]!);
      data.boundaries[0].references[0].kind = "module-import";
      files["scripts/ci-source-boundaries.json"] = JSON.stringify(data);
    },
    (files) => {
      const data = JSON.parse(files["scripts/ci-source-boundaries.json"]!);
      data.boundaries.push(data.boundaries[0]);
      files["scripts/ci-source-boundaries.json"] = JSON.stringify(data);
    },
  ];
  for (const mutate of variants) {
    const files = fixture();
    mutate(files);
    await assert.rejects(collect(files));
  }
  const files = fixture();
  await assert.rejects(
    sourceBoundaryInputs({
      files: Object.keys(files),
      requirements,
      jobs,
      inputs: {},
      readText: async (file: string) => files[file],
    }),
    /no declared native consumer/,
  );
  const noCatalog = fixture();
  delete noCatalog["scripts/ci-source-boundaries.json"];
  assert.deepEqual(await collect(noCatalog), {});
});

test("CI source boundaries preserve adjacent filenames and comments while recognising canonical encoded callers", async () => {
  const files = fixture();
  files["src/adjacent.ts"] =
    "// ./original-runner.js\nexport const unrelated=new URL('./other-original-runner.js',import.meta.url);";
  assert.deepEqual(await collect(files), {
    [file]: ["original-job"],
  });
  files["src/original.ts"] =
    "export const selected=new URL('./%6friginal-runner.js',import.meta.url);";
  assert.deepEqual(await collect(files), {
    [file]: ["original-job"],
  });
  const data = JSON.parse(files["scripts/ci-source-boundaries.json"]!);
  data.boundaries[0].references.push({
    file: "src/adjacent.ts",
    kind: "validation-literal",
    count: 1,
  });
  files["scripts/ci-source-boundaries.json"] = JSON.stringify(data);
  files["src/adjacent.ts"] =
    "export const expected=actual==='original-runner.js';";
  assert.deepEqual(await collect(files), {
    [file]: ["original-job"],
  });
});

test("CI production source catalog retains every explicit runner reference and native profile in the current repository", async () => {
  const root = new URL("../../", import.meta.url);
  const catalog = JSON.parse(
    await readFile(new URL("scripts/ci-source-boundaries.json", root), "utf8"),
  );
  assert.equal(catalog.boundaries.length, 9);
  assert.deepEqual(
    catalog.boundaries.map((row: { file: string }) => row.file).sort(),
    [
      "clang",
      "detekt",
      "helm",
      "scala",
      "terraform",
      "detekt-extensions",
      "helm-extensions",
      "scala-extensions",
      "terraform-extensions",
    ]
      .map((name) => "src/" + name + "-runner.ts")
      .sort(),
  );
});

test("CI source isolation admits only the exact shared producer-identity registry and rejects stale exemptions", async () => {
  const text = await readFile(
    new URL("../../src/native-journal-engine.ts", import.meta.url),
    "utf8",
  );
  const files = fixture();
  files["src/native-journal-engine.ts"] = text;
  assert.deepEqual(await collect(files), {
    [file]: ["original-job"],
  });
  files["src/native-journal-engine.ts"] = text.replace(/\r?\n/g, "\r\n");
  assert.deepEqual(await collect(files), {
    [file]: ["original-job"],
  });
  files["src/native-journal-engine.ts"] =
    text + "\n// A changed registry requires review.\n";
  await assert.rejects(collect(files), /Producer registry changed/);
});
