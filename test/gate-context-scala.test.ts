import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  createReviewContext,
  parseReviewContext,
  projectReviewContext,
  type ReviewContext,
} from "../src/review.js";
import { createHypothesisPlan } from "../src/review-hypotheses.js";
import { ReviewWorkflowEngine } from "../src/review-workflow.js";
import { runProcess } from "../src/runner.js";
import { fixture } from "./helpers.js";
import { fixtureGit, syntheticCommit } from "./git-fixture.js";
import { scalaBoundaryFixtures } from "./review-scala-boundaries-fixture.js";

const broken =
  'package policy\nval FALLBACK = "grant"\ndef decision(value: String = FALLBACK): Boolean = { return value.startsWith(FALLBACK) }\n';
const fixed =
  'package policy\nval FALLBACK = "grant"\ndef decision(value: String = FALLBACK): Boolean = { return value == FALLBACK || value.startsWith(FALLBACK + ":") }\n';
const near =
  'package policy\nval FALLBACK = "grant"\ndef decision(value: String = FALLBACK): Boolean = { return value == "grant:read" || value == "grant:write" }\n';
const consumer =
  'package consumer\nimport policy.decision as decide\nimport policy.FALLBACK as DEFAULT\ndef submit() = decide("grantToken")\ndef route() = policy.decision(DEFAULT)\n';
const native = {
  skip:
    (await access("/opt/checktrail/scala/lib/scala3-compiler_3-3.9.0.jar").then(
      () => true,
      () => false,
    )) &&
    /^javac 25\.0\.4$/.test(
      spawnSync("javac", ["--version"], { encoding: "utf8" }).stdout?.trim() ??
        "",
    )
      ? false
      : "Pinned native Scala unavailable",
  timeout: 120000,
};
const input = (
  files = ["src/policy/Policy.scala"],
  supportFiles = ["src/consumer/Consumer.scala"],
  moduleRoots = ["src"],
) => ({
  schemaVersion: 14,
  track: "snapshot",
  currentSource: "working-tree",
  files,
  supportFiles,
  moduleRoots,
  topics: [],
});
function analysis(context: ReviewContext) {
  assert.equal(context.schemaVersion, 14);
  if (context.schemaVersion !== 14)
    throw Error("Original Scala context required");
  return context.analysis;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function rebound(context: ReviewContext): ReviewContext {
  const body = Object.fromEntries(
    Object.entries(context).filter(([key]) => key !== "contextDigest"),
  );
  return {
    ...body,
    contextDigest: hash(JSON.stringify(body)),
  } as ReviewContext;
}
async function original(t: TestContext, policy = broken) {
  const root = await fixture(t, {
    "src/policy/Policy.scala": policy,
    "src/consumer/Consumer.scala": consumer,
    ".checktrail/keep": "",
  });
  const context = await createReviewContext(root, input());
  return { root, context, result: analysis(context) };
}
const compilerHome = "/opt/checktrail/scala";
async function compile(
  root: string,
  files: string[],
  witness: string,
  name = "original-classes",
) {
  await writeFile(path.join(root, "Witness.scala"), witness);
  const classes = path.join(root, name);
  await mkdir(classes);
  const result = await runProcess(
    root,
    {
      executable: "java",
      args: [
        "-Xmx256m",
        "-cp",
        compilerHome + "/lib/*",
        "dotty.tools.dotc.Main",
        "-encoding",
        "UTF-8",
        "-source",
        "3.9",
        "-release:25",
        "-color:never",
        "-classpath",
        compilerHome + "/lib/*",
        "-d",
        classes,
        ...files,
        "Witness.scala",
      ],
      cwd: ".",
    },
    { timeoutMs: 60000, maxOutputBytes: 65536 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.errorCode, undefined);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.truncated, false);
  return classes;
}
async function execute(root: string, classes: string) {
  const result = await runProcess(
    root,
    {
      executable: "java",
      args: [
        "-Xmx64m",
        "-cp",
        classes + ":" + compilerHome + "/lib/*",
        "Witness",
      ],
      cwd: ".",
    },
    { timeoutMs: 30000, maxOutputBytes: 65536 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.errorCode, undefined);
  assert.equal(result.truncated, false);
  assert.equal(result.timedOut, false);
  return result.stdout;
}
async function witness(root: string) {
  const classes = await compile(
    root,
    ["src/policy/Policy.scala", "src/consumer/Consumer.scala"],
    'object Witness { def main(args: Array[String]): Unit = { for (value <- Array("grant:read", "grantToken", "grant2", "other")) println(policy.decision(value)); println(consumer.submit()); println(consumer.route()) } }',
  );
  return (await execute(root, classes))
    .trim()
    .split("\n")
    .map((value) => {
      assert.ok(value === "true" || value === "false");
      return value === "true";
    });
}
function bindings(result: ReturnType<typeof analysis>) {
  const policy = result.functions.find(
    (fn) => fn.file === "src/policy/Policy.scala" && fn.name === "decision",
  )!;
  assert.ok(policy);
  const calls = result.calls.filter(
    (call) => call.file === "src/consumer/Consumer.scala",
  );
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(
      (call) =>
        call.resolution === "lexical-binding" &&
        call.targetFunctionId === policy.id,
    ),
  );
  assert.equal(result.modules.length, 2);
  assert.ok(result.modules.every((value) => value.resolution === "selected"));
  assert.equal(
    result.scalaBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === policy.id && edge.depth === 1,
    ).length,
    2,
  );
  assert.equal(
    result.scalaBindings.counts.calls,
    result.scalaBindings.counts.resolvedCalls +
      result.scalaBindings.counts.unresolvedCalls,
  );
  assert.equal(
    result.scalaBindings.counts.imports,
    result.scalaBindings.counts.resolvedImports +
      result.scalaBindings.counts.unresolvedImports,
  );
  assert.equal(result.scalaBindings.fullImpactFallback, true);
  assert.equal(result.scalaBindings.runtimeReachabilityVerified, false);
  assert.equal(result.scalaBindings.nativeNameResolutionVerified, false);
  assert.equal(result.scalaBindings.moduleLoadingVerified, false);
  assert.equal(result.scalaBindings.validationPlanUnchanged, true);
}
test("context-scala broken acceptance", native, async (t) => {
  const { root, context, result } = await original(t);
  bindings(result);
  assert.deepEqual(await witness(root), [true, true, true, false, true, true]);
  const fn = result.functions.find((fn) => fn.name === "decision")!,
    source = context.files.find((file) => file.path === fn.file)!;
  assert.equal(
    source.content.slice(fn.start, fn.end),
    "def decision(value: String = FALLBACK): Boolean = { return value.startsWith(FALLBACK) }",
  );
  const parameter = result.declarations.find(
    (value) => value.name === "value" && value.kind === "parameter",
  )!;
  assert.ok(parameter.initializer);
  assert.equal(
    source.content.slice(
      parameter.initializer.start,
      parameter.initializer.end,
    ),
    "FALLBACK",
  );
  const constant = result.declarations.find(
    (value) => value.name === "FALLBACK" && value.kind === "variable",
  )!;
  assert.ok(constant.initializer);
  assert.equal(
    source.content.slice(constant.initializer.start, constant.initializer.end),
    '"grant"',
  );
  assert.ok(
    result.references.some(
      (value) => value.targetDeclarationId === constant.id,
    ),
  );
  assert.equal(
    createHypothesisPlan(context).scope.runtimeReachability,
    "unknown",
  );
  const old = {
      "src/policy/Policy.scala": broken,
      "src/consumer/Consumer.scala": consumer,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await rename(
    path.join(revision, "src/consumer/Consumer.scala"),
    path.join(revision, "src/consumer/Moved.scala"),
  );
  await writeFile(
    path.join(revision, "src/consumer/Moved.scala"),
    'package consumer\nimport policy.decision as decide\ndef submit(decide: String => Boolean) = decide("grantToken")\n',
  );
  await writeFile(path.join(revision, "src/policy/Policy.scala"), fixed);
  const captured = await createReviewContext(revision, {
      ...input(undefined, [
        "src/consumer/Consumer.scala",
        "src/consumer/Moved.scala",
      ]),
      track: "diff",
      baseCommit: base,
    }),
    value = analysis(captured),
    before = value.functions.find(
      (fn) => fn.revision === "base" && fn.name === "decision",
    )!,
    after = value.functions.find(
      (fn) => fn.revision === "current" && fn.name === "decision",
    )!;
  assert.notEqual(before.id, after.id);
  assert.equal(
    value.calls.filter(
      (call) =>
        call.file === "src/consumer/Consumer.scala" &&
        call.revision === "base" &&
        call.targetFunctionId === before.id,
    ).length,
    2,
  );
  assert.ok(
    value.calls
      .filter((call) => call.file === "src/consumer/Moved.scala")
      .every((call) => call.targetFunctionId === null),
  );
  assert.ok(
    value.scalaBindings.callerEdges.some(
      (edge) => edge.revision === "base" && edge.targetFunctionId === before.id,
    ),
  );
});
test("context-scala fixed acceptance", native, async (t) => {
  const { root, result } = await original(t, fixed);
  bindings(result);
  assert.deepEqual(await witness(root), [
    true,
    false,
    false,
    false,
    false,
    true,
  ]);
  assert.ok(
    result.decisions.some(
      (decision) => decision.file === "src/policy/Policy.scala",
    ),
  );
});
test("context-scala near-miss acceptance", native, async (t) => {
  await scalaBoundaryFixtures(t);
  const { root, result } = await original(t, near);
  bindings(result);
  assert.deepEqual(await witness(root), [
    true,
    false,
    false,
    false,
    false,
    false,
  ]);
  const sample = await fixture(t, {
    "Sample.scala":
      "package original\nprivate def hidden() = true\ndef decide() = true\ndef useit(decide: () => Boolean) = decide()\ndef ordered(): Boolean = { def before() = decide(); def decide() = false; before() == decide() }\ndef choose(): () => Boolean = () => true\ndef nested() = choose()()\ndef localValue(): Boolean = { val decide: () => Boolean = () => false; decide() }\ndef escapedValue(): Boolean = { val `decide`: () => Boolean = () => false; decide() }\ndef generic[T]() = decide()\ndef overloaded() = true\ndef overloaded(value: Int) = false\n",
    "Priority.scala":
      "package consumer\nimport original.decide\ndef decide() = false\ndef sameFile() = decide()\n",
    "PolicyNative.scala": "package policy\ndef decision() = true\n",
    "Receiver.scala":
      "package receiver\nobject Stable { def decision() = false }\nval policy = Stable\nimport policy.decision as decide\ndef stableReceiver() = decide()\n",
    "ImportOrder.scala":
      "package original\ndef early() = decide()\nimport consumer.decide as decide\ndef later() = decide()\ndef privateUse() = hidden()\n",
  });
  const classes = await compile(
    sample,
    [
      "Sample.scala",
      "Priority.scala",
      "ImportOrder.scala",
      "PolicyNative.scala",
      "Receiver.scala",
    ],
    "object Witness { def main(args: Array[String]): Unit = { println(original.useit(() => false)); println(original.ordered()); println(original.nested()); println(original.localValue()); println(original.escapedValue()); println(original.generic[String]()); println(original.overloaded()); println(consumer.sameFile()); println(original.early()); println(original.later()); println(original.privateUse()); println(receiver.stableReceiver()) } }",
  );
  assert.deepEqual((await execute(sample, classes)).trim().split("\n"), [
    "false",
    "true",
    "true",
    "false",
    "false",
    "true",
    "true",
    "false",
    "false",
    "false",
    "true",
    "false",
  ]);
});
test("context-scala prerequisite acceptance", async (t) => {
  const { root } = await original(t);
  for (const roots of [
    [".."],
    ["src", "src/policy"],
    Array.from({ length: 17 }, (_, i) => "root" + i),
  ])
    await assert.rejects(
      createReviewContext(root, input(undefined, undefined, roots)),
    );
  const outside = analysis(
    await createReviewContext(root, input(undefined, undefined, ["elsewhere"])),
  );
  assert.equal(outside.scalaBindings.state, "partial");
  assert.ok(outside.scalaBindings.omissions.includes("outside-module-roots"));
  assert.ok(outside.calls.every((call) => call.targetFunctionId === null));
  const unsupported = await fixture(t, {
    "unknown.vb": "Module Original\nEnd Module\n",
  });
  assert.equal(
    analysis(
      await createReviewContext(unsupported, input(["unknown.vb"], [], ["."])),
    ).files[0]!.state,
    "unsupported",
  );
  const copied = await fixture(t, {}),
    repository = fileURLToPath(new URL("../../", import.meta.url));
  await mkdir(path.join(copied, "dist"));
  await cp(
    await realpath(path.join(repository, "dist/src")),
    path.join(copied, "dist/src"),
    { recursive: true, dereference: true },
  );
  await symlink(
    path.join(repository, "node_modules"),
    path.join(copied, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await writeFile(path.join(copied, "package.json"), '{"type":"module"}');
  const isolated = (await import(
      pathToFileURL(path.join(copied, "dist/src/review-polyglot.js")).href
    )) as typeof import("../src/review-polyglot.js"),
    source = {
      path: "Sample.scala",
      content: "def decision() = true\n",
      sha256: hash("def decision() = true\n"),
    };
  const missing = await isolated.collectReviewScalaBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(missing.files[0]!.state, "error");
  assert.deepEqual(missing.functions, []);
  assert.equal(missing.scalaBindings.state, "partial");
  await mkdir(path.join(copied, "assets/context-grammars"), {
    recursive: true,
  });
  const bytes = await readFile(
      path.join(
        await realpath(path.join(repository, "dist/src")),
        "../../assets/context-grammars/tree-sitter-scala.wasm",
      ),
    ),
    altered = Buffer.from(bytes),
    position = altered.indexOf(Buffer.from("tree_sitter_scala"));
  assert.notEqual(position, -1);
  altered[position + "tree_sitter_scal".length] = "s".charCodeAt(0);
  assert.doesNotThrow(() => new WebAssembly.Module(altered));
  const asset = path.join(
    copied,
    "assets/context-grammars/tree-sitter-scala.wasm",
  );
  await writeFile(asset, altered);
  const changed = await isolated.collectReviewScalaBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(changed.files[0]!.state, "error");
  assert.deepEqual(changed.calls, []);
  await writeFile(asset, bytes);
  const restored = await isolated.collectReviewScalaBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(restored.files[0]!.state, "collected");
  assert.equal(restored.functions.length, 1);
  const missingNative = await runProcess(
    root,
    {
      executable: path.join(root, "missing-original-java"),
      args: ["--version"],
      cwd: ".",
    },
    { timeoutMs: 1000 },
  );
  assert.equal(missingNative.errorCode, "ENOENT");
  assert.notEqual(missingNative.exitCode, 0);
});
test("context-scala stale acceptance", async (t) => {
  const { root, context } = await original(t);
  const wrongGrammar = structuredClone(context);
  analysis(wrongGrammar).grammarManifestDigest = "0".repeat(64);
  assert.throws(
    () => parseReviewContext(rebound(wrongGrammar)),
    /behavior anchors/,
  );
  for (const [mutate, message] of [
    [
      (value: ReturnType<typeof analysis>) => {
        value.scalaBindings.moduleRoots = ["elsewhere"];
      },
      /module roots differ/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.scalaBindings.counts.resolvedCalls++;
      },
      /counts do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.scalaBindings.callerEdges = [];
      },
      /closure does not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.scalaBindings.omissions = [];
      },
      /omissions do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.scalaBindings.state = "collected";
      },
      /omissions do not reconcile/,
    ],
  ] as const) {
    const forged = structuredClone(context);
    mutate(analysis(forged));
    assert.throws(() => parseReviewContext(rebound(forged)), message);
  }
  const script = await fixture(t, { "Sample.sc": "def decision() = true\n" });
  const scriptContext = await createReviewContext(
    script,
    input(["Sample.sc"], [], ["."]),
  );
  const scriptForged = structuredClone(scriptContext);
  analysis(scriptForged).scalaBindings.omissions = analysis(
    scriptForged,
  ).scalaBindings.omissions.filter(
    (value) => value !== "script-loading-unknown",
  );
  assert.throws(
    () => parseReviewContext(rebound(scriptForged)),
    /omissions do not reconcile/,
  );
  const outside = await createReviewContext(
      root,
      input(undefined, undefined, ["elsewhere"]),
    ),
    forged = structuredClone(outside);
  analysis(forged).scalaBindings.omissions = analysis(
    forged,
  ).scalaBindings.omissions.filter((value) => value !== "outside-module-roots");
  assert.throws(
    () => parseReviewContext(rebound(forged)),
    /omissions do not reconcile/,
  );
  const constructRoot = await fixture(t, {
      "Sample.scala": "class Original\ndef useit() = new Original()\n",
    }),
    constructContext = await createReviewContext(
      constructRoot,
      input(["Sample.scala"], [], ["."]),
    );
  const constructForged = structuredClone(constructContext);
  analysis(constructForged).scalaBindings.omissions = analysis(
    constructForged,
  ).scalaBindings.omissions.filter(
    (value) => value !== "constructor-dispatch-unknown",
  );
  assert.throws(
    () => parseReviewContext(rebound(constructForged)),
    /omissions do not reconcile/,
  );
  const engine = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const id = (await engine.open(context)).workflowId;
    await writeFile(path.join(root, "src/policy/Policy.scala"), fixed);
    await engine.next(id);
    assert.equal(engine.status(id).status, "stale");
  } finally {
    engine.dispose();
  }
  const old = {
      "src/policy/Policy.scala": broken,
      "src/consumer/Consumer.scala": consumer,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await writeFile(path.join(revision, "src/policy/Policy.scala"), fixed);
  fixtureGit(revision, ["add", "--all"]);
  await writeFile(path.join(revision, "src/policy/Policy.scala"), near);
  for (const currentSource of ["working-tree", "index"] as const) {
    const captured = await createReviewContext(revision, {
        ...input(),
        track: "diff",
        baseCommit: base,
        currentSource,
      }),
      value = analysis(captured),
      before = value.functions.find(
        (fn) => fn.revision === "base" && fn.name === "decision",
      )!,
      after = value.functions.find(
        (fn) => fn.revision === "current" && fn.name === "decision",
      )!;
    assert.notEqual(before.id, after.id);
    assert.equal(
      captured.files.find((file) => file.path === "src/policy/Policy.scala")!
        .content,
      currentSource === "index" ? fixed : near,
    );
    assert.ok(
      value.calls
        .filter((call) => call.file === "src/consumer/Consumer.scala")
        .every(
          (call) =>
            call.targetFunctionId ===
            (call.revision === "base" ? before.id : after.id),
        ),
    );
  }
});
test("context-scala empty acceptance", async (t) => {
  for (const source of ["", "// inert decision()\n", "def broken( ="]) {
    const root = await fixture(t, { "Sample.scala": source }),
      value = analysis(
        await createReviewContext(root, input(["Sample.scala"], [], ["."])),
      );
    assert.equal(value.scalaBindings.state, "partial");
    assert.deepEqual(value.scalaBindings.callerEdges, []);
    assert.equal(value.scalaBindings.counts.resolvedCalls, 0);
  }
  const unresolved = await fixture(t, {
      "Sample.scala": "def useit() = Unknown.decision()\n",
    }),
    value = analysis(
      await createReviewContext(unresolved, input(["Sample.scala"], [], ["."])),
    );
  assert.equal(value.calls[0]!.targetFunctionId, null);
  assert.equal(value.scalaBindings.counts.unresolvedCalls, 1);
  const wide = await fixture(t, {
      "Sample.scala": Array.from(
        { length: 3000 },
        (_, i) => "val x" + i + " = 1\n",
      ).join(""),
    }),
    exhausted = analysis(
      await createReviewContext(wide, input(["Sample.scala"], [], ["."])),
    );
  assert.equal(exhausted.files[0]!.state, "budget-exhausted");
  assert.deepEqual(exhausted.scalaBindings.callerEdges, []);
  const chain = Array.from(
      { length: 10 },
      (_, i) =>
        "def f" + i + "() = " + (i ? "f" + (i - 1) + "()" : "true") + "\n",
    ).join(""),
    chains = await fixture(t, { "Sample.scala": chain }),
    links = analysis(
      await createReviewContext(chains, input(["Sample.scala"], [], ["."])),
    ),
    f0 = links.functions.find((fn) => fn.name === "f0")!;
  assert.equal(
    links.scalaBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === f0.id,
    ).length,
    8,
  );
  assert.ok(links.scalaBindings.omissions.includes("depth-limit"));
  const roots = Array.from({ length: 16 }, (_, i) => "root" + i),
    paths = roots.flatMap((root) => [
      root + "/First.scala",
      root + "/Second.scala",
    ]),
    text = "//" + " ".repeat(32765) + "\n";
  assert.equal(Buffer.byteLength(text), 32768);
  const boundary = await fixture(
      t,
      Object.fromEntries(paths.map((file) => [file, text])),
    ),
    full = await createReviewContext(
      boundary,
      input(paths.slice(0, 1), paths.slice(1), roots),
    );
  assert.equal(full.files.length, 32);
  assert.equal(
    full.files.reduce(
      (total, file) => total + Buffer.byteLength(file.content),
      0,
    ),
    1048576,
  );
  assert.ok(analysis(full).files.every((file) => file.state === "collected"));
  const forged = structuredClone(full),
    source = forged.files[0]!;
  source.content += " ";
  source.sha256 = hash(source.content);
  analysis(forged).files.find((file) => file.file === source.path)!.sha256 =
    source.sha256;
  assert.throws(() => parseReviewContext(rebound(forged)), /source total/);
  await writeFile(path.join(boundary, paths[0]!), text + " ");
  await assert.rejects(
    createReviewContext(
      boundary,
      input(paths.slice(0, 1), paths.slice(1), roots),
    ),
    /source total/,
  );
});
test("context-scala privacy acceptance", async (t) => {
  const selection = input(),
    root = await fixture(t, {
      "src/policy/Policy.scala": fixed,
      "src/consumer/Consumer.scala": consumer,
      "selection.json": JSON.stringify(selection),
    }),
    expected = await createReviewContext(root, selection),
    cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  for (const flags of [[], ["--detailed", "--allow-review-source"]]) {
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "review-context",
        "--root",
        root,
        "--input",
        "selection.json",
        ...flags,
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout),
      projectReviewContext(expected, flags.length > 0),
    );
    assert.equal(result.stdout.includes("scalaBindings"), flags.length > 0);
    const client = new Client(
      { name: "original-scala-context-host", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [cli, "serve", "--root", root, ...flags],
          stderr: "pipe",
        }),
      );
      const output = await client.callTool({
        name: "review_context",
        arguments: selection,
      });
      assert.equal(output.isError, undefined);
      assert.deepEqual(
        output.structuredContent,
        projectReviewContext(expected, flags.length > 0),
      );
      assert.equal(
        (
          await client.callTool({
            name: "review_context",
            arguments: {
              ...selection,
              allowExecution: true,
              allowReviewSource: true,
            },
          })
        ).isError,
        true,
      );
      assert.equal(
        (await client.callTool({ name: "validation_run", arguments: {} }))
          .isError,
        true,
      );
    } finally {
      await client.close();
    }
  }
});
test("context-scala lifecycle acceptance", native, async (t) => {
  const marker = "original-side-effect.txt",
    root = await fixture(t, {
      "Sample.scala":
        'val sideEffect = java.nio.file.Files.writeString(java.nio.file.Path.of("' +
        marker +
        '"), "executed")\ndef decision() = true\n',
    });
  const value = analysis(
    await createReviewContext(root, input(["Sample.scala"], [], ["."])),
  );
  assert.equal(value.functions.length, 1);
  await assert.rejects(access(path.join(root, marker)), { code: "ENOENT" });
  const worker =
    'class NativeControl{public static void main(String[] args)throws Exception{if(args.length==1&&args[0].equals("child")){Thread.sleep(60000);return;}String javaExecutable=java.nio.file.Path.of(System.getProperty("java.home"),"bin","java").toString();Process child=new ProcessBuilder(javaExecutable,"-Xmx64m","-cp",System.getProperty("java.class.path"),"NativeControl","child").start();String body="{\\"parent\\":"+ProcessHandle.current().pid()+",\\"child\\":"+child.pid()+"}";java.nio.file.Path target=java.nio.file.Path.of(args[0]),pending=java.nio.file.Path.of(args[0]+".pending");java.nio.file.Files.writeString(pending,body);java.nio.file.Files.move(pending,target,java.nio.file.StandardCopyOption.ATOMIC_MOVE);if(args[1].equals("output")){System.out.write(new byte[1048576]);System.out.flush();}Thread.sleep(60000);}}';
  await writeFile(path.join(root, "NativeControl.java"), worker);
  const build = await runProcess(
    root,
    {
      executable: "javac",
      args: [
        "-J-Xmx256m",
        "-proc:none",
        "--release",
        "25",
        "NativeControl.java",
      ],
      cwd: ".",
    },
    { timeoutMs: 30000 },
  );
  assert.equal(build.exitCode, 0, build.stderr);
  assert.equal(build.errorCode, undefined);
  const command = (ready: string, mode: string) => ({
    executable: "java",
    args: ["-Xmx64m", "-cp", root, "NativeControl", ready, mode],
    cwd: ".",
  });
  const pre = new AbortController();
  pre.abort();
  const notReached = await runProcess(
    root,
    command(path.join(root, "pre.json"), "cancel"),
    { signal: pre.signal, timeoutMs: 1000 },
  );
  assert.equal(notReached.cancelled, true);
  await assert.rejects(access(path.join(root, "pre.json")), { code: "ENOENT" });
  for (const mode of ["cancel", "timeout", "output"] as const) {
    const ready = path.join(root, "native-" + mode + ".json"),
      controller = new AbortController(),
      execution = runProcess(root, command(ready, mode), {
        signal: controller.signal,
        timeoutMs: mode === "timeout" ? 3000 : 10000,
        maxOutputBytes: mode === "output" ? 1024 : 65536,
      });
    try {
      let identities: { parent: number; child: number } | undefined;
      for (let n = 0; n < 150; n++) {
        identities = await readFile(ready, "utf8")
          .then(JSON.parse)
          .catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        if (identities) break;
        await delay(20);
      }
      assert.ok(identities, "Reached native Java parent and child");
      assert.ok(
        Number.isInteger(identities.parent) &&
          Number.isInteger(identities.child) &&
          identities.parent > 1 &&
          identities.child > 1 &&
          identities.parent !== identities.child,
      );
      if (mode === "cancel") controller.abort();
      const result = await execution;
      assert.equal(result.errorCode, undefined);
      assert.equal(result.cancelled, mode === "cancel");
      assert.equal(result.timedOut, mode === "timeout");
      assert.equal(result.truncated, mode === "output");
      for (const pid of [identities.parent, identities.child]) {
        let alive = true;
        for (let n = 0; n < 100; n++) {
          try {
            process.kill(pid, 0);
          } catch {
            alive = false;
            break;
          }
          await delay(20);
        }
        assert.equal(alive, false, "Reached Java process survived cleanup");
      }
      await assert.rejects(access(ready + ".pending"), { code: "ENOENT" });
    } finally {
      controller.abort();
      await execution;
    }
  }
  await rm(path.join(root, "NativeControl.class"));
  await assert.rejects(access(path.join(root, "NativeControl.class")), {
    code: "ENOENT",
  });
  await assert.rejects(access(path.join(root, marker)), { code: "ENOENT" });
  const legacy = await createReviewContext(root, {
    schemaVersion: 12,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["Sample.scala"],
    supportFiles: [],
    moduleRoots: ["."],
    topics: [],
  });
  assert.equal(legacy.schemaVersion, 12);
  if (legacy.schemaVersion !== 12)
    throw Error("Original legacy context required");
  assert.equal(legacy.analysis.profile, "java-selected-bindings-v1");
  assert.ok(
    legacy.analysis.calls.every((call) => call.targetFunctionId === null),
  );
});
test("context-scala installed acceptance", native, async () => {
  if (process.env.CHECKTRAIL_CONTEXT_SCALA_INSTALLED === "1") {
    const runtime = await realpath(
      fileURLToPath(
        new URL("../src/review-scala-resolution.js", import.meta.url),
      ),
    );
    assert.ok(
      runtime.includes(
        path.join("node_modules", "@stsepelin", "checktrail", "dist", "src"),
      ),
    );
    return;
  }
  const env = {
    ...process.env,
    CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "context-scala",
  };
  delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT;
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
    { env, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1048576 },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  assert.equal(receipt.offlineProductionInstall, true);
  assert.equal(receipt.profile.complete, true);
  assert.equal(receipt.profile.required, 9);
  assert.equal(receipt.profile.passed, 9);
});
