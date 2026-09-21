import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createPlan } from "../src/engine.js";
import {
  initialize,
  diagnose,
  mcpConfiguration,
  mcpClients,
} from "../src/onboarding.js";
import { VERSION } from "../src/types.js";
import { fixture, nodeManifest, passingTest } from "./helpers.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const policy = (checks: string[], project = ".") =>
  JSON.stringify({ schemaVersion: 1, projects: [{ path: project, checks }] });

test("init previews without writes and creates a planner-compatible polyglot policy", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "case.test.js": passingTest,
    "composer.json": "{}",
    "case.php": "<?php echo 1;",
    "service/go.mod": "module example.invalid/service\n\ngo 1.23\n",
    "service/main.go": "package main\nfunc main() {}\n",
  });
  const before = await readdir(root);
  const preview = await initialize(root);
  assert.equal(preview.status, "preview");
  assert.equal(preview.executionEnabled, false);
  assert.deepEqual(await readdir(root), before);
  assert.deepEqual(preview.configuration?.projects, [
    { path: ".", checks: ["javascript.node-test", "php.syntax"] },
    { path: "service", checks: ["go.format", "go.test", "go.vet"] },
  ]);
  const created = await initialize(root, { write: true });
  assert.equal(created.status, "created");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, "checktrail.json"), "utf8")),
    preview.configuration,
  );
  const { plan } = await createPlan(root);
  assert.deepEqual(
    plan.checks.map((check) => check.id).sort(),
    preview.configuration!.projects.flatMap((project) => project.checks).sort(),
  );
  assert.equal(
    (await readdir(root)).filter((name) => name.startsWith(".checktrail-init-"))
      .length,
    0,
  );
});

test("init preserves policy bytes, environment requirements and workspace settings", async (t) => {
  const original =
    '{"schemaVersion":1,"workspace":{"complete":true,"dependencies":[]},"projects":[{"path":".","checks":["javascript.node-test"],"environment":["FIXTURE_TOKEN"]}]}\n';
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "case.test.js": passingTest,
    "checktrail.json": original,
  });
  for (const write of [false, true])
    assert.equal((await initialize(root, { write })).status, "preserved");
  await assert.rejects(
    initialize(root, {
      write: true,
      selections: [{ path: ".", checks: ["javascript.eslint"] }],
    }),
    /preserved/,
  );
  assert.equal(
    await readFile(path.join(root, "checktrail.json"), "utf8"),
    original,
  );
});

test("init never overwrites malformed configuration, a directory or a symlink", async (t) => {
  for (const mode of ["malformed", "directory", "symlink"]) {
    const root = await fixture(t, {
      "package.json": nodeManifest,
      "case.test.js": passingTest,
      "original.json": "original",
    });
    const target = path.join(root, "checktrail.json");
    if (mode === "directory") await mkdir(target);
    else if (mode === "symlink") await symlink("original.json", target);
    else await writeFile(target, "broken");
    await assert.rejects(initialize(root, { write: true }));
    if (mode === "directory") assert.deepEqual(await readdir(target), []);
    else
      assert.equal(
        await readFile(target, "utf8"),
        mode === "malformed" ? "broken" : "original",
      );
  }
});

test("competing init writers publish one complete policy and leave no temporary files", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "case.test.js": passingTest,
  });
  const attempts = await Promise.allSettled(
    Array.from({ length: 4 }, () => initialize(root, { write: true })),
  );
  assert.equal(
    attempts.filter(
      (attempt) =>
        attempt.status === "fulfilled" && attempt.value.status === "created",
    ).length,
    1,
  );
  for (const attempt of attempts) {
    if (attempt.status === "rejected")
      assert.match(String(attempt.reason), /EEXIST|Project changed/);
    else assert.ok(["created", "preserved"].includes(attempt.value.status));
  }
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, "checktrail.json"), "utf8")),
    JSON.parse(policy(["javascript.node-test"])),
  );
  assert.deepEqual((await readdir(root)).sort(), [
    "case.test.js",
    "checktrail.json",
    "package.json",
  ]);
});

test("init requires explicit Python selection and does not evaluate setup.py", async (t) => {
  const root = await fixture(t, {
    "setup.py": "from pathlib import Path\nPath('executed').touch()\n",
    "test_case.py": "raise RuntimeError('must not execute')\n",
  });
  const unresolved = await initialize(root, { write: true });
  assert.equal(unresolved.status, "needs-selection");
  assert.equal(unresolved.configuration, null);
  assert.deepEqual(
    unresolved.unresolved.map((item) => item.adapter),
    ["python"],
  );
  const selected = await initialize(root, {
    write: true,
    selections: [{ path: ".", checks: ["python.unittest"] }],
  });
  assert.equal(selected.status, "created");
  assert.deepEqual(
    (await createPlan(root)).plan.checks.map((check) => check.id),
    ["python.unittest"],
  );
  assert.ok(!(await readdir(root)).includes("executed"));
});

test("init matches complete known test commands and refuses ambiguous or partial language coverage", async (t) => {
  for (const [script, expected] of [
    ["vitest run", "javascript.vitest"],
    ["jest", "javascript.jest"],
    ["playwright test", "javascript.playwright"],
  ]) {
    const root = await fixture(t, {
      "package.json": JSON.stringify({ scripts: { test: script } }),
    });
    assert.deepEqual(
      (await initialize(root)).configuration?.projects[0]?.checks,
      [expected],
    );
  }
  for (const script of [
    "vitest run && touch executed",
    "node --test --import ./setup.js",
    "jest-custom",
    "toString",
  ]) {
    const root = await fixture(t, {
      "package.json": JSON.stringify({ scripts: { test: script } }),
    });
    assert.equal(
      (await initialize(root, { write: true })).status,
      "needs-selection",
    );
    assert.deepEqual(await readdir(root), ["package.json"]);
  }
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "pyproject.toml": "",
    "case.test.js": passingTest,
  });
  assert.equal(
    (await initialize(root, { write: true })).status,
    "needs-selection",
  );
  assert.equal(
    (
      await initialize(root, {
        selections: [{ path: ".", checks: ["javascript.node-test"] }],
      })
    ).status,
    "needs-selection",
  );
  await assert.rejects(
    initialize(root, {
      selections: [{ path: ".", checks: ["javascript.unknown"] }],
    }),
    /unknown|inapplicable/,
  );
  await assert.rejects(
    initialize(root, {
      selections: [{ path: "absent", checks: ["javascript.node-test"] }],
    }),
    /discovered/,
  );
  await assert.rejects(
    initialize(root, {
      selections: [
        { path: ".", checks: ["javascript.node-test", "javascript.node-test"] },
      ],
    }),
    /unique/,
  );
});

test("empty and unsupported projects never become a passing setup", async (t) => {
  for (const files of [{}, { "main.tf": "terraform {}" }]) {
    const root = await fixture(t, files);
    assert.equal(
      (await initialize(root, { write: true })).status,
      "needs-selection",
    );
    const report = await diagnose(root);
    assert.equal(report.status, "attention-required");
    assert.equal(report.validationPerformed, false);
    assert.ok(
      report.issues.some((issue) =>
        ["empty-plan", "unavailable-check"].includes(issue.code),
      ),
    );
    assert.ok(!(await readdir(root)).includes("checktrail.json"));
  }
});

test("doctor checks binaries and permissions without executing them or importing tests", async (t) => {
  const root = await fixture(t, {
    "pyproject.toml": "",
    "test_case.py": "raise RuntimeError('must not import')\n",
    "checktrail.json": policy(["python.unittest"]),
    "tools/python3": "#!/bin/sh\n: > executed\nexit 99\n",
  });
  const binary = path.join(root, "tools/python3");
  await chmod(binary, 0o755);
  const run = async () => {
    try {
      const output = await exec(
        process.execPath,
        [cli, "doctor", "--root", root],
        { env: { ...process.env, PATH: path.join(root, "tools") } },
      );
      return { code: 0, result: JSON.parse(output.stdout) };
    } catch (error) {
      const failure = error as { code: number; stdout: string };
      return { code: failure.code, result: JSON.parse(failure.stdout) };
    }
  };
  const available = await run();
  assert.equal(available.code, 0);
  assert.equal(available.result.status, "no-static-blockers");
  assert.equal(available.result.validationPerformed, false);
  assert.ok(available.result.unverified.length > 0);
  await chmod(binary, 0o644);
  const unavailable = await run();
  assert.equal(unavailable.code, 2);
  assert.deepEqual(
    unavailable.result.issues.map((issue: { code: string }) => issue.code),
    ["missing-executable"],
  );
  await rm(binary);
  await mkdir(binary);
  const directory = await run();
  assert.equal(directory.code, 2);
  assert.deepEqual(
    directory.result.issues.map((issue: { code: string }) => issue.code),
    ["missing-executable"],
  );
  assert.ok(!(await readdir(root)).includes("executed"));
});

test("doctor diagnoses native executables hidden behind engine wrappers without running them", async (t) => {
  const checks = ["jvm.javac", "dotnet.csharp", "infrastructure.actionlint"];
  const root = await fixture(t, {
    "pom.xml": "<project />",
    "Fixture.csproj": "<Project />",
    ".github/workflows/fixture.yml": "name: Fixture\non: push\njobs: {}\n",
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks, environment: ["PATH"] }],
    }),
  });
  const tools = path.join(root, "tools");
  await mkdir(tools);
  const options = { environment: { PATH: tools } };
  const before = await diagnose(root, options);
  assert.deepEqual(
    before.issues
      .filter((issue) => issue.code === "missing-executable")
      .map((issue) => issue.check)
      .sort(),
    [...checks].sort(),
  );
  for (const executable of ["java", "dotnet", "actionlint"]) {
    const binary = path.join(tools, executable);
    await writeFile(binary, "#!/bin/sh\n: > executed\nexit 99\n");
    await chmod(binary, 0o755);
  }
  const after = await diagnose(root, options);
  assert.equal(
    after.issues.filter((issue) => issue.code === "missing-executable").length,
    0,
  );
  assert.equal(after.validationPerformed, false);
  assert.ok(after.issues.some((issue) => issue.code === "unavailable-check"));
  assert.ok(!(await readdir(root)).includes("executed"));
});

test("doctor reports omitted ecosystems and invalid policy without leaking paths in summary", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "case.test.js": passingTest,
    "composer.json": "{}",
    "hidden-service/go.mod": "module example.invalid/hidden\n\ngo 1.23\n",
    "checktrail.json": policy(["javascript.node-test"]),
  });
  const result = await diagnose(root);
  assert.deepEqual(result.issues.map((issue) => issue.adapter).sort(), [
    "go",
    "php",
  ]);
  assert.ok(
    result.issues.every((issue) => issue.code === "unselected-project"),
  );
  assert.ok(!JSON.stringify(result).includes("hidden-service"));
  assert.ok(!JSON.stringify(result).includes(root));
  assert.ok(
    JSON.stringify(await diagnose(root, { detailed: true })).includes(
      "hidden-service",
    ),
  );
  await writeFile(
    path.join(root, "checktrail.json"),
    policy(["private.unknown"]),
  );
  const invalid = await diagnose(root);
  assert.equal(invalid.status, "attention-required");
  assert.deepEqual(invalid.issues, [{ code: "configuration-error" }]);
  assert.ok(!JSON.stringify(invalid).includes("private.unknown"));
});

test("doctor diagnoses missing JS dependencies, required environment and configuration symlinks", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "case.test.js": passingTest,
    "checktrail.json": policy(["javascript.vitest"]),
  });
  const missing = await diagnose(root);
  assert.ok(missing.issues.some((issue) => issue.code === "package-metadata"));
  assert.ok(missing.issues.some((issue) => issue.code === "unavailable-check"));
  await writeFile(
    path.join(root, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: ".",
          checks: ["javascript.node-test"],
          environment: ["FIXTURE_TOKEN"],
        },
      ],
    }),
  );
  assert.equal((await diagnose(root)).status, "attention-required");
  const ready = await diagnose(root, {
    environment: { FIXTURE_TOKEN: "synthetic-secret" },
  });
  assert.equal(ready.status, "no-static-blockers");
  assert.ok(!JSON.stringify(ready).includes("synthetic-secret"));
  const linked = await fixture(t, {
    "package.json": nodeManifest,
    "policy.json": policy(["javascript.node-test"]),
  });
  await symlink("policy.json", path.join(linked, "checktrail.json"));
  assert.deepEqual((await diagnose(linked)).issues, [
    { code: "configuration-error" },
  ]);
});

test("MCP snippets pin the engine, preserve quoted paths, disable execution and never write client files", async (t) => {
  const parent = await fixture(t, {});
  const root = path.join(parent, 'space "quote" \\ unicode-é');
  await mkdir(root);
  const canonical = await realpath(root);
  for (const client of mcpClients) {
    const output = await mcpConfiguration(root, client);
    assert.equal(output.executionEnabled, false);
    let args: string[];
    if (client === "codex") {
      assert.match(
        output.configuration,
        /^\[mcp_servers.checktrail\]\ncommand = "npx"\n/,
      );
      args = JSON.parse(output.configuration.split("args = ")[1]!);
    } else {
      const config = JSON.parse(output.configuration);
      const server = (config.mcpServers ?? config.servers).checktrail;
      assert.equal(server.command, "npx");
      if (client === "vscode") assert.equal(server.type, "stdio");
      args = server.args;
    }
    assert.deepEqual(args, [
      "--yes",
      "--ignore-scripts",
      `@stsepelin/checktrail@${VERSION}`,
      "serve",
      "--root",
      canonical,
    ]);
  }
  assert.deepEqual(await readdir(root), []);
  const variableRoot = path.join(parent, "${VARIABLE}");
  await mkdir(variableRoot);
  await assert.rejects(
    mcpConfiguration(variableRoot, "claude-code"),
    /variable syntax/,
  );
});

test("CLI onboarding rejects irrelevant permissions and exposes useful nonzero results", async (t) => {
  const root = await fixture(t, { "pyproject.toml": "", "test_case.py": "" });
  for (const args of [
    ["init", "--trust-project"],
    ["doctor", "--allow-execution"],
    ["doctor", "--base", "HEAD"],
    ["plan", "--write"],
    ["mcp-config", "--client", "unsupported"],
  ])
    await assert.rejects(
      exec(process.execPath, [cli, ...args, "--root", root]),
      (error: unknown) => {
        assert.equal((error as { code: number }).code, 2);
        return true;
      },
    );
  await assert.rejects(
    exec(process.execPath, [cli, "init", "--write", "--root", root]),
    (error: unknown) => {
      const failure = error as { code: number; stdout: string };
      assert.equal(failure.code, 2);
      assert.equal(JSON.parse(failure.stdout).status, "needs-selection");
      return true;
    },
  );
  const selected = await exec(process.execPath, [
    cli,
    "init",
    "--write",
    "--root",
    root,
    "--check",
    ".#python.unittest",
  ]);
  assert.equal(JSON.parse(selected.stdout).status, "created");
});
