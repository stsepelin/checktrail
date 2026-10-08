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
import { fsharpBoundariesFixture } from "./review-fsharp-boundaries-fixture.js";

const broken =
  'module Policy\nlet FALLBACK = "grant"\nlet decision (value: string) = value.StartsWith FALLBACK\n';
const fixed =
  'module Policy\nlet FALLBACK = "grant"\nlet decision (value: string) = value = FALLBACK || value.StartsWith (FALLBACK + ":")\n';
const near =
  'module Policy\nlet FALLBACK = "grant"\nlet decision (value: string) = value = "grant:read" || value = "grant:write"\n';
const consumer =
  'module Consumer\nopen Policy\nmodule P = Policy\nlet submit () = decision "grantToken"\nlet route () = P.decision FALLBACK\nlet alias () = Policy.decision "grantToken"\n';
const sdk = "/usr/share/dotnet/sdk/10.0.401/FSharp/fsc.dll";
const coreLibrary = "/usr/share/dotnet/sdk/10.0.401/FSharp/FSharp.Core.dll";
const refs =
  "/usr/share/dotnet/packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0";
const compilerVersion =
  "Microsoft (R) F# Compiler version 15.2.401.0 for F# 10.0";
const native = {
  skip:
    spawnSync("dotnet", [sdk, "--version"], {
      encoding: "utf8",
    }).stdout?.trim() === compilerVersion
      ? false
      : "Pinned native F# unavailable",
  timeout: 120000,
};
const input = (
  files = ["src/policy/Policy.fs"],
  supportFiles = ["src/consumer/Consumer.fs"],
  moduleRoots = ["src"],
) => ({
  schemaVersion: 16,
  track: "snapshot",
  currentSource: "working-tree",
  files,
  supportFiles,
  moduleRoots,
  topics: [],
});
function analysis(context: ReviewContext) {
  assert.equal(context.schemaVersion, 16);
  if (context.schemaVersion !== 16) throw Error("Original F# context required");
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
    "src/policy/Policy.fs": policy,
    "src/consumer/Consumer.fs": consumer,
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
  await cp(coreLibrary, path.join(destination, "FSharp.Core.dll"));
  return {
    destination,
    assembly,
    args: [
      sdk,
      "--nocopyfsharpcore",
      "--noframework",
      "--targetprofile:netcore",
      "--simpleresolution",
      "--target:exe",
      "--out:" + assembly,
      ...libraries.map((value) => "--reference:" + path.join(refs, value)),
      "--reference:" + coreLibrary,
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
  await writeFile(path.join(root, "Witness.fs"), witness);
  const configured = await compilerArgs(root, [...files, "Witness.fs"], name);
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
    ["src/policy/Policy.fs", "src/consumer/Consumer.fs"],
    'module Witness\n[<EntryPoint>]\nlet main _ =\n  ["grant:read";"grantToken";"grant2";"other"] |> List.iter (fun value -> printfn "%b" (Policy.decision value))\n  printfn "%b" (Consumer.submit ())\n  printfn "%b" (Consumer.route ())\n  printfn "%b" (Consumer.alias ())\n  0\n',
  );
  return (await execute(root, assembly))
    .trim()
    .split("\n")
    .map((value) => {
      assert.ok(value === "true" || value === "false");
      return value === "true";
    });
}
function bindings(result: ReturnType<typeof analysis>) {
  const policy = result.functions.find(
    (fn) => fn.file === "src/policy/Policy.fs" && fn.name === "decision",
  )!;
  assert.ok(policy);
  const calls = result.calls.filter(
    (call) => call.file === "src/consumer/Consumer.fs",
  );
  assert.equal(calls.length, 3);
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
    result.fsharpBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === policy.id && edge.depth === 1,
    ).length,
    3,
  );
  assert.equal(
    result.fsharpBindings.counts.calls,
    result.fsharpBindings.counts.resolvedCalls +
      result.fsharpBindings.counts.unresolvedCalls,
  );
  assert.equal(
    result.fsharpBindings.counts.imports,
    result.fsharpBindings.counts.resolvedImports +
      result.fsharpBindings.counts.unresolvedImports,
  );
  assert.equal(result.fsharpBindings.fullImpactFallback, true);
  assert.equal(result.fsharpBindings.runtimeReachabilityVerified, false);
  assert.equal(result.fsharpBindings.nativeNameResolutionVerified, false);
  assert.equal(result.fsharpBindings.moduleLoadingVerified, false);
  assert.equal(result.fsharpBindings.validationPlanUnchanged, true);
}
test("context-fsharp broken acceptance", native, async (t) => {
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
    "let decision (value: string) = value.StartsWith FALLBACK",
  );
  const constant = result.declarations.find(
    (value) => value.name === "FALLBACK" && value.kind === "variable",
  )!;
  assert.ok(constant);
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
      "src/policy/Policy.fs": broken,
      "src/consumer/Consumer.fs": consumer,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await rename(
    path.join(revision, "src/consumer/Consumer.fs"),
    path.join(revision, "src/consumer/Moved.fs"),
  );
  await writeFile(
    path.join(revision, "src/consumer/Moved.fs"),
    'module Moved\nlet submit P = P "grantToken"\n',
  );
  await writeFile(path.join(revision, "src/policy/Policy.fs"), fixed);
  const captured = await createReviewContext(revision, {
      ...input(undefined, [
        "src/consumer/Consumer.fs",
        "src/consumer/Moved.fs",
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
        call.file === "src/consumer/Consumer.fs" &&
        call.revision === "base" &&
        call.targetFunctionId === before.id,
    ).length,
    3,
  );
  assert.ok(
    value.calls
      .filter((call) => call.file === "src/consumer/Moved.fs")
      .every((call) => call.targetFunctionId === null),
  );
  assert.ok(
    value.fsharpBindings.callerEdges.some(
      (edge) => edge.revision === "base" && edge.targetFunctionId === before.id,
    ),
  );
});
test("context-fsharp fixed acceptance", native, async (t) => {
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
      (decision) => decision.file === "src/policy/Policy.fs",
    ),
  );
});
test("context-fsharp near-miss acceptance", native, async (t) => {
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
  await fsharpBoundariesFixture(t);
  const selected = await fixture(t, {
    "Policy.fs": "module Policy\nlet LIMIT = 2\nlet decision () = true\n",
    "Other.fs": "module Other\nlet decision () = false\n",
    "Sample.fs":
      "module Sample\nlet decision () = false\nopen Policy\nlet own_before () = decision ()\nopen Other\nlet later_open () = decision ()\nlet local () =\n  let before () = decision ()\n  let decision () = true\n  before ()\nlet param decision = decision ()\nlet initializer () =\n  let LIMIT = LIMIT\n  LIMIT\nmodule P = Policy\nlet alias () = P.decision ()\nlet typed (value: string) = P.decision ()\n",
  });
  const assembly = await compile(
    selected,
    ["Policy.fs", "Other.fs", "Sample.fs"],
    'module Witness\n[<EntryPoint>]\nlet main _ =\n  printfn "%b" (Sample.own_before ())\n  printfn "%b" (Sample.later_open ())\n  printfn "%b" (Sample.local ())\n  printfn "%b" (Sample.param (fun () -> true))\n  printfn "%d" (Sample.initializer ())\n  printfn "%b" (Sample.alias ())\n  printfn "%b" (Sample.typed "original")\n  0\n',
  );
  assert.equal(
    await execute(selected, assembly),
    "true\nfalse\nfalse\ntrue\n2\ntrue\ntrue\n",
  );
  for (const source of [
    "module Sample\nlet decision () = true\nlet useit () = Sample.decision ()\n",
    "module Sample\nlet decision () = true\nmodule P = Sample\nlet useit () = P.decision ()\n",
    "module Container.Sample\nlet decision () = true\nlet useit () = Container.Sample.decision ()\n",
  ]) {
    const rejectedRoot = await fixture(t, { "Sample.fs": source });
    const configured = await compilerArgs(
      rejectedRoot,
      ["Sample.fs"],
      "rejected-self-module",
    );
    const rejected = await runProcess(
      rejectedRoot,
      { executable: "dotnet", args: configured.args, cwd: "." },
      { timeoutMs: 30000, maxOutputBytes: 65536 },
    );
    assert.equal(rejected.errorCode, undefined);
    assert.equal(rejected.exitCode, 1);
    assert.equal(rejected.timedOut, false);
    assert.equal(rejected.cancelled, false);
    assert.equal(rejected.truncated, false);
    assert.match(rejected.stderr, /FS0039/);
  }
  const mutableRoot = await fixture(t, {
    "Sample.fs":
      "module Sample\nlet mutable private LIMIT = 2\nlet useit () = LIMIT\n",
  });
  const mutableAssembly = await compile(
    mutableRoot,
    ["Sample.fs"],
    'module Witness\n[<EntryPoint>]\nlet main _ =\n  printfn "%d" (Sample.useit ())\n  0\n',
  );
  assert.equal(await execute(mutableRoot, mutableAssembly), "2\n");
  const recursiveRoot = await fixture(t, {
    "Recursive.fs":
      "module Recursive\nopen Shadow\nlet rec first value = if value <= 0 then true else second (value - 1)\nand second value = first value\n",
    "Shadow.fs": "module Shadow\nlet first value = false\n",
  });
  const recursiveAssembly = await compile(
    recursiveRoot,
    ["Shadow.fs", "Recursive.fs"],
    'module Witness\n[<EntryPoint>]\nlet main _ =\n  printfn "%b" (Recursive.first 4)\n  0\n',
  );
  assert.equal(await execute(recursiveRoot, recursiveAssembly), "true\n");
});
test("context-fsharp prerequisite acceptance", async (t) => {
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
  assert.equal(outside.fsharpBindings.state, "partial");
  assert.ok(outside.fsharpBindings.omissions.includes("outside-module-roots"));
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
      path: "Sample.fs",
      content: "module Sample\nlet decision () = true\n",
      sha256: hash("module Sample\nlet decision () = true\n"),
    };
  const missing = await isolated.collectReviewFsharpBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(missing.files[0]!.state, "error");
  assert.deepEqual(missing.functions, []);
  assert.equal(missing.fsharpBindings.state, "partial");
  await mkdir(path.join(copied, "assets/context-grammars"), {
    recursive: true,
  });
  const bytes = await readFile(
      path.join(
        await realpath(path.join(repository, "dist/src")),
        "../../assets/context-grammars/tree-sitter-fsharp.wasm",
      ),
    ),
    altered = Buffer.from(bytes),
    position = altered.indexOf(Buffer.from("tree_sitter_fsharp"));
  assert.notEqual(position, -1);
  altered[position + "tree_sitter_fshar".length] = "q".charCodeAt(0);
  assert.doesNotThrow(() => new WebAssembly.Module(altered));
  const asset = path.join(
    copied,
    "assets/context-grammars/tree-sitter-fsharp.wasm",
  );
  await writeFile(asset, altered);
  const changed = await isolated.collectReviewFsharpBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(changed.files[0]!.state, "error");
  assert.deepEqual(changed.calls, []);
  await writeFile(asset, bytes);
  const restored = await isolated.collectReviewFsharpBehavior(
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
      executable: path.join(root, "missing-original-fsharp"),
      args: ["--version"],
      cwd: ".",
    },
    { timeoutMs: 1000 },
  );
  assert.equal(missingNative.errorCode, "ENOENT");
  assert.notEqual(missingNative.exitCode, 0);
});
test("context-fsharp stale acceptance", async (t) => {
  const { root, context } = await original(t);
  for (const [mutate, message] of [
    [
      (value: ReturnType<typeof analysis>) => {
        value.fsharpBindings.moduleRoots = ["elsewhere"];
      },
      /module roots differ/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.fsharpBindings.counts.resolvedCalls++;
      },
      /counts do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.fsharpBindings.callerEdges = [];
      },
      /closure does not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.fsharpBindings.omissions = [];
      },
      /omissions do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.fsharpBindings.state = "collected";
      },
      /omissions do not reconcile/,
    ],
  ] as const) {
    const forged = structuredClone(context);
    mutate(analysis(forged));
    assert.throws(() => parseReviewContext(rebound(forged)), message);
  }
  for (const [name, source, omission] of [
    [
      "Sample.fs",
      "module Sample\n[<Unknown>]\nlet decision () = true\n",
      "attributes-unknown",
    ],
    [
      "Sample.fsx",
      "module Sample\nlet decision () = true\n",
      "script-source-unknown",
    ],
    [
      "Sample.fsi",
      "module Sample\nval decision: unit -> bool\n",
      "signature-source-unknown",
    ],
    [
      "Sample.fs",
      "module Sample\n#if FEATURE\nlet decision () = true\n#endif\n",
      "conditional-source-unknown",
    ],
  ] as const) {
    const specialRoot = await fixture(t, { [name]: source });
    const special = await createReviewContext(
      specialRoot,
      input([name], [], ["."]),
    );
    const tampered = structuredClone(special);
    analysis(tampered).fsharpBindings.omissions = analysis(
      tampered,
    ).fsharpBindings.omissions.filter((value) => value !== omission);
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
  analysis(forged).fsharpBindings.omissions = analysis(
    forged,
  ).fsharpBindings.omissions.filter(
    (value) => value !== "outside-module-roots",
  );
  assert.throws(
    () => parseReviewContext(rebound(forged)),
    /omissions do not reconcile/,
  );
  const engine = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const id = (await engine.open(context)).workflowId;
    await writeFile(path.join(root, "src/policy/Policy.fs"), fixed);
    await engine.next(id);
    assert.equal(engine.status(id).status, "stale");
  } finally {
    engine.dispose();
  }
  const conditionalFiles = {
    "src/policy/Policy.fs":
      "module Policy\n#if FEATURE\nlet decision () = true\n#endif\n",
    "src/consumer/Consumer.fs": consumer,
  };
  const conditionalRoot = await fixture(t, conditionalFiles);
  fixtureGit(conditionalRoot, ["init", "--quiet"]);
  const conditionalBase = await syntheticCommit(
    conditionalRoot,
    conditionalFiles,
  );
  await writeFile(path.join(conditionalRoot, "src/policy/Policy.fs"), fixed);
  const conditionalDiff = await createReviewContext(conditionalRoot, {
    ...input(),
    track: "diff",
    baseCommit: conditionalBase,
  });
  assert.ok(
    analysis(conditionalDiff).fsharpBindings.omissions.includes(
      "conditional-source-unknown",
    ),
  );
  const erasedBase = structuredClone(conditionalDiff);
  analysis(erasedBase).fsharpBindings.omissions = analysis(
    erasedBase,
  ).fsharpBindings.omissions.filter(
    (value) => value !== "conditional-source-unknown",
  );
  assert.throws(
    () => parseReviewContext(rebound(erasedBase)),
    /omissions do not reconcile/,
  );
  const old = {
      "src/policy/Policy.fs": broken,
      "src/consumer/Consumer.fs": consumer,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await writeFile(path.join(revision, "src/policy/Policy.fs"), fixed);
  fixtureGit(revision, ["add", "--all"]);
  await writeFile(path.join(revision, "src/policy/Policy.fs"), near);
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
      captured.files.find((file) => file.path === "src/policy/Policy.fs")!
        .content,
      currentSource === "index" ? fixed : near,
    );
    assert.ok(
      value.calls
        .filter((call) => call.file === "src/consumer/Consumer.fs")
        .every(
          (call) =>
            call.targetFunctionId ===
            (call.revision === "base" ? before.id : after.id),
        ),
    );
  }
});
test("context-fsharp empty acceptance", async (t) => {
  for (const source of [
    "",
    "// inert decision()\n",
    "module Broken\nlet broken (",
  ]) {
    const root = await fixture(t, { "Sample.fs": source }),
      value = analysis(
        await createReviewContext(root, input(["Sample.fs"], [], ["."])),
      );
    assert.equal(value.fsharpBindings.state, "partial");
    assert.deepEqual(value.fsharpBindings.callerEdges, []);
    assert.equal(value.fsharpBindings.counts.resolvedCalls, 0);
  }
  const unresolved = await fixture(t, {
      "Sample.fs": "module Sample\nlet useit () = Unknown.decision ()\n",
    }),
    value = analysis(
      await createReviewContext(unresolved, input(["Sample.fs"], [], ["."])),
    );
  assert.equal(value.calls[0]!.targetFunctionId, null);
  assert.equal(value.fsharpBindings.counts.unresolvedCalls, 1);
  const wide = await fixture(t, {
    "Sample.fs":
      "module Sample\n" +
      Array.from({ length: 3000 }, (_, i) => "let x" + i + " = 1\n").join(""),
  });
  const exhausted = analysis(
    await createReviewContext(wide, input(["Sample.fs"], [], ["."])),
  );
  assert.equal(exhausted.files[0]!.state, "budget-exhausted");
  assert.deepEqual(exhausted.fsharpBindings.callerEdges, []);
  const chain =
      "module Sample\n" +
      Array.from(
        { length: 10 },
        (_, i) =>
          "let f" + i + " () = " + (i ? "f" + (i - 1) + " ()" : "true") + "\n",
      ).join(""),
    chains = await fixture(t, { "Sample.fs": chain }),
    links = analysis(
      await createReviewContext(chains, input(["Sample.fs"], [], ["."])),
    ),
    f0 = links.functions.find((fn) => fn.name === "f0")!;
  assert.ok(f0);
  assert.equal(
    links.fsharpBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === f0.id,
    ).length,
    8,
  );
  assert.ok(links.fsharpBindings.omissions.includes("depth-limit"));
  const roots = Array.from({ length: 16 }, (_, i) => "root" + i),
    paths = roots.flatMap((root) => [root + "/First.fs", root + "/Second.fs"]),
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
test("context-fsharp privacy acceptance", async (t) => {
  const selection = input(),
    root = await fixture(t, {
      "src/policy/Policy.fs": fixed,
      "src/consumer/Consumer.fs": consumer,
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
    assert.equal(result.stdout.includes("fsharpBindings"), flags.length > 0);
    const client = new Client(
      { name: "original-fsharp-context-host", version: "1" },
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
test("context-fsharp lifecycle acceptance", native, async (t) => {
  const marker = "original-side-effect.txt",
    root = await fixture(t, {
      "Sample.fs":
        'module Sample\nlet sideEffect = System.IO.File.WriteAllText("' +
        marker +
        '","executed")\nlet decision () = true\n',
    });
  const value = analysis(
    await createReviewContext(root, input(["Sample.fs"], [], ["."])),
  );
  assert.ok(value.functions.some((fn) => fn.name === "decision"));
  await assert.rejects(access(path.join(root, marker)), { code: "ENOENT" });
  const worker = `module Witness
open System
open System.Diagnostics
open System.IO
open System.Reflection
open System.Threading
[<EntryPoint>]
let main (args: string[]) =
  if args.Length = 1 && args[0] = "child" then
    Thread.Sleep 60000
  else
    let info = ProcessStartInfo("dotnet", UseShellExecute = false)
    info.ArgumentList.Add(Assembly.GetExecutingAssembly().Location)
    info.ArgumentList.Add("child")
    use child = Process.Start(info)
    let body = sprintf "{\\"parent\\":%d,\\"child\\":%d}" Environment.ProcessId child.Id
    File.WriteAllText(args[0]+".pending",body)
    File.Move(args[0]+".pending",args[0])
    if args[1] = "output" then
      Console.Write(String('x',1048576))
      Console.Out.Flush()
    Thread.Sleep 60000
  0
`;
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
      assert.ok(identities, "Reached F# runtime parent and child");
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
        assert.equal(alive, false, "Reached F# process survived cleanup");
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
    schemaVersion: 15,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["Sample.fs"],
    supportFiles: [],
    moduleRoots: ["."],
    topics: [],
  });
  assert.equal(legacy.schemaVersion, 15);
  assert.equal(legacy.analysis.profile, "csharp-selected-bindings-v1");
  assert.ok(
    legacy.analysis.calls.every((call) => call.targetFunctionId === null),
  );
});
test("context-fsharp installed acceptance", native, async () => {
  if (process.env.CHECKTRAIL_CONTEXT_FSHARP_INSTALLED === "1") {
    const runtime = await realpath(
      fileURLToPath(
        new URL("../src/review-fsharp-resolution.js", import.meta.url),
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
    CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "context-fsharp",
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
