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
import { callIdentityFixture } from "./review-call-identity-fixture.js";
import {
  javaMethodReferenceFixture,
  javaLocalTypeFixture,
  javaCompetingImportFixture,
  javaConstructorFixture,
  javaAncestorAccessibilityFixture,
  javaUnicodeEscapeFixture,
} from "./review-java-boundaries-fixture.js";

const broken =
  'package policy;public class Policy{public static final String FALLBACK="grant";public static boolean decision(String value){return value.startsWith(FALLBACK);}}\n';
const fixed =
  'package policy;public class Policy{public static final String FALLBACK="grant";public static boolean decision(String value){return value.equals(FALLBACK)||value.startsWith(FALLBACK+":");}}\n';
const near =
  'package policy;public class Policy{public static final String FALLBACK="grant";public static boolean decision(String value){return value.equals("grant:read")||value.equals("grant:write");}}\n';
const consumer =
  'package consumer;import policy.Policy;import static policy.Policy.decision;import static policy.Policy.FALLBACK;public class Consumer{public static boolean submit(){return decision("grantToken");}public static boolean route(){return Policy.decision(FALLBACK);}}\n';
const native = {
  skip: /^javac 25\.0\.4$/.test(
    spawnSync("javac", ["--version"], { encoding: "utf8" }).stdout?.trim() ??
      "",
  )
    ? false
    : "Pinned native Java unavailable",
  timeout: 120000,
};
const input = (
  files = ["src/policy/Policy.java"],
  supportFiles = ["src/consumer/Consumer.java"],
  moduleRoots = ["src"],
) => ({
  schemaVersion: 12,
  track: "snapshot",
  currentSource: "working-tree",
  files,
  supportFiles,
  moduleRoots,
  topics: [],
});
function analysis(context: ReviewContext) {
  assert.equal(context.schemaVersion, 12);
  if (context.schemaVersion !== 12)
    throw Error("Original Java context required");
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
    "src/policy/Policy.java": policy,
    "src/consumer/Consumer.java": consumer,
    ".checktrail/keep": "",
  });
  const context = await createReviewContext(root, input());
  return { root, context, result: analysis(context) };
}
async function compile(
  root: string,
  files: string[],
  witness: string,
  name = "original-classes",
) {
  await writeFile(path.join(root, "Witness.java"), witness);
  const classes = path.join(root, name);
  await mkdir(classes);
  const result = await runProcess(
    root,
    {
      executable: "javac",
      args: [
        "-J-Xmx256m",
        "-proc:none",
        "--release",
        "25",
        "-d",
        classes,
        ...files,
        "Witness.java",
      ],
      cwd: ".",
    },
    { timeoutMs: 30000, maxOutputBytes: 65536 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.errorCode, undefined);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.truncated, false);
  return classes;
}
async function compilerRejects(root: string, files: string[], pattern: RegExp) {
  const result = await runProcess(
    root,
    {
      executable: "javac",
      args: ["-J-Xmx256m", "-proc:none", "--release", "25", ...files],
      cwd: ".",
    },
    { timeoutMs: 30000, maxOutputBytes: 65536 },
  );
  assert.equal(result.exitCode, 1, result.stderr);
  assert.equal(result.errorCode, undefined);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.truncated, false);
  assert.match(result.stderr, pattern);
}
async function execute(root: string, classes: string) {
  const result = await runProcess(
    root,
    {
      executable: "java",
      args: ["-Xmx256m", "-cp", classes, "Witness"],
      cwd: ".",
    },
    { timeoutMs: 10000, maxOutputBytes: 65536 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.errorCode, undefined);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.truncated, false);
  return result.stdout;
}
async function witness(root: string) {
  const classes = await compile(
    root,
    ["src/policy/Policy.java", "src/consumer/Consumer.java"],
    'class Witness{public static void main(String[] args){for(String value:new String[]{"grant:read","grantToken","grant2","other"})System.out.println(policy.Policy.decision(value));System.out.println(consumer.Consumer.submit());System.out.println(consumer.Consumer.route());}}',
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
    (fn) => fn.file === "src/policy/Policy.java" && fn.name === "decision",
  )!;
  assert.ok(policy);
  const calls = result.calls.filter(
    (call) => call.file === "src/consumer/Consumer.java",
  );
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(
      (call) =>
        call.resolution === "lexical-binding" &&
        call.targetFunctionId === policy.id,
    ),
  );
  assert.equal(result.modules.length, 3);
  assert.ok(result.modules.every((value) => value.resolution === "selected"));
  assert.equal(
    result.javaBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === policy.id && edge.depth === 1,
    ).length,
    2,
  );
  assert.equal(
    result.javaBindings.counts.calls,
    result.javaBindings.counts.resolvedCalls +
      result.javaBindings.counts.unresolvedCalls,
  );
  assert.equal(
    result.javaBindings.counts.imports,
    result.javaBindings.counts.resolvedImports +
      result.javaBindings.counts.unresolvedImports,
  );
  assert.equal(result.javaBindings.fullImpactFallback, true);
  assert.equal(result.javaBindings.runtimeReachabilityVerified, false);
  assert.equal(result.javaBindings.nativeNameResolutionVerified, false);
  assert.equal(result.javaBindings.moduleLoadingVerified, false);
  assert.equal(result.javaBindings.validationPlanUnchanged, true);
}
test("context-java broken acceptance", native, async (t) => {
  const { root, context, result } = await original(t);
  bindings(result);
  assert.deepEqual(await witness(root), [true, true, true, false, true, true]);
  const fn = result.functions.find((fn) => fn.name === "decision")!,
    source = context.files.find((file) => file.path === fn.file)!;
  assert.equal(
    source.content.slice(fn.start, fn.end),
    "public static boolean decision(String value){return value.startsWith(FALLBACK);}",
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
      "src/policy/Policy.java": broken,
      "src/consumer/Consumer.java": consumer,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await rename(
    path.join(revision, "src/consumer/Consumer.java"),
    path.join(revision, "src/consumer/Moved.java"),
  );
  await writeFile(
    path.join(revision, "src/consumer/Moved.java"),
    'package consumer;import policy.Policy;class Moved{static boolean submit(Policy Policy){return Policy.decision("grantToken");}}',
  );
  await writeFile(path.join(revision, "src/policy/Policy.java"), fixed);
  const captured = await createReviewContext(revision, {
      ...input(undefined, [
        "src/consumer/Consumer.java",
        "src/consumer/Moved.java",
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
        call.file === "src/consumer/Consumer.java" &&
        call.revision === "base" &&
        call.targetFunctionId === before.id,
    ).length,
    2,
  );
  assert.ok(
    value.calls
      .filter((call) => call.file === "src/consumer/Moved.java")
      .every((call) => call.targetFunctionId === null),
  );
  assert.ok(
    value.javaBindings.callerEdges.some(
      (edge) => edge.revision === "base" && edge.targetFunctionId === before.id,
    ),
  );
});
test("context-java fixed acceptance", native, async (t) => {
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
      (decision) => decision.file === "src/policy/Policy.java",
    ),
  );
});
test("context-java near-miss acceptance", native, async (t) => {
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
  await callIdentityFixture(t, "java", true);
  await javaMethodReferenceFixture(t);
  await javaLocalTypeFixture(t);
  await javaCompetingImportFixture(t);
  await javaConstructorFixture(t);
  await javaAncestorAccessibilityFixture(t);
  await javaUnicodeEscapeFixture(t);
  for (const [source, expected] of [
    [
      "class Sample{static boolean decision(){return true;}static boolean useit(java.util.function.BooleanSupplier decision){return decision();}}",
      "lexical-binding",
    ],
    [
      "class Sample{static final int LIMIT=1;static int useit(){int LIMIT=LIMIT;return LIMIT;}}",
      "no-constant-reference",
    ],
    [
      'class Sample{static boolean decision(String s){return true;}static boolean decision(int i){return false;}static boolean useit(){return decision("ok");}}',
      "ambiguous-definition",
    ],
    [
      "class Policy{static boolean decision(){return true;}}class Sample{static boolean useit(Policy Policy){return Policy.decision();}}",
      "unsupported-dispatch",
    ],
    [
      "class Policy{static boolean decision(){return true;}}class Sample{static boolean useit(){return Policy2.decision();}}",
      "no-selected-definition",
    ],
    [
      'class Policy{static boolean decision(){return true;}}class Sample{static String inert="Policy.decision()";/* Policy.decision() */}',
      "no-call",
    ],
    [
      "class Policy{static boolean decision(){return true;}}class Sample extends Policy{static boolean useit(){return decision();}}",
      "unsupported-dispatch",
    ],
    [
      "class Sample{static final int label=1;static int useit(){label:while(true){break label;}return 2;}}",
      "no-constant-reference",
    ],
  ] as const) {
    const boundary = await fixture(t, { "Sample.java": source }),
      context = await createReviewContext(
        boundary,
        input(["Sample.java"], [], ["."]),
      ),
      value = analysis(context);
    if (expected === "no-call") assert.deepEqual(value.calls, []);
    else if (expected === "no-constant-reference")
      assert.deepEqual(value.references, []);
    else {
      assert.equal(value.calls.length, 1);
      assert.equal(value.calls[0]!.resolution, expected);
      if (expected !== "lexical-binding")
        assert.equal(value.calls[0]!.targetFunctionId, null);
    }
  }
  const local = await fixture(t, {
    "Sample.java":
      "class Policy{static boolean decision(){return true;}}class Sample{static boolean useit(){boolean before=Policy.decision();class Policy{static boolean decision(){return false;}}return before;}}",
  });
  const classes = await compile(
    local,
    ["Sample.java"],
    "class Witness{public static void main(String[] args){System.out.println(Sample.useit());}}",
  );
  assert.equal(await execute(local, classes), "true\n");
  const reference = await fixture(t, {
    "Sample.java":
      "class Sample{static final boolean decision=true;static boolean decision(){return false;}static java.util.function.BooleanSupplier reference(){return Sample::decision;}}",
  });
  const referenceClasses = await compile(
    reference,
    ["Sample.java"],
    "class Witness{public static void main(String[] args){System.out.println(Sample.decision);System.out.println(Sample.reference().getAsBoolean());}}",
  );
  assert.equal(await execute(reference, referenceClasses), "true\nfalse\n");
  const methods = await fixture(t, {
    "Sample.java":
      "class Sample{static boolean decision(){return true;}static boolean useit(java.util.function.BooleanSupplier decision){return decision();}}",
  });
  const methodClasses = await compile(
    methods,
    ["Sample.java"],
    "class Witness{public static void main(String[] args){System.out.println(Sample.useit(()->false));}}",
  );
  assert.equal(await execute(methods, methodClasses), "true\n");
  const nested = await fixture(t, {
    "Sample.java":
      "class Sample{static class Policy{static final int VALUE=3;static boolean decision(){return true;}}static boolean useit(){return Policy.decision();}}",
  });
  const nestedValue = analysis(
    await createReviewContext(nested, input(["Sample.java"], [], ["."])),
  );
  assert.equal(nestedValue.calls[0]!.resolution, "lexical-binding");
  const nestedClasses = await compile(
    nested,
    ["Sample.java"],
    "class Witness{public static void main(String[] args){System.out.println(Sample.useit());}}",
  );
  assert.equal(await execute(nested, nestedClasses), "true\n");
  const inaccessibleSource =
      "package b;import a.Outer.Inner;public class Sample{public static boolean useit(){return Inner.decision();}}",
    outer =
      "package a;class Outer{public static class Inner{public static boolean decision(){return true;}}}";
  const inaccessible = await fixture(t, {
    "Sample.java": inaccessibleSource,
    "a/Outer.java": outer,
  });
  await compilerRejects(
    inaccessible,
    ["Sample.java", "a/Outer.java"],
    /inaccessible|is not public/,
  );
  for (const [consumer, producer, packageName] of [
    [
      inaccessibleSource,
      outer.replace("class Outer", "public class Outer"),
      "b",
    ],
    [inaccessibleSource.replace("package b;", "package a;"), outer, "a"],
  ] as const) {
    const accessible = await fixture(t, {
      "Sample.java": consumer,
      "a/Outer.java": producer,
    });
    const classes = await compile(
      accessible,
      ["Sample.java", "a/Outer.java"],
      "class Witness{public static void main(String[] args){System.out.println(" +
        packageName +
        ".Sample.useit());}}",
    );
    assert.equal(await execute(accessible, classes), "true\n");
  }
  const escaped = await fixture(t, {
    "Sample.java": String.raw`class Policy{static boolean decision(){return true;}}class Sample{
// \u000a static Object Policy=new Object();
static boolean useit(){return Policy.decision();}}`,
  });
  await compilerRejects(escaped, ["Sample.java"], /cannot find symbol/);
  const inertEscapeSource = String.raw`class Sample{static final String TEXT="\\u0050";static boolean useit(){return true;}}`;
  const inertEscape = await fixture(t, { "Sample.java": inertEscapeSource }),
    inertContext = analysis(
      await createReviewContext(inertEscape, input(["Sample.java"], [], ["."])),
    );
  assert.equal(inertContext.javaBindings.state, "partial");
  assert.ok(
    inertContext.javaBindings.omissions.includes("unicode-escapes-unknown"),
  );
  const inertClasses = await compile(
    inertEscape,
    ["Sample.java"],
    "class Witness{public static void main(String[] args){System.out.println(Sample.TEXT);}}",
  );
  assert.equal(await execute(inertEscape, inertClasses), "\\u0050\n");
  const wildcard = await fixture(t, {
    "Sample.java":
      'import static policy.Policy.*;class Sample{static boolean useit(){return decision("grantToken");}}',
    "src/policy/Policy.java": fixed,
  });
  const wild = analysis(
    await createReviewContext(
      wildcard,
      input(["Sample.java"], ["src/policy/Policy.java"], ["."]),
    ),
  );
  assert.equal(
    wild.calls.find((call) => call.file === "Sample.java")!.targetFunctionId,
    null,
  );
  assert.ok(wild.javaBindings.omissions.includes("unsupported-import"));
  const duplicate = await fixture(t, {
    "src/policy/Policy.java": fixed,
    "src/copy/Policy.java": fixed,
    "src/consumer/Consumer.java": consumer,
  });
  const ambiguous = analysis(
    await createReviewContext(
      duplicate,
      input(undefined, ["src/copy/Policy.java", "src/consumer/Consumer.java"]),
    ),
  );
  assert.ok(
    ambiguous.calls
      .filter((call) => call.file === "src/consumer/Consumer.java")
      .every(
        (call) =>
          call.resolution === "ambiguous-definition" &&
          call.targetFunctionId === null,
      ),
  );
});
test("context-java prerequisite acceptance", async (t) => {
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
  assert.equal(outside.javaBindings.state, "partial");
  assert.ok(outside.javaBindings.omissions.includes("outside-module-roots"));
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
      path: "Sample.java",
      content: "class Sample{static boolean decision(){return true;}}",
      sha256: hash("class Sample{static boolean decision(){return true;}}"),
    };
  const missing = await isolated.collectReviewJavaBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(missing.files[0]!.state, "error");
  assert.deepEqual(missing.functions, []);
  assert.equal(missing.javaBindings.state, "partial");
  await mkdir(path.join(copied, "assets/context-grammars"), {
    recursive: true,
  });
  const bytes = await readFile(
      path.join(
        await realpath(path.join(repository, "dist/src")),
        "../../assets/context-grammars/tree-sitter-java.wasm",
      ),
    ),
    altered = Buffer.from(bytes),
    position = altered.indexOf(Buffer.from("tree_sitter_java"));
  assert.notEqual(position, -1);
  altered[position + "tree_sitter_jav".length] = "s".charCodeAt(0);
  assert.doesNotThrow(() => new WebAssembly.Module(altered));
  const asset = path.join(
    copied,
    "assets/context-grammars/tree-sitter-java.wasm",
  );
  await writeFile(asset, altered);
  const changed = await isolated.collectReviewJavaBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(changed.files[0]!.state, "error");
  assert.deepEqual(changed.calls, []);
  await writeFile(asset, bytes);
  const restored = await isolated.collectReviewJavaBehavior(
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
test("context-java stale acceptance", async (t) => {
  const { root, context } = await original(t);
  for (const [mutate, message] of [
    [
      (value: ReturnType<typeof analysis>) => {
        value.javaBindings.moduleRoots = ["elsewhere"];
      },
      /module roots differ/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.javaBindings.counts.resolvedCalls++;
      },
      /counts do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.javaBindings.callerEdges = [];
      },
      /closure does not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.javaBindings.omissions = [];
      },
      /omissions do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.javaBindings.state = "collected";
      },
      /omissions do not reconcile/,
    ],
  ] as const) {
    const forged = structuredClone(context);
    mutate(analysis(forged));
    assert.throws(() => parseReviewContext(rebound(forged)), message);
  }
  for (const [source, omission] of [
    [
      "class Sample{static Sample choose(){return new Sample();}}",
      "constructor-dispatch-unknown",
    ],
    [
      String.raw`class Policy{static boolean decision(){return true;}}class Sample{
// \u000a static Object Policy=new Object();
static boolean useit(){return Policy.decision();}}`,
      "unicode-escapes-unknown",
    ],
  ] as const) {
    const specialRoot = await fixture(t, { "Sample.java": source });
    const special = await createReviewContext(
      specialRoot,
      input(["Sample.java"], [], ["."]),
    );
    const tampered = structuredClone(special);
    analysis(tampered).javaBindings.omissions = analysis(
      tampered,
    ).javaBindings.omissions.filter((value) => value !== omission);
    assert.throws(
      () => parseReviewContext(rebound(tampered)),
      /omissions do not reconcile/,
    );
  }
  const outside = await createReviewContext(
      root,
      input(undefined, undefined, ["elsewhere"]),
    ),
    forged = structuredClone(outside);
  analysis(forged).javaBindings.omissions = analysis(
    forged,
  ).javaBindings.omissions.filter((value) => value !== "outside-module-roots");
  assert.throws(
    () => parseReviewContext(rebound(forged)),
    /omissions do not reconcile/,
  );
  const engine = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const id = (await engine.open(context)).workflowId;
    await writeFile(path.join(root, "src/policy/Policy.java"), fixed);
    await engine.next(id);
    assert.equal(engine.status(id).status, "stale");
  } finally {
    engine.dispose();
  }
  const old = {
      "src/policy/Policy.java": broken,
      "src/consumer/Consumer.java": consumer,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await writeFile(path.join(revision, "src/policy/Policy.java"), fixed);
  fixtureGit(revision, ["add", "--all"]);
  await writeFile(path.join(revision, "src/policy/Policy.java"), near);
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
      captured.files.find((file) => file.path === "src/policy/Policy.java")!
        .content,
      currentSource === "index" ? fixed : near,
    );
    assert.ok(
      value.calls
        .filter((call) => call.file === "src/consumer/Consumer.java")
        .every(
          (call) =>
            call.targetFunctionId ===
            (call.revision === "base" ? before.id : after.id),
        ),
    );
  }
});
test("context-java empty acceptance", async (t) => {
  for (const source of [
    "",
    "// inert decision()\n",
    "class Broken{static boolean (",
  ]) {
    const root = await fixture(t, { "Sample.java": source }),
      value = analysis(
        await createReviewContext(root, input(["Sample.java"], [], ["."])),
      );
    assert.equal(value.javaBindings.state, "partial");
    assert.deepEqual(value.javaBindings.callerEdges, []);
    assert.equal(value.javaBindings.counts.resolvedCalls, 0);
  }
  const unresolved = await fixture(t, {
      "Sample.java":
        "class Sample{static boolean useit(){return Unknown.decision();}}",
    }),
    value = analysis(
      await createReviewContext(unresolved, input(["Sample.java"], [], ["."])),
    );
  assert.equal(value.calls[0]!.targetFunctionId, null);
  assert.equal(value.javaBindings.counts.unresolvedCalls, 1);
  const wide = await fixture(t, {
      "Sample.java":
        "class Sample{" +
        Array.from({ length: 3000 }, (_, i) => "static int x" + i + "=1;").join(
          "",
        ) +
        "}",
    }),
    exhausted = analysis(
      await createReviewContext(wide, input(["Sample.java"], [], ["."])),
    );
  assert.equal(exhausted.files[0]!.state, "budget-exhausted");
  assert.deepEqual(exhausted.javaBindings.callerEdges, []);
  const chain =
      "class Sample{" +
      Array.from(
        { length: 10 },
        (_, i) =>
          "static boolean f" +
          i +
          "(){return " +
          (i ? "f" + (i - 1) + "()" : "true") +
          ";}",
      ).join("") +
      "}",
    chains = await fixture(t, { "Sample.java": chain }),
    links = analysis(
      await createReviewContext(chains, input(["Sample.java"], [], ["."])),
    ),
    f0 = links.functions.find((fn) => fn.name === "f0")!;
  assert.equal(
    links.javaBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === f0.id,
    ).length,
    8,
  );
  assert.ok(links.javaBindings.omissions.includes("depth-limit"));
  const roots = Array.from({ length: 16 }, (_, i) => "root" + i),
    paths = roots.flatMap((root) => [
      root + "/First.java",
      root + "/Second.java",
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
test("context-java privacy acceptance", async (t) => {
  const selection = input(),
    root = await fixture(t, {
      "src/policy/Policy.java": fixed,
      "src/consumer/Consumer.java": consumer,
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
    assert.equal(result.stdout.includes("javaBindings"), flags.length > 0);
    const client = new Client(
      { name: "original-java-context-host", version: "1" },
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
test("context-java lifecycle acceptance", native, async (t) => {
  const marker = "original-side-effect.txt",
    root = await fixture(t, {
      "Sample.java":
        'class Sample{static{try{java.nio.file.Files.writeString(java.nio.file.Path.of("' +
        marker +
        '"),"executed");}catch(Exception failure){throw new RuntimeException(failure);}}static boolean decision(){return true;}}',
    });
  const value = analysis(
    await createReviewContext(root, input(["Sample.java"], [], ["."])),
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
    schemaVersion: 11,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["Sample.java"],
    supportFiles: [],
    crateRoots: ["Sample.rs"],
    topics: [],
  });
  assert.equal(legacy.schemaVersion, 11);
  if (legacy.schemaVersion !== 11)
    throw Error("Original legacy context required");
  assert.equal(legacy.analysis.profile, "rust-selected-bindings-v1");
  assert.ok(
    legacy.analysis.calls.every((call) => call.targetFunctionId === null),
  );
});
test("context-java installed acceptance", native, async () => {
  if (process.env.CHECKTRAIL_CONTEXT_JAVA_INSTALLED === "1") {
    const runtime = await realpath(
      fileURLToPath(
        new URL("../src/review-java-resolution.js", import.meta.url),
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
    CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "context-java",
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
