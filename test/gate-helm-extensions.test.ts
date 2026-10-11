import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createPlan, validate } from "../src/engine.js";
import { helmExtensionsEvidence } from "../src/helm-extensions-evidence.js";
import { helmExtensionsPacketSchema } from "../src/helm-extensions-packet.js";
import {
  helmExtensionsSources,
  helmExtensionsDebug,
} from "../src/helm-extensions-native.js";
import { helmExtensionsValues } from "../src/helm-extensions-values.js";
import {
  helmExtensionsConfig,
  helmExtensionsFixture,
  helmExtensionsWriteConfig,
  helmExtensionsNative as native,
} from "./helm-extensions-fixture.js";
import { mavenHash } from "../src/maven.js";
import type { ProcessResult } from "../src/types.js";
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
const brief = (r: Awaited<ReturnType<typeof run>>) =>
  JSON.stringify(
    r.checks.map((c) => ({
      id: c.id,
      status: c.status,
      reason: c.reason,
      processes: c.processes.map((p) => ({
        exit: p.exitCode,
        stderr: p.stderr.slice(-200),
        truncated: p.truncated,
        timedOut: p.timedOut,
      })),
    })),
  );
const packet = (p: ProcessResult) =>
  helmExtensionsPacketSchema.parse(JSON.parse(p.stdout));
const changed = (
  p: ProcessResult,
  edit: (v: ReturnType<typeof packet>) => void,
) => {
  const v = packet(p);
  edit(v);
  return { ...p, stdout: JSON.stringify(v) };
};
const nativeOutput = (
  v: ReturnType<typeof packet>,
  index: number,
  edit: (text: string) => string,
) => {
  const r = v.receipts[index]!;
  r.stdout = edit(r.stdout);
  r.stdoutSha256 = mavenHash(r.stdout);
};
test("helm-extensions broken acceptance", native, async (t) => {
  const variants = [
    { kind: "minimum", count: 3, file: "values.yaml", line: 1 },
    { kind: "child", count: 6, file: "charts/worker/values.yaml", line: 1 },
    { kind: "override", count: 2, file: "values.yaml", line: 7 },
    { kind: "masked", count: 2, file: "charts/worker/values.yaml", line: 1 },
    { kind: "required", count: 3, file: "values.schema.json", line: 27 },
    { kind: "enum", count: 3, file: "values.yaml", line: 2 },
    {
      kind: "parse",
      count: 3,
      file: "charts/worker/templates/object.yaml",
      line: 12,
    },
    {
      kind: "execute",
      count: 3,
      file: "charts/worker/templates/object.yaml",
      line: 12,
    },
    {
      kind: "yaml",
      count: 2,
      file: "charts/worker/charts/leaf/templates/object.yaml",
      line: 14,
    },
  ];
  for (const variant of variants) {
    const config = helmExtensionsConfig();
    switch (variant.kind) {
      case "minimum":
        config.charts[0]!.values.count = 0;
        break;
      case "child":
        config.charts[1]!.values.count = 8;
        break;
      case "override":
        (config.charts[0]!.values.first as Record<string, unknown>).count = 0;
        break;
      case "masked":
        config.charts[1]!.values.count = 0;
        (config.charts[0]!.values.first as Record<string, unknown>).count = 2;
        (config.charts[0]!.values.second as Record<string, unknown>).count = 2;
        break;
      case "required":
        delete config.charts[0]!.values.count;
        break;
      case "enum": {
        const p = config.charts[0]!.properties.label!;
        assert.equal(p.type, "string");
        if (p.type !== "string") throw new Error("Original schema differs");
        p.enum = ["other", "next"];
        break;
      }
      case "parse":
        config.charts[1]!.templates["templates/object.yaml"]![5] =
          "  count: {{ if }}";
        break;
      case "execute":
        config.charts[1]!.templates["templates/object.yaml"]![5] =
          "  count: {{ .Values.absent.member | quote }}";
        break;
      case "yaml":
        config.charts[2]!.templates["templates/object.yaml"]![5] = "  count: [";
        break;
    }
    const root = await helmExtensionsFixture(t, config),
      r = await run(root),
      c = r.checks[0]!;
    assert.equal(r.outcome, "failed", brief(r));
    assert.equal(c.status, "failed", brief(r));
    assert.equal(c.findingsComplete, true);
    assert.equal(c.findings?.length, variant.count);
    assert.ok(
      c.findings!.every(
        (f) => f.file === variant.file && f.line === variant.line,
      ),
    );
    const p = packet(c.processes[0]!);
    assert.equal(p.receipts[1]!.exitCode, 1);
    assert.equal(p.receipts[2]!.exitCode, variant.kind === "masked" ? 0 : 1);
  }
});
test("helm-extensions fixed acceptance", native, async (t) => {
  const config = helmExtensionsConfig();
  config.charts[1]!.values.count = 8;
  const root = await helmExtensionsFixture(t, config);
  assert.equal((await run(root)).checks[0]!.status, "failed");
  config.charts[1]!.values.count = 2;
  await helmExtensionsWriteConfig(root, config);
  const r = await run(root);
  assert.equal(r.outcome, "passed", brief(r));
  const c = r.checks[0]!;
  assert.equal(c.status, "passed");
  assert.equal(c.findingsComplete, true);
  assert.deepEqual(c.findings, []);
  const p = packet(c.processes[0]!);
  assert.deepEqual(
    p.receipts.map((r) => [r.phase, r.exitCode]),
    [
      ["version", 0],
      ["lint", 0],
      ["render", 0],
      ["debug", 0],
    ],
  );
  assert.equal(p.sourceInputs.length, 13);
  assert.equal(p.nativeInputs.length, 12);
  assert.equal(helmExtensionsSources(config).size, 5);
  assert.equal(helmExtensionsDebug(config, p.receipts[3]!.stderr, p.chart), "");
  assert.equal(p.receipts[2]!.stdout.match(/^# Source:/gm)?.length, 5);
  for (const directory of [p.temporary, p.source, p.chart])
    await assert.rejects(access(directory), { code: "ENOENT" });
});
test("helm-extensions near-miss acceptance", native, async (t) => {
  const config = helmExtensionsConfig();
  config.charts[0]!.dependencies[0]!.alias = "firstish";
  config.charts[0]!.values.firstish = config.charts[0]!.values.first!;
  delete config.charts[0]!.values.first;
  config.charts[0]!.values.count = 1;
  config.charts[1]!.values.count = 5;
  config.charts[0]!.properties.source_name = { type: "string" };
  config.charts[0]!.values.source_name = "ordinary";
  config.charts[0]!.properties.active = { type: "boolean" };
  config.charts[0]!.values.active = false;
  config.charts[0]!.templates["templates/object.yaml"]!.push(
    '  identifier: {{ default "original" .Values.source_name | quote }}',
    "  active: {{ .Values.active | quote }}",
  );
  const root = await helmExtensionsFixture(t, config),
    r = await run(root);
  assert.equal(r.outcome, "passed", brief(r));
  assert.equal(r.checks[0]!.findingsComplete, true);
  assert.deepEqual(r.checks[0]!.findings, []);
  const p = packet(r.checks[0]!.processes[0]!);
  assert.ok(p.receipts[2]!.stdout.includes("/charts/firstish/"));
  assert.ok(!p.receipts[2]!.stdout.includes("/charts/first/"));
  assert.deepEqual(
    helmExtensionsValues(config).map((i) => i.values.count),
    [1, 5, 2, 5, 2],
  );
});
test("helm-extensions prerequisite acceptance", native, async (t) => {
  const root = await helmExtensionsFixture(t),
    original = process.env.PATH;
  await mkdir(path.join(root, "original-bin"));
  const marker = path.join(root, "executed-original-marker"),
    tool = path.join(root, "original-bin/helm");
  await writeFile(tool, "#!/bin/sh\n: > " + JSON.stringify(marker) + "\n");
  await chmod(tool, 0o755);
  try {
    process.env.PATH = path.join(root, "absent-bin");
    const missing = await run(root);
    assert.equal(missing.checks[0]!.status, "unavailable", brief(missing));
    assert.equal(
      missing.checks[0]!.tools!.find((t) => t.name === "helm")!.status,
      "unavailable",
    );
    process.env.PATH =
      path.join(root, "original-bin") + path.delimiter + (original ?? "");
    const wrong = await run(root);
    assert.equal(wrong.checks[0]!.status, "unavailable", brief(wrong));
    assert.equal(
      wrong.checks[0]!.tools!.find((t) => t.name === "helm")!.status,
      "unavailable",
    );
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
});
test("helm-extensions stale acceptance", native, async (t) => {
  const config = helmExtensionsConfig(),
    root = await helmExtensionsFixture(t, config),
    r = await run(root);
  assert.equal(r.checks[0]!.status, "passed", brief(r));
  const { plan, source } = await createPlan(root),
    check = plan.checks[0]!,
    p = r.checks[0]!.processes[0]!;
  assert.equal(
    helmExtensionsEvidence(check, [p], source.root).status,
    "passed",
  );
  assert.equal(
    helmExtensionsEvidence(check, [p], undefined).status,
    "inconclusive",
  );
  for (const file of [
    "values.yaml",
    "charts/worker/values.schema.json",
    "charts/worker/charts/leaf/templates/object.yaml",
    "checktrail.helm-extensions.json",
  ]) {
    const physical = path.join(root, file),
      before = await readFile(physical);
    await writeFile(physical, Buffer.concat([before, Buffer.from("\n")]));
    try {
      assert.equal(
        helmExtensionsEvidence(check, [p], source.root).status,
        "inconclusive",
        file,
      );
    } finally {
      await writeFile(physical, before);
    }
  }
  await writeFile(
    path.join(root, "README.md"),
    "original newly observed metadata\n",
  );
  assert.equal(
    helmExtensionsEvidence(check, [p], source.root).status,
    "inconclusive",
  );
});
test("helm-extensions empty acceptance", native, async (t) => {
  const root = await helmExtensionsFixture(t),
    r = await run(root);
  assert.equal(r.checks[0]!.status, "passed", brief(r));
  const { plan, source } = await createPlan(root),
    check = plan.checks[0]!,
    p = r.checks[0]!.processes[0]!;
  assert.equal(
    helmExtensionsEvidence(check, [p], source.root).status,
    "passed",
  );
  const edits: ((v: ReturnType<typeof packet>) => void)[] = [
    (v) => {
      v.inputSha256 = "0".repeat(64);
    },
    (v) => {
      v.tool.bytes++;
    },
    (v) => {
      const originalChart = v.chart;
      v.workspace = path.join(v.temporary, "foreign");
      v.chart = path.join(v.workspace, "chart");
      v.receipts[3]!.stderr = v.receipts[3]!.stderr.replace(
        originalChart,
        v.chart,
      );
      v.receipts[3]!.stderrSha256 = mavenHash(v.receipts[3]!.stderr);
    },
    (v) => {
      const originalChart = v.chart;
      v.chart = path.join(v.workspace, "foreign");
      v.receipts[3]!.stderr = v.receipts[3]!.stderr.replace(
        originalChart,
        v.chart,
      );
      v.receipts[3]!.stderrSha256 = mavenHash(v.receipts[3]!.stderr);
    },
    (v) => {
      v.receipts[2]!.phase = "debug";
    },
    (v) => {
      v.receipts[2]!.executable = "/foreign/helm";
    },
    (v) => {
      v.receipts[2]!.stdoutSha256 = "0".repeat(64);
    },
    (v) => {
      v.receipts[2]!.stderrSha256 = "0".repeat(64);
    },
    (v) => {
      for (const index of [2, 3])
        nativeOutput(v, index, (text) =>
          text.replace("name: first-object", "name: first-object-foreign"),
        );
    },
    (v) => {
      v.receipts[3]!.stderr = v.receipts[3]!.stderr.replace(
        '\\"minimum\\": 1',
        '\\"minimum\\": 0',
      );
      assert.notEqual(v.receipts[3]!.stderr, packet(p).receipts[3]!.stderr);
      v.receipts[3]!.stderrSha256 = mavenHash(v.receipts[3]!.stderr);
    },
    (v) => {
      v.sourceInputs[0]!.sha256 = "0".repeat(64);
    },
    (v) => {
      v.nativeInputs[0]!.afterSha256 = "0".repeat(64);
    },
    (v) => {
      v.nativeFiles[0] = "foreign.yaml";
    },
    (v) => {
      v.sourceFiles[0] = "foreign.json";
    },
    (v) => {
      v.tool.afterSha256 = "0".repeat(64);
    },
    (v) => {
      v.source = path.join(v.temporary, "foreign");
    },
    (v) => {
      v.receipts[2]!.args.push("--skip-schema-validation");
    },
    (v) => {
      v.receipts[1]!.stdout = v.receipts[1]!.stdout.replace(
        "3 chart(s) linted",
        "1 chart(s) linted",
      );
      v.receipts[1]!.stdoutSha256 = mavenHash(v.receipts[1]!.stdout);
    },
    (v) => {
      v.receipts[3]!.stderr = v.receipts[3]!.stderr.replace(
        "dependencies=2",
        "dependencies=1",
      );
      v.receipts[3]!.stderrSha256 = mavenHash(v.receipts[3]!.stderr);
    },
    (v) => {
      for (const index of [2, 3])
        nativeOutput(v, index, (text) =>
          text.replace(
            "# checktrail-source-line:1",
            "# checktrail-source-line:2",
          ),
        );
    },
    (v) => {
      for (const index of [2, 3])
        nativeOutput(v, index, (text) =>
          text.replace("kind: ConfigMap", "kind: Secret"),
        );
    },
    (v) => {
      for (const index of [2, 3])
        nativeOutput(v, index, (text) =>
          text.replace("name: first-object", "name: second-object"),
        );
    },
  ];
  for (const [index, edit] of edits.entries()) {
    const imported = helmExtensionsEvidence(
      check,
      [changed(p, edit)],
      source.root,
    );
    assert.equal(
      imported.status,
      "inconclusive",
      "coherent receipt edit " + index,
    );
    assert.equal(imported.findingsComplete, false);
  }
  for (const flag of ["cancelled", "timedOut", "truncated"] as const)
    assert.equal(
      helmExtensionsEvidence(check, [{ ...p, [flag]: true }], source.root)
        .status,
      "inconclusive",
    );
  assert.equal(
    helmExtensionsEvidence(check, [{ ...p, stdout: "" }], source.root).status,
    "inconclusive",
  );
  assert.equal(
    helmExtensionsEvidence(check, [], source.root).status,
    "inconclusive",
  );
  assert.equal(
    helmExtensionsEvidence(
      check,
      [
        {
          ...p,
          command: { ...p.command, args: [...p.command.args, "foreign"] },
        },
      ],
      source.root,
    ).status,
    "inconclusive",
  );
});

test("helm-extensions diagnostic acceptance", native, async (t) => {
  const kinds = [
    "maximum",
    "fraction",
    "required-both",
    "boolean",
    "pattern",
    "short",
    "long",
    "enum-one",
    "multiple",
    "nested-origin",
  ];
  for (const kind of kinds) {
    const config = helmExtensionsConfig(),
      rootChart = config.charts[0]!;
    if (kind === "maximum") rootChart.values.count = 6;
    if (kind === "fraction") rootChart.values.count = 2.5;
    if (kind === "required-both") {
      delete rootChart.values.count;
      delete rootChart.values.label;
    }
    if (kind === "boolean") {
      rootChart.properties.active = { type: "boolean" };
      rootChart.values.active = "false";
    }
    if (kind === "pattern") rootChart.values.label = "Root";
    if (kind === "short") rootChart.values.label = "x";
    if (kind === "long") rootChart.values.label = "a".repeat(65);
    if (kind === "enum-one") {
      const property = rootChart.properties.label!;
      assert.equal(property.type, "string");
      if (property.type === "string") property.enum = ["other"];
    }
    if (kind === "multiple") {
      rootChart.values.count = 0;
      rootChart.values.label = "Root";
    }
    if (kind === "nested-origin")
      (
        (rootChart.values.first as Record<string, unknown>).leaf as Record<
          string,
          unknown
        >
      ).count = 0;
    const root = await helmExtensionsFixture(t, config),
      report = await run(root),
      check = report.checks[0]!;
    assert.equal(check.status, "failed", kind + ": " + brief(report));
    assert.equal(check.findingsComplete, true);
    assert.equal(
      check.findings!.length,
      kind === "multiple" ? 6 : kind === "nested-origin" ? 2 : 3,
    );
    assert.ok(
      check.findings!.every(
        (f) =>
          f.file ===
            (kind === "required-both" ? "values.schema.json" : "values.yaml") &&
          typeof f.line === "number" &&
          f.line > 0,
      ),
    );
    const planned = await createPlan(root),
      result = check.processes[0]!,
      p = packet(result);
    const admitted = (v: ReturnType<typeof packet>) =>
      helmExtensionsEvidence(
        planned.plan.checks[0]!,
        [{ ...result, stdout: JSON.stringify(v) }],
        planned.source.root,
      );
    assert.equal(admitted(p).status, "failed");
    const altered = structuredClone(p);
    altered.receipts[3]!.stderr = altered.receipts[3]!.stderr.replace(
      kind === "required-both" ? "missing properties" : "at '/",
      kind === "required-both" ? "missing property" : "at '/foreign",
    );
    assert.notEqual(altered.receipts[3]!.stderr, p.receipts[3]!.stderr);
    altered.receipts[3]!.stderrSha256 = mavenHash(altered.receipts[3]!.stderr);
    assert.equal(admitted(altered).status, "inconclusive", kind);
    const coherent = structuredClone(p);
    for (const index of [2, 3]) {
      coherent.receipts[index]!.stderr = coherent.receipts[
        index
      ]!.stderr.replace(
        kind === "required-both" ? "missing properties" : "at '/",
        kind === "required-both" ? "missing property" : "at '/foreign",
      );
      coherent.receipts[index]!.stderrSha256 = mavenHash(
        coherent.receipts[index]!.stderr,
      );
    }
    assert.equal(admitted(coherent).status, "inconclusive", kind);
  }
});
test(
  "helm-extensions installed acceptance",
  { ...native, timeout: 300000 },
  async () => {
    if (process.env.CHECKTRAIL_HELM_EXTENSIONS_INSTALLED === "1") {
      assert.match(
        await realpath(
          fileURLToPath(new URL("../src/engine.js", import.meta.url)),
        ),
        /node_modules\/@stsepelin\/checktrail\/dist\/src\/engine\.js$/,
      );
      return;
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "helm-extensions",
    };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../scripts/verify-import-context-package.mjs",
            import.meta.url,
          ),
        ),
      ],
      { env, encoding: "utf8", timeout: 285000, maxBuffer: 4 * 1048576 },
    );
    assert.equal(result.error, undefined, result.error?.message ?? "");
    assert.equal(result.status, 0, result.stderr.slice(-3000));
    const receipt = JSON.parse(result.stdout),
      requirements = JSON.parse(
        await readFile(
          fileURLToPath(
            new URL(
              "../../scripts/required-native-tests.json",
              import.meta.url,
            ),
          ),
          "utf8",
        ),
      );
    assert.equal(
      receipt.profile.required,
      requirements["helm-extensions"].length,
    );
    assert.equal(receipt.profile.passed, receipt.profile.required);
    assert.equal(receipt.profile.complete, true);
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.harnessOutsideInstalledPackage, true);
    if (process.env.CHECKTRAIL_HELM_EXTENSIONS_INSTALL_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_HELM_EXTENSIONS_INSTALL_RECEIPT,
        JSON.stringify(receipt) + "\n",
      );
  },
);
