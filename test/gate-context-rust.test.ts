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
  'pub const FALLBACK: &str = "grant";\npub fn decision(value: &str) -> bool { value.starts_with(FALLBACK) }\n';
const fixed =
  'pub const FALLBACK: &str = "grant";\npub fn decision(value: &str) -> bool { value == FALLBACK || value.starts_with(&(FALLBACK.to_owned() + ":")) }\n';
const near =
  'pub const FALLBACK: &str = "grant";\npub fn decision(value: &str) -> bool { value == "grant:read" || value == "grant:write" }\n';
const entry = "pub mod policy; pub mod consumer;\n";
const consumer =
  'use crate::policy::{decision as choose, FALLBACK};\npub fn submit() -> bool { choose("grantToken") }\npub fn route() -> bool { crate::policy::decision(FALLBACK) }\n';
const native = {
  skip: /^rustc 1\.98\.1\b/.test(
    spawnSync("rustc", ["--version"], { encoding: "utf8" }).stdout ?? "",
  )
    ? false
    : "Pinned native Rust unavailable",
  timeout: 120000,
};
const input = (
  files = ["src/policy.rs"],
  supportFiles = ["src/consumer.rs", "src/lib.rs"],
  crateRoots = ["src/lib.rs"],
) => ({
  schemaVersion: 11,
  track: "snapshot",
  currentSource: "working-tree",
  files,
  supportFiles,
  topics: [],
  crateRoots,
});
function analysis(context: ReviewContext) {
  assert.equal(context.schemaVersion, 11);
  if (context.schemaVersion !== 11) throw Error("Original version 11 required");
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
    "src/policy.rs": policy,
    "src/consumer.rs": consumer,
    "src/lib.rs": entry,
    ".checktrail/keep": "",
  });
  const context = await createReviewContext(root, input());
  return { root, context, result: analysis(context) };
}
async function compile(root: string, source: string, name = "native-witness") {
  await writeFile(path.join(root, name + ".rs"), source);
  const executable = path.join(root, name);
  const result = await runProcess(
    root,
    {
      executable: "rustc",
      args: [
        "--edition=2024",
        "--crate-name",
        "original_control",
        "-A",
        "dead_code",
        name + ".rs",
        "-o",
        executable,
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
  return executable;
}
async function witness(root: string) {
  const executable = await compile(
    root,
    'mod policy { include!("src/policy.rs"); } fn main(){let values=["grant:read","grantToken","grant2","other"]; let answers:Vec<bool>=values.iter().map(|value|policy::decision(value)).collect();println!("{:?}",answers);}',
  );
  try {
    const result = await runProcess(
      root,
      { executable, args: [], cwd: "." },
      { timeoutMs: 10000, maxOutputBytes: 65536 },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.errorCode, undefined);
    assert.equal(result.stderr, "");
    assert.equal(result.truncated, false);
    assert.equal(result.timedOut, false);
    return JSON.parse(result.stdout);
  } finally {
    await rm(executable);
    await rm(path.join(root, "native-witness.rs"));
  }
}
function bindings(result: ReturnType<typeof analysis>) {
  const policy = result.functions.find(
    (fn) => fn.file === "src/policy.rs" && fn.name === "decision",
  )!;
  assert.ok(policy);
  const calls = result.calls.filter((call) => call.file === "src/consumer.rs");
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(
      (call) =>
        call.resolution === "lexical-binding" &&
        call.targetFunctionId === policy.id,
    ),
  );
  assert.equal(result.modules.length, 4);
  assert.ok(result.modules.every((value) => value.resolution === "selected"));
  assert.equal(
    result.rustBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === policy.id && edge.depth === 1,
    ).length,
    2,
  );
  assert.equal(
    result.rustBindings.counts.calls,
    result.rustBindings.counts.resolvedCalls +
      result.rustBindings.counts.unresolvedCalls,
  );
  assert.equal(
    result.rustBindings.counts.imports,
    result.rustBindings.counts.resolvedImports +
      result.rustBindings.counts.unresolvedImports,
  );
  assert.equal(result.rustBindings.fullImpactFallback, true);
  assert.equal(result.rustBindings.runtimeReachabilityVerified, false);
  assert.equal(result.rustBindings.nativeNameResolutionVerified, false);
  assert.equal(result.rustBindings.moduleLoadingVerified, false);
  assert.equal(result.rustBindings.validationPlanUnchanged, true);
}

test("context-rust broken acceptance", native, async (t) => {
  const { root, context, result } = await original(t);
  bindings(result);
  assert.deepEqual(await witness(root), [true, true, true, false]);
  const fn = result.functions.find((fn) => fn.name === "decision")!,
    file = context.files.find((file) => file.path === fn.file)!;
  assert.equal(
    file.content.slice(fn.start, fn.end),
    broken.slice(broken.indexOf("pub fn")).trim(),
  );
  const constant = result.declarations.find(
    (value) => value.name === "FALLBACK",
  )!;
  assert.ok(constant.initializer);
  assert.equal(
    file.content.slice(constant.initializer.start, constant.initializer.end),
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
      "src/policy.rs": broken,
      "src/consumer.rs": consumer,
      "src/lib.rs": entry,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await rename(
    path.join(revision, "src/consumer.rs"),
    path.join(revision, "src/moved.rs"),
  );
  await writeFile(
    path.join(revision, "src/lib.rs"),
    "pub mod policy; pub mod moved;",
  );
  await writeFile(
    path.join(revision, "src/moved.rs"),
    'use crate::policy::decision as choose; pub fn submit(choose:fn(&str)->bool)->bool{choose("grantToken")}',
  );
  await writeFile(path.join(revision, "src/policy.rs"), fixed);
  const captured = await createReviewContext(revision, {
      ...input(undefined, ["src/consumer.rs", "src/moved.rs", "src/lib.rs"]),
      track: "diff",
      baseCommit: base,
    }),
    value = analysis(captured);
  assert.equal(
    value.calls.filter(
      (call) =>
        call.revision === "base" &&
        call.file === "src/consumer.rs" &&
        call.resolution === "lexical-binding",
    ).length,
    2,
  );
  assert.equal(
    value.calls.find(
      (call) => call.revision === "current" && call.file === "src/moved.rs",
    )!.targetFunctionId,
    null,
  );
  if (captured.schemaVersion !== 11 || captured.evidence.track !== "diff")
    throw Error("Diff required");
  assert.equal(
    captured.evidence.baseFiles.find((file) => file.path === "src/policy.rs")!
      .content,
    broken,
  );
});
test("context-rust fixed acceptance", native, async (t) => {
  const { root, context, result } = await original(t, fixed);
  bindings(result);
  assert.deepEqual(await witness(root), [true, false, false, false]);
  assert.equal(
    parseReviewContext(context).contextDigest,
    context.contextDigest,
  );
  const fn = result.functions.find((fn) => fn.name === "decision")!,
    source = context.files.find((file) => file.path === fn.file)!;
  assert.equal(
    source.content.slice(fn.start, fn.end),
    fixed.slice(fixed.indexOf("pub fn")).trim(),
  );
});
test("context-rust near-miss acceptance", native, async (t) => {
  const { root } = await original(t, near);
  assert.deepEqual(await witness(root), [true, false, false, false]);
  const cases: [string, string][] = [
    [
      'fn useit(choose:fn(&str)->bool)->bool{choose("x")}',
      "unsupported-dispatch",
    ],
    ['fn useit(p:u8)->bool{p::decision("x")}', "lexical-binding"],
    ['fn useit()->bool{(choose)("x")}', "lexical-binding"],
    ['fn useit()->bool{choose_extra("x")}', "no-selected-definition"],
    ['fn useit()->bool{CHOOSE("x")}', "no-selected-definition"],
    ['fn useit<T>()->bool{choose("x")}', "unsupported-dispatch"],
    ['fn useit()->bool{p::decision::<u8>("x")}', "unsupported-dispatch"],
    ['fn useit(obj:&Thing)->bool{obj.decision("x")}', "unsupported-dispatch"],
    ['fn useit()->bool{type p=u8;p::decision("x")}', "unsupported-dispatch"],
    ['fn useit()->bool{type choose=u8;choose("x")}', "lexical-binding"],
    ['fn useit()->bool{let closure=||choose("x");false}', "lexical-binding"],
    [
      'fn useit()->bool{let closure=|choose|choose("x");false}',
      "unsupported-dispatch",
    ],
    ['fn useit()->bool{choose("x")} // choose_extra("x")', "lexical-binding"],
  ];
  for (const [body, resolution] of cases) {
    const text = "use crate::policy::{self as p,decision as choose};\n" + body;
    await writeFile(path.join(root, "src/consumer.rs"), text);
    const captured = await createReviewContext(root, input());
    assert.equal(
      parseReviewContext(captured).contextDigest,
      captured.contextDigest,
    );
    const value = analysis(captured),
      call = value.calls.find((call) => call.file === "src/consumer.rs")!;
    assert.ok(call, body);
    assert.equal(call.resolution, resolution, body);
    if (resolution !== "lexical-binding")
      assert.equal(call.targetFunctionId, null);
  }
  const local =
    "fn decision()->bool{true} fn useit(){let decision=decision();decision();} fn other(){let decision=false;fn nested(){decision();} nested();}";
  const lexical = await fixture(t, { "scope.rs": local }),
    value = analysis(
      await createReviewContext(lexical, input(["scope.rs"], [], ["scope.rs"])),
    );
  const calls = value.calls.filter(
    (call) => local.slice(call.start, call.end) === "decision()",
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.resolution, "lexical-binding");
  assert.equal(calls[1]!.targetFunctionId, null);
  assert.equal(
    calls[2]!.targetFunctionId,
    null,
    "An inaccessible outer local still prevents a guessed function link",
  );
  const constructor =
    "fn decision(_value:bool)->bool{true} fn useit(){struct decision(bool); let converted=decision(false);}";
  const constructors = await fixture(t, { "constructors.rs": constructor });
  const constructorContext = analysis(
    await createReviewContext(
      constructors,
      input(["constructors.rs"], [], ["constructors.rs"]),
    ),
  );
  assert.equal(
    constructorContext.calls[0]!.targetFunctionId,
    null,
    "Tuple constructors occupy the value namespace",
  );
  for (const [body, expected] of [
    ["struct decision; let converted=decision(false);", "unsupported-dispatch"],
    ["struct decision{} let converted=decision(false);", "lexical-binding"],
    ["let _=decision(false);", "lexical-binding"],
  ] as const) {
    const source =
      "fn decision(_value:bool)->bool{true} fn useit(){" + body + "}";
    await writeFile(path.join(constructors, "constructors.rs"), source);
    const captured = analysis(
      await createReviewContext(
        constructors,
        input(["constructors.rs"], [], ["constructors.rs"]),
      ),
    );
    assert.equal(captured.calls[0]!.resolution, expected, body);
  }
  const labels = await fixture(t, {
    "labels.rs":
      "const FALLBACK:u8=1; fn useit(){'FALLBACK: loop{break 'FALLBACK;}let value=FALLBACK;}",
  });
  const labelContext = analysis(
    await createReviewContext(labels, input(["labels.rs"], [], ["labels.rs"])),
  );
  assert.equal(
    labelContext.references.length,
    1,
    "Label names are not constant reads",
  );
  const lifetimes = await fixture(t, {
    "lifetimes.rs":
      "const FALLBACK:u8=1; fn useit<'FALLBACK>(value:&'FALLBACK u8){}",
  });
  const lifetimeContext = analysis(
    await createReviewContext(
      lifetimes,
      input(["lifetimes.rs"], [], ["lifetimes.rs"]),
    ),
  );
  assert.equal(
    lifetimeContext.references.length,
    0,
    "Lifetime names are not constant reads",
  );
  await writeFile(
    path.join(constructors, "inaccessible.rs"),
    "fn decision(_value:bool)->bool{true} fn main(){let decision=false;fn inside()->bool{decision(false)}let observed=inside();}",
  );
  try {
    const inaccessible = await runProcess(
      constructors,
      {
        executable: "rustc",
        args: [
          "--edition=2024",
          "--crate-name",
          "original_inaccessible",
          "inaccessible.rs",
          "-o",
          path.join(constructors, "inaccessible"),
        ],
        cwd: ".",
      },
      { timeoutMs: 30000, maxOutputBytes: 65536 },
    );
    assert.equal(inaccessible.exitCode, 1);
    assert.match(inaccessible.stderr, /error\[E0434\]/);
    assert.equal(inaccessible.truncated, false);
    await assert.rejects(access(path.join(constructors, "inaccessible")), {
      code: "ENOENT",
    });
  } finally {
    await rm(path.join(constructors, "inaccessible.rs"), { force: true });
  }
  const namespaceExecutable = await compile(
    constructors,
    'fn decision(_value:bool)->bool{true} fn nested()->bool{let unrelated=false; fn inside()->bool{decision(false)} inside()} fn record()->bool{struct decision{} decision(false)} fn main(){struct decision(bool);let converted=decision(false);println!("{}",converted.0);println!("{}",record());println!("{}",nested());}',
    "namespace-witness",
  );
  try {
    const observed = await runProcess(
      constructors,
      { executable: namespaceExecutable, args: [], cwd: "." },
      { timeoutMs: 10000, maxOutputBytes: 65536 },
    );
    assert.equal(observed.exitCode, 0, observed.stderr);
    assert.equal(observed.truncated, false);
    assert.equal(observed.stdout, "false\ntrue\ntrue\n");
  } finally {
    await rm(namespaceExecutable, { force: true });
    await rm(path.join(constructors, "namespace-witness.rs"), { force: true });
  }
  for (const [rootSource, policySource] of [
    [
      "mod policy;fn useit(){policy::decision();}",
      '#![cfg(feature="other")] pub fn decision(){}',
    ],
    [
      'mod policy {#![cfg(feature="other")]pub fn decision(){}} fn useit(){policy::decision();}',
      null,
    ],
  ] as const) {
    const selected = await fixture(t, {
      "root.rs": rootSource,
      ...(policySource === null ? {} : { "policy.rs": policySource }),
    });
    const captured = analysis(
      await createReviewContext(
        selected,
        input(["root.rs"], policySource === null ? [] : ["policy.rs"], [
          "root.rs",
        ]),
      ),
    );
    assert.equal(
      captured.calls[0]!.targetFunctionId,
      null,
      "Unknown target module attributes remain unresolved",
    );
  }
  const shared = await fixture(t, {
    "root.rs": "mod policy;fn useit(){policy::decision();}",
    "other.rs": "mod policy;",
    "policy.rs": "pub fn decision(){}",
  });
  const repeated = analysis(
    await createReviewContext(
      shared,
      input(["policy.rs"], ["root.rs", "other.rs"], ["root.rs", "other.rs"]),
    ),
  );
  assert.ok(
    repeated.rustBindings.omissions.includes("ambiguous-definition"),
    "Multi-root memberships stay ambiguous",
  );
  for (const prefix of [
    "use crate::policy::*;",
    '#[cfg(feature="other")]',
    "macro_rules! unknown {()=>{}} unknown!();",
  ]) {
    const contents =
      prefix + '\nfn useit()->bool{crate::policy::decision("x")}';
    await writeFile(path.join(root, "src/consumer.rs"), contents);
    const unknown = analysis(await createReviewContext(root, input()));
    assert.equal(
      unknown.calls.find((call) => call.file === "src/consumer.rs")!
        .targetFunctionId,
      null,
      prefix,
    );
  }
  const inline = await fixture(t, {
    "root.rs":
      "mod policy {pub fn decision()->bool{true}} mod consumer {use super::policy::decision as choose; fn useit()->bool{choose()}}",
  });
  const nested = analysis(
    await createReviewContext(inline, input(["root.rs"], [], ["root.rs"])),
  );
  assert.equal(nested.calls[0]!.resolution, "lexical-binding");
  const missing = await fixture(t, {
    "root.rs": "mod absent;fn useit(){absent::decision();}",
    "unused.rs": "fn decision(){}",
  });
  const absent = analysis(
    await createReviewContext(
      missing,
      input(["root.rs"], ["unused.rs"], ["root.rs"]),
    ),
  );
  assert.equal(absent.modules[0]!.resolution, "missing");
  assert.equal(absent.calls[0]!.targetFunctionId, null);
  assert.ok(absent.rustBindings.omissions.includes("outside-crate-roots"));
  const duplicate = await fixture(t, {
    "root.rs": "mod policy;fn useit(){policy::decision();}",
    "policy.rs": "pub fn decision(){}",
    "policy/mod.rs": "pub fn decision(){}",
  });
  const ambiguous = analysis(
    await createReviewContext(
      duplicate,
      input(["root.rs"], ["policy.rs", "policy/mod.rs"], ["root.rs"]),
    ),
  );
  assert.equal(ambiguous.modules[0]!.resolution, "ambiguous");
  assert.equal(ambiguous.calls[0]!.targetFunctionId, null);
  const excluded = await fixture(t, { "vendor/copied.rs": fixed });
  await assert.rejects(
    createReviewContext(
      excluded,
      input(["vendor/copied.rs"], [], ["vendor/copied.rs"]),
    ),
    /excluded/,
  );
});
test("context-rust prerequisite acceptance", async (t) => {
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
    await createReviewContext(
      root,
      input(undefined, undefined, ["elsewhere.rs"]),
    ),
  );
  assert.equal(absent.rustBindings.state, "partial");
  assert.ok(absent.rustBindings.omissions.includes("outside-crate-roots"));
  const unsupported = await fixture(t, {
    "unsupported.vb": "Module Original\nEnd Module\n",
  });
  const value = analysis(
    await createReviewContext(unsupported, input(["unsupported.vb"], [])),
  );
  assert.equal(value.files[0]!.state, "unsupported");
  assert.equal(value.rustBindings.state, "partial");
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
  const source = { path: "sample.rs", content: fixed, sha256: hash(fixed) };
  const unavailable = await isolated.collectReviewRustBehavior(
    [source],
    [],
    [source.path],
    false,
    ["sample.rs"],
  );
  assert.equal(unavailable.files[0]!.state, "error");
  assert.equal(unavailable.rustBindings.state, "partial");
  assert.deepEqual(unavailable.functions, []);
  await mkdir(path.join(copied, "assets/context-grammars"), {
    recursive: true,
  });
  const bytes = await readFile(
    path.join(
      await realpath(path.join(repository, "dist/src")),
      "../../assets/context-grammars/tree-sitter-rust.wasm",
    ),
  );
  const altered = Buffer.from(bytes),
    position = altered.indexOf(Buffer.from("tree_sitter_rust"));
  assert.notEqual(position, -1);
  altered[position + "tree_sitter_rus".length] = "s".charCodeAt(0);
  assert.doesNotThrow(() => new WebAssembly.Module(altered));
  const asset = path.join(
    copied,
    "assets/context-grammars/tree-sitter-rust.wasm",
  );
  await writeFile(asset, altered);
  const changed = await isolated.collectReviewRustBehavior(
    [source],
    [],
    [source.path],
    false,
    ["sample.rs"],
  );
  assert.equal(changed.files[0]!.state, "error");
  assert.deepEqual(changed.calls, []);
  await writeFile(asset, bytes);
  const restored = await isolated.collectReviewRustBehavior(
    [source],
    [],
    [source.path],
    false,
    ["sample.rs"],
  );
  assert.equal(restored.files[0]!.state, "collected");
  assert.equal(restored.functions.length, 1);
  const missing = await runProcess(
    root,
    {
      executable: path.join(root, "missing-original-rust"),
      args: ["--version"],
      cwd: ".",
    },
    { timeoutMs: 1000 },
  );
  assert.equal(missing.errorCode, "ENOENT");
  assert.notEqual(missing.exitCode, 0);
});
test("context-rust stale acceptance", async (t) => {
  const { root, context } = await original(t);
  for (const [mutate, message] of [
    [
      (value: ReturnType<typeof analysis>) => {
        value.rustBindings.crateRoots = ["elsewhere.rs"];
      },
      /crate roots differ/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.rustBindings.counts.resolvedCalls++;
      },
      /counts do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.rustBindings.callerEdges = [];
      },
      /closure does not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.rustBindings.omissions = [];
      },
      /omissions do not reconcile/,
    ],
    [
      (value: ReturnType<typeof analysis>) => {
        value.rustBindings.state = "collected";
      },
      /omissions do not reconcile/,
    ],
  ] as const) {
    const forged = structuredClone(context);
    mutate(analysis(forged));
    assert.throws(() => parseReviewContext(rebound(forged)), message);
  }
  const absentContext = await createReviewContext(
    root,
    input(undefined, undefined, ["elsewhere.rs"]),
  );
  const absentForged = structuredClone(absentContext);
  analysis(absentForged).rustBindings.omissions = analysis(
    absentForged,
  ).rustBindings.omissions.filter((value) => value !== "missing-crate-root");
  assert.throws(
    () => parseReviewContext(rebound(absentForged)),
    /omissions do not reconcile/,
  );
  const engine = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const id = (await engine.open(context)).workflowId;
    await writeFile(
      path.join(root, "src/consumer.rs"),
      consumer + "// changed\n",
    );
    await engine.next(id);
    assert.equal(engine.status(id).status, "stale");
  } finally {
    engine.dispose();
  }
  const old = {
      "src/policy.rs": broken,
      "src/consumer.rs": consumer,
      "src/lib.rs": entry,
    },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await writeFile(path.join(revision, "src/policy.rs"), fixed);
  fixtureGit(revision, ["add", "--all"]);
  await writeFile(path.join(revision, "src/policy.rs"), near);
  for (const currentSource of ["working-tree", "index"] as const) {
    const captured = await createReviewContext(revision, {
        ...input(),
        track: "diff",
        baseCommit: base,
        currentSource,
      }),
      value = analysis(captured);
    const before = value.functions.find(
        (fn) => fn.revision === "base" && fn.name === "decision",
      )!,
      after = value.functions.find(
        (fn) => fn.revision === "current" && fn.name === "decision",
      )!;
    assert.notEqual(before.id, after.id);
    assert.equal(
      captured.files.find((file) => file.path === "src/policy.rs")!.content,
      currentSource === "index" ? fixed : near,
    );
    assert.ok(
      value.calls
        .filter((call) => call.file === "src/consumer.rs")
        .every(
          (call) =>
            call.targetFunctionId ===
            (call.revision === "base" ? before.id : after.id),
        ),
    );
  }
});
test("context-rust empty acceptance", async (t) => {
  for (const text of ["", "// inert decision()\n", "fn ("]) {
    const root = await fixture(t, { "sample.rs": text }),
      value = analysis(
        await createReviewContext(root, input(["sample.rs"], [])),
      );
    assert.equal(value.rustBindings.state, "partial");
    assert.deepEqual(value.rustBindings.callerEdges, []);
    assert.equal(value.rustBindings.counts.resolvedCalls, 0);
  }
  const wide = await fixture(t, {
    "wide.rs":
      "" +
      Array.from({ length: 3000 }, (_, i) => "const X" + i + ":i32=1;\n").join(
        "",
      ),
  });
  const exhausted = analysis(
    await createReviewContext(wide, input(["wide.rs"], [])),
  );
  assert.equal(exhausted.files[0]!.state, "budget-exhausted");
  assert.deepEqual(exhausted.rustBindings.callerEdges, []);
  const chain = Array.from(
    { length: 10 },
    (_, i) =>
      "fn F" + i + "()->bool{" + (i ? "F" + (i - 1) + "()" : "true") + "}\n",
  ).join("");
  const chains = await fixture(t, { "chain.rs": chain }),
    value = analysis(
      await createReviewContext(chains, input(["chain.rs"], [], ["chain.rs"])),
    );
  const f0 = value.functions.find((fn) => fn.name === "F0")!;
  assert.equal(
    value.rustBindings.callerEdges.filter(
      (edge) => edge.targetFunctionId === f0.id,
    ).length,
    8,
  );
  assert.ok(value.rustBindings.omissions.includes("depth-limit"));
  const roots = Array.from({ length: 16 }, (_, i) => "root" + i),
    paths = roots.flatMap((root) => [root + "/first.rs", root + "/second.rs"]),
    text = "//" + " ".repeat(32768 - 3) + "\n";
  assert.equal(Buffer.byteLength(text), 32768);
  const boundary = await fixture(
      t,
      Object.fromEntries(paths.map((file) => [file, text])),
    ),
    full = await createReviewContext(
      boundary,
      input(
        paths.slice(0, 1),
        paths.slice(1),
        roots.map((root) => root + "/first.rs"),
      ),
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
      input(
        paths.slice(0, 1),
        paths.slice(1),
        roots.map((root) => root + "/first.rs"),
      ),
    ),
    /source total/,
  );
});
test("context-rust privacy acceptance", async (t) => {
  const selection = input(),
    root = await fixture(t, {
      "src/policy.rs": fixed,
      "src/consumer.rs": consumer,
      "src/lib.rs": entry,
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
    assert.equal(result.stdout.includes("rustBindings"), flags.length > 0);
    const client = new Client(
      { name: "original-rust-context-host", version: "1" },
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
test("context-rust lifecycle acceptance", native, async (t) => {
  const marker = "original-side-effect.txt",
    root = await fixture(t, {
      "sample.rs":
        'fn main(){std::fs::write("original-side-effect.txt","executed").unwrap();}',
      ".checktrail/keep": "",
    });
  const value = analysis(
    await createReviewContext(root, input(["sample.rs"], [], ["sample.rs"])),
  );
  assert.equal(value.functions.length, 1);
  await assert.rejects(access(path.join(root, marker)), { code: "ENOENT" });
  const executable = await compile(
    root,
    'use std::{env,fs,process::{Command,id},thread,time::Duration,io::{self,Write}};\nfn main(){let args:Vec<String>=env::args().collect();if args.get(1).map(String::as_str)==Some("child"){thread::sleep(Duration::from_secs(60));return;}let mut child=Command::new(env::current_exe().unwrap()).arg("child").spawn().unwrap();let child_pid=child.id();thread::spawn(move||{let _=child.wait();});let target=&args[1];let pending=format!("{}.pending",target);fs::write(&pending,format!("{{\\"parent\\":{},\\"child\\":{}}}",id(),child_pid)).unwrap();fs::rename(&pending,target).unwrap();if args[2]=="output"{let _=io::stdout().write_all(&vec![b\'x\';1048576]);}thread::sleep(Duration::from_secs(60));}\n',
    "native-process",
  );
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
      controller = new AbortController(),
      execution = runProcess(
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
      assert.ok(identities, "Reached native Rust parent and child");
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
        assert.equal(alive, false, "Reached Rust process survived cleanup");
      }
      await assert.rejects(access(ready + ".pending"), { code: "ENOENT" });
    } finally {
      controller.abort();
      await execution;
    }
  }
  await rm(executable);
  await rm(path.join(root, "native-process.rs"));
  await assert.rejects(access(executable), { code: "ENOENT" });
  const legacy = await createReviewContext(root, {
    schemaVersion: 7,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["sample.rs"],
    supportFiles: [],
    topics: [],
  });
  assert.equal(legacy.schemaVersion, 7);
  if (legacy.schemaVersion !== 7) throw Error("Original legacy required");
  assert.equal(legacy.analysis.profile, "selected-syntax-v1");
});
test("context-rust installed acceptance", native, async () => {
  if (process.env.CHECKTRAIL_CONTEXT_RUST_INSTALLED === "1") {
    const runtime = await realpath(
      fileURLToPath(
        new URL("../src/review-rust-resolution.js", import.meta.url),
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
    CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "context-rust",
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
