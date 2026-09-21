import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  retrieveGuidance,
  projectGuidance,
  guidanceTopicSchema,
  guidanceSummarySchema,
  guidanceReportSchema,
} from "../src/guidance.js";
import { fixture, nodeManifest } from "./helpers.js";

test("guidance selection uses exact triggers, preserves overlap once and never produces a validation outcome", () => {
  const all = retrieveGuidance({
    schemaVersion: 1,
    checks: [],
    topics: guidanceTopicSchema.options,
  });
  assert.equal(
    new Set(all.items.map((item) => item.id)).size,
    guidanceTopicSchema.options.length,
  );
  for (const item of all.items) {
    assert.ok(item.questions.length > 0);
    assert.ok(item.references.length > 0);
    for (const check of item.triggers.checks) {
      const input = { schemaVersion: 1, checks: [check], topics: [] };
      const selected = retrieveGuidance(input);
      assert.deepEqual(
        selected.items.map((entry) => entry.id),
        [item.id],
      );
      assert.deepEqual(selected.items[0]!.matched.checks, [check]);
      for (const nearMiss of [
        `${check}.extra`,
        `extra.${check}`,
        check.replace(".", "-"),
      ])
        assert.deepEqual(
          retrieveGuidance({ ...input, checks: [nearMiss] }).items,
          [],
        );
      const overlap = retrieveGuidance({
        ...input,
        topics: item.triggers.topics,
      });
      assert.equal(overlap.items.length, 1);
      assert.deepEqual(overlap.items[0]!.matched.topics, item.triggers.topics);
      assert.equal(overlap.automatedCoverage, false);
      assert.equal(overlap.channel, "advisory");
      assert.ok(!Object.hasOwn(overlap, "outcome"));
      assert.ok(!Object.hasOwn(overlap, "findings"));
    }
  }
  assert.deepEqual(
    retrieveGuidance({ schemaVersion: 1, checks: [], topics: [] }).items,
    [],
  );
  assert.throws(() =>
    guidanceReportSchema.parse({ ...all, outcome: "passed" }),
  );
});

test("guidance is bounded, deterministic and detached from mutable caller data", () => {
  const context = {
    schemaVersion: 1,
    checks: ["swift.syntax", "ruby.syntax"],
    topics: ["execution-depth"],
  };
  const original = structuredClone(context);
  const report = retrieveGuidance(context);
  assert.deepEqual(context, original);
  assert.deepEqual(
    report,
    retrieveGuidance({ ...context, checks: [...context.checks].reverse() }),
  );
  const digest = report.catalogueDigest;
  report.items[0]!.questions[0] = "Modified by caller";
  report.items[0]!.triggers.checks.push("arbitrary.check");
  const fresh = retrieveGuidance(context);
  assert.equal(fresh.catalogueDigest, digest);
  assert.ok(!fresh.items[0]!.questions.includes("Modified by caller"));
  assert.deepEqual(
    retrieveGuidance({ ...context, topics: [], checks: ["arbitrary.check"] })
      .items,
    [],
  );
  for (const invalid of [
    { ...context, checks: ["swift.syntax", "swift.syntax"] },
    { ...context, topics: ["execution-depth", "execution-depth"] },
    { ...context, topics: ["execution-depth.extra"] },
    { ...context, topics: Array(17).fill("execution-depth") },
    { ...context, checks: Array.from({ length: 101 }, (_, i) => `check.${i}`) },
    { ...context, checks: ["x".repeat(129)] },
    { ...context, source: "private source" },
    { ...context, source: "x".repeat(16385) },
    { ...context, checks: ["../private"] },
    undefined,
  ])
    assert.throws(() => retrieveGuidance(invalid));
  const summary = projectGuidance(fresh, false);
  guidanceSummarySchema.parse(summary);
  assert.ok(!Object.hasOwn(summary, "context"));
  assert.ok(!JSON.stringify(summary).includes("swift.syntax"));
  assert.deepEqual(projectGuidance(fresh, true), fresh);
});

test("guidance CLI plans without executing project code and reads explicit bounded contexts", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "private.test.js": "require('node:fs').writeFileSync('executed', 'yes');",
    "context.json": JSON.stringify({
      schemaVersion: 1,
      checks: ["swift.syntax"],
      topics: [],
    }),
  });
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const invoke = (args: string[] = []) =>
    spawnSync(process.execPath, [cli, "guidance", "--root", root, ...args], {
      encoding: "utf8",
      timeout: 10000,
    });
  const result = invoke();
  assert.equal(result.status, 0, result.stderr);
  const summary = guidanceSummarySchema.parse(JSON.parse(result.stdout));
  assert.deepEqual(
    summary.items.map((item) => item.id),
    ["review.test-lifecycle"],
  );
  assert.ok(!result.stdout.includes("private.test.js"));
  const detailed = invoke(["--detailed", "--topic", "package-consumers"]);
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.deepEqual(
    guidanceReportSchema
      .parse(JSON.parse(detailed.stdout))
      .items.map((item) => item.id),
    ["review.test-lifecycle", "review.package-consumers"],
  );
  const imported = invoke(["--input", "context.json"]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.deepEqual(
    JSON.parse(imported.stdout).items.map((item: { id: string }) => item.id),
    ["review.execution-depth"],
  );
  assert.equal(
    invoke(["--input", "context.json", "--topic", "execution-depth"]).status,
    2,
  );
  assert.equal(invoke(["--topic", "unknown"]).status, 2);
  assert.equal(invoke(["--input", "../outside.json"]).status, 2);
  await assert.rejects(access(path.join(root, "executed")));
});

test("guidance URL constraints agree in runtime and standard JSON Schema validation", () => {
  const ajv = new Ajv2020({ strict: true });
  (addFormatsImport.default ?? addFormatsImport)(ajv);
  const report = retrieveGuidance({
    schemaVersion: 1,
    checks: [],
    topics: ["execution-depth"],
  });
  const candidates: [string, boolean][] = [
    ["https://example.test/reference?section=1#usage", true],
    [
      "https://example.test/" +
        "a".repeat(512 - "https://example.test/".length),
      true,
    ],
    [
      "https://example.test/" +
        "a".repeat(513 - "https://example.test/".length),
      false,
    ],
    ["http://example.test/reference", false],
    ["httpsx://example.test/reference", false],
    ["xhttps://example.test/reference", false],
    ["HTTPS://example.test/reference", false],
    ["/reference", false],
    ["", false],
  ];
  for (const [schema, base] of [
    [guidanceReportSchema, report],
    [
      guidanceSummarySchema,
      guidanceSummarySchema.parse(projectGuidance(report, false)),
    ],
  ] as const) {
    const validate = ajv.compile(z.toJSONSchema(schema));
    for (const [url, accepted] of candidates) {
      const value = structuredClone(base);
      value.items[0]!.references[0]!.url = url;
      assert.equal(
        schema.safeParse(value).success,
        accepted,
        `runtime: ${url}`,
      );
      assert.equal(validate(value), accepted, `JSON Schema: ${url}`);
    }
  }
});
