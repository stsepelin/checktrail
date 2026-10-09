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
import { rubyBoundariesFixture } from "./review-ruby-boundaries-fixture.js";

const broken =
  'module Policy\n  FALLBACK = "grant"\n  def self.decision(value = FALLBACK)\n    value.start_with?(FALLBACK)\n  end\nend\n';
const fixed =
  'module Policy\n  FALLBACK = "grant"\n  def self.decision(value = FALLBACK)\n    value == FALLBACK || value.start_with?(FALLBACK + ":")\n  end\nend\n';
const near =
  'module Policy\n  FALLBACK = "grant"\n  def self.decision(value = FALLBACK)\n    value == "grant:read" || value == "grant:write"\n  end\nend\n';
const consumer =
  'require_relative "../policy/Policy"\nmodule Consumer\n  def self.submit\n    Policy.decision("grantToken")\n  end\n  def self.route\n    Policy.decision(Policy::FALLBACK)\n  end\n  def self.alias\n    ::Policy.decision("grantToken")\n  end\nend\n';
const native = {
  skip: /^ruby 4\.0\.7 \(2026-09-15 revision 229531a6cf\)/.test(
    spawnSync("ruby", ["--disable-gems", "--version"], { encoding: "utf8" })
      .stdout ?? "",
  )
    ? false
    : "Pinned native Ruby unavailable",
  timeout: 120000,
};
const input = (
  files = ["src/policy/Policy.rb"],
  supportFiles = ["src/consumer/Consumer.rb"],
  moduleRoots = ["src"],
) => ({
  schemaVersion: 17,
  track: "snapshot",
  currentSource: "working-tree",
  files,
  supportFiles,
  moduleRoots,
  topics: [],
});
function analysis(context: ReviewContext) {
  assert.equal(context.schemaVersion, 17);
  if (context.schemaVersion !== 17)
    throw Error("Original Ruby context required");
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
    "src/policy/Policy.rb": policy,
    "src/consumer/Consumer.rb": consumer,
    ".checktrail/keep": "",
  });
  const context = await createReviewContext(root, input());
  return { root, context, result: analysis(context) };
}
async function execute(root: string, file: string, args: string[] = []) {
  const result = await runProcess(
    root,
    { executable: "ruby", args: ["--disable-gems", file, ...args], cwd: "." },
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
  await writeFile(
    path.join(root, "Witness.rb"),
    'require_relative "./src/policy/Policy"\nrequire_relative "./src/consumer/Consumer"\n["grant:read","grantToken","grant2","other"].each { |value| puts Policy.decision(value) }\nputs Consumer.submit\nputs Consumer.route\nputs Consumer.alias\n',
  );
  return (await execute(root, "Witness.rb"))
    .trim()
    .split("\n")
    .map((value) => {
      assert.ok(value === "true" || value === "false");
      return value === "true";
    });
}
function bindings(result: ReturnType<typeof analysis>) {
  const policy = result.functions.find(
    (fn) => fn.file === "src/policy/Policy.rb" && fn.name === "decision",
  )!;
  assert.ok(policy);
  const calls = result.calls.filter(
    (call) =>
      call.file === "src/consumer/Consumer.rb" &&
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
    result.rubyBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === policy.id && edge.depth === 1,
    ).length,
    3,
  );
  assert.equal(
    result.rubyBindings.counts.calls,
    result.rubyBindings.counts.resolvedCalls +
      result.rubyBindings.counts.unresolvedCalls,
  );
  assert.equal(
    result.rubyBindings.counts.imports,
    result.rubyBindings.counts.resolvedImports +
      result.rubyBindings.counts.unresolvedImports,
  );
  assert.equal(result.rubyBindings.fullImpactFallback, true);
  assert.equal(result.rubyBindings.runtimeReachabilityVerified, false);
  assert.equal(result.rubyBindings.nativeNameResolutionVerified, false);
  assert.equal(result.rubyBindings.moduleLoadingVerified, false);
  assert.equal(result.rubyBindings.validationPlanUnchanged, true);
}
test("context-ruby broken acceptance", native, async (t) => {
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
    "def self.decision(value = FALLBACK)\n    value.start_with?(FALLBACK)\n  end",
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
      "src/policy/Policy.rb": broken,
      "src/consumer/Consumer.rb": consumer,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await rename(
    path.join(revision, "src/consumer/Consumer.rb"),
    path.join(revision, "src/consumer/Moved.rb"),
  );
  await writeFile(
    path.join(revision, "src/consumer/Moved.rb"),
    'module Moved\n  def self.submit(p)\n    p.decision("grantToken")\n  end\nend\n',
  );
  await writeFile(path.join(revision, "src/policy/Policy.rb"), fixed);
  const captured = await createReviewContext(revision, {
      ...input(undefined, [
        "src/consumer/Consumer.rb",
        "src/consumer/Moved.rb",
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
        call.file === "src/consumer/Consumer.rb" &&
        call.revision === "base" &&
        call.targetFunctionId === before.id,
    ).length,
    3,
  );
  const moved = value.calls.filter(
    (call) => call.file === "src/consumer/Moved.rb",
  );
  assert.equal(moved.length, 1);
  assert.equal(moved[0]!.targetFunctionId, null);
  assert.ok(
    value.rubyBindings.callerEdges.some(
      (edge) => edge.revision === "base" && edge.targetFunctionId === before.id,
    ),
  );
});
test("context-ruby fixed acceptance", native, async (t) => {
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
      (decision) => decision.file === "src/policy/Policy.rb",
    ),
  );
});
test("context-ruby near-miss acceptance", native, async (t) => {
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
  await rubyBoundariesFixture(t);
  const orderRoot = await fixture(t, {
    "Order.rb":
      'module Sample\n  LIMIT = 2\n  def self.decision(value = "grant")\n    value\n  end\n  def self.local(decision)\n    [decision(), decision, self.decision, ::Sample.decision]\n  end\n  def self.forward\n    before = decision\n    decision = 2\n    after = decision\n    later = decision()\n    [before, after, later]\n  end\n  def self.initializer\n    decision = decision\n    [decision, decision()]\n  end\n  def self.default(value = LIMIT)\n    value\n  end\nend\np Sample.local(false)\np Sample.forward\np Sample.initializer\np Sample.default\n',
  });
  assert.equal(
    await execute(orderRoot, "Order.rb"),
    '["grant", false, "grant", "grant"]\n["grant", 2, "grant"]\n[nil, "grant"]\n2\n',
  );
  const addressRoot = await fixture(t, {
    "Addresses.rb":
      'module Policy\n def self.decision\n true\n end\nend\nmodule Sample\n LIMIT=2\n Policy=2\n def self.absolute\n ::Policy.decision\n end\n def self.root_constant\n ::LIMIT\n end\nend\nputs Sample.absolute\nbegin\n Sample.root_constant\nrescue NameError\n puts "root-unknown"\nend\n',
  });
  assert.equal(
    await execute(addressRoot, "Addresses.rb"),
    "true\nroot-unknown\n",
  );
});
test("context-ruby prerequisite acceptance", async (t) => {
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
  assert.equal(outside.rubyBindings.state, "partial");
  assert.ok(outside.rubyBindings.omissions.includes("outside-module-roots"));
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
      path: "Sample.rb",
      content: "module Sample\n def self.decision\n true\n end\nend\n",
      sha256: hash("module Sample\n def self.decision\n true\n end\nend\n"),
    };
  const missing = await isolated.collectReviewRubyBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(missing.files[0]!.state, "error");
  assert.deepEqual(missing.functions, []);
  assert.equal(missing.rubyBindings.state, "partial");
  await mkdir(path.join(copied, "assets/context-grammars"), {
    recursive: true,
  });
  const bytes = await readFile(
      path.join(
        await realpath(path.join(repository, "dist/src")),
        "../../assets/context-grammars/tree-sitter-ruby.wasm",
      ),
    ),
    altered = Buffer.from(bytes),
    position = altered.indexOf(Buffer.from("tree_sitter_ruby"));
  assert.notEqual(position, -1);
  altered[position + "tree_sitter_rub".length] = "q".charCodeAt(0);
  assert.doesNotThrow(() => new WebAssembly.Module(altered));
  const asset = path.join(
    copied,
    "assets/context-grammars/tree-sitter-ruby.wasm",
  );
  await writeFile(asset, altered);
  const changed = await isolated.collectReviewRubyBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(changed.files[0]!.state, "error");
  assert.deepEqual(changed.calls, []);
  await writeFile(asset, bytes);
  const restored = await isolated.collectReviewRubyBehavior(
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
      executable: path.join(root, "missing-original-ruby"),
      args: ["--version"],
      cwd: ".",
    },
    { timeoutMs: 1000 },
  );
  assert.equal(missingNative.errorCode, "ENOENT");
  assert.notEqual(missingNative.exitCode, 0);
});
test("context-ruby stale acceptance", async (t) => {
  const { root, context } = await original(t);
  for (const [mutate, message] of [
    [
      (value: ReturnType<typeof analysis>) => {
        value.rubyBindings.moduleRoots = ["elsewhere"];
      },
      /module roots differ/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.rubyBindings.counts.resolvedCalls++;
      },
      /counts do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.rubyBindings.callerEdges = [];
      },
      /closure does not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.rubyBindings.omissions = [];
      },
      /omissions do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.rubyBindings.state = "collected";
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
      "module Sample\n def self.decision\n true\n end\nend\n__END__\ninert body\n",
      "data-tail-unknown",
    ],
    [
      "# coding: ASCII-8BIT\nmodule Sample\n def self.decision\n true\n end\nend\n",
      "source-encoding-unknown",
    ],
  ] as const) {
    const specialRoot = await fixture(t, { "Sample.rb": source }),
      special = await createReviewContext(
        specialRoot,
        input(["Sample.rb"], [], ["."]),
      ),
      tampered = structuredClone(special);
    analysis(tampered).rubyBindings.omissions = analysis(
      tampered,
    ).rubyBindings.omissions.filter((value) => value !== omission);
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
  analysis(forged).rubyBindings.omissions = analysis(
    forged,
  ).rubyBindings.omissions.filter((value) => value !== "outside-module-roots");
  assert.throws(
    () => parseReviewContext(rebound(forged)),
    /omissions do not reconcile/,
  );
  const engine = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const id = (await engine.open(context)).workflowId;
    await writeFile(path.join(root, "src/policy/Policy.rb"), fixed);
    await engine.next(id);
    assert.equal(engine.status(id).status, "stale");
  } finally {
    engine.dispose();
  }
  const conditionalFiles = {
    "src/policy/Policy.rb": "# coding: ASCII-8BIT\n" + broken,
    "src/consumer/Consumer.rb": consumer,
  };
  const conditionalRoot = await fixture(t, conditionalFiles);
  fixtureGit(conditionalRoot, ["init", "--quiet"]);
  const conditionalBase = await syntheticCommit(
    conditionalRoot,
    conditionalFiles,
  );
  await writeFile(path.join(conditionalRoot, "src/policy/Policy.rb"), fixed);
  const conditionalDiff = await createReviewContext(conditionalRoot, {
    ...input(),
    track: "diff",
    baseCommit: conditionalBase,
  });
  assert.ok(
    analysis(conditionalDiff).rubyBindings.omissions.includes(
      "source-encoding-unknown",
    ),
  );
  const erasedBase = structuredClone(conditionalDiff);
  analysis(erasedBase).rubyBindings.omissions = analysis(
    erasedBase,
  ).rubyBindings.omissions.filter(
    (value) => value !== "source-encoding-unknown",
  );
  assert.throws(
    () => parseReviewContext(rebound(erasedBase)),
    /omissions do not reconcile/,
  );
  const old = {
      "src/policy/Policy.rb": broken,
      "src/consumer/Consumer.rb": consumer,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await writeFile(path.join(revision, "src/policy/Policy.rb"), fixed);
  fixtureGit(revision, ["add", "--all"]);
  await writeFile(path.join(revision, "src/policy/Policy.rb"), near);
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
      captured.files.find((file) => file.path === "src/policy/Policy.rb")!
        .content,
      currentSource === "index" ? fixed : near,
    );
    assert.ok(
      value.calls
        .filter(
          (call) =>
            call.file === "src/consumer/Consumer.rb" &&
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
test("context-ruby empty acceptance", async (t) => {
  for (const source of [
    "",
    "# inert decision()\n",
    "module Broken\ndef broken(",
  ]) {
    const root = await fixture(t, { "Sample.rb": source }),
      value = analysis(
        await createReviewContext(root, input(["Sample.rb"], [], ["."])),
      );
    assert.equal(value.rubyBindings.state, "partial");
    assert.deepEqual(value.rubyBindings.callerEdges, []);
    assert.equal(value.rubyBindings.counts.resolvedCalls, 0);
  }
  const unresolved = await fixture(t, {
      "Sample.rb":
        "module Sample\n def self.useit\n Unknown.decision()\n end\nend\n",
    }),
    value = analysis(
      await createReviewContext(unresolved, input(["Sample.rb"], [], ["."])),
    );
  assert.equal(value.calls[0]!.targetFunctionId, null);
  assert.equal(value.rubyBindings.counts.unresolvedCalls, 1);
  const wide = await fixture(t, {
    "Sample.rb":
      "module Sample\n" +
      Array.from({ length: 3000 }, (_, i) => "X" + i + " = 1\n").join("") +
      "end\n",
  });
  const exhausted = analysis(
    await createReviewContext(wide, input(["Sample.rb"], [], ["."])),
  );
  assert.equal(exhausted.files[0]!.state, "budget-exhausted");
  assert.deepEqual(exhausted.rubyBindings.callerEdges, []);
  const chain =
      "module Sample\n" +
      Array.from(
        { length: 10 },
        (_, i) =>
          " def self.f" +
          i +
          "\n " +
          (i ? "f" + (i - 1) + "()" : "true") +
          "\n end\n",
      ).join("") +
      "end\n",
    chains = await fixture(t, { "Sample.rb": chain }),
    links = analysis(
      await createReviewContext(chains, input(["Sample.rb"], [], ["."])),
    ),
    f0 = links.functions.find((fn) => fn.name === "f0")!;
  assert.ok(f0);
  assert.equal(
    links.rubyBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === f0.id,
    ).length,
    8,
  );
  assert.ok(links.rubyBindings.omissions.includes("depth-limit"));
  const roots = Array.from({ length: 16 }, (_, i) => "root" + i),
    paths = roots.flatMap((root) => [root + "/First.rb", root + "/Second.rb"]),
    text = "#" + " ".repeat(32766) + "\n";
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
test("context-ruby privacy acceptance", async (t) => {
  const selection = input(),
    root = await fixture(t, {
      "src/policy/Policy.rb": fixed,
      "src/consumer/Consumer.rb": consumer,
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
    assert.equal(result.stdout.includes("rubyBindings"), flags.length > 0);
    const client = new Client(
      { name: "original-ruby-context-host", version: "1" },
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
test("context-ruby lifecycle acceptance", native, async (t) => {
  const marker = "original-side-effect.txt",
    root = await fixture(t, {
      "Sample.rb":
        'module Sample\n File.write("' +
        marker +
        '","executed")\n def self.decision\n true\n end\nend\n',
    }),
    value = analysis(
      await createReviewContext(root, input(["Sample.rb"], [], ["."])),
    );
  assert.ok(value.functions.some((fn) => fn.name === "decision"));
  await assert.rejects(access(path.join(root, marker)), { code: "ENOENT" });
  const worker = `if ARGV[0] == "child"
  sleep 60
else
  child = Process.spawn("ruby", "--disable-gems", __FILE__, "child")
  Process.detach(child)
  File.write(ARGV[0]+".pending",'{"parent":'+Process.pid.to_s+',"child":'+child.to_s+'}')
  File.rename(ARGV[0]+".pending",ARGV[0])
  if ARGV[1] == "output"
    STDOUT.write("x" * 1048576)
    STDOUT.flush
  end
  sleep 60
end
`;
  const file = path.join(root, "Worker.rb");
  await writeFile(file, worker);
  const command = (ready: string, mode: string) => ({
    executable: "ruby",
    args: ["--disable-gems", file, ready, mode],
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
      assert.ok(identities, "Reached Ruby parent and child");
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
        assert.equal(alive, false, "Reached Ruby process survived cleanup");
      }
      await assert.rejects(access(ready + ".pending"), { code: "ENOENT" });
    } finally {
      controller.abort();
      await execution;
    }
  }
  await rm(file);
  await assert.rejects(access(file), { code: "ENOENT" });
  await assert.rejects(access(path.join(root, marker)), { code: "ENOENT" });
  const legacy = await createReviewContext(root, {
    schemaVersion: 16,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["Sample.rb"],
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
test("context-ruby installed acceptance", native, async () => {
  if (process.env.CHECKTRAIL_CONTEXT_RUBY_INSTALLED === "1") {
    const runtime = await realpath(
      fileURLToPath(
        new URL("../src/review-ruby-resolution.js", import.meta.url),
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
    CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "context-ruby",
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
