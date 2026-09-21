import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createPlan, validate } from "../src/engine.js";
import {
  clangDependencies,
  supportedClangVersion,
} from "../src/clang-protocol.js";
import { evaluate } from "../src/evidence.js";
import { planSchema } from "../src/schemas.js";
import { fixture } from "./helpers.js";
import type { ProcessResult } from "../src/types.js";

type NativeClangOutput = {
  units: [
    {
      index: number;
      observedSources: string[];
      scopeError: boolean;
      diagnostics: {
        runs: [{ invocations: [{ executionSuccessful: boolean }] }];
      };
    },
  ];
};

const version = spawnSync("clang", ["--no-default-config", "--version"], {
  encoding: "utf8",
  timeout: 10000,
});
const native = version.status === 0 && supportedClangVersion(version.stdout);
const nativeOptions = {
  skip: native ? false : "Verified Clang toolchain unavailable",
  timeout: 60000,
};
async function example(t: TestContext) {
  const root = await fixture(t, {});
  await cp(
    fileURLToPath(new URL("../../examples/cpp/", import.meta.url)),
    root,
    { recursive: true },
  );
  return root;
}
const database = [
  {
    directory: ".",
    file: "value.c",
    arguments: ["clang", "-std=c17", "-c", "value.c", "-o", "value.o"],
  },
];

test("Clang planning requires a prepared database, never runs build configuration and rejects hidden compiler behavior", async (t) => {
  const root = await fixture(t, {
    "CMakeLists.txt": 'message(FATAL_ERROR "Never evaluate")',
    "value.c": "int value(void) { return 1; }",
    "value.c.backup": "",
  });
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /Prepare/,
  );
  await writeFile(
    path.join(root, "compile_commands.json"),
    JSON.stringify(database),
  );
  const { plan } = await createPlan(root);
  planSchema.parse(plan);
  assert.equal(plan.checks[0]!.unavailableReason, undefined);
  assert.deepEqual(plan.checks[0]!.scope, ["value.c"]);
  await assert.rejects(validate(root, { trusted: false }), /trust/);
  await assert.rejects(access(path.join(root, "value.o")));
  for (const flag of [
    "@response.txt",
    "-Xclang",
    "-fplugin=plugin.so",
    "-fmodules",
    "--config=local.cfg",
    "-include-pch",
    "-march=native",
    "-Wextra-private",
    "-I../",
    "-std=c++20-extra",
  ]) {
    const entry = structuredClone(database[0]!);
    entry.arguments.splice(1, 0, flag);
    await writeFile(
      path.join(root, "compile_commands.json"),
      JSON.stringify([entry]),
    );
    assert.ok((await createPlan(root)).plan.checks[0]!.unavailableReason, flag);
  }
  await writeFile(
    path.join(root, "compile_commands.json"),
    JSON.stringify([
      { directory: ".", file: "value.c", command: "clang -c value.c" },
    ]),
  );
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /arguments-array/,
  );
  await writeFile(
    path.join(root, "compile_commands.json"),
    JSON.stringify(database),
  );
  await writeFile(
    path.join(root, "repo-verifier.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: ".",
          checks: ["cpp.clang-check"],
          environment: ["CCC_OVERRIDE_OPTIONS"],
        },
      ],
    }),
  );
  await assert.rejects(
    createPlan(root, { environment: { CCC_OVERRIDE_OPTIONS: "-E" } }),
    /protected/,
  );
});

test("Clang dependency evidence decodes continuation lines and literal spaces while rejecting malformed targets and escapes", () => {
  assert.deepEqual(
    clangDependencies(
      "repo-verifier: \\\n source.c include/with\\ space.h\n",
      "/synthetic",
    ),
    ["/synthetic/include/with space.h", "/synthetic/source.c"],
  );
  for (const bad of [
    "",
    "other: a.c",
    "repo-verifier: ",
    "repo-verifier: a.c\nother: b.h",
    "repo-verifier: a$token.h",
    "repo-verifier: a\\x.h",
    "repo-verifier: a#token.h",
  ])
    assert.throws(() => clangDependencies(bad, "/synthetic"));
});

test(
  "native Clang validates mixed C/C++ public sources and headers, catches type errors and never emits objects or runs code",
  nativeOptions,
  async (t) => {
    const root = await example(t);
    const { source, plan } = await createPlan(root);
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.equal(report.sourceChanged, false);
    assert.equal(report.checks[0]?.tests, undefined);
    assert.equal(report.checks[0]?.findingsComplete, true);
    assert.ok(
      report.checks[0]!.tools!.every((tool) => tool.status === "identified"),
    );
    await assert.rejects(access(path.join(root, "quantity.o")));
    await assert.rejects(access(path.join(root, "total.o")));
    const good = await readFile(path.join(root, "include/offset.hpp"), "utf8");
    await writeFile(
      path.join(root, "include/offset.hpp"),
      good.replace("= 1", '= "wrong"'),
    );
    const failed = await validate(root, { trusted: true });
    assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
    assert.equal(failed.checks[0]?.findingsComplete, false);
    assert.ok(
      failed.checks[0]!.findings!.some(
        (finding) =>
          finding.level === "error" &&
          finding.file === "include/offset.hpp" &&
          finding.line === 2,
      ),
    );
    await writeFile(path.join(root, "include/offset.hpp"), good);
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    for (const alter of [
      (data: NativeClangOutput) => data.units.pop(),
      (data: NativeClangOutput) => data.units[0].observedSources.splice(0),
      (data: NativeClangOutput) => {
        data.units[0].diagnostics.runs[0].invocations = [
          { executionSuccessful: false },
        ];
      },
      (data: NativeClangOutput) => {
        data.units[0].scopeError = true;
      },
      (data: NativeClangOutput) => {
        data.units[0].index = 1;
      },
      (data: NativeClangOutput) => {
        data.units[0].observedSources.push("unobserved.h");
      },
    ]) {
      const processes: ProcessResult[] = structuredClone(
        report.checks[0]!.processes,
      );
      const data = JSON.parse(processes[0]!.stdout);
      alter(data);
      processes[0]!.stdout = JSON.stringify(data);
      assert.equal(
        evaluate(plan.checks[0]!, processes, source.root).status,
        "inconclusive",
      );
    }
  },
);

test(
  "native Clang requires all source/header coverage and rejects generated or symlinked project inputs",
  nativeOptions,
  async (t) => {
    const root = await example(t);
    await writeFile(
      path.join(root, "unlinked.cpp"),
      "int omitted() { return 3; }",
    );
    assert.equal(
      (await validate(root, { trusted: true })).outcome,
      "incomplete",
    );
    await rm(path.join(root, "unlinked.cpp"));
    await writeFile(path.join(root, "unused.hpp"), "#pragma once\n");
    assert.equal(
      (await validate(root, { trusted: true })).outcome,
      "incomplete",
    );
    await rm(path.join(root, "unused.hpp"));
    await mkdir(path.join(root, "build"));
    await writeFile(
      path.join(root, "build/generated.hpp"),
      "constexpr int offset = 1;\n",
    );
    const header = path.join(root, "include/offset.hpp");
    const good = await readFile(header, "utf8");
    await writeFile(header, '#include "../build/generated.hpp"\n');
    assert.equal(
      (await validate(root, { trusted: true })).outcome,
      "incomplete",
    );
    await writeFile(header, good);
    await symlink("offset.hpp", path.join(root, "include/alias.hpp"));
    const source = path.join(root, "src/total.cpp");
    const original = await readFile(source, "utf8");
    await writeFile(source, original.replace('"offset.hpp"', '"alias.hpp"'));
    assert.equal(
      (await validate(root, { trusted: true })).outcome,
      "incomplete",
    );
    await writeFile(source, original);
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
  },
);

test(
  "native Clang preserves relative macro path spelling, configured working directories and literal-space dependencies",
  nativeOptions,
  async (t) => {
    const root = await example(t);
    const c = path.join(root, "src/quantity.c");
    await writeFile(
      c,
      (await readFile(c, "utf8")) +
        '\n_Static_assert(sizeof(__FILE__) == sizeof("src/quantity.c"), "source path spelling changed");\n',
    );
    const header = path.join(root, "include/offset.hpp");
    await writeFile(
      header,
      (await readFile(header, "utf8")) +
        '\nstatic_assert(sizeof(__FILE__) == sizeof("include/offset.hpp"), "include path spelling changed");\n#include "with space.hpp"\n',
    );
    await writeFile(
      path.join(root, "include/with space.hpp"),
      "#pragma once\nconstexpr int extraOffset = 3;\n",
    );
    const cpp = path.join(root, "src/total.cpp");
    await writeFile(
      cpp,
      "#include <vector>\n" +
        (await readFile(cpp, "utf8")) +
        "\nstd::vector<int> values() { return {offset, extraOffset}; }\n",
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await mkdir(path.join(root, "build"));
    const dbPath = path.join(root, "compile_commands.json");
    const entries = JSON.parse(await readFile(dbPath, "utf8")) as {
      directory: string;
      file: string;
      arguments: string[];
    }[];
    for (const entry of entries) {
      entry.directory = "build";
      entry.arguments = entry.arguments.map((arg) =>
        arg === "-Iinclude"
          ? "-I../include"
          : arg === entry.file
            ? `../${arg}`
            : arg,
      );
      entry.file = `../${entry.file}`;
    }
    await writeFile(dbPath, JSON.stringify(entries));
    await writeFile(
      c,
      (await readFile(c, "utf8")).replace(
        'sizeof("src/quantity.c")',
        'sizeof("../src/quantity.c")',
      ),
    );
    await writeFile(
      header,
      (await readFile(header, "utf8")).replace(
        'sizeof("include/offset.hpp")',
        'sizeof("../include/offset.hpp")',
      ),
    );
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.ok(
      JSON.parse(report.checks[0]!.processes[0]!.stdout).units.find(
        (unit: { compiler: string }) => unit.compiler === "clang++",
      ).externalDependencyCount > 0,
    );
    await assert.rejects(access(path.join(root, "build/total.o")));
  },
);

test(
  "native Clang checks every database configuration and distinguishes warnings, missing tools and compiler failures",
  nativeOptions,
  async (t) => {
    const root = await example(t);
    const databasePath = path.join(root, "compile_commands.json");
    const entries = JSON.parse(await readFile(databasePath, "utf8")) as {
      directory: string;
      file: string;
      arguments: string[];
      command?: string;
    }[];
    entries[0]!.command = "touch executed";
    entries[0]!.arguments.splice(1, 0, '-DMESSAGE="$(touch executed)"');
    await writeFile(databasePath, JSON.stringify(entries));
    const source = path.join(root, "src/quantity.c");
    const good = await readFile(source, "utf8");
    await writeFile(source, "#warning synthetic-warning\n" + good);
    const warning = await validate(root, { trusted: true });
    assert.equal(warning.outcome, "passed", JSON.stringify(warning.checks));
    assert.ok(
      warning.checks[0]!.findings!.some(
        (finding) =>
          finding.level === "warning" &&
          finding.message.includes("synthetic-warning"),
      ),
    );
    await assert.rejects(access(path.join(root, "executed")));
    const variant = structuredClone(entries[0]!);
    variant.arguments = variant.arguments.map((arg) =>
      arg === "-DBATCH_SIZE=2" ? '-DBATCH_SIZE="wrong"' : arg,
    );
    entries.push(variant);
    await writeFile(databasePath, JSON.stringify(entries));
    const failure = await validate(root, { trusted: true });
    assert.equal(failure.outcome, "failed");
    assert.equal(
      JSON.parse(failure.checks[0]!.processes[0]!.stdout).units.length,
      3,
    );
    entries.pop();
    await writeFile(databasePath, JSON.stringify(entries));
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const missing = spawnSync(
      process.execPath,
      [cli, "run", "--root", root, "--trust-project"],
      { env: { ...process.env, PATH: "" }, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(missing.status, 2, missing.stderr);
    assert.equal(JSON.parse(missing.stdout).checks[0].status, "unavailable");
    const { plan, source: inventory } = await createPlan(root);
    const processResult = structuredClone(warning.checks[0]!.processes[0]!);
    processResult.exitCode = 3;
    processResult.stdout = "not json";
    assert.equal(
      evaluate(plan.checks[0]!, [processResult], inventory.root).status,
      "inconclusive",
    );
  },
);
