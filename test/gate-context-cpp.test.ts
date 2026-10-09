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
import { runProcess } from "../src/runner.js";
import { fixture } from "./helpers.js";
import { fixtureGit, syntheticCommit } from "./git-fixture.js";
import { cppBoundariesFixture } from "./review-cpp-boundaries-fixture.js";
const prefix =
  "value[0]=='g' && value[1]=='r' && value[2]=='a' && value[3]=='n' && value[4]=='t'";
const broken =
  "static const int LIMIT=5;\nstatic int Decision(const char *value){return " +
  prefix +
  ";}\n";
const fixed =
  "static const int LIMIT=5;\nstatic int Decision(const char *value){if(" +
  prefix +
  " && (value[LIMIT]==0 || value[LIMIT]==':')){return 1;}return 0;}\n";
const near =
  "static const int LIMIT=5;\nstatic int Decision(const char *value){return " +
  prefix +
  " && value[LIMIT]==':' && ((value[6]=='r' && value[7]=='e' && value[8]=='a' && value[9]=='d' && value[10]==0) || (value[6]=='w' && value[7]=='r' && value[8]=='i' && value[9]=='t' && value[10]=='e' && value[11]==0));}\n";
const consumer =
  '#include "../policy/rules.h"\nint Submit(void){return (Decision)("grantToken");}\nint Route(void){return Decision("grant:read");}\n';
const native = {
  skip:
    spawnSync("g++", ["-dumpfullversion"], {
      encoding: "utf8",
    }).stdout?.trim() === "14.2.0"
      ? false
      : "Pinned supplementary native G++ unavailable",
  timeout: 120000,
};
const input = (
  files = ["src/policy/rules.h"],
  supportFiles = ["src/consumer/use.cpp"],
  moduleRoots = ["src"],
) => ({
  schemaVersion: 21,
  track: "snapshot",
  currentSource: "working-tree",
  files,
  supportFiles,
  moduleRoots,
  topics: [],
});
function analysis(context: ReviewContext) {
  assert.equal(context.schemaVersion, 21);
  if (context.schemaVersion !== 21)
    throw Error("Original C++ context required");
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
    "src/policy/rules.h": policy,
    "src/consumer/use.cpp": consumer,
    ".checktrail/keep": "",
  });
  const context = await createReviewContext(root, input());
  return { root, context, result: analysis(context) };
}
async function compile(root: string, source: string, name = "witness") {
  await writeFile(path.join(root, name + ".cpp"), source);
  const result = await runProcess(
    root,
    {
      executable: "g++",
      args: [
        "-std=c++20",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pedantic",
        "-O0",
        name + ".cpp",
        "-o",
        name,
      ],
      cwd: ".",
    },
    { timeoutMs: 30000, maxOutputBytes: 65536 },
  );
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.equal(result.errorCode, undefined);
  assert.equal(result.cancelled, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  return path.join(root, name);
}
async function witness(root: string) {
  const executable = await compile(
    root,
    '#include <stdio.h>\n#include "src/consumer/use.cpp"\nint main(void){const char *values[]={"grant:read","grantToken","grant2","other","grant","grant:write","g"};for(int i=0;i<7;i++)printf("%d\\n",Decision(values[i]));printf("%d\\n%d\\n",Submit(),Route());return LIMIT==5?0:1;}\n',
  );
  try {
    const result = await runProcess(
      root,
      { executable, args: [], cwd: "." },
      { timeoutMs: 10000, maxOutputBytes: 65536 },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.errorCode, undefined);
    assert.equal(result.truncated, false);
    assert.equal(result.timedOut, false);
    return result.stdout
      .trim()
      .split("\n")
      .map((value) => {
        assert.ok(value === "0" || value === "1");
        return value === "1";
      });
  } finally {
    await rm(executable, { force: true });
    await rm(path.join(root, "witness.cpp"), { force: true });
  }
}
function bindings(value: ReturnType<typeof analysis>) {
  const policy = value.functions.find(
    (fn) => fn.file === "src/policy/rules.h" && fn.name === "Decision",
  )!;
  assert.ok(policy);
  const calls = value.calls.filter((c) => c.file === "src/consumer/use.cpp");
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(
      (c) =>
        c.resolution === "lexical-binding" && c.targetFunctionId === policy.id,
    ),
  );
  assert.equal(value.modules.length, 1);
  assert.equal(value.modules[0]!.resolution, "selected");
  assert.equal(value.modules[0]!.targetFile, "src/policy/rules.h");
  assert.equal(
    value.cppBindings.callerEdges.filter(
      (e) => e.targetFunctionId === policy.id && e.depth === 1,
    ).length,
    2,
  );
  assert.equal(
    value.cppBindings.counts.calls,
    value.cppBindings.counts.resolvedCalls +
      value.cppBindings.counts.unresolvedCalls,
  );
  assert.equal(value.cppBindings.fullImpactFallback, true);
  assert.equal(value.cppBindings.runtimeReachabilityVerified, false);
  assert.equal(value.cppBindings.nativeNameResolutionVerified, false);
  assert.equal(value.cppBindings.moduleLoadingVerified, false);
  assert.equal(value.cppBindings.validationPlanUnchanged, true);
}
test("context-cpp broken acceptance", native, async (t) => {
  const { root, context, result } = await original(t);
  bindings(result);
  assert.deepEqual(await witness(root), [
    true,
    true,
    true,
    false,
    true,
    true,
    false,
    true,
    true,
  ]);
  const fn = result.functions.find((fn) => fn.name === "Decision")!,
    source = context.files.find((f) => f.path === fn.file)!;
  assert.equal(
    source.content.slice(fn.start, fn.end),
    broken.slice(broken.indexOf("static int")).trim(),
  );
  assert.equal(
    createHypothesisPlan(context).scope.runtimeReachability,
    "unknown",
  );
  const old = {
      "src/policy/rules.h": broken,
      "src/consumer/use.cpp": consumer,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await rename(
    path.join(revision, "src/consumer/use.cpp"),
    path.join(revision, "src/consumer/moved.cpp"),
  );
  await writeFile(
    path.join(revision, "src/consumer/moved.cpp"),
    '#include "../policy/rules.h"\nint Submit(int (*Decision)(const char*)){return Decision("grantToken");}\n',
  );
  await writeFile(path.join(revision, "src/policy/rules.h"), fixed);
  const captured = await createReviewContext(revision, {
      ...input(undefined, ["src/consumer/use.cpp", "src/consumer/moved.cpp"]),
      track: "diff",
      baseCommit: base,
    }),
    value = analysis(captured),
    before = value.functions.find(
      (f) => f.revision === "base" && f.name === "Decision",
    )!,
    after = value.functions.find(
      (f) => f.revision === "current" && f.name === "Decision",
    )!;
  assert.notEqual(before.id, after.id);
  assert.equal(
    value.calls.filter(
      (c) =>
        c.revision === "base" &&
        c.file === "src/consumer/use.cpp" &&
        c.targetFunctionId === before.id,
    ).length,
    2,
  );
  assert.equal(
    value.calls.filter((c) => c.file === "src/consumer/moved.cpp").length,
    1,
  );
  assert.equal(
    value.calls.find((c) => c.file === "src/consumer/moved.cpp")!
      .targetFunctionId,
    null,
  );
  assert.ok(
    value.cppBindings.callerEdges.some(
      (e) => e.revision === "base" && e.targetFunctionId === before.id,
    ),
  );
});
test("context-cpp fixed acceptance", native, async (t) => {
  const { root, context, result } = await original(t, fixed);
  bindings(result);
  assert.deepEqual(await witness(root), [
    true,
    false,
    false,
    false,
    true,
    true,
    false,
    false,
    true,
  ]);
  assert.equal(
    parseReviewContext(context).contextDigest,
    context.contextDigest,
  );
  const d = result.decisions.find(
    (d) => d.file === "src/policy/rules.h" && d.nodeType === "if_statement",
  )!;
  assert.ok(d);
  assert.equal(
    fixed.slice(d.start, d.end),
    "if(" + prefix + " && (value[LIMIT]==0 || value[LIMIT]==':')){return 1;}",
  );
  const c = result.declarations.find((d) => d.name === "LIMIT")!;
  assert.ok(c.initializer);
  assert.equal(fixed.slice(c.initializer.start, c.initializer.end), "5");
  assert.equal(
    result.references.filter((r) => r.targetDeclarationId === c.id).length,
    2,
  );
});
test("context-cpp near-miss acceptance", native, async (t) => {
  const { root, result } = await original(t, near);
  bindings(result);
  assert.deepEqual(await witness(root), [
    true,
    false,
    false,
    false,
    false,
    true,
    false,
    false,
    true,
  ]);
  await cppBoundariesFixture(t);
  const scopes = await fixture(t, {});
  const scoped = await compile(
    scopes,
    "constexpr int LIMIT=2; namespace policy{int Decision(int LIMIT=LIMIT){return LIMIT;}} namespace P=policy; int Use(int P){return P::Decision()+P;} int main(){return Use(0)==2?0:1;}\n",
    "scopes",
  );
  try {
    const ran = await runProcess(
      scopes,
      { executable: scoped, args: [], cwd: "." },
      { timeoutMs: 10000 },
    );
    assert.equal(ran.exitCode, 0, ran.stderr);
    assert.equal(ran.errorCode, undefined);
    assert.equal(ran.timedOut, false);
  } finally {
    await rm(scoped, { force: true });
  }
  for (const [name, source, expected] of [
    [
      "earlier",
      "int Decision(int LIMIT,int value=LIMIT){return LIMIT+value;}\n",
      /parameter.*LIMIT.*may not appear/,
    ],
    [
      "selfdefault",
      "int Decision(int value=Decision()){return value;}\n",
      /Decision.*not declared/,
    ],
  ] as const) {
    await writeFile(path.join(scopes, name + ".cpp"), source);
    const ran = await runProcess(
      scopes,
      {
        executable: "g++",
        args: [
          "-std=c++20",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-pedantic",
          "-c",
          name + ".cpp",
          "-o",
          name + ".o",
        ],
        cwd: ".",
      },
      { timeoutMs: 30000, maxOutputBytes: 65536 },
    );
    assert.notEqual(ran.exitCode, 0);
    assert.equal(ran.errorCode, undefined);
    assert.equal(ran.truncated, false);
    assert.match(ran.stderr, expected);
  }
  const lexical = await fixture(t, {});
  const executable = await compile(
    lexical,
    "static int Decision(void){return 1;}static int Zero(void){return 0;}int main(void){int first=Decision();int (*Decision)(void)=Zero;return first && !Decision()?0:1;}\n",
  );
  try {
    const ran = await runProcess(
      lexical,
      { executable, args: [], cwd: "." },
      { timeoutMs: 10000 },
    );
    assert.equal(ran.exitCode, 0, ran.stderr);
    assert.equal(ran.errorCode, undefined);
  } finally {
    await rm(executable, { force: true });
  }
  const factory = await fixture(t, {});
  const nested = await compile(
    factory,
    "static int Answer(void){return 1;}static int (*Factory(void))(void){return Answer;}int main(void){return Factory()()?0:1;}\n",
  );
  try {
    const ran = await runProcess(
      factory,
      { executable: nested, args: [], cwd: "." },
      { timeoutMs: 10000 },
    );
    assert.equal(ran.exitCode, 0, ran.stderr);
    assert.equal(ran.errorCode, undefined);
  } finally {
    await rm(nested, { force: true });
  }
});
test("context-cpp prerequisite acceptance", async (t) => {
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
  assert.equal(outside.cppBindings.state, "partial");
  assert.ok(outside.cppBindings.omissions.includes("outside-module-roots"));
  assert.ok(outside.calls.every((c) => c.targetFunctionId === null));
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
      path: "sample.cpp",
      content: "int Decision(void){return 1;}\n",
      sha256: hash("int Decision(void){return 1;}\n"),
    };
  const missing = await isolated.collectReviewCppBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(missing.files[0]!.state, "error");
  assert.deepEqual(missing.functions, []);
  await mkdir(path.join(copied, "assets/context-grammars"), {
    recursive: true,
  });
  const bytes = await readFile(
      path.join(
        await realpath(path.join(repository, "dist/src")),
        "../../assets/context-grammars/tree-sitter-cpp.wasm",
      ),
    ),
    altered = Buffer.from(bytes),
    position = altered.indexOf(Buffer.from("tree_sitter_cpp"));
  assert.notEqual(position, -1);
  altered[position + "tree_sitter_".length] = "s".charCodeAt(0);
  assert.doesNotThrow(() => new WebAssembly.Module(altered));
  const asset = path.join(
    copied,
    "assets/context-grammars/tree-sitter-cpp.wasm",
  );
  await writeFile(asset, altered);
  const changed = await isolated.collectReviewCppBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(changed.files[0]!.state, "error");
  assert.deepEqual(changed.calls, []);
  await writeFile(asset, bytes);
  const restored = await isolated.collectReviewCppBehavior(
    [source],
    [],
    [source.path],
    false,
    ["."],
  );
  assert.equal(restored.files[0]!.state, "collected");
  assert.equal(restored.functions.length, 1);
  const unavailable = await runProcess(
    root,
    { executable: path.join(root, "missing-original-cpp"), args: [], cwd: "." },
    { timeoutMs: 1000 },
  );
  assert.equal(unavailable.errorCode, "ENOENT");
  assert.notEqual(unavailable.exitCode, 0);
});
test("context-cpp stale acceptance", async (t) => {
  const { context } = await original(t, fixed);
  for (const [mutate, message] of [
    [
      (v: ReturnType<typeof analysis>) => {
        v.cppBindings.moduleRoots = ["elsewhere"];
      },
      /roots differ/,
    ],
    [
      (v: ReturnType<typeof analysis>) => {
        v.cppBindings.counts.resolvedCalls++;
      },
      /counts do not reconcile/,
    ],
    [
      (v: ReturnType<typeof analysis>) => {
        v.cppBindings.callerEdges = [];
      },
      /closure does not reconcile/,
    ],
    [
      (v: ReturnType<typeof analysis>) => {
        v.cppBindings.omissions = [];
      },
      /omissions do not reconcile/,
    ],
    [
      (v: ReturnType<typeof analysis>) => {
        v.grammarManifestDigest = "0".repeat(64);
      },
      /anchors/,
    ],
  ] as const) {
    const forged = structuredClone(context);
    mutate(analysis(forged));
    assert.throws(() => parseReviewContext(rebound(forged)), message);
  }
  const stale = structuredClone(context);
  stale.files[0]!.content += " ";
  assert.throws(() => parseReviewContext(rebound(stale)), /source/);
  const revision = await fixture(t, {
    "sample.cpp": "#define unseen 1\n" + broken,
  });
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, {
    "sample.cpp": "#define unseen 1\n" + broken,
  });
  await writeFile(path.join(revision, "sample.cpp"), fixed);
  const conditional = await createReviewContext(revision, {
    ...input(["sample.cpp"], [], ["."]),
    track: "diff",
    baseCommit: base,
  });
  const erased = structuredClone(conditional);
  analysis(erased).cppBindings.omissions = analysis(
    erased,
  ).cppBindings.omissions.filter((o) => o !== "preprocessor-source-unknown");
  assert.throws(() => parseReviewContext(rebound(erased)), /omissions/);
  const old = {
      "src/policy/rules.h": broken,
      "src/consumer/use.cpp": consumer,
    },
    root = await fixture(t, old);
  fixtureGit(root, ["init", "--quiet"]);
  const oldBase = await syntheticCommit(root, old);
  await writeFile(path.join(root, "src/policy/rules.h"), fixed);
  fixtureGit(root, ["add", "src/policy/rules.h"]);
  await writeFile(path.join(root, "src/policy/rules.h"), near);
  for (const currentSource of ["index", "working-tree"]) {
    const captured = await createReviewContext(root, {
        ...input(),
        track: "diff",
        baseCommit: oldBase,
        currentSource,
      }),
      value = analysis(captured),
      before = value.functions.find(
        (f) => f.revision === "base" && f.name === "Decision",
      )!,
      after = value.functions.find(
        (f) => f.revision === "current" && f.name === "Decision",
      )!;
    assert.notEqual(before.id, after.id);
    assert.equal(
      captured.files.find((f) => f.path === "src/policy/rules.h")!.content,
      currentSource === "index" ? fixed : near,
    );
    assert.equal(
      value.calls.filter((c) => c.file === "src/consumer/use.cpp").length,
      4,
    );
    assert.ok(
      value.calls
        .filter((c) => c.file === "src/consumer/use.cpp")
        .every(
          (c) =>
            c.targetFunctionId ===
            (c.revision === "base" ? before.id : after.id),
        ),
    );
  }
});
test("context-cpp empty acceptance", async (t) => {
  for (const source of [
    "",
    "// inert Decision()\n",
    "int Broken(",
    "int Use(void){return Deci\\\nsion();}",
  ]) {
    const root = await fixture(t, { "sample.cpp": source }),
      value = analysis(
        await createReviewContext(root, input(["sample.cpp"], [], ["."])),
      );
    assert.equal(value.cppBindings.state, "partial");
    assert.deepEqual(value.cppBindings.callerEdges, []);
    assert.equal(value.cppBindings.counts.resolvedCalls, 0);
  }
  const wide = await fixture(t, {
      "sample.cpp": Array.from(
        { length: 3000 },
        (_, i) => "const int x" + i + "=1;\n",
      ).join(""),
    }),
    exhausted = analysis(
      await createReviewContext(wide, input(["sample.cpp"], [], ["."])),
    );
  assert.equal(exhausted.files[0]!.state, "budget-exhausted");
  assert.deepEqual(exhausted.cppBindings.callerEdges, []);
  const chain = Array.from(
      { length: 10 },
      (_, i) =>
        "int f" +
        i +
        "(void){return " +
        (i ? "f" + (i - 1) + "()" : "1") +
        ";}\n",
    ).join(""),
    root = await fixture(t, { "sample.cpp": chain }),
    links = analysis(
      await createReviewContext(root, input(["sample.cpp"], [], ["."])),
    ),
    f0 = links.functions.find((f) => f.name === "f0")!;
  assert.equal(
    links.cppBindings.callerEdges.filter((e) => e.targetFunctionId === f0.id)
      .length,
    8,
  );
  assert.ok(links.cppBindings.omissions.includes("depth-limit"));
  const roots = Array.from({ length: 16 }, (_, i) => "root" + i),
    paths = roots.flatMap((root) => [
      root + "/first.cpp",
      root + "/second.cpp",
    ]),
    text = "/*" + " ".repeat(32764) + "*/";
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
  assert.ok(analysis(full).files.every((f) => f.state === "collected"));
  const forged = structuredClone(full),
    source = forged.files[0]!;
  source.content += " ";
  source.sha256 = hash(source.content);
  analysis(forged).files.find((f) => f.file === source.path)!.sha256 =
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
test("context-cpp privacy acceptance", async (t) => {
  const selection = input(),
    root = await fixture(t, {
      "src/policy/rules.h": fixed,
      "src/consumer/use.cpp": consumer,
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
    assert.equal(result.stdout.includes("cppBindings"), flags.length > 0);
    const client = new Client(
      { name: "original-cpp-context-host", version: "1" },
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
test("context-cpp lifecycle acceptance", native, async (t) => {
  const root = await fixture(t, {});
  const worker = await compile(
    root,
    '#define _POSIX_C_SOURCE 200809L\n#include <unistd.h>\n#include <sys/wait.h>\n#include <signal.h>\n#include <stdio.h>\n#include <string.h>\n#include <time.h>\nstatic void sleep_short(void){struct timespec ts={0,10000000};nanosleep(&ts,0);}\nint main(int argc,char **argv){if(argc!=2)return 2;pid_t child=fork();if(child<0)return 3;if(child==0){FILE *f=fopen("child.pending","w");if(!f)return 4;fprintf(f,"%ld\\n",(long)getpid());fclose(f);if(rename("child.pending","child.ready"))return 5;while(access("worker.release",F_OK))sleep_short();if(!strcmp(argv[1],"output")){char bytes[4096];memset(bytes,\'x\',sizeof bytes);for(;;){if(write(STDOUT_FILENO,bytes,sizeof bytes)<0)return 0;}}for(;;)pause();}signal(SIGTERM,SIG_IGN);while(access("child.ready",F_OK))sleep_short();FILE *f=fopen("parent.pending","w");if(!f)return 6;fprintf(f,"{\\"parent\\":%ld,\\"child\\":%ld}",(long)getpid(),(long)child);fclose(f);if(rename("parent.pending","parent.ready"))return 7;int status=0;while(waitpid(child,&status,0)<0)sleep_short();return 0;}\n',
    "worker",
  );
  const ready = path.join(root, "parent.ready");
  async function reached() {
    for (let i = 0; i < 300; i++) {
      try {
        const ids = JSON.parse(await readFile(ready, "utf8")) as {
          parent: number;
          child: number;
        };
        assert.ok(ids.parent > 0 && ids.child > 0 && ids.parent !== ids.child);
        assert.equal(
          Number(
            (await readFile(path.join(root, "child.ready"), "utf8")).trim(),
          ),
          ids.child,
        );
        process.kill(ids.parent, 0);
        process.kill(ids.child, 0);
        return ids;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await delay(10);
      }
    }
    throw Error("Original C++ parent and child never reached");
  }
  async function absent(ids: { parent: number; child: number }) {
    for (const pid of [ids.child, ids.parent]) {
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(pid, 0);
          await delay(10);
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
          break;
        }
      }
      assert.throws(
        () => process.kill(pid, 0),
        (error) => (error as NodeJS.ErrnoException).code === "ESRCH",
      );
    }
  }
  const artifacts = [
    "worker.release",
    "parent.ready",
    "child.ready",
    "parent.pending",
    "child.pending",
  ];
  try {
    for (const mode of ["cancel", "timeout", "output"]) {
      const abort = new AbortController(),
        pending = runProcess(
          root,
          { executable: worker, args: [mode], cwd: "." },
          {
            timeoutMs: mode === "timeout" ? 1000 : 5000,
            maxOutputBytes: mode === "output" ? 1024 : 65536,
            signal: abort.signal,
          },
        );
      try {
        const ids = await reached();
        await writeFile(path.join(root, "worker.release"), "go");
        if (mode === "cancel") abort.abort();
        const result = await pending;
        assert.equal(result.errorCode, undefined, JSON.stringify(result));
        assert.equal(result.cancelled, mode === "cancel");
        assert.equal(result.timedOut, mode === "timeout");
        assert.equal(result.truncated, mode === "output");
        if (mode === "output")
          assert.equal(Buffer.byteLength(result.stdout), 1024);
        await absent(ids);
      } finally {
        abort.abort();
        await pending;
      }
      for (const file of artifacts)
        await rm(path.join(root, file), { force: true });
      for (const file of artifacts)
        await assert.rejects(
          access(path.join(root, file)),
          (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
        );
    }
    const aborted = new AbortController();
    aborted.abort();
    const result = await runProcess(
      root,
      { executable: worker, args: ["cancel"], cwd: "." },
      { timeoutMs: 1000, signal: aborted.signal },
    );
    assert.equal(result.cancelled, true);
    assert.notEqual(result.exitCode, 0);
    await assert.rejects(
      access(ready),
      (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  } finally {
    for (const file of [...artifacts, "worker", "worker.cpp"])
      await rm(path.join(root, file), { force: true });
  }
  for (const file of [...artifacts, "worker", "worker.cpp"])
    await assert.rejects(
      access(path.join(root, file)),
      (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
});
test("context-cpp installed acceptance", native, async () => {
  if (process.env.CHECKTRAIL_CONTEXT_CPP_INSTALLED === "1") {
    const runtime = await realpath(
      fileURLToPath(
        new URL("../src/review-cpp-resolution.js", import.meta.url),
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
    CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "context-cpp",
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
