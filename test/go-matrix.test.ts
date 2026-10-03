import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { applyGoBuildPolicy } from "../src/go-build.js";
import { goBuildEvidence } from "../src/go-build-evidence.js";
import { goTargetPreflight } from "../src/go-target.js";
import { validatedReport } from "../src/report-validation.js";
import {
  createFindingBaseline,
  compareFindings,
} from "../src/finding-policy.js";
import { exportSarif } from "../src/sarif.js";
import { projectPlan, projectReport } from "../src/output.js";
import {
  planSchema,
  planSummarySchema,
  reportSchema,
  reportSummarySchema,
} from "../src/schemas.js";
import type { Check, ProcessResult } from "../src/types.js";
import { fixture } from "./helpers.js";

const native = spawnSync("go", ["env", "-json", "GOHOSTOS", "GOHOSTARCH"], {
  encoding: "utf8",
});
const available = native.status === 0;
const host = available
  ? (JSON.parse(native.stdout) as { GOHOSTOS: string; GOHOSTARCH: string })
  : { GOHOSTOS: "linux", GOHOSTARCH: "amd64" };
const target = { os: host.GOHOSTOS, arch: host.GOHOSTARCH, cgo: false };
const manifest = "module example.invalid/sample\n\ngo 1.23\n";
const source = "package sample\nfunc Value() int { return 42 }\n";
const assertion =
  'package sample\nimport "testing"\nfunc TestValue(t *testing.T) { if Value()!=42 {t.Fatal(Value())} }\n';
const config = (checks: string[], environment: string[] = []) =>
  JSON.stringify({
    schemaVersion: 1,
    projects: [{ path: ".", checks, environment }],
  });
const profile = (checks = ["go.test"], repetitions = 2, name = "required") => ({
  name,
  tags: [] as string[],
  checks,
  excludedFiles: [] as { path: string; reason: string }[],
  repetitions,
});
const policy = (...profiles: ReturnType<typeof profile>[]) =>
  JSON.stringify({ schemaVersion: 2, profiles });
const options = { trusted: true, timeoutMs: 120_000 };

// This planning fixture installs an executable marker which must never run.
test("Go matrix planning expands exact required identities without executing code or leaking profile metadata", async (t) => {
  const ids = [
    "go.build",
    "go.vet",
    "go.test",
    "go.test-race",
    "go.staticcheck",
    "go.golangci-lint",
  ];
  const root = await fixture(t, {
    "go.mod": manifest,
    "value.go": source,
    "value_test.go": assertion,
    ".golangci.yml": 'version: "2"\n',
    "tools/go": "#!/bin/sh\n: > executed\nexit 99\n",
    "checktrail.json": config(["go.format", ...ids], ["PATH"]),
    "checktrail.go-build.json": policy(
      {
        ...profile(ids, 2, "private_first"),
        tags: ["private_tag"],
        target: { ...target, cgo: true },
      } as ReturnType<typeof profile>,
      profile(ids, 1, "private_second"),
    ),
  });
  await chmod(path.join(root, "tools/go"), 0o755);
  const settings = { environment: { PATH: path.join(root, "tools") } };
  const { plan, source: inventory } = await createPlan(root, settings);
  planSchema.parse(plan);
  assert.equal(plan.checks.length, 19);
  assert.equal(plan.checks[0]!.executionId, undefined);
  const identities = plan.checks.slice(1).map((c) => c.executionId);
  assert.equal(new Set(identities).size, 18);
  assert.ok(identities.every((id) => /^[a-f0-9]{64}$/.test(id!)));
  assert.deepEqual(
    (await createPlan(root, settings)).plan.checks.map((c) => c.executionId),
    plan.checks.map((c) => c.executionId),
  );
  for (const check of plan.checks.filter(
    (c) => c.goBuild?.profile === "private_first",
  )) {
    assert.equal(check.commands[0]!.args[0], "env");
    assert.deepEqual(check.commands[1]!.args, [
      "tool",
      "dist",
      "list",
      "-json",
    ]);
    assert.ok(
      check.commands.every(
        (c) =>
          c.env?.GOOS === target.os &&
          c.env.GOARCH === target.arch &&
          c.env.CGO_ENABLED === "1" &&
          c.env.GOPROXY === "off" &&
          c.env.GOFLAGS === "-mod=readonly",
      ),
    );
    if (check.id === "go.test" || check.id === "go.test-race")
      assert.equal(
        check.commands.at(-1)!.args.filter((a) => a === "-count=1").length,
        1,
      );
  }
  const summary = projectPlan(plan, false);
  planSummarySchema.parse(summary);
  assert.ok(!JSON.stringify(summary).includes("private_"));
  assert.ok(!JSON.stringify(summary).includes(root));
  await assert.rejects(readFile(path.join(root, "executed")), {
    code: "ENOENT",
  });
  // Corrupt a later command to check atomic policy application, not only schema validation.
  const checks: Check[] = [
    {
      ...plan.checks.find((c) => c.id === "go.vet")!,
      commands: [{ executable: "go", args: ["vet", "./..."], cwd: "." }],
    },
    {
      ...plan.checks.find((c) => c.id === "go.test")!,
      commands: [{ executable: "unexpected", args: [], cwd: "." }],
    },
  ];
  const before = structuredClone(checks);
  await applyGoBuildPolicy(inventory, plan.projects[0]!, checks);
  assert.deepEqual(
    checks.map((c) => c.commands),
    before.map((c) => c.commands),
  );
  assert.ok(
    checks.every((c) => c.unavailableReason === "Unsupported Go build command"),
  );
});

test("Go matrix rejects unsafe, ambiguous and over-budget declarations before any process starts", async (t) => {
  const root = await fixture(t, {
    "go.mod": manifest,
    "value.go": source,
    "checktrail.json": config(["go.test"]),
  });
  const valid = profile();
  const invalid = [
    { ...valid, repetitions: 0 },
    { ...valid, repetitions: 17 },
    { ...valid, repetitions: 1.5 },
    { ...valid, checks: ["go.test", "go.test"] },
    { ...valid, target: { ...target, os: "linux;true" } },
    { ...valid, target: { ...target, arch: "-race" } },
    { ...valid, target: { ...target, cgo: "1" } },
    { ...valid, target: { ...target, CC: "project-script" } },
    { ...valid, repetitions: undefined },
  ].map((p) => [p]);
  invalid.push([valid, valid]);
  invalid.push(
    Array.from({ length: 9 }, (_, i) => ({
      ...profile(["go.test"], 16, `p${i}`),
    })),
  );
  for (const profiles of invalid) {
    await writeFile(
      path.join(root, "checktrail.go-build.json"),
      JSON.stringify({ schemaVersion: 2, profiles }),
    );
    const report = await validate(root, options);
    assert.equal(report.outcome, "incomplete", JSON.stringify(profiles));
    assert.deepEqual(
      report.checks.map((c) => c.status),
      ["unavailable"],
    );
    assert.deepEqual(report.checks[0]!.processes, []);
  }
  await writeFile(
    path.join(root, "checktrail.go-build.json"),
    policy({ ...profile(["go.test-race"]), target } as ReturnType<
      typeof profile
    >),
  );
  await writeFile(path.join(root, "checktrail.json"), config(["go.test-race"]));
  const report = await validate(root, options);
  assert.deepEqual(
    report.checks.map((c) => c.status),
    ["unavailable", "unavailable"],
  );
  assert.ok(
    report.checks.every(
      (c) => c.processes.length === 0 && /cgo/.test(c.reason),
    ),
  );
});

const processResult = (
  command: Check["commands"][number],
  output: unknown,
): ProcessResult => ({
  command,
  stdout: JSON.stringify(output),
  stderr: "",
  exitCode: 0,
  signal: null,
  durationMs: 1,
  timedOut: false,
  truncated: false,
  cancelled: false,
});
test("Go target preflight rejects incomplete, contradictory and duplicate native evidence and exact target near misses", () => {
  const check: Check = {
    id: "go.test",
    adapter: "go",
    project: ".",
    scope: ["value.go"],
    kind: "test",
    parser: "go-scope-test",
    reason: "synthetic",
    commands: [],
    goBuild: { profile: "targeted", tags: [], target },
  };
  const command = { executable: "go", args: [], cwd: "." };
  const env = {
    GOOS: target.os,
    GOARCH: target.arch,
    CGO_ENABLED: "0",
    GOHOSTOS: target.os,
    GOHOSTARCH: target.arch,
  };
  const platform = {
    GOOS: target.os,
    GOARCH: target.arch,
    CgoSupported: true,
    FirstClass: true,
  };
  const complete = [
    processResult(command, env),
    processResult(command, [platform]),
  ];
  assert.equal(goTargetPreflight(check, complete).status, "ready");
  for (const results of [
    [],
    complete.slice(0, 1),
    [complete[0]!, { ...complete[1]!, truncated: true }],
    [complete[0]!, processResult(command, [platform, platform])],
    [processResult(command, { ...env, CGO_ENABLED: "1" }), complete[1]!],
    [
      processResult(command, { ...env, GOARCH: target.arch + "extra" }),
      complete[1]!,
    ],
  ])
    assert.equal(goTargetPreflight(check, results).status, "inconclusive");
  assert.equal(
    goTargetPreflight(check, [
      complete[0]!,
      processResult(command, [{ ...platform, GOOS: target.os + "extra" }]),
    ]).status,
    "unavailable",
  );
  const cgo = {
    ...check,
    goBuild: { ...check.goBuild!, target: { ...target, cgo: true } },
  };
  assert.equal(
    goTargetPreflight(cgo, [
      processResult(command, { ...env, CGO_ENABLED: "1" }),
      processResult(command, [{ ...platform, CgoSupported: false }]),
    ]).status,
    "unavailable",
  );
});

test(
  "native Go repetitions retain intermittent failures, fresh processes and every cancelled or omitted execution",
  { skip: available ? false : "Go unavailable", timeout: 120_000 },
  async (t) => {
    const testSource = `package sample
import ("testing"; "os"; "strconv")
var starts int
func TestRepeated(t *testing.T) {
 starts++
 if starts != 1 { t.Fatal("process reused") }
 data, err := os.ReadFile(".checktrail/count")
 if err != nil { t.Fatal(err) }
 n, err := strconv.Atoi(string(data))
 if err != nil { t.Fatal(err) }
 n++
 if err = os.WriteFile(".checktrail/count", []byte(strconv.Itoa(n)), 0600); err != nil {t.Fatal(err)}
 if n == 2 { t.Fatal("second independent execution") }
}
`;
    const root = await fixture(t, {
      "go.mod": manifest,
      "value.go": source,
      "value_test.go": testSource,
      ".checktrail/count": "0",
      "checktrail.json": config(["go.test"]),
      "checktrail.go-build.json": policy(profile(["go.test"], 3)),
    });
    const failed = await validate(root, options);
    assert.equal(failed.outcome, "failed");
    assert.deepEqual(
      failed.checks.map((c) => c.status),
      ["passed", "failed", "passed"],
    );
    assert.deepEqual(
      failed.checks.map((c) => c.tests),
      [
        { total: 1, passed: 1, failed: 0, skipped: 0 },
        { total: 1, passed: 0, failed: 1, skipped: 0 },
        { total: 1, passed: 1, failed: 0, skipped: 0 },
      ],
    );
    assert.equal(
      await readFile(path.join(root, ".checktrail/count"), "utf8"),
      "3",
    );
    assert.ok(
      failed.checks.every((c) =>
        c.processes[1]!.command.args.includes("-count=1"),
      ),
    );
    validatedReport(failed);
    await writeFile(
      path.join(root, "value_test.go"),
      testSource.replace("if n == 2", "if n < 0"),
    );
    await writeFile(path.join(root, ".checktrail/count"), "0");
    const passed = await validate(root, options);
    assert.equal(passed.outcome, "passed");
    assert.equal(passed.sourceChanged, false);
    assert.equal(
      await readFile(path.join(root, ".checktrail/count"), "utf8"),
      "3",
    );
    const sarif = exportSarif(passed);
    assert.deepEqual(
      sarif.runs.map((r) => r.properties.executionId),
      passed.checks.map((c) => c.executionId),
    );
    const missing = { ...passed, checks: passed.checks.slice(1) };
    assert.throws(
      () =>
        validatedReport({
          ...missing,
          requiredExecutionIds: missing.checks.map(
            (check) => check.executionId!,
          ),
        }),
      /repetitions are missing/,
    );
    assert.throws(() => validatedReport(missing), /repetitions are missing/);
    assert.throws(() => exportSarif(missing), /repetitions are missing/);
    assert.throws(
      () =>
        validatedReport({
          ...passed,
          checks: [passed.checks[0]!, passed.checks[0]!, passed.checks[2]!],
        }),
      /Duplicate check/,
    );
    assert.throws(
      () =>
        validatedReport({
          ...passed,
          checks: passed.checks.map((c, i) =>
            i === 0 ? { ...c, executionId: "a".repeat(64) } : c,
          ),
        }),
      /execution identity/,
    );
    const cancelled = await validate(root, {
      ...options,
      signal: AbortSignal.abort(),
    });
    assert.equal(cancelled.outcome, "incomplete");
    assert.deepEqual(
      cancelled.checks.map((c) => c.executionId),
      passed.checks.map((c) => c.executionId),
    );
    assert.ok(
      cancelled.checks.every(
        (c) =>
          c.status === "inconclusive" && c.processes.length === 0 && !c.tests,
      ),
    );
    validatedReport(cancelled);
    const exhausted = await validate(root, { ...options, timeoutMs: 1 });
    assert.equal(exhausted.outcome, "incomplete");
    assert.equal(exhausted.checks.length, 3);
    assert.ok(exhausted.checks.every((c) => c.status !== "passed"));
  },
);

test(
  "native Go target matrices compile and link cross targets while retaining host tests and unavailable foreign execution",
  { skip: available ? false : "Go unavailable", timeout: 180_000 },
  async (t) => {
    const foreignOs = target.os === "linux" ? "darwin" : "linux";
    const foreign = { os: foreignOs, arch: target.arch, cgo: false };
    const selectedFile = `selected_${foreignOs}.go`;
    const profiles = [
      {
        ...profile(["go.build", "go.vet", "go.test"], 2, "host"),
        target,
        excludedFiles: [
          {
            path: selectedFile,
            reason: "Only the foreign build profile selects this file",
          },
        ],
      },
      { ...profile(["go.build", "go.vet"], 1, "foreign"), target: foreign },
    ];
    const root = await fixture(t, {
      "go.mod": manifest,
      "value.go": source,
      "value_test.go": assertion,
      [selectedFile]: 'package sample\nfunc Selected() int {return "wrong"}\n',
      "cmd/synthetic/main.go":
        'package main\nimport "example.invalid/sample"\nfunc number() int {return sample.Value()}\nfunc main() { _ = number() }\n',
      "cmd/synthetic/main_test.go":
        'package main\nimport "testing"\nfunc TestNumber(t *testing.T) { if number()!=42 {t.Fatal(number())} }\n',
      "checktrail.json": config(["go.build", "go.vet", "go.test"]),
      "checktrail.go-build.json": policy(...profiles),
    });
    const temporary = await fixture(t, {});
    const originalTemp = process.env.TMPDIR;
    process.env.TMPDIR = temporary;
    t.after(() => {
      if (originalTemp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTemp;
    });
    const broken = await validate(root, options);
    assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
    assert.equal(broken.checks.length, 8);
    assert.ok(
      broken.checks
        .filter((c) => c.goBuild?.profile === "host")
        .every((c) => c.status === "passed"),
    );
    const failures = broken.checks.filter(
      (c) => c.goBuild?.profile === "foreign",
    );
    assert.deepEqual(
      failures.map((c) => c.status),
      ["failed", "failed"],
    );
    assert.ok(
      failures.every((c) =>
        c.processes.some(
          (p) =>
            p.stderr.includes("cannot use") && p.stderr.includes(selectedFile),
        ),
      ),
    );
    await writeFile(
      path.join(root, selectedFile),
      "package sample\nfunc Selected() int {return 7}\n",
    );
    const passed = await validate(root, options);
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    reportSchema.parse(passed);
    validatedReport(passed);
    assert.throws(
      () =>
        validatedReport({
          ...passed,
          checks: passed.checks.filter((c) => c.goBuild?.profile === "host"),
        }),
      /execution manifest/,
    );
    assert.throws(
      () =>
        validatedReport({
          ...passed,
          checks: passed.checks.map((c, i) =>
            i === 0 ? { ...c, goTarget: { ...c.goTarget!, arch: "wrong" } } : c,
          ),
        }),
      /target evidence/,
    );
    assert.equal(passed.sourceChanged, false);
    for (const check of passed.checks) {
      assert.deepEqual(check.goTarget, {
        ...check.goBuild!.target,
        hostOs: target.os,
        hostArch: target.arch,
      });
      if (check.id === "go.build") {
        assert.equal(check.tests, undefined);
        assert.ok(check.scope.every((file) => !file.endsWith("_test.go")));
        assert.equal(check.processes.at(-1)!.command.temporaryDirectory, true);
        assert.deepEqual(
          check.tools?.find((tool) => tool.name === "node"),
          {
            name: "node",
            source: "engine-runtime",
            version: process.versions.node,
            status: "identified",
          },
        );
      } else if (check.id === "go.test") assert.equal(check.tests?.passed, 2);
    }
    assert.ok(!(await readdir(root)).includes("synthetic"));
    assert.deepEqual(await readdir(path.join(root, "cmd/synthetic")), [
      "main.go",
      "main_test.go",
    ]);
    profiles[1]!.checks.push("go.test");
    await writeFile(
      path.join(root, "checktrail.go-build.json"),
      policy(...profiles),
    );
    const incomplete = await validate(root, options);
    assert.equal(incomplete.outcome, "incomplete");
    const unrun = incomplete.checks.find(
      (c) => c.id === "go.test" && c.goBuild?.profile === "foreign",
    )!;
    assert.equal(unrun.status, "unavailable");
    assert.equal(unrun.processes.length, 2);
    assert.equal(unrun.tests, undefined);
    assert.match(unrun.reason, /another platform/);
    assert.ok(
      incomplete.checks
        .filter((c) => c !== unrun)
        .every((c) => c.status === "passed"),
    );
    await writeFile(
      path.join(root, "checktrail.go-build.json"),
      policy({
        ...profile(["go.test"], 1),
        target: { ...target, os: "unknownos" },
      } as ReturnType<typeof profile>),
    );
    await writeFile(path.join(root, "checktrail.json"), config(["go.test"]));
    const unsupported = await validate(root, options);
    assert.equal(unsupported.outcome, "incomplete");
    assert.equal(unsupported.checks[0]!.status, "unavailable");
    assert.equal(unsupported.checks[0]!.processes.length, 2);
    assert.deepEqual(
      await readdir(temporary),
      [],
      "Every owned build directory must be removed after success and failure",
    );
    await writeFile(
      path.join(root, "checktrail.go-build.json"),
      policy(profile(["go.build"], 1)),
    );
    await writeFile(path.join(root, "checktrail.json"), config(["go.build"]));
    await writeFile(
      path.join(root, "go.mod"),
      manifest + "require example.invalid/unavailable v1.0.0\n",
    );
    await writeFile(
      path.join(root, "value.go"),
      'package sample\nimport _ "example.invalid/unavailable"\n',
    );
    const loading = await validate(root, options);
    assert.equal(loading.outcome, "incomplete");
    assert.notEqual(loading.checks[0]!.status, "failed");
    assert.deepEqual(await readdir(temporary), []);
  },
);

for (const [id, tool, args] of [
  ["go.staticcheck", "staticcheck", ["-version"]],
  ["go.golangci-lint", "golangci-lint", ["version", "--short"]],
] as const) {
  const nativePath =
    path.resolve(".checktrail/go-tools/bin") +
    path.delimiter +
    (process.env.PATH ?? "");
  const availableTool =
    spawnSync(tool, args, { env: { ...process.env, PATH: nativePath } })
      .status === 0;
  test(
    `native ${id} repeated target profiles preserve per-execution diagnostics and baseline identities`,
    { skip: availableTool ? false : `${tool} unavailable`, timeout: 120_000 },
    async (t) => {
      const tagged =
        '//go:build feature\n\npackage sample\nimport "strings"\nfunc Fold(value string) string {return strings.ToLower(value)}\n';
      const root = await fixture(t, {
        "go.mod": manifest,
        "value.go":
          "// Package sample is an original synthetic fixture.\n" + source,
        "feature.go": tagged,
        ".golangci.yml":
          'version: "2"\nlinters:\n  default: none\n  enable: [staticcheck]\n',
        "checktrail.json": config([id], ["PATH"]),
        "checktrail.go-build.json": policy({
          ...profile([id]),
          target,
          tags: ["feature"],
        } as ReturnType<typeof profile>),
      });
      const settings = { ...options, environment: { PATH: nativePath } };
      const clean = await validate(root, settings);
      assert.equal(clean.outcome, "passed", JSON.stringify(clean.checks));
      assert.equal(clean.checks.length, 2);
      await writeFile(
        path.join(root, "feature.go"),
        tagged.replace(
          "return strings.ToLower(value)",
          "strings.ToLower(value); return value",
        ),
      );
      const failed = await validate(root, settings);
      assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
      assert.ok(
        failed.checks.every(
          (c) =>
            c.status === "failed" &&
            c.findingsComplete &&
            c.findings?.some(
              (f) =>
                f.file === "feature.go" &&
                (f.ruleId === "SA4017" || f.message.includes("SA4017")),
            ),
        ),
      );
      const baseline = createFindingBaseline(failed, {
        owner: "synthetic",
        reason: "Test only",
      });
      assert.equal(baseline.entries.length, 2);
      assert.equal(new Set(baseline.entries.map((e) => e.executionId)).size, 2);
      assert.ok(baseline.entries.every((e) => e.occurrences === 1));
      assert.equal(compareFindings(failed, baseline).outcome, "passed");
      await writeFile(
        path.join(root, "checktrail.go-build.json"),
        policy({
          ...profile([id], 2, "changed_profile"),
          target,
          tags: ["feature"],
        } as ReturnType<typeof profile>),
      );
      const changed = await validate(root, settings);
      const comparison = compareFindings(changed, baseline);
      assert.equal(comparison.outcome, "failed");
      assert.equal(comparison.counts.new, 2);
      assert.equal(comparison.counts.unverified, 2);
    },
  );
}

test(
  "Go matrix CLI and MCP retain every execution with summary privacy and operator trust",
  { skip: available ? false : "Go unavailable", timeout: 120_000 },
  async (t) => {
    const root = await fixture(t, {
      "go.mod": manifest,
      "value.go": source,
      "value_test.go": assertion,
      "checktrail.json": config(["go.test"]),
      "checktrail.go-build.json": policy({
        ...profile(["go.test"], 2, "private_profile"),
        tags: ["private_tag"],
        target,
      } as ReturnType<typeof profile>),
    });
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const output = spawnSync(
      process.execPath,
      [cli, "run", "--root", root, "--trust-project"],
      { encoding: "utf8", timeout: 60000 },
    );
    assert.equal(output.status, 0, output.stderr);
    const report = reportSummarySchema.parse(JSON.parse(output.stdout));
    assert.equal(report.outcome, "passed");
    assert.equal(report.checks.length, 2);
    assert.ok(
      report.checks.every(
        (c, i) =>
          c.goRepetition?.iteration === i + 1 &&
          c.goRepetition.total === 2 &&
          c.executionId,
      ),
    );
    assert.ok(
      !output.stdout.includes("private_") && !output.stdout.includes(root),
    );
    for (const trusted of [false, true]) {
      const client = new Client(
        { name: "go-matrix-test", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      try {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [
              cli,
              "serve",
              "--root",
              root,
              ...(trusted ? ["--allow-execution"] : []),
            ],
            stderr: "pipe",
          }),
        );
        const plan = await client.callTool({
          name: "validation_plan",
          arguments: {},
        });
        const planned = planSummarySchema.parse(plan.structuredContent);
        assert.equal(planned.checks.length, 2);
        assert.deepEqual(
          planned.checks.map((c) => c.executionId),
          report.checks.map((c) => c.executionId),
        );
        const result = await client.callTool({
          name: "validation_run",
          arguments: {},
        });
        if (!trusted) assert.equal(result.isError, true);
        else {
          assert.notEqual(result.isError, true);
          const summary = reportSummarySchema.parse(result.structuredContent);
          assert.equal(summary.outcome, "passed");
          assert.deepEqual(summary.checks, report.checks);
          assert.ok(
            !JSON.stringify(result).includes("private_") &&
              !JSON.stringify(result).includes(root),
          );
        }
      } finally {
        await client.close();
      }
    }
    const detailed = await validate(root, options);
    reportSummarySchema.parse(projectReport(detailed, false));
  },
);

test(
  "native Go repeated race targets preserve instrumentation and independent native test counts",
  { skip: available ? false : "Go unavailable", timeout: 120_000 },
  async (t) => {
    const root = await fixture(t, {
      "go.mod": manifest,
      "value.go": source,
      "value_test.go": assertion,
      "race_test.go": `//go:build race

package sample
import ("testing"; "sync"; "sync/atomic")
func TestAtomic(t *testing.T) {
 var n atomic.Int32
 var wg sync.WaitGroup
 wg.Add(2)
 for i:=0; i<2; i++ {go func() {defer wg.Done(); n.Add(1)}()}
 wg.Wait()
 if n.Load()!=2 {t.Fatal(n.Load())}
}
`,
      "checktrail.json": config(["go.test-race"]),
      "checktrail.go-build.json": policy({
        ...profile(["go.test-race"]),
        target: { ...target, cgo: true },
      } as ReturnType<typeof profile>),
    });
    const report = await validate(root, options);
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.equal(report.checks.length, 2);
    assert.deepEqual(
      report.checks.map((c) => c.tests),
      Array.from({ length: 2 }, () => ({
        total: 2,
        passed: 2,
        failed: 0,
        skipped: 0,
      })),
    );
    assert.ok(
      report.checks.every(
        (c) =>
          c.goTarget?.cgo &&
          c.processes.slice(2).every((p) => p.command.args.includes("-race")),
      ),
    );
    validatedReport(report);
  },
);

test("Go build evidence distinguishes positioned compiler failures from loading, linking, unexpected output and omitted production scope", () => {
  const root = path.resolve("synthetic-build");
  const command = { executable: "go", args: [], cwd: "." };
  const check: Check = {
    id: "go.build",
    adapter: "go",
    project: ".",
    scope: ["value.go"],
    kind: "analysis",
    parser: "go-build",
    reason: "synthetic",
    commands: [command, command],
  };
  const scope = processResult(command, {
    Dir: root,
    ImportPath: "example.invalid/sample",
    GoFiles: ["value.go"],
    TestGoFiles: ["value_test.go"],
  });
  const clean = { ...processResult(command, {}), stdout: "" };
  assert.equal(goBuildEvidence(check, [scope, clean], root).status, "passed");
  const compiler = {
    ...clean,
    exitCode: 1,
    stderr: "# example.invalid/sample\n./value.go:2:1: invalid assignment\n",
  };
  const failed = goBuildEvidence(check, [scope, compiler], root);
  assert.equal(failed.status, "failed");
  assert.equal(failed.findingsComplete, true);
  assert.deepEqual(failed.findings, [
    {
      ruleId: "go.compiler",
      level: "error",
      message: "invalid assignment",
      file: "value.go",
      line: 2,
    },
  ]);
  assert.equal(
    goBuildEvidence(
      check,
      [
        scope,
        {
          ...compiler,
          stderr:
            compiler.stderr +
            "# example.invalid/other\n./value.go:3:1: another assignment\n",
        },
      ],
      root,
    ).findings?.length,
    2,
  );
  for (const stderr of [
    "go: unavailable dependency",
    "# example.invalid/sample\nlink: undefined external symbol",
    compiler.stderr + "go: loading failed\n",
    compiler.stderr.replace("./value.go", "./foreign.go"),
  ]) {
    assert.equal(
      goBuildEvidence(check, [scope, { ...compiler, stderr }], root).status,
      "error",
    );
  }
  assert.equal(
    goBuildEvidence(check, [scope, { ...clean, stderr: "warning" }], root)
      .status,
    "inconclusive",
  );
  assert.equal(
    goBuildEvidence(check, [{ ...scope, exitCode: 1 }, compiler], root).status,
    "inconclusive",
  );
});

test(
  "native Go production builds retain test exclusions only in checks that actually select tests",
  { skip: available ? false : "Go unavailable", timeout: 120_000 },
  async (t) => {
    const root = await fixture(t, {
      "go.mod": manifest,
      "value.go": source,
      "value_test.go": assertion,
      "hidden_test.go":
        '//go:build other\n\npackage sample\nimport "testing"\nfunc TestHidden(t *testing.T) {t.Fatal("not selected")}\n',
      "checktrail.json": config(["go.build", "go.test"]),
      "checktrail.go-scope.json": JSON.stringify({
        schemaVersion: 1,
        excludedFiles: [
          { path: "hidden_test.go", reason: "Requires another tag" },
        ],
      }),
    });
    const report = await validate(root, options);
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    const build = report.checks.find((check) => check.id === "go.build")!;
    const tests = report.checks.find((check) => check.id === "go.test")!;
    assert.deepEqual(build.scope, ["value.go"]);
    assert.deepEqual(build.goScope?.excludedFiles, []);
    assert.equal(build.tests, undefined);
    assert.deepEqual(
      tests.goScope?.excludedFiles.map((entry) => entry.path),
      ["hidden_test.go"],
    );
    assert.equal(tests.tests?.passed, 1);
    await writeFile(
      path.join(root, "hidden_test.go"),
      'package sample\nimport "testing"\nfunc TestHidden(t *testing.T) {t.Fatal("now selected")}\n',
    );
    const failed = await validate(root, options);
    assert.equal(
      failed.checks.find((check) => check.id === "go.build")!.status,
      "passed",
    );
    assert.equal(
      failed.checks.find((check) => check.id === "go.test")!.status,
      "failed",
    );
    assert.equal(failed.outcome, "failed");
  },
);
