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
const broken =
  "<?php\nnamespace Rules;\nconst FALLBACK = 'grant';\nfunction Decision(string $value = FALLBACK): bool { return str_starts_with($value, FALLBACK); }\n";
const fixed =
  "<?php\nnamespace Rules;\nconst FALLBACK = 'grant';\nfunction Decision(string $value = FALLBACK): bool { return $value === FALLBACK || str_starts_with($value, FALLBACK . ':'); }\n";
const near =
  "<?php\nnamespace Rules;\nfunction Decision(string $value = 'grant'): bool { return $value === 'grant:read' || $value === 'grant:write'; }\n";
const consumer =
  "<?php\nnamespace Consumer;\nuse function Rules\\Decision as choose;\nuse Rules as P;\nuse const Rules\\FALLBACK as DEFAULT_VALUE;\nrequire_once __DIR__ . '/../policy/policy.php';\nfunction Submit($choose = DEFAULT_VALUE) { return choose('grantToken'); }\nfunction Route() { return P\\Decision('grant:read'); }\n";
const native = {
  skip:
    spawnSync("php", ["--version"], { encoding: "utf8" }).status === 0
      ? false
      : "Native PHP unavailable",
  timeout: 120000,
};
const input = (
  files = ["policy/policy.php"],
  supportFiles = ["consumer/consumer.php"],
  moduleRoots = ["."],
) => ({
  schemaVersion: 10,
  track: "snapshot",
  currentSource: "working-tree",
  files,
  supportFiles,
  topics: [],
  moduleRoots,
});
function analysis(context: ReviewContext) {
  assert.equal(context.schemaVersion, 10);
  if (context.schemaVersion !== 10) throw Error("Original version 10 required");
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
    "policy/policy.php": policy,
    "consumer/consumer.php": consumer,
    ".checktrail/keep": "",
  });
  const context = await createReviewContext(root, input());
  return { root, context, result: analysis(context) };
}
async function php(root: string, code: string) {
  const result = await runProcess(
    root,
    { executable: "php", args: ["-r", code], cwd: "." },
    { timeoutMs: 10000, maxOutputBytes: 65536 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.errorCode, undefined);
  assert.equal(result.cancelled, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}
async function witness(root: string) {
  return php(
    root,
    "require 'policy/policy.php'; echo json_encode(array_map('Rules\\\\Decision', ['grant:read','grantToken','grant2','other']));",
  );
}
function bindings(result: ReturnType<typeof analysis>) {
  const policy = result.functions.find(
    (fn) => fn.file === "policy/policy.php" && fn.name === "Decision",
  )!;
  assert.ok(policy);
  const calls = result.calls.filter(
    (call) => call.file === "consumer/consumer.php",
  );
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(
      (call) =>
        call.resolution === "lexical-binding" &&
        call.targetFunctionId === policy.id,
    ),
  );
  const imports = result.modules.filter(
    (value) => value.file === "consumer/consumer.php",
  );
  assert.equal(imports.length, 4);
  assert.ok(
    imports.every(
      (value) =>
        value.resolution === "selected" &&
        value.targetFile === "policy/policy.php",
    ),
  );
  assert.equal(
    result.phpBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === policy.id && edge.depth === 1,
    ).length,
    2,
  );
  assert.equal(
    result.phpBindings.counts.calls,
    result.phpBindings.counts.resolvedCalls +
      result.phpBindings.counts.unresolvedCalls,
  );
  assert.equal(
    result.phpBindings.counts.imports,
    result.phpBindings.counts.resolvedImports +
      result.phpBindings.counts.unresolvedImports,
  );
  assert.equal(result.phpBindings.fullImpactFallback, true);
  assert.equal(result.phpBindings.runtimeReachabilityVerified, false);
  assert.equal(result.phpBindings.nativeNameResolutionVerified, false);
  assert.equal(result.phpBindings.moduleLoadingVerified, false);
  assert.equal(result.phpBindings.validationPlanUnchanged, true);
}
test("context-php broken acceptance", native, async (t) => {
  const { root, context, result } = await original(t);
  bindings(result);
  assert.deepEqual(await witness(root), [true, true, true, false]);
  const fn = result.functions.find((fn) => fn.name === "Decision")!,
    file = context.files.find((file) => file.path === fn.file)!;
  assert.equal(
    file.content.slice(fn.start, fn.end),
    broken.slice(broken.indexOf("function ")).trim(),
  );
  const declaration = result.declarations.find(
    (value) => value.name === "FALLBACK",
  )!;
  assert.ok(declaration.initializer);
  assert.equal(
    file.content.slice(
      declaration.initializer.start,
      declaration.initializer.end,
    ),
    "'grant'",
  );
  assert.ok(
    result.references.some(
      (value) => value.targetDeclarationId === declaration.id,
    ),
  );
  const parameter = result.declarations.find(
    (value) => value.kind === "parameter" && value.file === "policy/policy.php",
  )!;
  assert.ok(parameter.initializer);
  assert.equal(
    file.content.slice(parameter.initializer.start, parameter.initializer.end),
    "FALLBACK",
  );
  assert.equal(
    createHypothesisPlan(context).scope.runtimeReachability,
    "unknown",
  );
  const old = {
      "policy/policy.php": broken,
      "consumer/consumer.php": consumer,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await rename(
    path.join(revision, "consumer/consumer.php"),
    path.join(revision, "consumer/moved.php"),
  );
  await writeFile(
    path.join(revision, "consumer/moved.php"),
    "<?php namespace Consumer; use function Rules\\Decision as choose; function Submit($choose){return $choose('grantToken');}\n",
  );
  await writeFile(path.join(revision, "policy/policy.php"), fixed);
  const captured = await createReviewContext(revision, {
    ...input(undefined, ["consumer/consumer.php", "consumer/moved.php"]),
    track: "diff",
    baseCommit: base,
  });
  const value = analysis(captured);
  assert.equal(
    value.calls.filter(
      (call) =>
        call.revision === "base" &&
        call.file === "consumer/consumer.php" &&
        call.resolution === "lexical-binding",
    ).length,
    2,
  );
  assert.equal(
    value.calls.find(
      (call) =>
        call.revision === "current" && call.file === "consumer/moved.php",
    )!.targetFunctionId,
    null,
  );
  assert.equal(captured.schemaVersion, 10);
  if (captured.schemaVersion !== 10 || captured.evidence.track !== "diff")
    throw Error("Diff required");
  assert.equal(
    captured.evidence.baseFiles.find(
      (file) => file.path === "policy/policy.php",
    )!.content,
    broken,
  );
});
test("context-php fixed acceptance", native, async (t) => {
  const { root, context, result } = await original(t, fixed);
  bindings(result);
  assert.deepEqual(await witness(root), [true, false, false, false]);
  assert.equal(
    parseReviewContext(context).contextDigest,
    context.contextDigest,
  );
  const decision = result.functions.find(
      (value) =>
        value.file === "policy/policy.php" && value.name === "Decision",
    )!,
    source = context.files.find((file) => file.path === decision.file)!;
  assert.equal(
    source.content.slice(decision.start, decision.end),
    fixed.slice(fixed.indexOf("function ")).trim(),
  );
});
test("context-php near-miss acceptance", native, async (t) => {
  const { root } = await original(t, near);
  assert.deepEqual(await witness(root), [true, false, false, false]);
  const cases: [string, string][] = [
    ["function UseIt($choose){return choose('x');}", "lexical-binding"],
    ["function UseIt($choose){return $choose('x');}", "unsupported-dispatch"],
    [
      "function UseIt($obj){return $obj->Decision('x');}",
      "unsupported-dispatch",
    ],
    [
      "function UseIt($obj){return $obj?->Decision('x');}",
      "unsupported-dispatch",
    ],
    ["function UseIt(){return P::Decision('x');}", "unsupported-dispatch"],
    ["function UseIt(){return (choose)('x');}", "unsupported-dispatch"],
    ["function UseIt(){return chooseExtra('x');}", "no-selected-definition"],
    [
      "function UseIt(){return CHOOSE('x');} // chooseExtra('x')",
      "lexical-binding",
    ],
    ["function UseIt(){return \\Rules\\Decision('x');}", "lexical-binding"],
    ["function UseIt(){return P\\Decision('x');}", "lexical-binding"],
    [
      "function UseIt(){return namespace\\choose('x');}",
      "no-selected-definition",
    ],
    ["function UseIt(){return Decision('x');}", "no-selected-definition"],
  ];
  for (const [body, resolution] of cases) {
    const contents =
      "<?php namespace Consumer; use function Rules\\Decision as choose; use Rules as P; " +
      body;
    await writeFile(path.join(root, "consumer/consumer.php"), contents);
    const value = analysis(await createReviewContext(root, input()));
    const call = value.calls.find(
      (call) => call.file === "consumer/consumer.php",
    )!;
    assert.ok(call, body);
    assert.equal(call.resolution, resolution, body);
    if (resolution !== "lexical-binding")
      assert.equal(call.targetFunctionId, null);
  }
  const source =
    "<?php namespace P { function foo(){return 'producer';} const VALUE='constant'; } namespace C { function Before(){return foo();} use function P\\foo as foo; function After(){return FOO();} use const P\\VALUE as V; function ConstCase(){return V;} } namespace C { function foo(){return 'local';} } namespace { echo json_encode([\\C\\Before(),\\C\\After(),\\C\\ConstCase()]); }";
  const lexical = await fixture(t, { "names.php": source });
  const value = analysis(
    await createReviewContext(lexical, input(["names.php"], [])),
  );
  const foo = value.functions.filter((fn) => fn.name === "foo");
  assert.equal(foo.length, 2);
  for (const [name, target] of [
    ["Before", foo[1]!.id],
    ["After", foo[0]!.id],
  ] as const) {
    const owner = value.functions.find((fn) => fn.name === name)!;
    assert.equal(
      value.calls.find((call) => call.callerFunctionId === owner.id)!
        .targetFunctionId,
      target,
    );
  }
  assert.deepEqual(await php(lexical, "require 'names.php';"), [
    "local",
    "producer",
    "constant",
  ]);
  const kinds =
    "<?php namespace P { function FnName(){return 'fn';} const FLAG='constant'; } namespace C { use P\\{function FnName as Run, const FLAG as Value}; function Good(){return [RUN(),Value];} function Wrong(){return value;} function Qualified(){return Run\\FnName();} } namespace { echo json_encode(\\C\\Good()); }";
  const grouped = await fixture(t, { "groups.php": kinds });
  const groups = analysis(
    await createReviewContext(grouped, input(["groups.php"], [])),
  );
  assert.deepEqual(await php(grouped, "require 'groups.php';"), [
    "fn",
    "constant",
  ]);
  const flag = groups.declarations.find((value) => value.name === "FLAG")!;
  const refs = groups.references.filter(
    (value) => value.targetDeclarationId === flag.id,
  );
  assert.equal(refs.length, 1);
  assert.equal(kinds.slice(refs[0]!.start, refs[0]!.end), "Value");
  assert.equal(
    groups.calls.find(
      (call) => kinds.slice(call.start, call.end) === "Run\\FnName()",
    )!.targetFunctionId,
    null,
  );
  const conditional = await fixture(t, {
    "conditional.php":
      "<?php namespace P; if (false) { function Maybe(){} } function UseIt(){Maybe();}",
  });
  const unknown = analysis(
    await createReviewContext(conditional, input(["conditional.php"], [])),
  );
  assert.equal(unknown.calls[0]!.resolution, "unsupported-dispatch");
  assert.ok(unknown.phpBindings.omissions.includes("conditional-declaration"));
  const duplicate = await fixture(t, {
    "left.php": fixed,
    "right.php": fixed,
    "caller.php":
      "<?php use function Rules\\Decision; function UseIt(){Decision('x');}",
  });
  const ambiguous = analysis(
    await createReviewContext(
      duplicate,
      input(["left.php"], ["right.php", "caller.php"]),
    ),
  );
  assert.equal(
    ambiguous.calls.find((call) => call.file === "caller.php")!.resolution,
    "ambiguous-definition",
  );
  const loads = await fixture(t, {
    "nested/main.php":
      "<?php require __DIR__ . '/../policy.php'; require 'policy.php'; require $dynamic; function Main(){}",
    "policy.php": fixed,
  });
  const loading = analysis(
    await createReviewContext(
      loads,
      input(["nested/main.php"], ["policy.php"]),
    ),
  );
  assert.deepEqual(
    loading.modules.map((value) => [value.resolution, value.targetFile]),
    [
      ["selected", "policy.php"],
      ["dynamic", null],
      ["dynamic", null],
    ],
  );
  const doubles = await fixture(t, {
    "doubles/main.php":
      '<?php require __DIR__ . "/../policy.php"; require __DIR__ . "\\u002f../policy.php"; function Main(){}',
    "policy.php": fixed,
  });
  const doubleContext = analysis(
    await createReviewContext(
      doubles,
      input(["doubles/main.php"], ["policy.php"]),
    ),
  );
  assert.deepEqual(
    doubleContext.modules.map((value) => [value.resolution, value.targetFile]),
    [
      ["selected", "policy.php"],
      ["dynamic", null],
    ],
    "Only PHP-compatible literal escapes resolve selected loading paths",
  );
  assert.equal(await php(doubles, 'echo json_encode("\\u002f");'), "\\u002f");
  const members = await fixture(t, {
    "class.php":
      "<?php namespace P; class C { const FLAG=1; function method(){return self::FLAG;} } function UseIt(){return FLAG;}",
  });
  const member = analysis(
    await createReviewContext(members, input(["class.php"], [])),
  );
  assert.equal(member.references.length, 0);
  assert.ok(member.phpBindings.omissions.includes("unsupported-binding"));
  const namespaces = await fixture(t, {
    "extra.php": "<?php namespace RulesExtra; function Decision(){}",
    "consumer.php":
      "<?php use Rules as P; function UseIt(){return P\\Decision();}",
  });
  const boundary = analysis(
    await createReviewContext(
      namespaces,
      input(["extra.php"], ["consumer.php"]),
    ),
  );
  assert.equal(boundary.modules[0]!.resolution, "external");
  assert.equal(boundary.calls[0]!.targetFunctionId, null);
  const splitNamespace = await fixture(t, {
    "one.php": fixed,
    "two.php": "<?php namespace Rules; function Other(){}",
    "caller.php":
      "<?php use Rules as P; function UseIt(){return P\\Decision('x');}",
  });
  const split = analysis(
    await createReviewContext(
      splitNamespace,
      input(["one.php"], ["two.php", "caller.php"]),
    ),
  );
  assert.equal(split.modules[0]!.resolution, "ambiguous");
  assert.equal(split.modules[0]!.targetFile, null);
  assert.equal(
    split.calls.find((call) => call.file === "caller.php")!.resolution,
    "lexical-binding",
  );
  const labels =
    "<?php namespace L; const MARKER='constant'; function EchoValue($MARKER){return $MARKER;} function UseIt(){goto MARKER; MARKER:return EchoValue(MARKER:'label');} echo json_encode(UseIt());";
  const labelled = await fixture(t, { "labels.php": labels });
  const labelContext = analysis(
    await createReviewContext(labelled, input(["labels.php"], [])),
  );
  assert.equal(
    labelContext.references.length,
    0,
    "Labels and argument names are not constant reads",
  );
  assert.equal(await php(labelled, "require 'labels.php';"), "label");
  const caseNames =
    "<?php namespace P { const FLAG='case'; function FnName(){return 'fn';} } namespace { function UseIt(){return [\\p\\FLAG,\\p\\FNNAME()];} echo json_encode(UseIt()); }";
  const caseRoot = await fixture(t, { "case.php": caseNames });
  const caseContext = analysis(
    await createReviewContext(caseRoot, input(["case.php"], [])),
  );
  assert.equal(caseContext.references.length, 1);
  assert.equal(
    caseContext.calls.find(
      (call) => caseNames.slice(call.start, call.end) === "\\p\\FNNAME()",
    )!.resolution,
    "lexical-binding",
  );
  assert.deepEqual(await php(caseRoot, "require 'case.php';"), ["case", "fn"]);
  const excluded = await fixture(t, { "vendor/copied.php": fixed });
  await assert.rejects(
    createReviewContext(excluded, input(["vendor/copied.php"], [])),
    /excluded/,
  );
});
test("context-php prerequisite acceptance", async (t) => {
  const { root } = await original(t);
  for (const roots of [
    [".", "pkg"],
    [".."],
    Array.from({ length: 17 }, (_, i) => "root" + i),
  ])
    await assert.rejects(
      createReviewContext(root, input(undefined, undefined, roots)),
    );
  const absent = analysis(
    await createReviewContext(root, input(undefined, undefined, ["elsewhere"])),
  );
  assert.equal(absent.phpBindings.state, "partial");
  assert.ok(absent.phpBindings.omissions.includes("outside-module-roots"));
  const unsupported = await fixture(t, {
    "unsupported.vb": "Module Original\nEnd Module\n",
  });
  const value = analysis(
    await createReviewContext(unsupported, input(["unsupported.vb"], [])),
  );
  assert.equal(value.files[0]!.state, "unsupported");
  assert.equal(value.phpBindings.state, "partial");
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
  )) as typeof import("../src/review-polyglot.js");
  const source = { path: "sample.php", content: fixed, sha256: hash(fixed) };
  const unavailable = await isolated.collectReviewPhpBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(unavailable.files[0]!.state, "error");
  assert.equal(unavailable.phpBindings.state, "partial");
  assert.deepEqual(unavailable.functions, []);
  await mkdir(path.join(copied, "assets/context-grammars"), {
    recursive: true,
  });
  const bytes = await readFile(
    path.join(
      await realpath(path.join(repository, "dist/src")),
      "../../assets/context-grammars/tree-sitter-php.wasm",
    ),
  );
  const altered = Buffer.from(bytes),
    position = altered.indexOf(Buffer.from("tree_sitter_php"));
  assert.notEqual(position, -1);
  altered[position + "tree_sitter_ph".length] = "s".charCodeAt(0);
  assert.doesNotThrow(() => new WebAssembly.Module(altered));
  const asset = path.join(
    copied,
    "assets/context-grammars/tree-sitter-php.wasm",
  );
  await writeFile(asset, altered);
  const changed = await isolated.collectReviewPhpBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(changed.files[0]!.state, "error");
  assert.deepEqual(changed.calls, []);
  await writeFile(asset, bytes);
  const restored = await isolated.collectReviewPhpBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(restored.files[0]!.state, "collected");
  assert.equal(restored.functions.length, 1);
  const missing = await runProcess(
    root,
    {
      executable: path.join(root, "missing-original-php"),
      args: ["--version"],
      cwd: ".",
    },
    { timeoutMs: 1000 },
  );
  assert.equal(missing.errorCode, "ENOENT");
  assert.notEqual(missing.exitCode, 0);
});
test("context-php stale acceptance", async (t) => {
  const { root, context } = await original(t);
  for (const [mutate, message] of [
    [
      (value: ReturnType<typeof analysis>) => {
        value.phpBindings.moduleRoots = ["elsewhere"];
      },
      /module roots differ/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.phpBindings.counts.resolvedCalls++;
      },
      /counts do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.phpBindings.callerEdges = [];
      },
      /closure does not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.phpBindings.omissions = [];
      },
      /omissions do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.phpBindings.state = "collected";
      },
      /omissions do not reconcile/,
    ],
  ] as const) {
    const forged = structuredClone(context);
    mutate(analysis(forged));
    assert.throws(() => parseReviewContext(rebound(forged)), message);
  }
  const engine = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const id = (await engine.open(context)).workflowId;
    await writeFile(
      path.join(root, "consumer/consumer.php"),
      consumer + "// changed\n",
    );
    await engine.next(id);
    assert.equal(engine.status(id).status, "stale");
  } finally {
    engine.dispose();
  }
  const old = {
      "policy/policy.php": broken,
      "consumer/consumer.php": consumer,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await writeFile(path.join(revision, "policy/policy.php"), fixed);
  fixtureGit(revision, ["add", "--all"]);
  await writeFile(path.join(revision, "policy/policy.php"), near);
  for (const currentSource of ["working-tree", "index"] as const) {
    const captured = await createReviewContext(revision, {
        ...input(),
        track: "diff",
        baseCommit: base,
        currentSource,
      }),
      value = analysis(captured);
    const before = value.functions.find(
        (fn) => fn.revision === "base" && fn.name === "Decision",
      )!,
      after = value.functions.find(
        (fn) => fn.revision === "current" && fn.name === "Decision",
      )!;
    assert.notEqual(before.id, after.id);
    assert.equal(
      captured.files.find((file) => file.path === "policy/policy.php")!.content,
      currentSource === "index" ? fixed : near,
    );
    assert.ok(
      value.calls
        .filter((call) => call.file === "consumer/consumer.php")
        .every(
          (call) =>
            call.targetFunctionId ===
            (call.revision === "base" ? before.id : after.id),
        ),
    );
  }
});
test("context-php empty acceptance", async (t) => {
  for (const text of ["", "<?php // inert Decision()\n", "<?php function ("]) {
    const root = await fixture(t, { "sample.php": text }),
      value = analysis(
        await createReviewContext(root, input(["sample.php"], [])),
      );
    assert.equal(value.phpBindings.state, "partial");
    assert.deepEqual(value.phpBindings.callerEdges, []);
    assert.equal(value.phpBindings.counts.resolvedCalls, 0);
  }
  const wide = await fixture(t, {
    "wide.php":
      "<?php\n" +
      Array.from({ length: 3000 }, (_, i) => "const X" + i + "=1;\n").join(""),
  });
  const exhausted = analysis(
    await createReviewContext(wide, input(["wide.php"], [])),
  );
  assert.equal(exhausted.files[0]!.state, "budget-exhausted");
  assert.deepEqual(exhausted.phpBindings.callerEdges, []);
  const chain =
    "<?php\n" +
    Array.from(
      { length: 10 },
      (_, i) =>
        "function F" +
        i +
        "(){return " +
        (i ? "F" + (i - 1) + "()" : "true") +
        ";}\n",
    ).join("");
  const chains = await fixture(t, { "chain.php": chain }),
    value = analysis(
      await createReviewContext(chains, input(["chain.php"], [])),
    );
  const f0 = value.functions.find((fn) => fn.name === "F0")!;
  assert.equal(
    value.phpBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === f0.id,
    ).length,
    8,
  );
  assert.ok(value.phpBindings.omissions.includes("depth-limit"));
  const roots = Array.from({ length: 16 }, (_, i) => "root" + i),
    paths = roots.flatMap((root) => [
      root + "/first.php",
      root + "/second.php",
    ]),
    text = "<?php //" + " ".repeat(32768 - 9) + "\n";
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
test("context-php privacy acceptance", async (t) => {
  const selection = input(),
    root = await fixture(t, {
      "policy/policy.php": fixed,
      "consumer/consumer.php": consumer,
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
    assert.equal(result.stdout.includes("phpBindings"), flags.length > 0);
    const client = new Client(
      { name: "original-php-context-host", version: "1" },
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
test("context-php lifecycle acceptance", native, async (t) => {
  const marker = "original-side-effect.txt",
    root = await fixture(t, {
      "sample.php":
        "<?php file_put_contents('" +
        marker +
        "','executed'); function Main(){}\n",
      ".checktrail/keep": "",
    });
  const value = analysis(
    await createReviewContext(root, input(["sample.php"], [])),
  );
  assert.equal(value.functions.length, 1);
  await assert.rejects(access(path.join(root, marker)), { code: "ENOENT" });
  const program =
    "<?php\nif (($argv[1] ?? '') === 'child') { sleep(60); exit; }\n$child = proc_open([PHP_BINARY, __FILE__, 'child'], [0=>['file','/dev/null','r'],1=>['pipe','w'],2=>['pipe','w']], $pipes); if (!is_resource($child)) { throw new Exception('spawn'); }\n$status = proc_get_status($child); $target = $argv[1]; file_put_contents($target.'.pending', json_encode(['parent'=>getmypid(),'child'=>$status['pid']])); rename($target.'.pending',$target);\nif ($argv[2] === 'output') { fwrite(STDOUT,str_repeat('x',1048576)); }\nstream_get_contents($pipes[1]); foreach ($pipes as $pipe) { fclose($pipe); } proc_close($child); sleep(60);\n";
  await writeFile(path.join(root, "native.php"), program);
  const pre = new AbortController();
  pre.abort();
  const notReached = await runProcess(
    root,
    {
      executable: "php",
      args: ["native.php", path.join(root, "pre.json"), "cancel"],
      cwd: ".",
    },
    { signal: pre.signal, timeoutMs: 1000 },
  );
  assert.equal(notReached.cancelled, true);
  await assert.rejects(access(path.join(root, "pre.json")), { code: "ENOENT" });
  for (const mode of ["cancel", "timeout", "output"] as const) {
    const ready = path.join(root, "native-" + mode + ".json"),
      controller = new AbortController(),
      execution = runProcess(
        root,
        { executable: "php", args: ["native.php", ready, mode], cwd: "." },
        {
          signal: controller.signal,
          timeoutMs: mode === "timeout" ? 3000 : 10000,
          maxOutputBytes: mode === "output" ? 1024 : 65536,
        },
      );
    try {
      let identities: { parent: number; child: number } | undefined;
      for (let n = 0; n < 100; n++) {
        identities = await readFile(ready, "utf8")
          .then(JSON.parse)
          .catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        if (identities) break;
        await delay(20);
      }
      assert.ok(identities, "Reached native PHP parent and child");
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
        assert.equal(alive, false, "Reached PHP process survived cleanup");
      }
      await assert.rejects(access(ready + ".pending"), { code: "ENOENT" });
    } finally {
      controller.abort();
      await execution;
    }
  }
  await rm(path.join(root, "native.php"));
  await assert.rejects(access(path.join(root, "native.php")), {
    code: "ENOENT",
  });
  const legacy = await createReviewContext(root, {
    schemaVersion: 7,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["sample.php"],
    supportFiles: [],
    topics: [],
  });
  assert.equal(legacy.schemaVersion, 7);
  if (legacy.schemaVersion !== 7) throw Error("Original legacy required");
  assert.equal(legacy.analysis.profile, "selected-syntax-v1");
});
test("context-php installed acceptance", native, async () => {
  if (process.env.CHECKTRAIL_CONTEXT_PHP_INSTALLED === "1") {
    const runtime = await realpath(
      fileURLToPath(
        new URL("../src/review-php-resolution.js", import.meta.url),
      ),
    );
    assert.ok(
      runtime.includes(
        path.join("node_modules", "@stsepelin", "checktrail", "dist", "src"),
      ),
    );
    return;
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "context-php",
  };
  delete env.NODE_TEST_CONTEXT;
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
