import assert from "node:assert/strict";
import { access, cp, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { fixture } from "./helpers.js";

const compiler = path.dirname(
  path.dirname(fileURLToPath(import.meta.resolve("typescript"))),
);
const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["javascript.typescript-build"] }],
});
const options = {
  composite: true,
  strict: true,
  noCheck: true,
  noEmit: true,
  types: [],
  module: "NodeNext",
  moduleResolution: "NodeNext",
  target: "ES2022",
  outDir: "build",
};
const library = JSON.stringify({
  compilerOptions: options,
  files: ["value.ts"],
});
const consumer = JSON.stringify({
  compilerOptions: options,
  files: ["use.ts"],
  references: [{ path: "../library" }],
});
const files = {
  "package.json": "{}",
  "repo-verifier.json": policy,
  "tsconfig.json": JSON.stringify({
    files: [],
    references: [{ path: "./consumer" }],
  }),
  "library/package.json": "{}",
  "library/tsconfig.json": library,
  "library/value.ts": "export const value: number = 42;",
  "consumer/package.json": "{}",
  "consumer/tsconfig.json": consumer,
  "consumer/use.ts":
    "import {value} from '../library/value';export const copied: number = value;",
};

test(
  "native TypeScript solution builds fresh declarations in memory and catches producer and consumer errors",
  { timeout: 60_000 },
  async (t) => {
    const root = await fixture(t, files);
    await cp(compiler, path.join(root, "node_modules/typescript"), {
      recursive: true,
    });
    const passed = await validate(root, { trusted: true });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.equal(passed.sourceChanged, false);
    for (const file of [
      "library/build",
      "consumer/build",
      "library/tsconfig.tsbuildinfo",
      "consumer/tsconfig.tsbuildinfo",
    ])
      await assert.rejects(access(path.join(root, file)));
    await writeFile(
      path.join(root, "library/value.ts"),
      'export const value: number = "incorrect";',
    );
    const producer = await validate(root, { trusted: true });
    assert.equal(producer.outcome, "failed", JSON.stringify(producer.checks));
    assert.ok(
      producer.checks[0]!.findings?.some(
        (finding) =>
          finding.ruleId === "TS2322" && finding.file === "library/value.ts",
      ),
    );
    await writeFile(
      path.join(root, "library/value.ts"),
      'export const value: string = "valid library, incompatible consumer";',
    );
    const incompatible = await validate(root, { trusted: true });
    assert.equal(
      incompatible.outcome,
      "failed",
      JSON.stringify(incompatible.checks),
    );
    assert.ok(
      incompatible.checks[0]!.findings?.some(
        (finding) =>
          finding.ruleId === "TS2322" && finding.file === "consumer/use.ts",
      ),
    );
    await writeFile(
      path.join(root, "consumer/use.ts"),
      files["consumer/use.ts"].replace("copied: number", "copied: string"),
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await writeFile(
      path.join(root, "consumer/omitted.ts"),
      'export const omitted: number = "invalid";',
    );
    const omitted = await validate(root, { trusted: true });
    assert.equal(omitted.checks[0]!.processes[0]!.exitCode, 0);
    assert.equal(omitted.outcome, "incomplete");
  },
);

test(
  "TypeScript solution never trusts persisted outputs or escapes the configured root",
  { timeout: 60_000 },
  async (t) => {
    const root = await fixture(t, {
      ...files,
      "library/build/value.d.ts": "export declare const value: number;",
      "library/build/tsconfig.tsbuildinfo": "synthetic stale data",
      "library/value.ts": 'export const value: string = "changed";',
    });
    await cp(compiler, path.join(root, "node_modules/typescript"), {
      recursive: true,
    });
    const stale = await validate(root, { trusted: true });
    assert.equal(stale.outcome, "failed", JSON.stringify(stale.checks));
    assert.equal(
      await readFile(path.join(root, "library/build/value.d.ts"), "utf8"),
      "export declare const value: number;",
    );
    assert.equal(
      await readFile(
        path.join(root, "library/build/tsconfig.tsbuildinfo"),
        "utf8",
      ),
      "synthetic stale data",
    );
    assert.equal(stale.sourceChanged, false);
    const outside = await fixture(t, {
      "tsconfig.json": JSON.stringify({
        compilerOptions: options,
        files: ["outside.ts"],
      }),
      "outside.ts": "export const value=42;",
    });
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ files: [], references: [{ path: outside }] }),
    );
    const escaped = await validate(root, { trusted: true });
    assert.equal(escaped.outcome, "incomplete", JSON.stringify(escaped.checks));
    assert.match(escaped.checks[0]!.processes[0]!.stderr, /outside/);
    await assert.rejects(access(path.join(outside, "build")));
  },
);

test("TypeScript solution planning never executes the compiler", async (t) => {
  const root = await fixture(t, {
    ...files,
    "node_modules/typescript/lib/typescript.js":
      "require('node:fs').writeFileSync('executed','yes');",
  });
  const plan = await createPlan(root);
  assert.equal(plan.plan.checks[0]!.unavailableReason, undefined);
  assert.deepEqual(plan.plan.checks[0]!.scope, [
    "consumer/use.ts",
    "library/value.ts",
  ]);
  await assert.rejects(access(path.join(root, "executed")));
});

test(
  "TypeScript solution preserves files when native configuration has cycles or output escapes",
  { timeout: 30_000 },
  async (t) => {
    const root = await fixture(t, files);
    await cp(compiler, path.join(root, "node_modules/typescript"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "library/tsconfig.json"),
      JSON.stringify({
        compilerOptions: options,
        files: ["value.ts"],
        references: [{ path: "../consumer" }],
      }),
    );
    const cycle = await validate(root, { trusted: true });
    assert.equal(cycle.outcome, "failed", JSON.stringify(cycle.checks));
    assert.ok(
      cycle.checks[0]!.findings?.some((finding) => finding.ruleId === "TS6202"),
    );
    const outside = await fixture(t, {});
    await writeFile(
      path.join(root, "library/tsconfig.json"),
      JSON.stringify({
        compilerOptions: { ...options, outDir: outside },
        files: ["value.ts"],
      }),
    );
    const escape = await validate(root, { trusted: true });
    assert.notEqual(escape.outcome, "passed");
    await assert.rejects(access(path.join(outside, "value.js")));
    assert.equal(escape.sourceChanged, false);
  },
);

test("TypeScript solution evidence rejects missing programs, omitted files, duplicate paths and malformed diagnostics", async () => {
  const { evaluate } = await import("../src/evidence.js");
  const command = { executable: "synthetic", args: [], cwd: "." };
  const check: import("../src/types.js").Check = {
    id: "javascript.typescript-build",
    adapter: "javascript",
    project: ".",
    kind: "analysis",
    scope: ["value.ts"],
    parser: "typescript-build-json",
    reason: "synthetic",
    commands: [command],
  };
  const process: import("../src/types.js").ProcessResult = {
    command,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    truncated: false,
  };
  const good = {
    version: 1,
    exitStatus: 0,
    programs: 1,
    configs: ["/synthetic/tsconfig.json"],
    files: ["/synthetic/value.ts"],
    diagnostics: [],
  };
  const parse = (value: unknown) =>
    evaluate(
      check,
      [{ ...process, stdout: JSON.stringify(value) }],
      "/synthetic",
    );
  assert.equal(parse(good).status, "passed");
  for (const patch of [
    { programs: 0 },
    { configs: [] },
    { files: [] },
    { files: ["/synthetic/value.ts", "/synthetic/value.ts"] },
    { files: ["/outside/value.ts"] },
    { diagnostics: [{ code: "not a native number", message: "invalid" }] },
  ])
    assert.equal(parse({ ...good, ...patch }).status, "inconclusive");
  assert.equal(
    parse({
      ...good,
      diagnostics: [
        {
          code: 2322,
          message: "wrong type",
          file: "/synthetic/value.ts",
          line: 1,
        },
      ],
    }).status,
    "failed",
  );
  assert.equal(
    evaluate(
      check,
      [{ ...process, stdout: JSON.stringify(good), truncated: true }],
      "/synthetic",
    ).status,
    "inconclusive",
  );
});
