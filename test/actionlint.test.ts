import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { actionlintInputs } from "../src/actionlint-inputs.js";
import { actionlintEvidence } from "../src/actionlint-evidence.js";
import { createPlan, validate } from "../src/engine.js";
import { fixture } from "./helpers.js";

const version = spawnSync("actionlint", ["-version"], {
  encoding: "utf8",
  timeout: 10000,
});
const options = {
  skip:
    version.status === 0 && version.stdout.startsWith("1.7.12\n")
      ? false
      : "Verified actionlint unavailable",
};
const config = { schemaVersion: 1, runnerLabels: [], variables: [] };
const workflow =
  "name: Example\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ready\n";
const base = {
  "repo-verifier.actionlint.json": JSON.stringify(config),
  ".github/workflows/check.yml": workflow,
};

test("workflow planning finds repository roots and retains unrelated infrastructure gaps without execution", async (t) => {
  const root = await fixture(t, {
    ...base,
    "main.tf": "",
    "nested/.github/workflows/other.yaml": workflow,
    "nested/repo-verifier.actionlint.json": JSON.stringify(config),
    "irrelevant.yaml": "jobs: {}",
  });
  const { plan } = await createPlan(root);
  assert.deepEqual(
    plan.checks.map((check) => [check.project, check.id]),
    [
      [".", "infrastructure.actionlint"],
      [".", "infrastructure.unsupported"],
      ["nested", "infrastructure.actionlint"],
    ],
  );
  assert.deepEqual(plan.checks[0]!.scope, [".github/workflows/check.yml"]);
  assert.deepEqual(plan.checks[2]!.scope, [".github/workflows/other.yaml"]);
  assert.equal(plan.checks[0]!.unavailableReason, undefined);
  await assert.rejects(validate(root, { trusted: false }), /trust/);
  for (const invalid of [
    { ...config, runnerLabels: ["private*"] },
    { ...config, runnerLabels: ["Runner", "runner"] },
    { ...config, variables: ["a", "A"] },
    { ...config, paths: { "**": { ignore: [".*"] } } },
  ]) {
    await writeFile(
      path.join(root, "repo-verifier.actionlint.json"),
      JSON.stringify(invalid),
    );
    assert.ok((await createPlan(root)).plan.checks[0]!.unavailableReason);
  }
  await rm(path.join(root, "repo-verifier.actionlint.json"));
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /Prepare/,
  );
});

test(
  "native workflows catch expressions and invalid YAML, recover after fixes, and never execute scripts or repository ignores",
  options,
  async (t) => {
    const root = await fixture(t, {
      ...base,
      ".github/actionlint.yaml": "paths:\n  '**':\n    ignore: ['.*']\n",
      ".github/actionlint.yml": "invalid: [",
      ".github/Actionlint.YAML": "invalid: [",
    });
    const marker = path.join(root, "executed");
    await writeFile(
      path.join(root, ".github/workflows/check.yml"),
      workflow.replace("echo ready", `touch '${marker}'`),
    );
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report));
    assert.equal(report.checks[0]!.findingsComplete, true);
    assert.equal(report.checks[0]!.tests, undefined);
    assert.deepEqual(
      report.checks[0]!.tools!.map((tool) => tool.status),
      ["identified", "identified"],
    );
    await assert.rejects(access(marker));
    await writeFile(
      path.join(root, ".github/workflows/check.yml"),
      workflow.replace("echo ready", "echo '${{ unknown.value }}'"),
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report));
    assert.ok(
      report.checks[0]!.findings!.some(
        (finding) =>
          finding.ruleId === "actionlint/expression" &&
          finding.file === ".github/workflows/check.yml" &&
          finding.line === 7,
      ),
    );
    await writeFile(
      path.join(root, ".github/workflows/check.yml"),
      "jobs: [\n",
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed");
    assert.ok(report.checks[0]!.findings![0]!.ruleId.startsWith("yaml/"));
    assert.equal(report.checks[0]!.findingsComplete, false);
    await writeFile(path.join(root, ".github/workflows/check.yml"), workflow);
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
  },
);

test(
  "native local actions require metadata and runtime assets without executing them, including nested package inputs",
  options,
  async (t) => {
    const root = await fixture(t, {
      ...base,
      ".github/workflows/check.yml": workflow.replace(
        "run: echo ready",
        "uses: ./tools/local\n        with:\n          greeting: hello",
      ),
      "tools/local/package.json": "{}",
      "tools/local/action.yml":
        "name: Local\ndescription: Example\ninputs:\n  greeting:\n    description: Greeting\n    required: true\nruns:\n  using: node24\n  main: main.js\n",
      "tools/local/main.js": "throw new Error('Must never execute');",
      "repo-verifier.json": JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["infrastructure.actionlint"] }],
      }),
    });
    assert.equal(
      (await validate(root, { trusted: true })).checks.find(
        (check) => check.id === "infrastructure.actionlint",
      )?.status,
      "passed",
    );
    const file = path.join(root, ".github/workflows/check.yml");
    await writeFile(
      file,
      workflow.replace(
        "run: echo ready",
        "uses: ./tools/local\n        with:\n          unknown: hello",
      ),
    );
    const broken = await validate(root, { trusted: true });
    assert.equal(broken.outcome, "failed", JSON.stringify(broken));
    assert.ok(
      broken.checks
        .flatMap((check) => check.findings ?? [])
        .some((finding) => finding.ruleId === "actionlint/action"),
    );
    await rm(path.join(root, "tools/local/main.js"));
    assert.equal(
      (await validate(root, { trusted: true })).checks[0]!.status,
      "unavailable",
    );
    await symlink(
      path.join(root, "repo-verifier.actionlint.json"),
      path.join(root, "tools/local/main.js"),
    );
    assert.equal(
      (await validate(root, { trusted: true })).checks[0]!.status,
      "unavailable",
    );
    await rm(path.join(root, "tools/local/main.js"));
    await writeFile(path.join(root, "tools/local/main.js"), "");
    await writeFile(
      path.join(root, "tools/local/action.yaml"),
      "name: duplicate",
    );
    assert.equal(
      (await validate(root, { trusted: true })).checks[0]!.status,
      "unavailable",
    );
    await writeFile(
      file,
      workflow.replace("run: echo ready", "uses: ./../outside"),
    );
    assert.equal(
      (await validate(root, { trusted: true })).checks[0]!.status,
      "unavailable",
    );
    await writeFile(
      file,
      workflow.replace("run: echo ready", "uses: ./node_modules/local"),
    );
    assert.equal(
      (await validate(root, { trusted: true })).checks[0]!.status,
      "unavailable",
    );
  },
);

test(
  "native reusable workflow inputs and explicit labels and variables are checked",
  options,
  async (t) => {
    const root = await fixture(t, {
      ...base,
      ".github/workflows/check.yml":
        "on: push\njobs:\n  call:\n    uses: ./.github/workflows/reuse.yml\n    with:\n      count: 3\n",
      ".github/workflows/reuse.yml":
        "on:\n  workflow_call:\n    inputs:\n      count:\n        type: number\n        required: true\njobs:\n  check:\n    runs-on: custom-runner\n    steps:\n      - run: echo '${{ vars.GREETING }}'\n",
      "repo-verifier.actionlint.json": JSON.stringify({
        ...config,
        runnerLabels: ["custom-runner"],
        variables: ["GREETING"],
      }),
    });
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await writeFile(
      path.join(root, ".github/workflows/check.yml"),
      "on: push\njobs:\n  call:\n    uses: ./.github/workflows/reuse.yml\n    with:\n      count: wrong\n",
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "failed");
    await rm(path.join(root, ".github/workflows/reuse.yml"));
    assert.equal(
      (await validate(root, { trusted: true })).checks[0]!.status,
      "unavailable",
    );
    await writeFile(
      path.join(root, ".github/workflows/check.yml"),
      workflow.replace("echo ready", "echo '${{ vars.MISSING }}'"),
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "failed");
  },
);

test(
  "native workflow accounting rejects omissions, duplicates, contradictory exits and altered configurations",
  options,
  async (t) => {
    const root = await fixture(t, {
      ...base,
      ".github/workflows/second file.yaml": workflow,
    });
    const { plan } = await createPlan(root);
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed");
    const process = report.checks[0]!.processes[0]!;
    type Payload = {
      scope: string[];
      config: { variables: string[] };
      results: {
        file: string;
        exitCode: number;
        stdout: string;
        stderr: string;
      }[];
    };
    const mutations: ((value: Payload) => void)[] = [
      (value) => {
        value.results.pop();
      },
      (value) => {
        value.results[1] = value.results[0]!;
      },
      (value) => {
        value.results[0]!.stderr = value.results[0]!.stderr.replace(
          /verbose: Found total[^\n]+\n/,
          "",
        );
      },
      (value) => {
        value.results[0]!.stderr = value.results[0]!.stderr.replace(
          "Using project at <project>",
          "Using project at elsewhere",
        );
      },
      (value) => {
        value.results[0]!.stderr += "verbose: ignored errors\n";
      },
      (value) => {
        value.results[0]!.stdout = "null";
      },
      (value) => {
        value.results[0]!.exitCode = 1;
      },
      (value) => {
        value.config.variables.push("HIDDEN");
      },
      (value) => {
        value.scope.pop();
      },
    ];
    for (const mutate of mutations) {
      const value = JSON.parse(process.stdout) as Payload;
      mutate(value);
      assert.equal(
        actionlintEvidence(plan.checks[0]!, [
          { ...process, stdout: JSON.stringify(value) },
        ]).status,
        "inconclusive",
        String(mutate),
      );
    }
    await writeFile(
      path.join(root, ".github/workflows/check.yml"),
      "on: push\njobs: {}\n",
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "failed");
  },
);

test(
  "workflow dependency preflight rejects unsupported YAML aliases and missing composite dependencies",
  options,
  async (t) => {
    const root = await fixture(t, {
      ...base,
      ".github/workflows/check.yml": workflow.replace(
        "run: echo ready",
        "uses: ./action",
      ),
      "action/action.yml":
        "name: Local\ndescription: Example\nruns:\n  using: composite\n  steps:\n    - uses: ./missing\n",
    });
    assert.equal(
      (await validate(root, { trusted: true })).checks[0]!.status,
      "unavailable",
    );
    await writeFile(
      path.join(root, ".github/workflows/check.yml"),
      "on: push\njobs:\n  check: &job\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ready\n  repeat: *job\n",
    );
    assert.equal(
      (await validate(root, { trusted: true })).checks[0]!.status,
      "unavailable",
    );
  },
);

test("missing actionlint cannot produce successful workflow evidence", async (t) => {
  const root = await fixture(t, base);
  const { plan } = await createPlan(root);
  const empty = path.join(root, "empty-bin");
  await mkdir(empty);
  const command = plan.checks[0]!.commands[0]!;
  const result = spawnSync(command.executable, command.args, {
    cwd: root,
    env: { PATH: empty },
    encoding: "utf8",
  });
  assert.equal(result.status, 3);
  assert.deepEqual(JSON.parse(result.stdout), {
    unavailable: "actionlint-toolchain",
  });
});

test("workflow dependency paths reject escapes, ambiguous YAML and missing runtime assets before native reads", () => {
  const scope = [".github/workflows/check.yml"];
  const input = (metadata: string, assets: Record<string, string> = {}) =>
    actionlintInputs(
      new Map(
        Object.entries({
          ".github/workflows/check.yml": workflow.replace(
            "run: echo ready",
            "uses: ./local",
          ),
          "local/action.yml": metadata,
          ...assets,
        }).map(([file, text]) => [file, Buffer.from(text)]),
      ),
      scope,
    );
  const metadata =
    "name: Local\ndescription: Example\nruns:\n  using: node24\n  main: main.js\n";
  assert.deepEqual(input(metadata, { "local/main.js": "" }), { findings: [] });
  for (const main of [
    "../../outside.js",
    "/absolute.js",
    "node_modules/main.js",
    "main.js",
  ]) {
    assert.ok(input(metadata.replace("main.js", main)).unavailable, main);
  }
  assert.ok(
    input(metadata, { "local/action.yaml": metadata, "local/main.js": "" })
      .unavailable,
  );
  assert.ok(input("runs: !custom {}\n").unavailable);
  assert.ok(input("runs: {using: node24, using: docker}\n").findings.length);
});
