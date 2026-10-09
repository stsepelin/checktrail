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
  readdir,
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
import { csharpBoundariesFixture } from "./review-csharp-boundaries-fixture.js";

const broken =
  'namespace policy;public static class Policy{public const string FALLBACK="grant";public static bool decision(string value){return value.StartsWith(FALLBACK);}}\n';
const fixed =
  'namespace policy;public static class Policy{public const string FALLBACK="grant";public static bool decision(string value){return value==FALLBACK||value.StartsWith(FALLBACK+":");}}\n';
const near =
  'namespace policy;public static class Policy{public const string FALLBACK="grant";public static bool decision(string value){return value=="grant:read"||value=="grant:write";}}\n';
const consumer =
  'using P=policy.Policy;using N=policy;using static policy.Policy;namespace consumer;public static class Consumer{public static bool submit(){return decision("grantToken");}public static bool route(){return P.decision(FALLBACK);}public static bool alias(){return N.Policy.decision("grantToken");}}\n';
const sdk = "/usr/share/dotnet/sdk/10.0.401/Roslyn/bincore/csc.dll";
const refs =
  "/usr/share/dotnet/packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0";
const compilerVersion =
  "5.9.0-1.26423.113 (e34a38d2ae1fc26406a317517196e55c68ff83ab)";
const native = {
  skip:
    spawnSync("dotnet", ["exec", sdk, "-version"], {
      encoding: "utf8",
    }).stdout?.trim() === compilerVersion
      ? false
      : "Pinned native C# unavailable",
  timeout: 120000,
};
const input = (
  files = ["src/policy/Policy.cs"],
  supportFiles = ["src/consumer/Consumer.cs"],
  moduleRoots = ["src"],
) => ({
  schemaVersion: 15,
  track: "snapshot",
  currentSource: "working-tree",
  files,
  supportFiles,
  moduleRoots,
  topics: [],
});
function analysis(context: ReviewContext) {
  assert.equal(context.schemaVersion, 15);
  if (context.schemaVersion !== 15) throw Error("Original C# context required");
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
    "src/policy/Policy.cs": policy,
    "src/consumer/Consumer.cs": consumer,
    ".checktrail/keep": "",
  });
  const context = await createReviewContext(root, input());
  return { root, context, result: analysis(context) };
}
async function compilerArgs(root: string, files: string[], name: string) {
  const destination = path.join(root, name);
  await mkdir(destination);
  const assembly = path.join(destination, "Witness.dll");
  const libraries = (await readdir(refs))
    .filter((value) => value.endsWith(".dll"))
    .sort();
  assert.ok(libraries.length > 100);
  await writeFile(
    path.join(destination, "Witness.runtimeconfig.json"),
    JSON.stringify({
      runtimeOptions: {
        tfm: "net10.0",
        framework: { name: "Microsoft.NETCore.App", version: "10.0.12" },
      },
    }),
  );
  return {
    destination,
    assembly,
    args: [
      "exec",
      sdk,
      "-noconfig",
      "-nostdlib+",
      "-langversion:14",
      "-target:exe",
      "-out:" + assembly,
      ...libraries.map((value) => "-r:" + path.join(refs, value)),
      ...files,
    ],
  };
}
async function compile(
  root: string,
  files: string[],
  witness: string,
  name = "original-assembly",
) {
  await writeFile(path.join(root, "Witness.cs"), witness);
  const configured = await compilerArgs(root, [...files, "Witness.cs"], name);
  const result = await runProcess(
    root,
    { executable: "dotnet", args: configured.args, cwd: "." },
    { timeoutMs: 30000, maxOutputBytes: 65536 },
  );
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.equal(result.errorCode, undefined);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.truncated, false);
  return configured.assembly;
}
async function execute(root: string, assembly: string) {
  const result = await runProcess(
    root,
    { executable: "dotnet", args: [assembly], cwd: "." },
    { timeoutMs: 10000, maxOutputBytes: 65536 },
  );
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.equal(result.errorCode, undefined);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.truncated, false);
  return result.stdout;
}
async function witness(root: string) {
  const assembly = await compile(
    root,
    ["src/policy/Policy.cs", "src/consumer/Consumer.cs"],
    'class Witness{static void Main(){foreach(string value in new[]{"grant:read","grantToken","grant2","other"})System.Console.WriteLine(policy.Policy.decision(value));System.Console.WriteLine(consumer.Consumer.submit());System.Console.WriteLine(consumer.Consumer.route());System.Console.WriteLine(consumer.Consumer.alias());}}',
  );
  return (await execute(root, assembly))
    .trim()
    .split("\n")
    .map((value) => {
      assert.ok(value === "True" || value === "False");
      return value === "True";
    });
}
function bindings(result: ReturnType<typeof analysis>) {
  const policy = result.functions.find(
    (fn) => fn.file === "src/policy/Policy.cs" && fn.name === "decision",
  )!;
  assert.ok(policy);
  const calls = result.calls.filter(
    (call) => call.file === "src/consumer/Consumer.cs",
  );
  assert.equal(calls.length, 3);
  assert.ok(
    calls.every(
      (call) =>
        call.resolution === "lexical-binding" &&
        call.targetFunctionId === policy.id,
    ),
  );
  assert.equal(result.modules.length, 3);
  assert.equal(
    result.modules.filter((value) => value.resolution === "selected").length,
    2,
  );

  assert.equal(
    result.csharpBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === policy.id && edge.depth === 1,
    ).length,
    3,
  );
  assert.equal(
    result.csharpBindings.counts.calls,
    result.csharpBindings.counts.resolvedCalls +
      result.csharpBindings.counts.unresolvedCalls,
  );
  assert.equal(
    result.csharpBindings.counts.imports,
    result.csharpBindings.counts.resolvedImports +
      result.csharpBindings.counts.unresolvedImports,
  );
  assert.equal(result.csharpBindings.fullImpactFallback, true);
  assert.equal(result.csharpBindings.runtimeReachabilityVerified, false);
  assert.equal(result.csharpBindings.nativeNameResolutionVerified, false);
  assert.equal(result.csharpBindings.moduleLoadingVerified, false);
  assert.equal(result.csharpBindings.validationPlanUnchanged, true);
}
test("context-csharp broken acceptance", native, async (t) => {
  const { root, context, result } = await original(t);
  bindings(result);
  assert.deepEqual(await witness(root), [
    true,
    true,
    true,
    false,
    true,
    true,
    true,
  ]);
  const fn = result.functions.find((fn) => fn.name === "decision")!,
    source = context.files.find((file) => file.path === fn.file)!;
  assert.equal(
    source.content.slice(fn.start, fn.end),
    "public static bool decision(string value){return value.StartsWith(FALLBACK);}",
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
      "src/policy/Policy.cs": broken,
      "src/consumer/Consumer.cs": consumer,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await rename(
    path.join(revision, "src/consumer/Consumer.cs"),
    path.join(revision, "src/consumer/Moved.cs"),
  );
  await writeFile(
    path.join(revision, "src/consumer/Moved.cs"),
    'using P=policy.Policy;namespace consumer;class Moved{static bool submit(System.Func<string,bool> P){return P("grantToken");}}',
  );
  await writeFile(path.join(revision, "src/policy/Policy.cs"), fixed);
  const captured = await createReviewContext(revision, {
      ...input(undefined, [
        "src/consumer/Consumer.cs",
        "src/consumer/Moved.cs",
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
        call.file === "src/consumer/Consumer.cs" &&
        call.revision === "base" &&
        call.targetFunctionId === before.id,
    ).length,
    3,
  );
  assert.ok(
    value.calls
      .filter((call) => call.file === "src/consumer/Moved.cs")
      .every((call) => call.targetFunctionId === null),
  );
  assert.ok(
    value.csharpBindings.callerEdges.some(
      (edge) => edge.revision === "base" && edge.targetFunctionId === before.id,
    ),
  );
});
test("context-csharp fixed acceptance", native, async (t) => {
  const { root, result } = await original(t, fixed);
  bindings(result);
  assert.deepEqual(await witness(root), [
    true,
    false,
    false,
    false,
    false,
    true,
    false,
  ]);
  assert.ok(
    result.decisions.some(
      (decision) => decision.file === "src/policy/Policy.cs",
    ),
  );
});
test("context-csharp near-miss acceptance", native, async (t) => {
  const { root, result } = await original(t, near);
  bindings(result);
  assert.deepEqual(await witness(root), [
    true,
    false,
    false,
    false,
    false,
    false,
    false,
  ]);
  await csharpBoundariesFixture(t);
  for (const [source, expected] of [
    [
      "using static policy.Policy;class Sample{public static bool useit(System.Func<bool> decision){return decision();}}",
      "False\n",
    ],
    [
      "using static policy.Policy;class Sample{public static bool useit(){bool before(){return decision();}bool decision(){return false;}return before();}}",
      "False\n",
    ],
    [
      "using static policy.Policy;class Sample{public static bool decision(){return false;}public static bool useit(){return decision();}}",
      "False\n",
    ],
    [
      "using static policy.Policy;class Sample{public static readonly System.Func<bool> decision=()=>false;public static bool useit(){return decision();}}",
      "False\n",
    ],
    [
      "class Sample{public class Policy{public static bool decision(){return true;}}public static bool useit(){return Policy.decision();}}",
      "True\n",
    ],
    [
      "class Sample{const int LIMIT=2;public static int useit(int value=LIMIT){return LIMIT;}}",
      "2\n",
    ],
    [
      'using A=policy.Policy;class Sample{public static bool useit(){return A.decision("grant");}}',
      "True\n",
    ],
    [
      'using N=policy;class Sample{public static bool useit(){return N.Policy.decision("grant");}}',
      "True\n",
    ],
  ] as const) {
    const selected = await fixture(t, {
      "Sample.cs": source,
      "Policy.cs": broken,
    });
    const asm = await compile(
      selected,
      ["Sample.cs", "Policy.cs"],
      source.includes("Func<bool> decision)")
        ? "class Witness{static void Main(){System.Console.WriteLine(Sample.useit(()=>false));}}"
        : "class Witness{static void Main(){System.Console.WriteLine(Sample.useit());}}",
    );
    assert.equal(await execute(selected, asm), expected);
  }
  const invalid = await fixture(t, {
    "Sample.cs":
      "using static first.Policy;using static second.Policy;class Sample{static bool useit(){return decision();}}",
    "First.cs":
      "namespace first;public static class Policy{public static bool decision(){return true;}}",
    "Second.cs":
      "namespace second;public static class Policy{public static bool decision(){return false;}}",
  });
  await writeFile(
    path.join(invalid, "Witness.cs"),
    "class Witness{static void Main(){}}",
  );
  const config = await compilerArgs(
    invalid,
    ["Sample.cs", "First.cs", "Second.cs", "Witness.cs"],
    "ambiguous-native",
  );
  const rejected = await runProcess(
    invalid,
    { executable: "dotnet", args: config.args, cwd: "." },
    { timeoutMs: 30000 },
  );
  assert.equal(rejected.exitCode, 1);
  assert.equal(rejected.errorCode, undefined);
  assert.match(rejected.stdout, /CS0121/);
});
test("context-csharp prerequisite acceptance", async (t) => {
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
  assert.equal(outside.csharpBindings.state, "partial");
  assert.ok(outside.csharpBindings.omissions.includes("outside-module-roots"));
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
      path: "Sample.cs",
      content: "class Sample{static bool decision(){return true;}}",
      sha256: hash("class Sample{static bool decision(){return true;}}"),
    };
  const missing = await isolated.collectReviewCsharpBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(missing.files[0]!.state, "error");
  assert.deepEqual(missing.functions, []);
  assert.equal(missing.csharpBindings.state, "partial");
  await mkdir(path.join(copied, "assets/context-grammars"), {
    recursive: true,
  });
  const bytes = await readFile(
      path.join(
        await realpath(path.join(repository, "dist/src")),
        "../../assets/context-grammars/tree-sitter-c_sharp.wasm",
      ),
    ),
    altered = Buffer.from(bytes),
    position = altered.indexOf(Buffer.from("tree_sitter_c_sharp"));
  assert.notEqual(position, -1);
  altered[position + "tree_sitter_c_shar".length] = "s".charCodeAt(0);
  assert.doesNotThrow(() => new WebAssembly.Module(altered));
  const asset = path.join(
    copied,
    "assets/context-grammars/tree-sitter-c_sharp.wasm",
  );
  await writeFile(asset, altered);
  const changed = await isolated.collectReviewCsharpBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(changed.files[0]!.state, "error");
  assert.deepEqual(changed.calls, []);
  await writeFile(asset, bytes);
  const restored = await isolated.collectReviewCsharpBehavior(
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
      executable: path.join(root, "missing-original-csharp"),
      args: ["--version"],
      cwd: ".",
    },
    { timeoutMs: 1000 },
  );
  assert.equal(missingNative.errorCode, "ENOENT");
  assert.notEqual(missingNative.exitCode, 0);
});
test("context-csharp stale acceptance", async (t) => {
  const { root, context } = await original(t);
  for (const [mutate, message] of [
    [
      (value: ReturnType<typeof analysis>) => {
        value.csharpBindings.moduleRoots = ["elsewhere"];
      },
      /module roots differ/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.csharpBindings.counts.resolvedCalls++;
      },
      /counts do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.csharpBindings.callerEdges = [];
      },
      /closure does not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.csharpBindings.omissions = [];
      },
      /omissions do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.csharpBindings.state = "collected";
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
      "global using static policy.Policy;class Sample{static bool useit(){return decision();}}",
      "global-using-unknown",
    ],
    [
      "#if FEATURE\nclass Sample{static bool decision(){return true;}}\n#endif",
      "conditional-source-unknown",
    ],
    [
      String.raw`class Sample{static bool deci\U00000073ion(){return true;}}`,
      "unicode-escapes-unknown",
    ],
    [
      "class Sample{static Sample choose(){return new Sample();}}",
      "constructor-dispatch-unknown",
    ],
    [
      String.raw`class Policy{static bool decision(){return true;}}class Sample{
// \u000a static object Policy=new object();
static bool useit(){return Policy.decision();}}`,
      "unicode-escapes-unknown",
    ],
  ] as const) {
    const specialRoot = await fixture(t, { "Sample.cs": source });
    const special = await createReviewContext(
      specialRoot,
      input(["Sample.cs"], [], ["."]),
    );
    const tampered = structuredClone(special);
    analysis(tampered).csharpBindings.omissions = analysis(
      tampered,
    ).csharpBindings.omissions.filter((value) => value !== omission);
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
  analysis(forged).csharpBindings.omissions = analysis(
    forged,
  ).csharpBindings.omissions.filter(
    (value) => value !== "outside-module-roots",
  );
  assert.throws(
    () => parseReviewContext(rebound(forged)),
    /omissions do not reconcile/,
  );
  const engine = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const id = (await engine.open(context)).workflowId;
    await writeFile(path.join(root, "src/policy/Policy.cs"), fixed);
    await engine.next(id);
    assert.equal(engine.status(id).status, "stale");
  } finally {
    engine.dispose();
  }
  const old = {
      "src/policy/Policy.cs": broken,
      "src/consumer/Consumer.cs": consumer,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await writeFile(path.join(revision, "src/policy/Policy.cs"), fixed);
  fixtureGit(revision, ["add", "--all"]);
  await writeFile(path.join(revision, "src/policy/Policy.cs"), near);
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
      captured.files.find((file) => file.path === "src/policy/Policy.cs")!
        .content,
      currentSource === "index" ? fixed : near,
    );
    assert.ok(
      value.calls
        .filter((call) => call.file === "src/consumer/Consumer.cs")
        .every(
          (call) =>
            call.targetFunctionId ===
            (call.revision === "base" ? before.id : after.id),
        ),
    );
  }
});
test("context-csharp empty acceptance", async (t) => {
  for (const source of [
    "",
    "// inert decision()\n",
    "class Broken{static bool (",
  ]) {
    const root = await fixture(t, { "Sample.cs": source }),
      value = analysis(
        await createReviewContext(root, input(["Sample.cs"], [], ["."])),
      );
    assert.equal(value.csharpBindings.state, "partial");
    assert.deepEqual(value.csharpBindings.callerEdges, []);
    assert.equal(value.csharpBindings.counts.resolvedCalls, 0);
  }
  const unresolved = await fixture(t, {
      "Sample.cs":
        "class Sample{static bool useit(){return Unknown.decision();}}",
    }),
    value = analysis(
      await createReviewContext(unresolved, input(["Sample.cs"], [], ["."])),
    );
  assert.equal(value.calls[0]!.targetFunctionId, null);
  assert.equal(value.csharpBindings.counts.unresolvedCalls, 1);
  const wide = await fixture(t, {
      "Sample.cs":
        "class Sample{" +
        Array.from({ length: 3000 }, (_, i) => "static int x" + i + "=1;").join(
          "",
        ) +
        "}",
    }),
    exhausted = analysis(
      await createReviewContext(wide, input(["Sample.cs"], [], ["."])),
    );
  assert.equal(exhausted.files[0]!.state, "budget-exhausted");
  assert.deepEqual(exhausted.csharpBindings.callerEdges, []);
  const chain =
      "class Sample{" +
      Array.from(
        { length: 10 },
        (_, i) =>
          "static bool f" +
          i +
          "(){return " +
          (i ? "f" + (i - 1) + "()" : "true") +
          ";}",
      ).join("") +
      "}",
    chains = await fixture(t, { "Sample.cs": chain }),
    links = analysis(
      await createReviewContext(chains, input(["Sample.cs"], [], ["."])),
    ),
    f0 = links.functions.find((fn) => fn.name === "f0")!;
  assert.equal(
    links.csharpBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === f0.id,
    ).length,
    8,
  );
  assert.ok(links.csharpBindings.omissions.includes("depth-limit"));
  const roots = Array.from({ length: 16 }, (_, i) => "root" + i),
    paths = roots.flatMap((root) => [root + "/First.cs", root + "/Second.cs"]),
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
test("context-csharp privacy acceptance", async (t) => {
  const selection = input(),
    root = await fixture(t, {
      "src/policy/Policy.cs": fixed,
      "src/consumer/Consumer.cs": consumer,
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
    assert.equal(result.stdout.includes("csharpBindings"), flags.length > 0);
    const client = new Client(
      { name: "original-csharp-context-host", version: "1" },
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
test("context-csharp lifecycle acceptance", native, async (t) => {
  const marker = "original-side-effect.txt",
    root = await fixture(t, {
      "Sample.cs":
        'class Sample{static Sample(){System.IO.File.WriteAllText("' +
        marker +
        '","executed");}static bool decision(){return true;}}',
    });
  const value = analysis(
    await createReviewContext(root, input(["Sample.cs"], [], ["."])),
  );
  assert.ok(value.functions.some((fn) => fn.name === "decision"));
  await assert.rejects(access(path.join(root, marker)), { code: "ENOENT" });
  const worker =
    'class Witness{static void Main(string[] args){if(args.Length==1&&args[0]=="child"){System.Threading.Thread.Sleep(60000);return;}var info=new System.Diagnostics.ProcessStartInfo("dotnet"){UseShellExecute=false};info.ArgumentList.Add(System.Reflection.Assembly.GetExecutingAssembly().Location);info.ArgumentList.Add("child");using var child=System.Diagnostics.Process.Start(info)!;var body="{\\"parent\\":"+System.Environment.ProcessId+",\\"child\\":"+child.Id+"}";System.IO.File.WriteAllText(args[0]+".pending",body);System.IO.File.Move(args[0]+".pending",args[0]);if(args[1]=="output"){System.Console.Write(new string(\'x\',1048576));System.Console.Out.Flush();}System.Threading.Thread.Sleep(60000);}}';
  const assembly = await compile(root, [], worker, "native-control"),
    command = (ready: string, mode: string) => ({
      executable: "dotnet",
      args: [assembly, ready, mode],
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
    const ready = path.join(root, mode + ".json"),
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
      assert.ok(identities, "Reached C# runtime parent and child");
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
        assert.equal(alive, false, "Reached C# process survived cleanup");
      }
      await assert.rejects(access(ready + ".pending"), { code: "ENOENT" });
    } finally {
      controller.abort();
      await execution;
    }
  }
  await rm(path.dirname(assembly), { recursive: true });
  await assert.rejects(access(assembly), { code: "ENOENT" });
  await assert.rejects(access(path.join(root, marker)), { code: "ENOENT" });
  const legacy = await createReviewContext(root, {
    schemaVersion: 14,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["Sample.cs"],
    supportFiles: [],
    moduleRoots: ["."],
    topics: [],
  });
  assert.equal(legacy.schemaVersion, 14);
  assert.equal(legacy.analysis.profile, "scala-selected-bindings-v1");
  assert.ok(
    legacy.analysis.calls.every((call) => call.targetFunctionId === null),
  );
});
test("context-csharp installed acceptance", native, async () => {
  if (process.env.CHECKTRAIL_CONTEXT_CSHARP_INSTALLED === "1") {
    const runtime = await realpath(
      fileURLToPath(
        new URL("../src/review-csharp-resolution.js", import.meta.url),
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
    CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "context-csharp",
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
