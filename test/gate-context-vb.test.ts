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
import { vbBoundariesFixture } from "./review-vb-boundaries-fixture.js";

const broken =
  'Namespace policy\nPublic Module Rules\nPublic Const FALLBACK As String="grant"\nPublic Function decision(value As String) As Boolean\nReturn value.StartsWith(FALLBACK)\nEnd Function\nEnd Module\nEnd Namespace\n';
const fixed =
  'Namespace policy\nPublic Module Rules\nPublic Const FALLBACK As String="grant"\nPublic Function decision(value As String) As Boolean\nIf value = FALLBACK OrElse value.StartsWith(FALLBACK & ":") Then\nReturn True\nEnd If\nReturn False\nEnd Function\nEnd Module\nEnd Namespace\n';
const near =
  'Namespace policy\nPublic Module Rules\nPublic Const FALLBACK As String="grant"\nPublic Function decision(value As String) As Boolean\nReturn value = "grant:read" OrElse value = "grant:write"\nEnd Function\nEnd Module\nEnd Namespace\n';
const consumer =
  'Imports P = policy.Rules\nImports N = policy\nImports policy.Rules\nNamespace consumer\nPublic Module Useit\nPublic Function submit() As Boolean\nReturn decision("grantToken")\nEnd Function\nPublic Function route() As Boolean\nReturn P.DECISION(FALLBACK)\nEnd Function\nPublic Function aliasCall() As Boolean\nReturn N.Rules.decision("grantToken")\nEnd Function\nEnd Module\nEnd Namespace\n';
const sdk = "/usr/share/dotnet/sdk/10.0.401/Roslyn/bincore/vbc.dll";
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
      : "Pinned native Visual Basic unavailable",
  timeout: 120000,
};
const input = (
  files = ["src/policy/Policy.vb"],
  supportFiles = ["src/consumer/Consumer.vb"],
  moduleRoots = ["src"],
) => ({
  schemaVersion: 19,
  track: "snapshot",
  currentSource: "working-tree",
  files,
  supportFiles,
  moduleRoots,
  topics: [],
});
function analysis(context: ReviewContext) {
  assert.equal(context.schemaVersion, 19);
  if (context.schemaVersion !== 19)
    throw Error("Original Visual Basic context required");
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
    "src/policy/Policy.vb": policy,
    "src/consumer/Consumer.vb": consumer,
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
      "-nostdlib",
      "-nosdkpath",
      "-optionstrict+",
      '-define:_MYTYPE="Empty"',
      "-vbruntime:" + path.join(refs, "Microsoft.VisualBasic.Core.dll"),
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
  await writeFile(path.join(root, "Witness.vb"), witness);
  const configured = await compilerArgs(root, [...files, "Witness.vb"], name);
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
    ["src/policy/Policy.vb", "src/consumer/Consumer.vb"],
    'Module Witness\nSub Main()\nFor Each value As String In New String(){"grant:read","grantToken","grant2","other"}\nSystem.Console.WriteLine(policy.Rules.decision(value))\nNext\nSystem.Console.WriteLine(consumer.Useit.submit())\nSystem.Console.WriteLine(consumer.Useit.route())\nSystem.Console.WriteLine(consumer.Useit.aliasCall())\nEnd Sub\nEnd Module\n',
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
    (fn) => fn.file === "src/policy/Policy.vb" && fn.name === "decision",
  )!;
  assert.ok(policy);
  const calls = result.calls.filter(
    (call) => call.file === "src/consumer/Consumer.vb",
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
    3,
  );

  assert.equal(
    result.vbBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === policy.id && edge.depth === 1,
    ).length,
    3,
  );
  assert.equal(
    result.vbBindings.counts.calls,
    result.vbBindings.counts.resolvedCalls +
      result.vbBindings.counts.unresolvedCalls,
  );
  assert.equal(
    result.vbBindings.counts.imports,
    result.vbBindings.counts.resolvedImports +
      result.vbBindings.counts.unresolvedImports,
  );
  assert.equal(result.vbBindings.fullImpactFallback, true);
  assert.equal(result.vbBindings.runtimeReachabilityVerified, false);
  assert.equal(result.vbBindings.nativeNameResolutionVerified, false);
  assert.equal(result.vbBindings.moduleLoadingVerified, false);
  assert.equal(result.vbBindings.validationPlanUnchanged, true);
}
test("context-vb broken acceptance", native, async (t) => {
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
    "Public Function decision(value As String) As Boolean\nReturn value.StartsWith(FALLBACK)\nEnd Function\n",
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
      "src/policy/Policy.vb": broken,
      "src/consumer/Consumer.vb": consumer,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await rename(
    path.join(revision, "src/consumer/Consumer.vb"),
    path.join(revision, "src/consumer/Moved.vb"),
  );
  await writeFile(
    path.join(revision, "src/consumer/Moved.vb"),
    'Imports P=policy.Rules\nNamespace consumer\nModule Moved\nFunction submit(P As Object) As Boolean\nReturn P("grantToken")\nEnd Function\nEnd Module\nEnd Namespace\n',
  );
  await writeFile(path.join(revision, "src/policy/Policy.vb"), fixed);
  const captured = await createReviewContext(revision, {
      ...input(undefined, [
        "src/consumer/Consumer.vb",
        "src/consumer/Moved.vb",
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
        call.file === "src/consumer/Consumer.vb" &&
        call.revision === "base" &&
        call.targetFunctionId === before.id,
    ).length,
    3,
  );
  assert.equal(
    value.calls.filter((call) => call.file === "src/consumer/Moved.vb").length,
    1,
  );
  assert.ok(
    value.calls
      .filter((call) => call.file === "src/consumer/Moved.vb")
      .every((call) => call.targetFunctionId === null),
  );
  assert.ok(
    value.vbBindings.callerEdges.some(
      (edge) => edge.revision === "base" && edge.targetFunctionId === before.id,
    ),
  );
});
test("context-vb fixed acceptance", native, async (t) => {
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
      (decision) => decision.file === "src/policy/Policy.vb",
    ),
  );
});
test("context-vb near-miss acceptance", native, async (t) => {
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
  await vbBoundariesFixture(t);
  for (const [source, call, expected] of [
    [
      "Namespace policy\nPublic Module Rules\nPublic Function typename() As String\nReturn GetType(Rules).FullName\nEnd Function\nEnd Module\nEnd Namespace\n",
      "policy.Rules.typename()",
      "policy.Rules\n",
    ],
    [
      "Module Rules\nPublic Const LIMIT As Integer=2\nPublic Function decision(Optional LIMIT As Integer=LIMIT) As Integer\nReturn LIMIT\nEnd Function\nEnd Module\n",
      "Rules.decision()",
      "2\n",
    ],
    [
      "Namespace policy\nPublic Module Rules\nPublic Function decision() As Boolean\nReturn True\nEnd Function\nEnd Module\nPublic Module Useit\nPublic Function submit() As Boolean\nReturn DECISION()\nEnd Function\nEnd Module\nEnd Namespace\n",
      "policy.Useit.submit()",
      "True\n",
    ],
  ] as const) {
    const selected = await fixture(t, { "Sample.vb": source });
    const asm = await compile(
      selected,
      ["Sample.vb"],
      "Module Witness\nSub Main()\nSystem.Console.WriteLine(" +
        call +
        ")\nEnd Sub\nEnd Module\n",
    );
    assert.equal(await execute(selected, asm), expected);
  }
  const invalid = await fixture(t, {
    "Sample.vb":
      "Module Rules\nFunction decision() As Boolean\nReturn True\nEnd Function\nFunction submit() As Boolean\nDim value As Boolean=decision()\nDim decision As System.Func(Of Boolean)=Function() False\nReturn value\nEnd Function\nEnd Module\n",
  });
  await writeFile(
    path.join(invalid, "Witness.vb"),
    "Module Witness\nSub Main()\nEnd Sub\nEnd Module\n",
  );
  const config = await compilerArgs(
    invalid,
    ["Sample.vb", "Witness.vb"],
    "masked-native",
  );
  const rejected = await runProcess(
    invalid,
    { executable: "dotnet", args: config.args, cwd: "." },
    { timeoutMs: 30000 },
  );
  assert.equal(rejected.exitCode, 1);
  assert.equal(rejected.errorCode, undefined);
  assert.match(rejected.stdout, /BC32000/);
});

test("context-vb prerequisite acceptance", async (t) => {
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
  assert.equal(outside.vbBindings.state, "partial");
  assert.ok(outside.vbBindings.omissions.includes("outside-module-roots"));
  assert.ok(outside.calls.every((call) => call.targetFunctionId === null));
  const unsupported = await fixture(t, {
    "unknown.vbs": "Module Original\nEnd Module\n",
  });
  assert.equal(
    analysis(
      await createReviewContext(unsupported, input(["unknown.vbs"], [], ["."])),
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
      path: "Sample.vb",
      content:
        "Module Sample\nFunction decision() As Boolean\nReturn True\nEnd Function\nEnd Module\n",
      sha256: hash(
        "Module Sample\nFunction decision() As Boolean\nReturn True\nEnd Function\nEnd Module\n",
      ),
    };
  const missing = await isolated.collectReviewVbBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(missing.files[0]!.state, "error");
  assert.deepEqual(missing.functions, []);
  assert.equal(missing.vbBindings.state, "partial");
  await mkdir(path.join(copied, "assets/context-vb-grammar"), {
    recursive: true,
  });
  const bytes = await readFile(
      path.join(
        await realpath(path.join(repository, "dist/src")),
        "../../assets/context-vb-grammar/tree-sitter-vbnet.wasm",
      ),
    ),
    altered = Buffer.from(bytes),
    position = altered.indexOf(Buffer.from("tree_sitter_vbnet"));
  assert.notEqual(position, -1);
  altered[position + "tree_sitter_vbne".length] = "s".charCodeAt(0);
  assert.doesNotThrow(() => new WebAssembly.Module(altered));
  const asset = path.join(
    copied,
    "assets/context-vb-grammar/tree-sitter-vbnet.wasm",
  );
  await writeFile(asset, altered);
  const changed = await isolated.collectReviewVbBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(changed.files[0]!.state, "error");
  assert.deepEqual(changed.calls, []);
  await writeFile(asset, bytes);
  const restored = await isolated.collectReviewVbBehavior(
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
      executable: path.join(root, "missing-original-vb"),
      args: ["--version"],
      cwd: ".",
    },
    { timeoutMs: 1000 },
  );
  assert.equal(missingNative.errorCode, "ENOENT");
  assert.notEqual(missingNative.exitCode, 0);
});
test("context-vb stale acceptance", async (t) => {
  const { root, context } = await original(t);
  for (const [mutate, message] of [
    [
      (value: ReturnType<typeof analysis>) => {
        value.vbBindings.moduleRoots = ["elsewhere"];
      },
      /module roots differ/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.vbBindings.counts.resolvedCalls++;
      },
      /counts do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.vbBindings.callerEdges = [];
      },
      /closure does not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.vbBindings.omissions = [];
      },
      /omissions do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.vbBindings.state = "collected";
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
      "#If FEATURE Then\nModule Sample\nFunction decision() As Boolean\nReturn True\nEnd Function\nEnd Module\n#End If\n",
      "conditional-source-unknown",
    ],
    [
      "Option Strict Off\nModule Sample\nFunction decision() As Boolean\nReturn True\nEnd Function\nEnd Module\n",
      "compiler-options-unknown",
    ],
  ] as const) {
    const specialRoot = await fixture(t, { "Sample.vb": source });
    const special = await createReviewContext(
      specialRoot,
      input(["Sample.vb"], [], ["."]),
    );
    const tampered = structuredClone(special);
    analysis(tampered).vbBindings.omissions = analysis(
      tampered,
    ).vbBindings.omissions.filter((value) => value !== omission);
    assert.throws(
      () => parseReviewContext(rebound(tampered)),
      /omissions do not reconcile/,
    );
  }
  const identity = structuredClone(context);
  analysis(identity).vbGrammarManifestDigest = "0".repeat(64);
  assert.throws(
    () => parseReviewContext(rebound(identity)),
    /behavior anchors/,
  );
  const outside = await createReviewContext(
      root,
      input(undefined, undefined, ["elsewhere"]),
    ),
    forged = structuredClone(outside);
  analysis(forged).vbBindings.omissions = analysis(
    forged,
  ).vbBindings.omissions.filter((value) => value !== "outside-module-roots");
  assert.throws(
    () => parseReviewContext(rebound(forged)),
    /omissions do not reconcile/,
  );
  const engine = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const id = (await engine.open(context)).workflowId;
    await writeFile(path.join(root, "src/policy/Policy.vb"), fixed);
    await engine.next(id);
    assert.equal(engine.status(id).status, "stale");
  } finally {
    engine.dispose();
  }
  const conditionalFiles = {
      "src/policy/Policy.vb": "#If ORIGINAL Then\n" + broken + "#End If\n",
      "src/consumer/Consumer.vb": consumer,
    },
    conditionalRoot = await fixture(t, conditionalFiles);
  fixtureGit(conditionalRoot, ["init", "--quiet"]);
  const conditionalBase = await syntheticCommit(
    conditionalRoot,
    conditionalFiles,
  );
  await writeFile(path.join(conditionalRoot, "src/policy/Policy.vb"), fixed);
  const conditional = await createReviewContext(conditionalRoot, {
    ...input(),
    track: "diff",
    baseCommit: conditionalBase,
  });
  assert.ok(
    analysis(conditional).vbBindings.omissions.includes(
      "conditional-source-unknown",
    ),
  );
  const erasedBase = structuredClone(conditional);
  analysis(erasedBase).vbBindings.omissions = analysis(
    erasedBase,
  ).vbBindings.omissions.filter(
    (value) => value !== "conditional-source-unknown",
  );
  assert.throws(
    () => parseReviewContext(rebound(erasedBase)),
    /omissions do not reconcile/,
  );
  const old = {
      "src/policy/Policy.vb": broken,
      "src/consumer/Consumer.vb": consumer,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await writeFile(path.join(revision, "src/policy/Policy.vb"), fixed);
  fixtureGit(revision, ["add", "--all"]);
  await writeFile(path.join(revision, "src/policy/Policy.vb"), near);
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
      captured.files.find((file) => file.path === "src/policy/Policy.vb")!
        .content,
      currentSource === "index" ? fixed : near,
    );
    assert.ok(
      value.calls
        .filter((call) => call.file === "src/consumer/Consumer.vb")
        .every(
          (call) =>
            call.targetFunctionId ===
            (call.revision === "base" ? before.id : after.id),
        ),
    );
  }
});
test("context-vb empty acceptance", async (t) => {
  for (const source of [
    "",
    "' inert decision()\n",
    "Module Broken\nFunction (",
  ]) {
    const root = await fixture(t, { "Sample.vb": source }),
      value = analysis(
        await createReviewContext(root, input(["Sample.vb"], [], ["."])),
      );
    assert.equal(value.vbBindings.state, "partial");
    assert.deepEqual(value.vbBindings.callerEdges, []);
    assert.equal(value.vbBindings.counts.resolvedCalls, 0);
  }
  const unresolved = await fixture(t, {
      "Sample.vb":
        "Module Sample\nFunction useit() As Boolean\nReturn Unknown.decision()\nEnd Function\nEnd Module\n",
    }),
    value = analysis(
      await createReviewContext(unresolved, input(["Sample.vb"], [], ["."])),
    );
  assert.equal(value.calls[0]!.targetFunctionId, null);
  assert.equal(value.vbBindings.counts.unresolvedCalls, 1);
  const wide = await fixture(t, {
      "Sample.vb":
        "Module Sample\n" +
        Array.from({ length: 3000 }, (_, i) => "Const x" + i + "=1\n").join(
          "",
        ) +
        "End Module\n",
    }),
    exhausted = analysis(
      await createReviewContext(wide, input(["Sample.vb"], [], ["."])),
    );
  assert.equal(exhausted.files[0]!.state, "budget-exhausted");
  assert.deepEqual(exhausted.vbBindings.callerEdges, []);
  const chain =
      "Module Sample\n" +
      Array.from(
        { length: 10 },
        (_, i) =>
          "Function f" +
          i +
          "() As Boolean\nReturn " +
          (i ? "f" + (i - 1) + "()" : "True") +
          "\nEnd Function\n",
      ).join("") +
      "End Module\n",
    chains = await fixture(t, { "Sample.vb": chain }),
    links = analysis(
      await createReviewContext(chains, input(["Sample.vb"], [], ["."])),
    ),
    f0 = links.functions.find((fn) => fn.name === "f0")!;
  assert.equal(
    links.vbBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === f0.id,
    ).length,
    8,
  );
  assert.ok(links.vbBindings.omissions.includes("depth-limit"));
  const roots = Array.from({ length: 16 }, (_, i) => "root" + i),
    paths = roots.flatMap((root) => [root + "/First.vb", root + "/Second.vb"]),
    text = "'" + " ".repeat(32766) + "\n";
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
test("context-vb privacy acceptance", async (t) => {
  const selection = input(),
    root = await fixture(t, {
      "src/policy/Policy.vb": fixed,
      "src/consumer/Consumer.vb": consumer,
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
    assert.equal(result.stdout.includes("vbBindings"), flags.length > 0);
    const client = new Client(
      { name: "original-vb-context-host", version: "1" },
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
test("context-vb lifecycle acceptance", native, async (t) => {
  const marker = "original-side-effect.txt",
    root = await fixture(t, {
      "Sample.vb":
        'Module Sample\nDim value As String=initialize()\nFunction initialize() As String\nSystem.IO.File.WriteAllText("original-side-effect.txt","executed")\nReturn "ready"\nEnd Function\nFunction decision() As Boolean\nReturn True\nEnd Function\nEnd Module\n',
    });
  const value = analysis(
    await createReviewContext(root, input(["Sample.vb"], [], ["."])),
  );
  assert.ok(value.functions.some((fn) => fn.name === "decision"));
  await assert.rejects(access(path.join(root, marker)), { code: "ENOENT" });
  const worker =
    'Module Witness\nSub Main(args As String())\nIf args.Length=1 AndAlso args(0)="child" Then\nSystem.Threading.Thread.Sleep(60000)\nReturn\nEnd If\nDim info As New System.Diagnostics.ProcessStartInfo("dotnet")\ninfo.UseShellExecute=False\ninfo.ArgumentList.Add(System.Reflection.Assembly.GetExecutingAssembly().Location)\ninfo.ArgumentList.Add("child")\nUsing child As System.Diagnostics.Process=System.Diagnostics.Process.Start(info)\nDim body As String="{""parent"":" & System.Environment.ProcessId & ",""child"":" & child.Id & "}"\nSystem.IO.File.WriteAllText(args(0) & ".pending",body)\nSystem.IO.File.Move(args(0) & ".pending",args(0))\nIf args(1)="output" Then\nSystem.Console.Write(New String("x"c,1048576))\nSystem.Console.Out.Flush()\nEnd If\nSystem.Threading.Thread.Sleep(60000)\nEnd Using\nEnd Sub\nEnd Module\n';
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
      assert.ok(identities, "Reached Visual Basic runtime parent and child");
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
        assert.equal(
          alive,
          false,
          "Reached Visual Basic process survived cleanup",
        );
      }
      await assert.rejects(access(ready + ".pending"), { code: "ENOENT" });
      await rm(ready);
      await assert.rejects(access(ready), { code: "ENOENT" });
    } finally {
      controller.abort();
      await execution;
    }
  }
  await rm(path.dirname(assembly), { recursive: true });
  await rm(path.join(root, "Witness.vb"));
  await assert.rejects(access(assembly), { code: "ENOENT" });
  await assert.rejects(access(path.join(root, marker)), { code: "ENOENT" });
  const legacy = await createReviewContext(root, {
    schemaVersion: 17,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["Sample.vb"],
    supportFiles: [],
    moduleRoots: ["."],
    topics: [],
  });
  assert.equal(legacy.schemaVersion, 17);
  assert.equal(legacy.analysis.profile, "ruby-selected-bindings-v1");
  assert.ok(
    legacy.analysis.calls.every((call) => call.targetFunctionId === null),
  );
});
test("context-vb installed acceptance", native, async () => {
  if (process.env.CHECKTRAIL_CONTEXT_VB_INSTALLED === "1") {
    const runtime = await realpath(
      fileURLToPath(new URL("../src/review-vb-resolution.js", import.meta.url)),
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
    CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "context-vb",
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
