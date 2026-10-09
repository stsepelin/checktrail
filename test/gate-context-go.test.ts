import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
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
import { callIdentityFixture } from "./review-call-identity-fixture.js";
import { fixtureGit, syntheticCommit } from "./git-fixture.js";

const broken =
  'package rules\nimport strings "strings"\nconst fallback = "grant"\nfunc Decision(value string) bool { return strings.HasPrefix(value, fallback) }\n';
const fixed =
  'package rules\nimport strings "strings"\nconst fallback = "grant"\nfunc Decision(value string) bool { return value == fallback || strings.HasPrefix(value, fallback+":") }\n';
const near =
  'package rules\nfunc Decision(value string) bool { return value == "grant:read" || value == "grant:write" }\n';
const consumer =
  'package consumer\nimport "example.invalid/original/policy"\nimport p "example.invalid/original/policy"\nfunc Submit() bool { return (rules.Decision)("grantToken") }\nfunc Route() bool { return p.Decision("grant:read") }\n';
const module = "module example.invalid/original\ngo 1.22\n";
const cache = await mkdtemp(
  path.join(tmpdir(), "checktrail-context-go-cache-"),
);
after(() => rm(cache, { recursive: true, force: true }));
const goEnv = {
  GOCACHE: cache,
  GOENV: "off",
  GOTOOLCHAIN: "local",
  GOWORK: "off",
  GOPROXY: "off",
  GOSUMDB: "off",
};
const native = {
  skip:
    spawnSync("go", ["version"], { encoding: "utf8" }).status === 0
      ? false
      : "Native Go unavailable",
  timeout: 180000,
};
const input = (
  files = ["policy/policy.go"],
  supportFiles = ["consumer/consumer.go", "go.mod"],
  moduleRoots = ["."],
) => ({
  schemaVersion: 9,
  track: "snapshot",
  currentSource: "working-tree",
  files,
  supportFiles,
  topics: [],
  moduleRoots,
});
const analysis = (context: ReviewContext) => {
  assert.equal(context.schemaVersion, 9);
  if (context.schemaVersion !== 9)
    throw new Error("Original version 9 required");
  return context.analysis;
};
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
    "policy/policy.go": policy,
    "consumer/consumer.go": consumer,
    "go.mod": module,
    ".checktrail/keep": "",
  });
  const context = await createReviewContext(root, input());
  return { root, context, result: analysis(context) };
}
async function witness(root: string) {
  await mkdir(path.join(root, "witness"));
  await writeFile(
    path.join(root, "witness/main.go"),
    'package main\nimport ("encoding/json";"fmt";"runtime";rules "example.invalid/original/policy")\nfunc main(){ values:=[]string{"grant:read","grantToken","grant2","other"}; answers:=[]bool{};for _,value:=range values { answers=append(answers,rules.Decision(value)) }; data,_:=json.Marshal(map[string]any{"go":runtime.Version(),"answers":answers});fmt.Println(string(data)) }\n',
  );
  const result = await runProcess(
    root,
    { executable: "go", args: ["run", "./witness"], cwd: ".", env: goEnv },
    { timeoutMs: 60000, maxOutputBytes: 65536 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.errorCode, undefined);
  assert.equal(result.cancelled, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  assert.equal(result.stderr, "");
  const value = JSON.parse(result.stdout);
  assert.equal(value.answers.length, 4);
  assert.match(value.go, /^go1\./);
  return value.answers as boolean[];
}
function bindings(result: ReturnType<typeof analysis>) {
  const policy = result.functions.find(
    (fn) => fn.file === "policy/policy.go" && fn.name === "Decision",
  )!;
  assert.ok(policy);
  const calls = result.calls.filter(
    (call) => call.file === "consumer/consumer.go",
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
    (value) => value.file === "consumer/consumer.go",
  );
  assert.equal(imports.length, 2);
  assert.ok(
    imports.every(
      (value) =>
        value.resolution === "selected" &&
        value.targetFile === "policy/policy.go",
    ),
  );
  assert.equal(
    result.goBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === policy.id && edge.depth === 1,
    ).length,
    2,
  );
  assert.equal(
    result.goBindings.counts.calls,
    result.goBindings.counts.resolvedCalls +
      result.goBindings.counts.unresolvedCalls,
  );
  assert.equal(
    result.goBindings.counts.imports,
    result.goBindings.counts.resolvedImports +
      result.goBindings.counts.unresolvedImports,
  );
  assert.equal(result.goBindings.fullImpactFallback, true);
  assert.equal(result.goBindings.runtimeReachabilityVerified, false);
  assert.equal(result.goBindings.nativeModuleResolutionVerified, false);
  assert.equal(result.goBindings.validationPlanUnchanged, true);
  assert.deepEqual(result.goBindings.moduleManifests, [
    {
      revision: "current",
      root: ".",
      file: "go.mod",
      sha256: hash(module),
      modulePath: "example.invalid/original",
      state: "captured",
    },
  ]);
}
test("context-go broken acceptance", native, async (t) => {
  const { root, context, result } = await original(t);
  bindings(result);
  assert.deepEqual(await witness(root), [true, true, true, false]);
  const fn = result.functions.find((fn) => fn.name === "Decision")!,
    file = context.files.find((file) => file.path === fn.file)!;
  assert.equal(
    file.content.slice(fn.start, fn.end),
    broken.slice(broken.indexOf("func ")).trim(),
  );
  const declaration = result.declarations.find(
    (value) => value.name === "fallback",
  )!;
  assert.ok(declaration.initializer);
  assert.equal(
    file.content.slice(
      declaration.initializer.start,
      declaration.initializer.end,
    ),
    '"grant"',
  );
  assert.ok(
    result.references.some(
      (value) => value.targetDeclarationId === declaration.id,
    ),
  );
  assert.equal(
    createHypothesisPlan(context).scope.runtimeReachability,
    "unknown",
  );
  const old = {
    "policy/policy.go": broken,
    "consumer/consumer.go": consumer,
    "go.mod": module,
  };
  const revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await rename(
    path.join(revision, "consumer/consumer.go"),
    path.join(revision, "consumer/moved.go"),
  );
  await writeFile(
    path.join(revision, "consumer/moved.go"),
    'package consumer\nimport p "example.invalid/original/policy"\nfunc Submit(p interface{Decision(string)bool})bool{return p.Decision("grantToken")}\n',
  );
  await writeFile(path.join(revision, "policy/policy.go"), fixed);
  const captured = await createReviewContext(revision, {
    ...input(
      ["policy/policy.go"],
      ["consumer/consumer.go", "consumer/moved.go", "go.mod"],
    ),
    track: "diff",
    baseCommit: base,
  });
  const value = analysis(captured);
  assert.equal(
    value.calls.filter(
      (call) =>
        call.revision === "base" &&
        call.file === "consumer/consumer.go" &&
        call.resolution === "lexical-binding",
    ).length,
    2,
  );
  assert.equal(
    value.calls.find(
      (call) =>
        call.revision === "current" && call.file === "consumer/moved.go",
    )!.targetFunctionId,
    null,
  );
  assert.equal(captured.schemaVersion, 9);
  if (captured.schemaVersion !== 9) throw Error("Version 9 required");
  assert.equal(captured.evidence.track, "diff");
  if (captured.evidence.track !== "diff") throw Error("Diff required");
  assert.equal(
    captured.evidence.baseFiles.find(
      (file) => file.path === "policy/policy.go",
    )!.content,
    broken,
  );
});
test("context-go fixed acceptance", native, async (t) => {
  const { root, context, result } = await original(t, fixed);
  bindings(result);
  assert.deepEqual(await witness(root), [true, false, false, false]);
  assert.equal(
    parseReviewContext(context).contextDigest,
    context.contextDigest,
  );
  const decision = result.functions.find(
    (value) => value.file === "policy/policy.go" && value.name === "Decision",
  )!;
  assert.ok(decision);
  const source = context.files.find((file) => file.path === decision.file)!;
  assert.equal(
    source.content.slice(decision.start, decision.end),
    fixed.slice(fixed.indexOf("func ")).trim(),
  );
});
test("context-go near-miss acceptance", native, async (t) => {
  await callIdentityFixture(t, "go", true, goEnv);
  const { root } = await original(t, near);
  assert.deepEqual(await witness(root), [true, false, false, false]);
  const cases: [string, string][] = [
    [
      'type C struct{};func (p C) Use()bool{return p.Decision("x")}',
      "unsupported-dispatch",
    ],
    [
      'func Use()(p interface{Decision(string)bool}){p.Decision("x");return}',
      "unsupported-dispatch",
    ],
    [
      'func Use(p interface{Decision(string)bool})bool {return p.Decision("x")}',
      "unsupported-dispatch",
    ],
    [
      'func Use()bool {p:=struct{Decision func(string)bool}{func(string)bool{return false}};return p.Decision("x")}',
      "unsupported-dispatch",
    ],
    ['func Use()bool {return p.DecisionExtra("x")}', "no-selected-definition"],
    [
      'func Use()bool {obj:=struct{Decision func(string)bool}{func(string)bool{return false}};return obj.Decision("x")}',
      "unsupported-dispatch",
    ],
    ['func Use()bool {return (p.Decision)("x")}', "lexical-binding"],
    [
      'func Use()bool {return p.Decision("x")} // p.DecisionExtra("x")',
      "lexical-binding",
    ],
    ['func Use[T any]()bool {return p.Decision("x")}', "unsupported-dispatch"],
    [
      'func Use()bool { f:=func()bool{return p.Decision("x")};return f()}',
      "unsupported-dispatch",
    ],
  ];
  for (const [body, resolution] of cases) {
    const contents =
      'package consumer\nimport p "example.invalid/original/policy"\n' +
      body +
      "\n";
    await writeFile(path.join(root, "consumer/consumer.go"), contents);
    const value = analysis(await createReviewContext(root, input()));
    const call = value.calls.find(
      (call) =>
        call.file === "consumer/consumer.go" &&
        contents.slice(call.start, call.end).includes("Decision"),
    )!;
    assert.ok(call, body);
    assert.equal(call.resolution, resolution, body);
    if (resolution !== "lexical-binding")
      assert.equal(call.targetFunctionId, null);
  }
  const local =
    "package own\nfunc Decision()bool{return true}\nfunc Use()bool{Decision:=Decision(); _=Decision; return Decision()}\n";
  const other = "package own\nfunc Across()bool{return Decision()}\n";
  const lexical = await fixture(t, { "same.go": local, "other.go": other });
  const value = analysis(
    await createReviewContext(lexical, input(["same.go"], ["other.go"])),
  );
  const calls = value.calls.filter((call) => call.file === "same.go");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.resolution, "lexical-binding");
  assert.equal(calls[1]!.targetFunctionId, null);
  assert.equal(
    value.calls.find((call) => call.file === "other.go")!.resolution,
    "lexical-binding",
  );
  for (const alias of ["", "outside ", "_ "]) {
    const contents =
      "package own\nimport " +
      alias +
      '"example.invalid/unselected"\nfunc Decision()bool{return true}\nfunc Use()bool{return Decision()}\n';
    const unselected = await fixture(t, { "sample.go": contents }),
      value = analysis(
        await createReviewContext(unselected, input(["sample.go"], [])),
      );
    const call = value.calls.find(
      (call) => contents.slice(call.start, call.end) === "Decision()",
    )!;
    assert.ok(call);
    assert.equal(
      call.resolution,
      alias ? "lexical-binding" : "unsupported-dispatch",
    );
  }
  const initializers = await fixture(t, {
    "sample.go": "package own\nfunc init(){}\nfunc Use(){init()}\n",
  });
  const initCalls = analysis(
    await createReviewContext(initializers, input(["sample.go"], [])),
  ).calls;
  assert.equal(initCalls.length, 1);
  assert.equal(initCalls[0]!.targetFunctionId, null);
  const dot = await fixture(t, {
    "go.mod": module,
    "policy/policy.go": fixed,
    "consumer/consumer.go":
      'package consumer\nimport . "example.invalid/original/policy"\nfunc Use()bool{return Decision("x")}\n',
  });
  const unknown = analysis(await createReviewContext(dot, input()));
  assert.equal(
    unknown.calls.find((call) => call.file === "consumer/consumer.go")!
      .targetFunctionId,
    null,
  );
  assert.ok(unknown.goBindings.omissions.includes("unsupported-import"));
  const excluded = await fixture(t, {
    "vendor/copied.go": "package rules\nfunc Decision()bool{return true}\n",
  });
  await assert.rejects(
    createReviewContext(excluded, input(["vendor/copied.go"], [])),
    /excluded/,
  );
  const fileShadow = await fixture(t, {
    "go.mod": module,
    "policy/policy.go": fixed,
    "consumer/consumer.go": consumer,
    "consumer/other.go": "package consumer\nfunc rules(){}\n",
  });
  const shadowed = analysis(
    await createReviewContext(
      fileShadow,
      input(undefined, ["consumer/consumer.go", "consumer/other.go", "go.mod"]),
    ),
  );
  assert.ok(
    shadowed.calls
      .filter((call) => call.file === "consumer/consumer.go")
      .every((call) => call.resolution === "lexical-binding"),
  );
  const duplicate = await fixture(t, {
    "left/go.mod": module,
    "right/go.mod": module,
    "left/policy/policy.go": fixed,
    "right/policy/policy.go": fixed,
    "left/consumer/consumer.go": consumer,
  });
  const ambiguous = analysis(
    await createReviewContext(
      duplicate,
      input(
        ["left/policy/policy.go"],
        [
          "right/policy/policy.go",
          "left/consumer/consumer.go",
          "left/go.mod",
          "right/go.mod",
        ],
        ["left", "right"],
      ),
    ),
  );
  assert.equal(
    ambiguous.modules.find(
      (value) => value.file === "left/consumer/consumer.go",
    )!.resolution,
    "ambiguous",
  );
  assert.ok(
    ambiguous.calls
      .filter((call) => call.file === "left/consumer/consumer.go")
      .every((call) => call.targetFunctionId === null),
  );
});
test("context-go prerequisite acceptance", async (t) => {
  const { root } = await original(t);
  await assert.rejects(
    createReviewContext(root, input(undefined, undefined, [".", "pkg"])),
    /Go module roots/,
  );
  await assert.rejects(
    createReviewContext(root, input(undefined, undefined, [".."])),
    /root/,
  );
  await assert.rejects(
    createReviewContext(
      root,
      input(
        undefined,
        undefined,
        Array.from({ length: 17 }, (_, i) => "root" + i),
      ),
    ),
  );
  const absent = analysis(
    await createReviewContext(root, input(undefined, undefined, ["elsewhere"])),
  );
  assert.equal(absent.goBindings.state, "partial");
  assert.ok(absent.goBindings.omissions.includes("outside-module-roots"));
  const unsupported = await fixture(t, {
    "unsupported.vb": "Module Original\nEnd Module\n",
  });
  const value = analysis(
    await createReviewContext(unsupported, input(["unsupported.vb"], [])),
  );
  assert.equal(value.files[0]!.state, "unsupported");
  assert.equal(value.goBindings.state, "partial");
  const copied = await fixture(t, {});
  const repository = fileURLToPath(new URL("../../", import.meta.url));
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
  const source = { path: "sample.go", content: fixed, sha256: hash(fixed) };
  const unavailable = await isolated.collectReviewGoBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(unavailable.files[0]!.state, "error");
  assert.equal(unavailable.goBindings.state, "partial");
  assert.deepEqual(unavailable.functions, []);
  await mkdir(path.join(copied, "assets/context-grammars"), {
    recursive: true,
  });
  const bytes = await readFile(
    path.join(
      await realpath(path.join(repository, "dist/src")),
      "../../assets/context-grammars/tree-sitter-go.wasm",
    ),
  );
  const altered = Buffer.from(bytes),
    position = altered.indexOf(Buffer.from("tree_sitter_go"));
  assert.notEqual(position, -1);
  altered[position + "tree_sitter_g".length] = "s".charCodeAt(0);
  assert.doesNotThrow(() => new WebAssembly.Module(altered));
  const asset = path.join(
    copied,
    "assets/context-grammars/tree-sitter-go.wasm",
  );
  await writeFile(asset, altered);
  const changedGrammar = await isolated.collectReviewGoBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(changedGrammar.files[0]!.state, "error");
  assert.deepEqual(changedGrammar.calls, []);
  await writeFile(asset, bytes);
  const restoredGrammar = await isolated.collectReviewGoBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(restoredGrammar.files[0]!.state, "collected");
  assert.equal(restoredGrammar.functions.length, 1);
  const missingNative = await runProcess(
    root,
    {
      executable: path.join(root, "missing-original-go"),
      args: ["--version"],
      cwd: ".",
    },
    { timeoutMs: 1000 },
  );
  assert.equal(missingNative.errorCode, "ENOENT");
  assert.notEqual(missingNative.exitCode, 0);
});

test("context-go stale acceptance", async (t) => {
  const { root, context } = await original(t);
  for (const [mutate, message] of [
    [
      (value: ReturnType<typeof analysis>) => {
        value.goBindings.moduleRoots = ["elsewhere"];
      },
      /module roots differ/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.goBindings.moduleManifests[0]!.modulePath =
          "example.invalid/forged";
      },
      /module directives differ/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.goBindings.counts.resolvedCalls++;
      },
      /counts do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.goBindings.callerEdges = [];
      },
      /closure does not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.goBindings.omissions = [];
      },
      /omissions do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.goBindings.state = "collected";
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
      path.join(root, "go.mod"),
      "module example.invalid/changed\n",
    );
    assert.equal((await engine.next(id)).format, "review-workflow-summary");
    assert.equal(engine.status(id).status, "stale");
  } finally {
    engine.dispose();
  }
  const old = {
      "policy/policy.go": broken,
      "consumer/consumer.go": consumer,
      "go.mod": module,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await writeFile(path.join(revision, "policy/policy.go"), fixed);
  fixtureGit(revision, ["add", "--all"]);
  await writeFile(path.join(revision, "policy/policy.go"), near);
  for (const currentSource of ["working-tree", "index"] as const) {
    const captured = await createReviewContext(revision, {
      ...input(),
      track: "diff",
      baseCommit: base,
      currentSource,
    });
    const value = analysis(captured);
    const before = value.functions.find(
        (fn) => fn.revision === "base" && fn.name === "Decision",
      )!,
      after = value.functions.find(
        (fn) => fn.revision === "current" && fn.name === "Decision",
      )!;
    assert.notEqual(before.id, after.id);
    assert.equal(
      captured.files.find((file) => file.path === "policy/policy.go")!.content,
      currentSource === "index" ? fixed : near,
    );
    assert.ok(
      value.calls
        .filter((call) => call.file === "consumer/consumer.go")
        .every(
          (call) =>
            call.targetFunctionId ===
            (call.revision === "base" ? before.id : after.id),
        ),
    );
    assert.deepEqual(
      value.goBindings.moduleManifests.map((value) => value.revision),
      ["base", "current"],
    );
  }
});
test("context-go empty acceptance", async (t) => {
  for (const text of ["", "// inert Decision()\n", "package broken\nfunc ("]) {
    const root = await fixture(t, { "sample.go": text });
    const value = analysis(
      await createReviewContext(root, input(["sample.go"], [])),
    );
    assert.equal(value.goBindings.state, "partial");
    assert.deepEqual(value.goBindings.callerEdges, []);
    assert.equal(value.goBindings.counts.resolvedCalls, 0);
  }
  const root = await fixture(t, {
    "policy/policy.go": fixed,
    "consumer/consumer.go": consumer,
  });
  const absent = analysis(
    await createReviewContext(root, input(undefined, ["consumer/consumer.go"])),
  );
  assert.equal(absent.goBindings.moduleManifests[0]!.state, "missing");
  assert.ok(
    absent.calls
      .filter((call) => call.file === "consumer/consumer.go")
      .every((call) => call.targetFunctionId === null),
  );
  for (const text of [
    "module wrong\nmodule duplicate\n",
    'module "unterminated\n',
    "module example.invalid/../escape\n",
    "module (\nwrong\nextra\n)\n",
    "module (\nexample.invalid/original\n)\n",
  ]) {
    await writeFile(path.join(root, "go.mod"), text);
    const unsupported = analysis(await createReviewContext(root, input()));
    assert.equal(
      unsupported.goBindings.moduleManifests[0]!.state,
      "unsupported",
    );
    assert.ok(
      unsupported.calls
        .filter((call) => call.file === "consumer/consumer.go")
        .every((call) => call.targetFunctionId === null),
    );
  }
  const wide = await fixture(t, {
    "wide.go":
      "package own\n" +
      Array.from({ length: 3000 }, (_, i) => "var x" + i + "=1\n").join(""),
  });
  const exhausted = analysis(
    await createReviewContext(wide, input(["wide.go"], [])),
  );
  assert.equal(exhausted.files[0]!.state, "budget-exhausted");
  assert.deepEqual(exhausted.goBindings.callerEdges, []);
  const chain =
    "package own\n" +
    Array.from(
      { length: 10 },
      (_, i) =>
        "func F" +
        i +
        "()bool{return " +
        (i ? "F" + (i - 1) + "()" : "true") +
        "}\n",
    ).join("");
  const chains = await fixture(t, { "chain.go": chain }),
    value = analysis(
      await createReviewContext(chains, input(["chain.go"], [])),
    );
  const f0 = value.functions.find((fn) => fn.name === "F0")!;
  assert.equal(
    value.goBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === f0.id,
    ).length,
    8,
  );
  assert.ok(value.goBindings.omissions.includes("depth-limit"));
  const roots = Array.from({ length: 16 }, (_, i) => "root" + i),
    paths = roots.flatMap((root) => [root + "/first.go", root + "/second.go"]);
  const text = "package own\n//" + " ".repeat(32768 - 15) + "\n";
  assert.equal(Buffer.byteLength(text), 32768);
  const boundary = await fixture(
    t,
    Object.fromEntries(paths.map((file) => [file, text])),
  );
  const full = await createReviewContext(
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
test("context-go privacy acceptance", async (t) => {
  const selection = input();
  const root = await fixture(t, {
    "policy/policy.go": fixed,
    "consumer/consumer.go": consumer,
    "go.mod": module,
    "selection.json": JSON.stringify(selection),
  });
  const expected = await createReviewContext(root, selection);
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
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
    assert.equal(result.stdout.includes("goBindings"), flags.length > 0);
    const client = new Client(
      { name: "original-go-context-host", version: "1" },
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

test("context-go lifecycle acceptance", native, async (t) => {
  const marker = "original-side-effect.txt",
    root = await fixture(t, {
      "sample.go":
        'package main\nimport "os"\nfunc init(){os.WriteFile("' +
        marker +
        '",[]byte("executed"),0600)}\nfunc main(){}\n',
      "go.mod": module,
      ".checktrail/keep": "",
    });
  const value = analysis(
    await createReviewContext(root, input(["sample.go"], ["go.mod"])),
  );
  assert.equal(value.functions.length, 2);
  await assert.rejects(access(path.join(root, marker)), { code: "ENOENT" });
  const program =
    'package main\nimport("encoding/json";"os";"os/exec";"path/filepath";"time")\nfunc main(){if len(os.Args)==2 && os.Args[1]=="child"{time.Sleep(time.Minute);return};cmd:=exec.Command(os.Args[0],"child");if err:=cmd.Start();err!=nil{panic(err)};go cmd.Wait();bytes,_:=json.Marshal(map[string]int{"parent":os.Getpid(),"child":cmd.Process.Pid});target:=os.Args[1];pending:=target+".pending";if err:=os.WriteFile(pending,bytes,0600);err!=nil{panic(err)};if err:=os.Rename(pending,target);err!=nil{panic(err)};if os.Args[2]=="output"{os.Stdout.Write(make([]byte,1048576))};_=filepath.Base(target);time.Sleep(time.Minute)}\n';
  await writeFile(path.join(root, "native.go"), program);
  const executable = path.join(
    root,
    process.platform === "win32" ? "native.exe" : "native",
  );
  const build = await runProcess(
    root,
    {
      executable: "go",
      args: ["build", "-o", executable, "native.go"],
      cwd: ".",
      env: goEnv,
    },
    { timeoutMs: 60000 },
  );
  assert.equal(build.exitCode, 0, build.stderr);
  assert.equal(build.errorCode, undefined);
  const pre = new AbortController();
  pre.abort();
  const notReached = await runProcess(
    root,
    { executable, args: [path.join(root, "pre.json"), "cancel"], cwd: "." },
    { signal: pre.signal, timeoutMs: 1000 },
  );
  assert.equal(notReached.cancelled, true);
  await assert.rejects(access(path.join(root, "pre.json")), { code: "ENOENT" });
  for (const mode of ["cancel", "timeout", "output"] as const) {
    const ready = path.join(root, "native-" + mode + ".json"),
      controller = new AbortController();
    const execution = runProcess(
      root,
      { executable, args: [ready, mode], cwd: "." },
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
      assert.ok(identities, "Reached native Go parent and child");
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
        assert.equal(alive, false, "Reached Go process survived cleanup");
      }
      await assert.rejects(access(ready + ".pending"), { code: "ENOENT" });
    } finally {
      controller.abort();
      await execution;
    }
  }
  await rm(executable);
  await assert.rejects(access(executable), { code: "ENOENT" });
  const legacy = await createReviewContext(root, {
    schemaVersion: 7,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["sample.go"],
    supportFiles: [],
    topics: [],
  });
  assert.equal(legacy.schemaVersion, 7);
  if (legacy.schemaVersion !== 7) throw Error("Original legacy required");
  assert.equal(legacy.analysis.profile, "selected-syntax-v1");
  assert.ok(
    legacy.analysis.calls.every((call) => call.targetFunctionId === null),
  );
});
test("context-go installed acceptance", async () => {
  if (process.env.CHECKTRAIL_CONTEXT_GO_INSTALLED === "1") {
    const runtime = await realpath(
      fileURLToPath(new URL("../src/review-go-resolution.js", import.meta.url)),
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
    CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "context-go",
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
