import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { createReviewContext, parseReviewContext } from "../src/review.js";
import { runProcess } from "../src/runner.js";
import { fixture } from "./helpers.js";

const sources = {
  python: [
    "sample.py",
    "def choose():\n    return lambda: True\ndef useit():\n    return choose()()\n",
    "choose",
  ],
  go: [
    "sample.go",
    "package main\nfunc Choose() func()bool{return func()bool{return true}}\nfunc Useit()bool{return Choose()()}\n",
    "Choose",
  ],
  php: [
    "sample.php",
    "<?php function choose(){return fn()=>true;}function useit(){return choose()();}\n",
    "choose",
  ],
  rust: [
    "sample.rs",
    "fn choose()->fn()->bool{fn produced()->bool{true}produced}\nfn useit()->bool{choose()()}\n",
    "choose",
  ],
} as const;
export type CallIdentityLanguage = keyof typeof sources;
export async function callIdentityFixture(
  t: TestContext,
  language: CallIdentityLanguage,
  native = false,
  env?: Record<string, string>,
) {
  const [file, source, name] = sources[language];
  const root = await fixture(t, { [file]: source });
  const common = {
    track: "snapshot",
    currentSource: "working-tree",
    files: [file],
    supportFiles: [],
    topics: [],
  };
  const selection =
    language === "python"
      ? { ...common, schemaVersion: 8, moduleRoots: ["."] }
      : language === "go"
        ? { ...common, schemaVersion: 9, moduleRoots: ["."] }
        : language === "php"
          ? { ...common, schemaVersion: 10, moduleRoots: ["."] }
          : { ...common, schemaVersion: 11, crateRoots: [file] };
  const context = await createReviewContext(root, selection);
  assert.ok(context.schemaVersion >= 8 && context.schemaVersion <= 11);
  if (
    context.schemaVersion !== 8 &&
    context.schemaVersion !== 9 &&
    context.schemaVersion !== 10 &&
    context.schemaVersion !== 11
  )
    throw Error("Original binding context required");
  const analysis = context.analysis;
  const choose = analysis.functions.find((fn) => fn.name === name)!;
  assert.ok(choose);
  const calls = analysis.calls
    .filter((call) => call.file === file)
    .sort((left, right) => right.end - left.end);
  assert.equal(calls.length, 2);
  const [outer, inner] = calls;
  assert.equal(
    outer!.start,
    inner!.start,
    "Original nested calls share a start address",
  );
  assert.ok(outer!.end > inner!.end, "The full ranges distinguish the calls");
  assert.equal(source.slice(inner!.start, inner!.end), name + "()");
  assert.equal(source.slice(outer!.start, outer!.end), name + "()()");
  assert.equal(
    outer!.resolution,
    "unsupported-dispatch",
    "The returned function has no selected static target",
  );
  assert.equal(outer!.targetFunctionId, null);
  assert.equal(inner!.resolution, "lexical-binding");
  assert.equal(inner!.targetFunctionId, choose.id);
  const bindings =
    "pythonBindings" in analysis
      ? analysis.pythonBindings
      : "goBindings" in analysis
        ? analysis.goBindings
        : "phpBindings" in analysis
          ? analysis.phpBindings
          : analysis.rustBindings;
  assert.equal(bindings.counts.calls, 2);
  assert.equal(bindings.counts.resolvedCalls, 1);
  assert.equal(bindings.counts.unresolvedCalls, 1);
  assert.equal(
    bindings.callerEdges.filter(
      (edge) => edge.depth === 1 && edge.targetFunctionId === choose.id,
    ).length,
    1,
    "Only the inner named call contributes the direct caller edge",
  );
  assert.equal(
    parseReviewContext(context).contextDigest,
    context.contextDigest,
  );
  if (!native) return;
  const execute = async (executable: string, args: string[]) => {
    const result = await runProcess(
      root,
      { executable, args, cwd: ".", ...(env ? { env } : {}) },
      { timeoutMs: 60000, maxOutputBytes: 65536 },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.errorCode, undefined);
    assert.equal(result.timedOut, false);
    assert.equal(result.cancelled, false);
    assert.equal(result.truncated, false);
    return result;
  };
  let output: string;
  if (language === "python")
    output = (
      await execute("python3", [
        "-I",
        "-B",
        "-c",
        "import runpy,sys;print(str(runpy.run_path(sys.argv[1])['useit']()).lower())",
        path.join(root, file),
      ])
    ).stdout;
  else if (language === "php")
    output = (
      await execute("php", [
        "-r",
        'require $argv[1];echo useit() ? "true\\n" : "false\\n";',
        path.join(root, file),
      ])
    ).stdout;
  else if (language === "go") {
    await writeFile(
      path.join(root, "witness.go"),
      'package main\nimport "fmt"\nfunc main(){fmt.Println(Useit())}\n',
    );
    output = (await execute("go", ["run", file, "witness.go"])).stdout;
  } else {
    await writeFile(
      path.join(root, "witness.rs"),
      source + 'fn main(){println!("{}",useit());}\n',
    );
    await execute("rustc", [
      "--edition=2024",
      "--crate-name",
      "original_call_identity",
      "witness.rs",
      "-o",
      "witness",
    ]);
    output = (await execute(path.join(root, "witness"), [])).stdout;
  }
  assert.equal(
    output,
    "true\n",
    "The original native factory executes both distinct calls",
  );
}
