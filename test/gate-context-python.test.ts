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
  'fallback = "grant"\ndef decision(value, prefix=fallback):\n    return value.startswith(prefix)\n';
const fixed =
  'fallback = "grant"\ndef decision(value, prefix=fallback):\n    return value == prefix or value.startswith(prefix + ":")\n';
const near =
  'fallback = "grant"\ndef decision(value, prefix=fallback):\n    return value in [prefix + ":read", prefix + ":write"]\n';
const consumer =
  'from .policy import decision as choose\nimport pkg . policy as rules\ndef submit():\n    return (choose)("grantToken")\ndef route():\n    return rules . decision("grant:read")\n';
const input = (
  files = ["pkg/policy.py"],
  supportFiles = ["pkg/consumer.py"],
  moduleRoots = ["."],
) => ({
  schemaVersion: 8,
  track: "snapshot",
  currentSource: "working-tree",
  files,
  supportFiles,
  topics: [],
  moduleRoots,
});
const analysis = (context: ReviewContext) => {
  assert.equal(context.schemaVersion, 8);
  if (context.schemaVersion !== 8)
    throw new Error("Original version 8 fixture required");
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
    "pkg/policy.py": policy,
    "pkg/consumer.py": consumer,
    ".checktrail/keep": "",
  });
  const context = await createReviewContext(root, input());
  return { root, context, result: analysis(context) };
}
async function witness(root: string) {
  const program =
    'import importlib.util,json,sys; spec=importlib.util.spec_from_file_location("original_fixture",sys.argv[1]); unit=importlib.util.module_from_spec(spec); spec.loader.exec_module(unit); values=["grant:read","grantToken","grant2","other"]; print(json.dumps({"python":list(sys.version_info[:3]),"cases":[{"input":value,"actual":unit.decision(value)} for value in values]}))';
  const native = await runProcess(
    root,
    {
      executable: "python3",
      args: ["-I", "-B", "-c", program, path.join(root, "pkg/policy.py")],
      cwd: ".",
    },
    { timeoutMs: 5000, maxOutputBytes: 65536 },
  );
  assert.equal(native.exitCode, 0, native.stderr);
  assert.equal(native.errorCode, undefined);
  assert.equal(native.timedOut, false);
  assert.equal(native.cancelled, false);
  assert.equal(native.truncated, false);
  assert.equal(native.stderr, "");
  const receipt = JSON.parse(native.stdout);
  assert.equal(receipt.cases.length, 4);
  return receipt;
}
function bindings(result: ReturnType<typeof analysis>) {
  const policy = result.functions.find(
    (fn) => fn.file === "pkg/policy.py" && fn.name === "decision",
  )!;
  assert.ok(policy);
  const selected = result.calls.filter(
    (call) => call.file === "pkg/consumer.py",
  );
  assert.equal(selected.length, 2);
  assert.equal(
    selected.every(
      (call) =>
        call.resolution === "lexical-binding" &&
        call.targetFunctionId === policy.id,
    ),
    true,
  );
  assert.equal(
    result.modules.filter((module) => module.file === "pkg/consumer.py").length,
    2,
  );
  assert.equal(
    result.modules
      .filter((module) => module.file === "pkg/consumer.py")
      .every(
        (module) =>
          module.targetFile === "pkg/policy.py" &&
          module.resolution === "selected",
      ),
    true,
  );
  assert.equal(
    result.pythonBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === policy.id && edge.depth === 1,
    ).length,
    2,
  );
  assert.equal(
    result.pythonBindings.counts.resolvedCalls +
      result.pythonBindings.counts.unresolvedCalls,
    result.pythonBindings.counts.calls,
  );
  assert.equal(
    result.pythonBindings.counts.resolvedImports +
      result.pythonBindings.counts.unresolvedImports,
    result.pythonBindings.counts.imports,
  );
  assert.equal(result.pythonBindings.fullImpactFallback, true);
  assert.equal(result.pythonBindings.runtimeReachabilityVerified, false);
  assert.equal(result.pythonBindings.validationPlanUnchanged, true);
}
test("context-python broken acceptance", async (t) => {
  const { root, context, result } = await original(t);
  bindings(result);
  const live = await witness(root);
  assert.deepEqual(
    live.cases.map((item: { actual: boolean }) => item.actual),
    [true, true, true, false],
  );
  const fn = result.functions.find((fn) => fn.name === "decision")!;
  const file = context.files.find((file) => file.path === fn.file)!;
  assert.equal(
    file.content.slice(fn.start, fn.end),
    broken.trim().slice(broken.indexOf("def ")),
  );
  const fallback = result.declarations.find(
    (declaration) =>
      declaration.name === "fallback" && declaration.file === "pkg/policy.py",
  )!;
  assert.ok(fallback.initializer);
  assert.equal(
    file.content.slice(fallback.initializer.start, fallback.initializer.end),
    '"grant"',
  );
  assert.ok(
    result.references.some(
      (reference) => reference.targetDeclarationId === fallback.id,
    ),
  );
  assert.equal(
    createHypothesisPlan(context).scope.runtimeReachability,
    "unknown",
  );
  const movedRoot = await fixture(t, {
    "pkg/policy.py": broken,
    "pkg/consumer.py": consumer,
  });
  fixtureGit(movedRoot, ["init", "--quiet"]);
  const base = await syntheticCommit(movedRoot, {
    "pkg/policy.py": broken,
    "pkg/consumer.py": consumer,
  });
  await rename(
    path.join(movedRoot, "pkg/consumer.py"),
    path.join(movedRoot, "pkg/moved.py"),
  );
  await writeFile(path.join(movedRoot, "pkg/policy.py"), fixed);
  await writeFile(
    path.join(movedRoot, "pkg/moved.py"),
    consumer.replace("def submit():", "def submit(choose):"),
  );
  const revisions = await createReviewContext(movedRoot, {
    ...input(undefined, ["pkg/consumer.py", "pkg/moved.py"]),
    track: "diff",
    baseCommit: base,
  });
  const captured = analysis(revisions);
  const prior = captured.functions.find(
    (fn) => fn.file === "pkg/policy.py" && fn.revision === "base",
  )!;
  assert.equal(
    captured.calls.filter(
      (call) =>
        call.file === "pkg/consumer.py" &&
        call.revision === "base" &&
        call.targetFunctionId === prior.id,
    ).length,
    2,
  );
  assert.equal(
    captured.functions.some(
      (fn) => fn.file === "pkg/consumer.py" && fn.revision === "current",
    ),
    false,
  );
  assert.equal(
    captured.calls.find(
      (call) =>
        call.file === "pkg/moved.py" &&
        revisions.files
          .find((file) => file.path === call.file)!
          .content.slice(call.start, call.end) === '(choose)("grantToken")',
    )!.targetFunctionId,
    null,
  );
  assert.ok(
    captured.pythonBindings.callerEdges.some(
      (edge) => edge.revision === "base" && edge.targetFunctionId === prior.id,
    ),
  );
  if (revisions.schemaVersion !== 8 || revisions.evidence.track !== "diff")
    throw new Error("Original moved diff required");
  const old = revisions.evidence.baseFiles.find(
    (file) => file.path === "pkg/policy.py",
  )!;
  assert.equal(
    old.content.slice(prior.start, prior.end),
    broken.trim().slice(broken.indexOf("def ")),
  );
});
test("context-python fixed acceptance", async (t) => {
  const { root, result } = await original(t, fixed);
  bindings(result);
  const live = await witness(root);
  assert.deepEqual(
    live.cases.map((item: { actual: boolean }) => item.actual),
    [true, false, false, false],
  );
  assert.ok(
    result.decisions.some((decision) => decision.file === "pkg/policy.py"),
  );
});
test("context-python near-miss acceptance", async (t) => {
  const { root, result } = await original(t, near);
  bindings(result);
  assert.deepEqual(
    (await witness(root)).cases.map((item: { actual: boolean }) => item.actual),
    [true, false, false, false],
  );
  const sources = [
    [
      "def decision():\n return True\ndef submit(decision):\n return decision()\n",
      "unsupported-dispatch",
    ],
    [
      "def decision():\n return True\ndecision = other\ndef submit():\n return decision()\n",
      "mutated-binding",
    ],
    [
      "def decision():\n return True\ndef submit():\n decision, other = factory()\n return decision()\n",
      "unsupported-dispatch",
    ],
    [
      "def decision():\n return True\nclass C:\n def decision(self):\n  return False\n def submit(self):\n  return decision()\n",
      "lexical-binding",
    ],
    [
      "def decision():\n return True\ndef outer():\n def decision():\n  return False\n def submit():\n  return decision()\n return submit()\n",
      "lexical-binding",
    ],
    [
      "from external import *\ndef decision():\n return True\ndef submit():\n return decision()\n",
      "unsupported-dispatch",
    ],
    [
      "def decision():\n return True\ndef submit():\n global decision\n return decision()\n",
      "unsupported-dispatch",
    ],
    [
      "def decision():\n return True\ndef submit():\n match value:\n  case decision:\n   pass\n return decision()\n",
      "unsupported-dispatch",
    ],
    [
      "def decision():\n return True\ndef submit():\n return obj.decision()\n",
      "no-selected-definition",
    ],
    [
      "def decision():\n return True\ndef submit():\n return decisionExtra()\n",
      "no-selected-definition",
    ],
  ] as const;
  for (const [contents, resolution] of sources) {
    const root = await fixture(t, { "sample.py": contents });
    const value = analysis(
      await createReviewContext(root, input(["sample.py"], [])),
    );
    const call = value.calls.find(
      (call) =>
        contents.slice(call.start, call.end) ===
        (contents.includes("decisionExtra")
          ? "decisionExtra()"
          : contents.includes("obj.decision")
            ? "obj.decision()"
            : "decision()"),
    )!;
    assert.ok(call);
    assert.equal(call.resolution, resolution, contents);
    if (resolution === "lexical-binding") {
      const target = value.functions.find(
        (fn) => fn.id === call.targetFunctionId,
      )!;
      assert.ok(target);
      assert.equal(
        contents.includes("class C") ? target.start : target.name,
        contents.includes("class C") ? 0 : "decision",
      );
    } else assert.equal(call.targetFunctionId, null);
  }
  const defaults = await fixture(t, {
    "sample.py":
      "def decision():\n return True\ndef factory(decision=decision()):\n return False\n",
  });
  const value = analysis(
    await createReviewContext(defaults, input(["sample.py"], [])),
  );
  assert.equal(value.calls[0]!.resolution, "lexical-binding");
  assert.equal(value.calls[0]!.callerFunctionId, null);
  const roots = await fixture(t, {
    "left/pkg/policy.py": "def decision():\n return True\n",
    "right/pkg/policy.py": "def decision():\n return False\n",
    "left/pkg/consumer.py":
      "from pkg.policy import decision\ndef submit():\n return decision()\n",
  });
  const ambiguous = analysis(
    await createReviewContext(
      roots,
      input(
        ["left/pkg/policy.py"],
        ["right/pkg/policy.py", "left/pkg/consumer.py"],
        ["left", "right"],
      ),
    ),
  );
  assert.equal(ambiguous.modules[0]!.resolution, "ambiguous");
  assert.equal(ambiguous.calls[0]!.resolution, "ambiguous-definition");
});
test("context-python prerequisite acceptance", async (t) => {
  const { root } = await original(t);
  await assert.rejects(
    createReviewContext(root, input(undefined, undefined, [".", "pkg"])),
    /overlap/,
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
  assert.equal(absent.pythonBindings.state, "partial");
  assert.ok(absent.pythonBindings.omissions.includes("outside-module-roots"));
  const unsupported = await fixture(t, {
    "unsupported.vb": "Module Original\nEnd Module\n",
  });
  const value = analysis(
    await createReviewContext(unsupported, input(["unsupported.vb"], [])),
  );
  assert.equal(value.files[0]!.state, "unsupported");
  assert.equal(value.pythonBindings.state, "partial");
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
  const source = { path: "sample.py", content: fixed, sha256: hash(fixed) };
  const unavailable = await isolated.collectReviewPythonBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(unavailable.files[0]!.state, "error");
  assert.equal(unavailable.pythonBindings.state, "partial");
  assert.deepEqual(unavailable.functions, []);
  await mkdir(path.join(copied, "assets/context-grammars"), {
    recursive: true,
  });
  const bytes = await readFile(
    path.join(
      await realpath(path.join(repository, "dist/src")),
      "../../assets/context-grammars/tree-sitter-python.wasm",
    ),
  );
  const altered = Buffer.from(bytes),
    position = altered.indexOf(Buffer.from("tree_sitter_python"));
  assert.notEqual(position, -1);
  altered[position + "tree_sitter_py".length] = "s".charCodeAt(0);
  assert.doesNotThrow(() => new WebAssembly.Module(altered));
  const asset = path.join(
    copied,
    "assets/context-grammars/tree-sitter-python.wasm",
  );
  await writeFile(asset, altered);
  const changedGrammar = await isolated.collectReviewPythonBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(changedGrammar.files[0]!.state, "error");
  assert.deepEqual(changedGrammar.calls, []);
  await writeFile(asset, bytes);
  const restoredGrammar = await isolated.collectReviewPythonBehavior(
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
      executable: path.join(root, "missing-original-python"),
      args: ["--version"],
      cwd: ".",
    },
    { timeoutMs: 1000 },
  );
  assert.equal(missingNative.errorCode, "ENOENT");
  assert.notEqual(missingNative.exitCode, 0);
});
test("context-python stale acceptance", async (t) => {
  const { root, context } = await original(t);
  const changed = structuredClone(context);
  const result = analysis(changed);
  result.pythonBindings.moduleRoots = ["elsewhere"];
  assert.throws(
    () => parseReviewContext(rebound(changed)),
    /module roots differ/,
  );
  const forged = structuredClone(context);
  analysis(forged).pythonBindings.callerEdges = [];
  assert.throws(
    () => parseReviewContext(rebound(forged)),
    /closure does not reconcile/,
  );
  for (const mutate of [
    (value: ReturnType<typeof analysis>) => {
      value.pythonBindings.counts.resolvedCalls++;
    },
    (value: ReturnType<typeof analysis>) => {
      value.pythonBindings.omissions = [];
    },
    (value: ReturnType<typeof analysis>) => {
      value.pythonBindings.state = "collected";
    },
  ]) {
    const forged = structuredClone(context);
    mutate(analysis(forged));
    assert.throws(
      () => parseReviewContext(rebound(forged)),
      /Python binding (counts|omissions)/,
    );
  }
  const engine = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const id = (await engine.open(context)).workflowId;
    await writeFile(path.join(root, "pkg/policy.py"), fixed);
    assert.equal((await engine.next(id)).format, "review-workflow-summary");
    assert.equal(engine.status(id).status, "stale");
  } finally {
    engine.dispose();
  }
  const old = { "pkg/policy.py": broken, "pkg/consumer.py": consumer };
  const revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await writeFile(path.join(revision, "pkg/policy.py"), fixed);
  fixtureGit(revision, ["add", "--all"]);
  await writeFile(path.join(revision, "pkg/policy.py"), near);
  for (const currentSource of ["working-tree", "index"] as const) {
    const captured = await createReviewContext(revision, {
      ...input(),
      track: "diff",
      baseCommit: base,
      currentSource,
    });
    const data = analysis(captured);
    assert.equal(captured.schemaVersion, 8);
    if (captured.schemaVersion !== 8 || captured.evidence.track !== "diff")
      throw new Error("Diff fixture required");
    assert.equal(
      captured.evidence.baseFiles.find((file) => file.path === "pkg/policy.py")!
        .content,
      broken,
    );
    assert.equal(
      captured.files.find((file) => file.path === "pkg/policy.py")!.content,
      currentSource === "index" ? fixed : near,
    );
    for (const call of data.calls.filter(
      (call) => call.file === "pkg/consumer.py",
    )) {
      const target = data.functions.find(
        (fn) => fn.id === call.targetFunctionId,
      )!;
      assert.equal(target.revision, call.revision);
      assert.equal(target.file, "pkg/policy.py");
    }
  }
});
test("context-python empty acceptance", async (t) => {
  for (const contents of [
    "",
    "# Original empty scope\n",
    "def malformed(:\n pass\n",
  ]) {
    const root = await fixture(t, { "sample.py": contents });
    const value = analysis(
      await createReviewContext(root, input(["sample.py"], [])),
    );
    assert.equal(value.pythonBindings.state, "partial");
    assert.deepEqual(value.functions, []);
    assert.deepEqual(value.pythonBindings.callerEdges, []);
    assert.equal(value.pythonBindings.fullImpactFallback, true);
  }
  const roots = Array.from({ length: 16 }, (_, i) => "root" + i);
  const files = Object.fromEntries(
    roots.flatMap((root) =>
      [0, 1].map((i) => [root + "/part" + i + ".py", "#".repeat(32768)]),
    ),
  );
  const paths = Object.keys(files);
  const boundary = await fixture(t, files);
  const full = await createReviewContext(
    boundary,
    input(paths.slice(0, 1), paths.slice(1), roots),
  );
  assert.equal(full.files.length, 32);
  assert.equal(
    full.files.reduce((n, file) => n + Buffer.byteLength(file.content), 0),
    1048576,
  );
  assert.equal(
    analysis(full).files.every((file) => file.state === "collected"),
    true,
  );
  assert.equal(analysis(full).pythonBindings.state, "partial");
  await writeFile(path.join(boundary, paths[0]!), files[paths[0]!]! + "#");
  await assert.rejects(
    createReviewContext(
      boundary,
      input(paths.slice(0, 1), paths.slice(1), roots),
    ),
    /source total/,
  );
  const wide = await fixture(t, { "wide.py": "x=1\n".repeat(12000) });
  const exhausted = analysis(
    await createReviewContext(wide, input(["wide.py"], [])),
  );
  assert.equal(exhausted.files[0]!.state, "budget-exhausted");
  assert.equal(exhausted.pythonBindings.state, "partial");
  assert.deepEqual(exhausted.calls, []);
  assert.deepEqual(exhausted.pythonBindings.callerEdges, []);
  const functions = Array.from(
    { length: 10 },
    (_, i) =>
      "def f" +
      i +
      "():\n return " +
      (i ? "f" + (i - 1) + "()" : "True") +
      "\n",
  ).join("");
  const root = await fixture(t, { "sample.py": functions });
  const value = analysis(
    await createReviewContext(root, input(["sample.py"], [])),
  );
  const target = value.functions.find((fn) => fn.name === "f0")!;
  assert.equal(
    value.pythonBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === target.id,
    ).length,
    8,
  );
  assert.ok(value.pythonBindings.omissions.includes("depth-limit"));
  assert.equal(value.pythonBindings.state, "partial");
});
test("context-python privacy acceptance", async (t) => {
  const selection = input();
  const root = await fixture(t, {
    "pkg/policy.py": fixed,
    "pkg/consumer.py": consumer,
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
    assert.equal(result.stdout.includes("pythonBindings"), flags.length > 0);
    const client = new Client(
      { name: "original-python-context-host", version: "1" },
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
test("context-python lifecycle acceptance", async (t) => {
  const marker = "original-side-effect.txt";
  const root = await fixture(t, {
    "sample.py":
      'from pathlib import Path\nPath("' +
      marker +
      '").write_text("executed")\ndef decision():\n return True\n',
  });
  const value = analysis(
    await createReviewContext(root, input(["sample.py"], [])),
  );
  assert.equal(value.functions.length, 1);
  await assert.rejects(access(path.join(root, marker)), { code: "ENOENT" });
  const cancelled = new AbortController();
  cancelled.abort();
  const native = await runProcess(
    root,
    {
      executable: "python3",
      args: [
        "-c",
        'from pathlib import Path; Path("' +
          marker +
          '").write_text("executed")',
      ],
      cwd: ".",
    },
    { timeoutMs: 1000, signal: cancelled.signal },
  );
  assert.equal(native.cancelled, true);
  await assert.rejects(access(path.join(root, marker)), { code: "ENOENT" });
  for (const mode of ["cancel", "timeout", "output"] as const) {
    const ready = path.join(root, "native-" + mode + ".json");
    const program = [
      "import json,os,pathlib,subprocess,sys,threading,time",
      "child=subprocess.Popen([sys.executable,'-I','-B','-c','import time; time.sleep(60)'])",
      "threading.Thread(target=child.wait,daemon=True).start()",
      "target=pathlib.Path(sys.argv[1]); pending=target.with_suffix('.pending')",
      "pending.write_text(json.dumps({'parent':os.getpid(),'child':child.pid})); pending.replace(target)",
      "sys.stdout.write('x'*1048576) if sys.argv[2]=='output' else None",
      "sys.stdout.flush()",
      "time.sleep(60)",
    ].join("\n");
    const controller = new AbortController();
    const execution = runProcess(
      root,
      {
        executable: "python3",
        args: ["-I", "-B", "-c", program, ready, mode],
        cwd: ".",
      },
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
      assert.ok(identities, "Reached native Python parent and child");
      assert.ok(
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
          "Reached native Python process survived cleanup",
        );
      }
      await assert.rejects(access(ready.replace(/\.json$/, ".pending")), {
        code: "ENOENT",
      });
    } finally {
      controller.abort();
      await execution;
    }
  }
  const legacy = await createReviewContext(root, {
    schemaVersion: 7,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["sample.py"],
    supportFiles: [],
    topics: [],
  });
  assert.equal(legacy.schemaVersion, 7);
  if (legacy.schemaVersion !== 7)
    throw new Error("Original legacy fixture required");
  assert.equal(legacy.analysis.profile, "selected-syntax-v1");
  assert.equal(
    legacy.analysis.calls.every((call) => call.targetFunctionId === null),
    true,
  );
});
test("context-python installed acceptance", async () => {
  if (process.env.CHECKTRAIL_CONTEXT_PYTHON_INSTALLED === "1") {
    const runtime = await realpath(
      fileURLToPath(
        new URL("../src/review-python-resolution.js", import.meta.url),
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
    CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "context-python",
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
