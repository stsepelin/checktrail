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
import { swiftBoundariesFixture } from "./review-swift-boundaries-fixture.js";

const broken =
  'public let FALLBACK = "grant"\npublic func decision(_ value: String = FALLBACK) -> Bool { return value.hasPrefix(FALLBACK) }\n';
const fixed =
  'public let FALLBACK = "grant"\npublic func decision(_ value: String = FALLBACK) -> Bool { if value == FALLBACK { return true }\nreturn value.hasPrefix(FALLBACK + ":") }\n';
const near =
  'public let FALLBACK = "grant"\npublic func decision(_ value: String = FALLBACK) -> Bool { return value == "grant:read" || value == "grant:write" }\n';
const consumer =
  'import Policy\nfunc submit() -> Bool { return Policy.decision("grantToken") }\nfunc route() -> Bool { return Policy.decision(Policy.FALLBACK) }\nfunc alias() -> Bool { return decision("grantToken") }\n';
const native = {
  skip:
    process.platform === "linux" &&
    /^Swift version 6\.2 \(swift-6\.2-RELEASE\)/.test(
      spawnSync("swiftc", ["--version"], { encoding: "utf8" }).stdout ?? "",
    )
      ? false
      : "Pinned native Swift6.2.0 unavailable",
  timeout: 120000,
};
const roots = [
  { directory: "src/consumer", module: "Consumer" },
  { directory: "src/policy", module: "Policy" },
];
const single = [{ directory: ".", module: "Sample" }];
const input = (
  files = ["src/policy/Policy.swift"],
  supportFiles = ["src/consumer/Consumer.swift"],
  moduleRoots = roots,
) => ({
  schemaVersion: 18,
  track: "snapshot",
  currentSource: "working-tree",
  files,
  supportFiles,
  moduleRoots,
  topics: [],
});
function analysis(context: ReviewContext) {
  assert.equal(context.schemaVersion, 18);
  if (context.schemaVersion !== 18)
    throw Error("Original Swift context required");
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
    "src/policy/Policy.swift": policy,
    "src/consumer/Consumer.swift": consumer,
    ".checktrail/keep": "",
  });
  const context = await createReviewContext(root, input());
  return { root, context, result: analysis(context) };
}
async function compileSwift(root: string, files: string[], args: string[]) {
  await mkdir(path.join(root, ".swift-cache"), { recursive: true });
  const result = await runProcess(
    root,
    {
      executable: "swiftc",
      args: [
        "-swift-version",
        "6",
        "-module-cache-path",
        path.join(root, ".swift-cache"),
        ...args,
        ...files,
      ],
      cwd: ".",
    },
    { timeoutMs: 30000, maxOutputBytes: 65536 },
  );
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.equal(result.errorCode, undefined);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.truncated, false);
}
async function execute(root: string, file: string, args: string[] = []) {
  const result = await runProcess(
    root,
    {
      executable: path.join(root, file),
      args,
      cwd: ".",
      env: { LD_LIBRARY_PATH: path.join(root, "out") },
    },
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
  const out = path.join(root, "out");
  await mkdir(out, { recursive: true });
  await compileSwift(
    root,
    ["src/policy/Policy.swift"],
    [
      "-module-name",
      "Policy",
      "-emit-library",
      "-emit-module",
      "-emit-module-path",
      out + "/Policy.swiftmodule",
      "-o",
      out + "/libPolicy.so",
    ],
  );
  await writeFile(
    path.join(root, "main.swift"),
    'import Policy\nfor value in ["grant:read","grantToken","grant2","other"] {print(Policy.decision(value))}\nprint(submit())\nprint(route())\nprint(alias())\n',
  );
  await compileSwift(
    root,
    ["src/consumer/Consumer.swift", "main.swift"],
    [
      "-module-name",
      "Consumer",
      "-I",
      out,
      "-L",
      out,
      "-lPolicy",
      "-o",
      out + "/Witness",
    ],
  );
  return (await execute(root, "out/Witness"))
    .trim()
    .split("\n")
    .map((value) => {
      assert.ok(value === "true" || value === "false");
      return value === "true";
    });
}
function bindings(result: ReturnType<typeof analysis>) {
  const policy = result.functions.find(
    (fn) => fn.file === "src/policy/Policy.swift" && fn.name === "decision",
  )!;
  assert.ok(policy);
  const calls = result.calls.filter(
    (call) =>
      call.file === "src/consumer/Consumer.swift" &&
      call.callerFunctionId !== null,
  );
  assert.equal(calls.length, 3);
  assert.ok(
    calls.every(
      (call) =>
        call.resolution === "lexical-binding" &&
        call.targetFunctionId === policy.id,
    ),
  );
  assert.equal(result.modules.length, 1);
  assert.ok(result.modules.every((value) => value.resolution === "selected"));
  assert.equal(
    result.swiftBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === policy.id && edge.depth === 1,
    ).length,
    3,
  );
  assert.equal(
    result.swiftBindings.counts.calls,
    result.swiftBindings.counts.resolvedCalls +
      result.swiftBindings.counts.unresolvedCalls,
  );
  assert.equal(
    result.swiftBindings.counts.imports,
    result.swiftBindings.counts.resolvedImports +
      result.swiftBindings.counts.unresolvedImports,
  );
  assert.equal(result.swiftBindings.fullImpactFallback, true);
  assert.equal(result.swiftBindings.runtimeReachabilityVerified, false);
  assert.equal(result.swiftBindings.nativeNameResolutionVerified, false);
  assert.equal(result.swiftBindings.moduleLoadingVerified, false);
  assert.equal(result.swiftBindings.validationPlanUnchanged, true);
}
test("context-swift broken acceptance", native, async (t) => {
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
    "public func decision(_ value: String = FALLBACK) -> Bool { return value.hasPrefix(FALLBACK) }",
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
  const reads = result.references.filter(
    (value) => value.targetDeclarationId === constant.id,
  );
  assert.equal(reads.length, 3);
  assert.equal(
    reads.filter((value) => value.ownerDeclarationId !== null).length,
    1,
  );
  assert.ok(
    reads.some((value) => value.file === "src/consumer/Consumer.swift"),
  );
  assert.equal(
    createHypothesisPlan(context).scope.runtimeReachability,
    "unknown",
  );
  const old = {
      "src/policy/Policy.swift": broken,
      "src/consumer/Consumer.swift": consumer,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await rename(
    path.join(revision, "src/consumer/Consumer.swift"),
    path.join(revision, "src/consumer/Moved.swift"),
  );
  await writeFile(
    path.join(revision, "src/consumer/Moved.swift"),
    'import Policy\nfunc submit(_ p: (String)->Bool) -> Bool { return p("grantToken") }\n',
  );
  await writeFile(path.join(revision, "src/policy/Policy.swift"), fixed);
  const captured = await createReviewContext(revision, {
      ...input(undefined, [
        "src/consumer/Consumer.swift",
        "src/consumer/Moved.swift",
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
        call.file === "src/consumer/Consumer.swift" &&
        call.revision === "base" &&
        call.targetFunctionId === before.id,
    ).length,
    3,
  );
  const moved = value.calls.filter(
    (call) => call.file === "src/consumer/Moved.swift",
  );
  assert.equal(moved.length, 1);
  assert.equal(moved[0]!.targetFunctionId, null);
  assert.ok(
    value.swiftBindings.callerEdges.some(
      (edge) => edge.revision === "base" && edge.targetFunctionId === before.id,
    ),
  );
});
test("context-swift fixed acceptance", native, async (t) => {
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
      (decision) => decision.file === "src/policy/Policy.swift",
    ),
  );
});
test("context-swift near-miss acceptance", native, async (t) => {
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
  await swiftBoundariesFixture(t);
  const orderRoot = await fixture(t, {
    "Sample.swift":
      "let LIMIT=2\nfunc decision()->Bool{return false}\nfunc forward()->Bool{return decision();func decision()->Bool{return true}}\nfunc defaults(LIMIT:Int,value:Int=LIMIT)->Int{return value}\nfunc own()->Bool{return Sample.decision()}\nfunc shadow()->Bool{let before=decision();let decision=2;return before}\n",
    "main.swift":
      "print(forward())\nprint(defaults(LIMIT:9))\nprint(own())\nprint(shadow())\n",
  });
  await compileSwift(
    orderRoot,
    ["Sample.swift", "main.swift"],
    ["-module-name", "Sample", "-o", path.join(orderRoot, "Witness")],
  );
  assert.equal(await execute(orderRoot, "Witness"), "true\n2\nfalse\nfalse\n");
});
test("context-swift prerequisite acceptance", async (t) => {
  const { root } = await original(t);
  for (const roots of [
    [{ directory: "..", module: "Sample" }],
    [
      { directory: "src", module: "One" },
      { directory: "src/policy", module: "Two" },
    ],
    [
      { directory: "one", module: "Duplicate" },
      { directory: "two", module: "Duplicate" },
    ],
    [{ directory: "src", module: "Swift" }],
    [{ directory: "src", module: "X".repeat(257) }],
    Array.from({ length: 17 }, (_, i) => ({
      directory: "root" + i,
      module: "Root" + i,
    })),
  ])
    await assert.rejects(
      createReviewContext(root, input(undefined, undefined, roots)),
    );
  const outside = analysis(
    await createReviewContext(
      root,
      input(undefined, undefined, [
        { directory: "elsewhere", module: "Elsewhere" },
      ]),
    ),
  );
  assert.equal(outside.swiftBindings.state, "partial");
  assert.ok(outside.swiftBindings.omissions.includes("outside-module-roots"));
  assert.ok(outside.calls.every((call) => call.targetFunctionId === null));
  const unsupported = await fixture(t, {
    "unknown.vb": "Module Original\nEnd Module\n",
  });
  assert.equal(
    analysis(
      await createReviewContext(unsupported, input(["unknown.vb"], [], single)),
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
      path: "Sample.swift",
      content: "func decision()->Bool{return true}\n",
      sha256: hash("func decision()->Bool{return true}\n"),
    };
  const missing = await isolated.collectReviewSwiftBehavior(
    [source],
    [],
    [source.path],
    false,
    single,
  );
  assert.equal(missing.files[0]!.state, "error");
  assert.deepEqual(missing.functions, []);
  assert.equal(missing.swiftBindings.state, "partial");
  await mkdir(path.join(copied, "assets/context-grammars"), {
    recursive: true,
  });
  const bytes = await readFile(
      path.join(
        await realpath(path.join(repository, "dist/src")),
        "../../assets/context-grammars/tree-sitter-swift.wasm",
      ),
    ),
    altered = Buffer.from(bytes),
    position = altered.indexOf(Buffer.from("tree_sitter_swift"));
  assert.notEqual(position, -1);
  altered[position + "tree_sitter_rub".length] = "q".charCodeAt(0);
  assert.doesNotThrow(() => new WebAssembly.Module(altered));
  const asset = path.join(
    copied,
    "assets/context-grammars/tree-sitter-swift.wasm",
  );
  await writeFile(asset, altered);
  const changed = await isolated.collectReviewSwiftBehavior(
    [source],
    [],
    [source.path],
    false,
    single,
  );
  assert.equal(changed.files[0]!.state, "error");
  assert.deepEqual(changed.calls, []);
  await writeFile(asset, bytes);
  const restored = await isolated.collectReviewSwiftBehavior(
    [source],
    [],
    [source.path],
    false,
    single,
  );
  assert.equal(restored.files[0]!.state, "collected");
  assert.equal(restored.functions.length, 1);
  const missingNative = await runProcess(
    root,
    {
      executable: path.join(root, "missing-original-swift"),
      args: ["--version"],
      cwd: ".",
    },
    { timeoutMs: 1000 },
  );
  assert.equal(missingNative.errorCode, "ENOENT");
  assert.notEqual(missingNative.exitCode, 0);
});
test("context-swift stale acceptance", async (t) => {
  const { root, context } = await original(t);
  for (const [mutate, message] of [
    [
      (value: ReturnType<typeof analysis>) => {
        value.swiftBindings.moduleRoots = [
          { directory: "elsewhere", module: "Elsewhere" },
        ];
      },
      /module roots differ/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.swiftBindings.counts.resolvedCalls++;
      },
      /counts do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.swiftBindings.callerEdges = [];
      },
      /closure does not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.swiftBindings.omissions = [];
      },
      /omissions do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.swiftBindings.state = "collected";
      },
      /omissions do not reconcile/,
    ],
  ] as const) {
    const forged = structuredClone(context);
    mutate(analysis(forged));
    assert.throws(() => parseReviewContext(rebound(forged)), message);
  }
  for (const [file, source, omission] of [
    [
      "Package.swift",
      "func decision()->Bool{return true}\n",
      "manifest-source-unknown",
    ],
    [
      "Sample.swift",
      "#if ORIGINAL\nfunc decision()->Bool{return true}\n#endif\n",
      "conditional-source-unknown",
    ],
  ] as const) {
    const specialRoot = await fixture(t, { [file]: source }),
      special = await createReviewContext(
        specialRoot,
        input([file], [], single),
      ),
      tampered = structuredClone(special);
    analysis(tampered).swiftBindings.omissions = analysis(
      tampered,
    ).swiftBindings.omissions.filter((value) => value !== omission);
    assert.throws(
      () => parseReviewContext(rebound(tampered)),
      /omissions do not reconcile/,
    );
  }
  const outside = await createReviewContext(
      root,
      input(undefined, undefined, [
        { directory: "elsewhere", module: "Elsewhere" },
      ]),
    ),
    forged = structuredClone(outside);
  analysis(forged).swiftBindings.omissions = analysis(
    forged,
  ).swiftBindings.omissions.filter((value) => value !== "outside-module-roots");
  assert.throws(
    () => parseReviewContext(rebound(forged)),
    /omissions do not reconcile/,
  );
  const engine = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const id = (await engine.open(context)).workflowId;
    await writeFile(path.join(root, "src/policy/Policy.swift"), fixed);
    await engine.next(id);
    assert.equal(engine.status(id).status, "stale");
  } finally {
    engine.dispose();
  }
  const conditionalFiles = {
    "src/policy/Policy.swift": "#if ORIGINAL\n" + broken + "#endif\n",
    "src/consumer/Consumer.swift": consumer,
  };
  const conditionalRoot = await fixture(t, conditionalFiles);
  fixtureGit(conditionalRoot, ["init", "--quiet"]);
  const conditionalBase = await syntheticCommit(
    conditionalRoot,
    conditionalFiles,
  );
  await writeFile(path.join(conditionalRoot, "src/policy/Policy.swift"), fixed);
  const conditionalDiff = await createReviewContext(conditionalRoot, {
    ...input(),
    track: "diff",
    baseCommit: conditionalBase,
  });
  assert.ok(
    analysis(conditionalDiff).swiftBindings.omissions.includes(
      "conditional-source-unknown",
    ),
  );
  const erasedBase = structuredClone(conditionalDiff);
  analysis(erasedBase).swiftBindings.omissions = analysis(
    erasedBase,
  ).swiftBindings.omissions.filter(
    (value) => value !== "conditional-source-unknown",
  );
  assert.throws(
    () => parseReviewContext(rebound(erasedBase)),
    /omissions do not reconcile/,
  );
  const old = {
      "src/policy/Policy.swift": broken,
      "src/consumer/Consumer.swift": consumer,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await writeFile(path.join(revision, "src/policy/Policy.swift"), fixed);
  fixtureGit(revision, ["add", "--all"]);
  await writeFile(path.join(revision, "src/policy/Policy.swift"), near);
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
      captured.files.find((file) => file.path === "src/policy/Policy.swift")!
        .content,
      currentSource === "index" ? fixed : near,
    );
    assert.ok(
      value.calls
        .filter(
          (call) =>
            call.file === "src/consumer/Consumer.swift" &&
            call.callerFunctionId !== null,
        )
        .every(
          (call) =>
            call.targetFunctionId ===
            (call.revision === "base" ? before.id : after.id),
        ),
    );
  }
});
test("context-swift empty acceptance", async (t) => {
  for (const source of ["", "// inert decision()\n", "func broken("]) {
    const root = await fixture(t, { "Sample.swift": source }),
      value = analysis(
        await createReviewContext(root, input(["Sample.swift"], [], single)),
      );
    assert.equal(value.swiftBindings.state, "partial");
    assert.deepEqual(value.swiftBindings.callerEdges, []);
    assert.equal(value.swiftBindings.counts.resolvedCalls, 0);
  }
  const unresolved = await fixture(t, {
      "Sample.swift": "func useit()->Bool{return Unknown.decision()}\n",
    }),
    value = analysis(
      await createReviewContext(
        unresolved,
        input(["Sample.swift"], [], single),
      ),
    );
  assert.equal(value.calls[0]!.targetFunctionId, null);
  assert.equal(value.swiftBindings.counts.unresolvedCalls, 1);
  const wide = await fixture(t, {
    "Sample.swift": Array.from(
      { length: 3000 },
      (_, i) => "let X" + i + "=1\n",
    ).join(""),
  });
  const exhausted = analysis(
    await createReviewContext(wide, input(["Sample.swift"], [], single)),
  );
  assert.equal(exhausted.files[0]!.state, "budget-exhausted");
  assert.deepEqual(exhausted.swiftBindings.callerEdges, []);
  const chain = Array.from(
      { length: 10 },
      (_, i) =>
        "func f" +
        i +
        "()->Bool{return " +
        (i ? "f" + (i - 1) + "()" : "true") +
        "}\n",
    ).join(""),
    chains = await fixture(t, { "Sample.swift": chain }),
    links = analysis(
      await createReviewContext(chains, input(["Sample.swift"], [], single)),
    ),
    f0 = links.functions.find((fn) => fn.name === "f0")!;
  assert.ok(f0);
  assert.equal(
    links.swiftBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === f0.id,
    ).length,
    8,
  );
  assert.ok(links.swiftBindings.omissions.includes("depth-limit"));
  const roots = Array.from({ length: 16 }, (_, i) => ({
      directory: "root" + i,
      module: "Root" + i,
    })),
    paths = roots.flatMap((root) => [
      root.directory + "/First.swift",
      root.directory + "/Second.swift",
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
test("context-swift privacy acceptance", async (t) => {
  const selection = input(),
    root = await fixture(t, {
      "src/policy/Policy.swift": fixed,
      "src/consumer/Consumer.swift": consumer,
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
    assert.equal(result.stdout.includes("swiftBindings"), flags.length > 0);
    const client = new Client(
      { name: "original-swift-context-host", version: "1" },
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
test("context-swift lifecycle acceptance", native, async (t) => {
  const marker = "original-side-effect.txt",
    root = await fixture(t, {
      "Sample.swift":
        'let originalSideEffect = { try! "executed".write(toFile: "' +
        marker +
        '",atomically:true,encoding:.utf8); return true }()\nfunc decision()->Bool{return true}\n',
    }),
    value = analysis(
      await createReviewContext(root, input(["Sample.swift"], [], single)),
    );
  assert.ok(value.functions.some((fn) => fn.name === "decision"));
  await assert.rejects(access(path.join(root, marker)), { code: "ENOENT" });
  const worker = `import Foundation
#if canImport(Glibc)
import Glibc
#else
import Darwin
#endif
let ready=CommandLine.arguments[1],mode=CommandLine.arguments[2]
let child=fork()
if child==0 {sleep(60);_exit(0)}
guard child>0 else {_exit(2)}
_ = signal(SIGTERM,SIG_IGN)
let data=try JSONSerialization.data(withJSONObject:["parent":getpid(),"child":child])
try data.write(to:URL(fileURLWithPath:ready+".pending"))
try FileManager.default.moveItem(atPath:ready+".pending",toPath:ready)
if mode=="output"{FileHandle.standardOutput.write(Data(repeating:120,count:1048576))}
var status:Int32=0
while waitpid(child,&status,0)<0 && errno==EINTR {}
`;
  const file = path.join(root, "Worker.swift"),
    binary = path.join(root, "Worker");
  await writeFile(file, worker);
  await compileSwift(root, [file], ["-o", binary]);
  const command = (ready: string, mode: string) => ({
    executable: binary,
    args: [ready, mode],
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
      assert.ok(identities, "Reached native Swift parent and child");
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
        assert.equal(alive, false, "Reached Swift process survived cleanup");
      }
      await assert.rejects(access(ready + ".pending"), { code: "ENOENT" });
    } finally {
      controller.abort();
      await execution;
      await rm(ready, { force: true });
      await rm(ready + ".pending", { force: true });
    }
    await assert.rejects(access(ready), { code: "ENOENT" });
  }
  await rm(path.join(root, ".swift-cache"), { recursive: true });
  await assert.rejects(access(path.join(root, ".swift-cache")), {
    code: "ENOENT",
  });
  await rm(file);
  await rm(binary);
  await assert.rejects(access(binary), { code: "ENOENT" });
  await assert.rejects(access(file), { code: "ENOENT" });
  await assert.rejects(access(path.join(root, marker)), { code: "ENOENT" });
  const legacy = await createReviewContext(root, {
    schemaVersion: 16,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["Sample.swift"],
    supportFiles: [],
    moduleRoots: ["."],
    topics: [],
  });
  assert.equal(legacy.schemaVersion, 16);
  assert.equal(legacy.analysis.profile, "fsharp-selected-bindings-v1");
  assert.ok(
    legacy.analysis.calls.every((call) => call.targetFunctionId === null),
  );
});
test("context-swift installed acceptance", native, async () => {
  if (process.env.CHECKTRAIL_CONTEXT_SWIFT_INSTALLED === "1") {
    const runtime = await realpath(
      fileURLToPath(
        new URL("../src/review-swift-resolution.js", import.meta.url),
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
    CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "context-swift",
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
