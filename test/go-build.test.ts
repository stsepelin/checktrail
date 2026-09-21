import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { projectPlan, projectReport } from "../src/output.js";
import {
  planSchema,
  planSummarySchema,
  reportSchema,
  reportSummarySchema,
} from "../src/schemas.js";
import { fixture } from "./helpers.js";

const available = spawnSync("go", ["version"]).status === 0;
const manifest = "module example.invalid/sample\n\ngo 1.23\n";
const source = "package sample\n\nfunc Value() int { return 42 }\n";
const assertion =
  'package sample\nimport "testing"\nfunc TestValue(t *testing.T) { if Value()!=42 { t.Fatal(Value()) } }\n';
const nativeChecks = [
  "go.vet",
  "go.test",
  "go.test-race",
  "go.staticcheck",
  "go.golangci-lint",
];
const config = (checks: string[], environment: string[] = []) =>
  JSON.stringify({
    schemaVersion: 1,
    projects: [{ path: ".", checks, environment }],
  });
const profile = (
  checks: string[],
  tags = ["feature"],
  excludedFiles: { path: string; reason: string }[] = [],
  name = "selected",
) => ({ name, tags, checks, excludedFiles });
const policy = (...profiles: ReturnType<typeof profile>[]) =>
  JSON.stringify({ schemaVersion: 1, profiles });
const options = { trusted: true, timeoutMs: 120_000 };

test("Go build planning is data-only and binds every native command while preserving formatting and summary privacy", async (t) => {
  const root = await fixture(t, {
    "go.mod": manifest,
    "value.go": source,
    ".golangci.yml": 'version: "2"\n',
    "checktrail.json": config(["go.format", ...nativeChecks], ["PATH"]),
    "checktrail.go-build.json": policy(
      profile(
        nativeChecks,
        ["private_feature", "integration"],
        [],
        "private_profile",
      ),
    ),
    "tools/go": "#!/bin/sh\n: > executed\nexit 99\n",
  });
  await chmod(path.join(root, "tools/go"), 0o755);
  const settings = { environment: { PATH: path.join(root, "tools") } };
  const { plan } = await createPlan(root, settings);
  planSchema.parse(plan);
  assert.equal(plan.checks.length, 6);
  const format = plan.checks[0]!;
  assert.equal(format.goBuild, undefined);
  assert.equal(format.goScope, undefined);
  assert.deepEqual(
    format.commands.map((c) => c.args),
    [["-l", "./value.go"]],
  );
  for (const check of plan.checks.slice(1)) {
    assert.equal(check.unavailableReason, undefined);
    assert.deepEqual(check.goBuild, {
      profile: "private_profile",
      tags: ["private_feature", "integration"],
    });
    assert.deepEqual(check.goScope, { schemaVersion: 1, excludedFiles: [] });
    for (const command of check.commands) {
      assert.equal(command.env?.GOFLAGS, "-mod=readonly");
      assert.equal(command.env?.GOPROXY, "off");
      if (command.executable === process.execPath)
        assert.deepEqual(JSON.parse(command.args[3]!), [
          "private_feature",
          "integration",
        ]);
      else
        assert.equal(
          command.args.filter(
            (arg) => arg === "-tags=private_feature,integration",
          ).length,
          1,
        );
    }
  }
  const summary = projectPlan(plan, false);
  planSummarySchema.parse(summary);
  assert.deepEqual(
    (summary.checks as { goBuildTagCount?: number }[]).map(
      (c) => c.goBuildTagCount,
    ),
    [undefined, 2, 2, 2, 2, 2],
  );
  assert.ok(!JSON.stringify(summary).includes("private_"));
  await assert.rejects(readFile(path.join(root, "executed")), {
    code: "ENOENT",
  });
  await writeFile(
    path.join(root, "checktrail.go-build.json"),
    policy(profile(nativeChecks, ["changed"])),
  );
  assert.notEqual(
    (await createPlan(root, settings)).plan.sourceFingerprint,
    plan.sourceFingerprint,
  );
});

test("Go build policy rejects ambiguous assignments, unsafe tags, invalid exclusions and nonregular policies before execution", async (t) => {
  const root = await fixture(t, {
    "go.mod": manifest,
    "value.go": source,
    "checktrail.json": config(["go.vet"]),
  });
  const target = path.join(root, "checktrail.go-build.json");
  const valid = profile(["go.vet"]);
  const bad = [
    { schemaVersion: 2, profiles: [valid] },
    { schemaVersion: 1, profiles: [] },
    ...[
      "-race",
      "a,b",
      "a b",
      "a\n",
      "$(touch marker)",
      "",
      "a".repeat(65),
    ].map((tag) => ({
      schemaVersion: 1,
      profiles: [profile(["go.vet"], [tag])],
    })),
    ...[
      [profile(["go.vet"], ["a", "a"])],
      [profile(["go.vet", "go.vet"])],
      [profile(["go.format"])],
      [
        profile(["go.test"], [], [], "duplicate"),
        profile(["go.vet"], [], [], "duplicate"),
      ],
      [valid, profile(["go.vet"], [], [], "second")],
      [profile(["go.vet"], [], [{ path: "absent.go", reason: "missing" }])],
      [profile(["go.vet"], [], [{ path: "../value.go", reason: "escape" }])],
      [profile(["go.vet"], [], [{ path: "value.go", reason: " " }])],
      [
        profile(
          ["go.vet"],
          [],
          [
            { path: "value.go", reason: "first" },
            { path: "value.go", reason: "duplicate" },
          ],
        ),
      ],
      [{ ...valid, GOOS: "linux" }],
      [{ ...valid, name: "a/b" }],
    ].map((profiles) => ({ schemaVersion: 1, profiles })),
  ];
  for (const input of bad) {
    await writeFile(target, JSON.stringify(input));
    const report = await validate(root, options);
    assert.equal(report.outcome, "incomplete", JSON.stringify(input));
    assert.equal(report.checks[0]!.status, "unavailable");
    assert.deepEqual(report.checks[0]!.processes, []);
  }
  await writeFile(target, policy(valid));
  await writeFile(
    path.join(root, "checktrail.go-scope.json"),
    JSON.stringify({ schemaVersion: 1, excludedFiles: [] }),
  );
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /either Go build/,
  );
  await rm(path.join(root, "checktrail.go-scope.json"));
  await rm(target);
  await mkdir(target);
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /regular file/,
  );
  await rm(target, { recursive: true });
  await writeFile(path.join(root, "policy.json"), policy(valid));
  await symlink("policy.json", target);
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /regular file/,
  );
});

test(
  "native Go build tags expose tagged failures and preserve exclusion, test-count and missing-profile accounting",
  { skip: available ? false : "Go unavailable", timeout: 180_000 },
  async (t) => {
    const selected = profile(["go.vet", "go.test"]);
    const root = await fixture(t, {
      "go.mod": manifest,
      "value.go": source,
      "value_test.go": assertion,
      "feature.go":
        '//go:build feature\n\npackage sample\nfunc Feature() int { return "wrong" }\n',
      "feature_test.go":
        '//go:build feature\n\npackage sample\nimport "testing"\nfunc TestFeature(t *testing.T) { if Feature()!=7 {t.Fatal(Feature())} }\n',
      "checktrail.json": config(["go.vet", "go.test"]),
    });
    assert.equal((await validate(root, options)).outcome, "incomplete");
    const file = path.join(root, "checktrail.go-build.json");
    await writeFile(file, policy(selected));
    const broken = await validate(root, options);
    assert.equal(broken.outcome, "failed");
    assert.ok(
      broken.checks.some((c) =>
        c.processes.some(
          (p) =>
            p.stdout.includes("cannot use") || p.stderr.includes("cannot use"),
        ),
      ),
    );
    await writeFile(
      path.join(root, "feature.go"),
      "//go:build feature\n\npackage sample\nfunc Feature() int { return 7 }\n",
    );
    const passed = await validate(root, options);
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.deepEqual(passed.checks[1]!.tests, {
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
    });
    reportSchema.parse(passed);
    reportSummarySchema.parse(projectReport(passed, false));
    await writeFile(
      path.join(root, "feature_test.go"),
      '//go:build feature\n\npackage sample\nimport "testing"\nfunc TestFeature(t *testing.T) { t.Fatal("tagged assertion failed") }\n',
    );
    const failed = await validate(root, options);
    assert.equal(failed.checks[1]!.status, "failed");
    assert.equal(failed.checks[1]!.tests?.failed, 1);
    await writeFile(
      path.join(root, "feature_test.go"),
      '//go:build feature\n\npackage sample\nimport "testing"\nfunc TestFeature(t *testing.T) {}\n',
    );
    await writeFile(
      path.join(root, "hidden.go"),
      "//go:build other\n\npackage sample\nfunc Hidden() int {return 1}\n",
    );
    assert.equal((await validate(root, options)).outcome, "incomplete");
    await writeFile(
      file,
      policy({
        ...selected,
        excludedFiles: [{ path: "hidden.go", reason: "Other tag unverified" }],
      }),
    );
    assert.equal((await validate(root, options)).outcome, "passed");
    await writeFile(
      file,
      policy({
        ...selected,
        tags: ["feature", "other"],
        excludedFiles: [{ path: "hidden.go", reason: "Now stale" }],
      }),
    );
    assert.equal((await validate(root, options)).outcome, "incomplete");
    await writeFile(
      file,
      policy(
        profile(
          ["go.test"],
          ["feature"],
          [{ path: "hidden.go", reason: "Other tag unverified" }],
        ),
      ),
    );
    const missing = await validate(root, options);
    assert.equal(missing.checks[0]!.status, "unavailable");
    assert.deepEqual(missing.checks[0]!.processes, []);
    assert.equal(missing.checks[1]!.status, "passed");
    assert.equal(missing.outcome, "incomplete");
  },
);

test(
  "native Go ordinary and race checks use independent tags and exclusions",
  { skip: available ? false : "Go unavailable", timeout: 120_000 },
  async (t) => {
    const root = await fixture(t, {
      "go.mod": manifest,
      "value.go": source,
      "value_test.go": assertion,
      "race_feature_test.go":
        '//go:build race && feature\n\npackage sample\nimport "testing"\nfunc TestRaceFeature(t *testing.T) { if Value()!=42 {t.Fatal(Value())} }\n',
      "checktrail.json": config(["go.test", "go.test-race"]),
      "checktrail.go-build.json": policy(
        profile(
          ["go.test"],
          [],
          [
            {
              path: "race_feature_test.go",
              reason: "Race profile covers this file",
            },
          ],
          "ordinary",
        ),
        profile(["go.test-race"], ["feature"], [], "instrumented"),
      ),
    });
    const passed = await validate(root, options);
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.deepEqual(
      passed.checks.map((c) => c.tests?.passed),
      [1, 2],
    );
    assert.deepEqual(
      passed.checks.map((c) => c.goBuild?.profile),
      ["ordinary", "instrumented"],
    );
    assert.ok(
      passed.checks[1]!.processes.every((p) =>
        p.command.args.includes("-race"),
      ),
    );
  },
);

const nativePath =
  path.resolve(".checktrail/go-tools/bin") +
  path.delimiter +
  (process.env.PATH ?? "");
for (const [id, tool, args] of [
  ["go.staticcheck", "staticcheck", ["-version"]],
  ["go.golangci-lint", "golangci-lint", ["version", "--short"]],
] as const) {
  const prepared =
    spawnSync(tool, args, { env: { ...process.env, PATH: nativePath } })
      .status === 0;
  test(
    `native ${id} build profiles analyze tagged source and retain diagnostics`,
    {
      skip: prepared ? false : `Prepared ${tool} unavailable`,
      timeout: 180_000,
    },
    async (t) => {
      const tagged =
        '//go:build feature\n\npackage sample\nimport "strings"\nfunc Fold(value string) string { return strings.ToLower(value) }\n';
      const root = await fixture(t, {
        "go.mod": manifest,
        "value.go":
          "// Package sample contains synthetic analyzer fixtures.\n" + source,
        "feature.go": tagged,
        ".golangci.yml":
          'version: "2"\nlinters:\n  default: none\n  enable: [staticcheck]\n',
        "checktrail.json": config([id], ["PATH"]),
        "checktrail.go-build.json": policy(profile([id])),
      });
      const settings = { ...options, environment: { PATH: nativePath } };
      const passed = await validate(root, settings);
      assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
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
        failed.checks[0]!.findings?.some(
          (f) =>
            f.file === "feature.go" &&
            (f.ruleId === "SA4017" || f.message.includes("SA4017")),
        ),
      );
    },
  );
}

test(
  "Go build profiles agree through CLI and MCP without disclosing tags or granting trust",
  { skip: available ? false : "Go unavailable", timeout: 120_000 },
  async (t) => {
    const root = await fixture(t, {
      "go.mod": manifest,
      "value.go": source,
      "value_test.go": assertion,
      "checktrail.json": config(["go.test"]),
      "checktrail.go-build.json": policy(
        profile(["go.test"], ["private_tag"], [], "private_name"),
      ),
    });
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const output = spawnSync(
      process.execPath,
      [cli, "run", "--root", root, "--trust-project"],
      { encoding: "utf8", timeout: 60000 },
    );
    assert.equal(output.status, 0, output.stderr);
    const report = JSON.parse(output.stdout);
    assert.equal(report.outcome, "passed");
    assert.equal(report.checks[0].goBuildTagCount, 1);
    assert.ok(!output.stdout.includes("private_"));
    for (const trusted of [false, true]) {
      const client = new Client(
        { name: "go-build-test", version: "1.0.0" },
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
        assert.notEqual(plan.isError, true);
        assert.ok(!JSON.stringify(plan).includes("private_"));
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
          assert.ok(!JSON.stringify(result).includes("private_"));
          assert.ok(!JSON.stringify(result).includes(root));
          const retained = await client.callTool({
            name: "validation_report",
            arguments: { runId: summary.runId },
          });
          assert.deepEqual(
            retained.structuredContent,
            result.structuredContent,
          );
        }
      } finally {
        await client.close();
      }
    }
  },
);
