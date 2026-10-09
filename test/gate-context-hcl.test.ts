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
import { runProcess } from "../src/runner.js";
import { fixture } from "./helpers.js";
import { fixtureGit, syntheticCommit } from "./git-fixture.js";
import { hclBoundariesFixture } from "./review-hcl-boundaries-fixture.js";
const broken =
  'variable "role" { default = "other" }\nlocals { allowed = startswith(var.role, "grant") ? true : false }\noutput "allowed" { value = local.allowed }\n';
const fixed =
  'variable "role" { default = "other" }\nlocals { allowed = (var.role == "grant" || startswith(var.role, "grant:")) ? true : false }\noutput "allowed" { value = local.allowed }\n';
const near =
  'variable "role" { default = "other" }\nlocals { allowed = (var.role == "grant:read" || var.role == "grant:write") ? true : false }\noutput "allowed" { value = local.allowed }\n';
const consumer =
  'variable "role" { default = "grantToken" }\nmodule "policy" {\n source = "./policy"\n role = var.role\n}\noutput "result" { value = module.policy.allowed }\n';
const native = {
  skip:
    process.env.CHECKTRAIL_CONTEXT_HCL_NATIVE === "1" &&
    spawnSync("terraform", ["version", "-json"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, CHECKPOINT_DISABLE: "1", HOME: "/tmp" },
    }).stdout?.includes('"terraform_version": "1.16.5"')
      ? false
      : "Pinned supplementary Terraform witness unavailable",
  timeout: 120000,
};
const input = (
  files = ["policy/rules.tf"],
  supportFiles = ["main.tf"],
  moduleRoots = ["."],
) => ({
  schemaVersion: 22,
  track: "snapshot",
  currentSource: "working-tree",
  files,
  supportFiles,
  moduleRoots,
  topics: [],
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function analysis(context: ReviewContext) {
  assert.equal(context.schemaVersion, 22);
  if (context.schemaVersion !== 22)
    throw Error("Original HCL context required");
  return context.analysis;
}
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
      "policy/rules.tf": policy,
      "main.tf": consumer,
      ".checktrail/keep": "",
    }),
    context = await createReviewContext(root, input());
  return { root, context, result: analysis(context) };
}
async function terraform(root: string, args: string[]) {
  return runProcess(
    root,
    { executable: "terraform", args, cwd: "." },
    {
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
      environment: {
        CHECKPOINT_DISABLE: "1",
        TF_IN_AUTOMATION: "1",
        TF_INPUT: "0",
      },
    },
  );
}
async function initialize(root: string) {
  const ran = await terraform(root, [
    "init",
    "-backend=false",
    "-input=false",
    "-no-color",
  ]);
  assert.equal(ran.exitCode, 0, ran.stdout + ran.stderr);
  assert.equal(ran.errorCode, undefined);
  assert.equal(ran.truncated, false);
  assert.equal(ran.timedOut, false);
}
async function witness(root: string) {
  await initialize(root);
  const values: boolean[] = [];
  try {
    for (const role of [
      "grant:read",
      "grantToken",
      "grant2",
      "other",
      "grant",
      "grant:write",
      "g",
    ]) {
      const ran = await terraform(root, [
        "plan",
        "-input=false",
        "-no-color",
        "-lock=false",
        "-var",
        "role=" + role,
        "-out=original.plan",
      ]);
      assert.equal(ran.exitCode, 0, ran.stdout + ran.stderr);
      assert.equal(ran.errorCode, undefined);
      assert.equal(ran.truncated, false);
      assert.equal(ran.timedOut, false);
      const shown = await terraform(root, ["show", "-json", "original.plan"]);
      assert.equal(shown.exitCode, 0, shown.stderr);
      assert.equal(shown.truncated, false);
      const parsed = JSON.parse(shown.stdout);
      const value = parsed.planned_values.outputs.result.value;
      assert.equal(typeof value, "boolean");
      values.push(value);
    }
    return values;
  } finally {
    await rm(path.join(root, "original.plan"), { force: true });
  }
}
function bindings(result: ReturnType<typeof analysis>, expectedReferences = 4) {
  assert.equal(result.hclBindings.counts.references, expectedReferences);
  assert.equal(
    result.hclBindings.counts.resolvedReferences,
    expectedReferences,
  );
  assert.equal(result.modules.length, 1);
  assert.equal(result.modules[0]!.resolution, "selected");
  assert.equal(result.modules[0]!.targetFile, "policy/rules.tf");
  assert.deepEqual(result.hclBindings.moduleCandidates[0]!.targetFiles, [
    "policy/rules.tf",
  ]);
  const local = result.declarations.find(
      (d) =>
        d.file === "policy/rules.tf" &&
        d.name === "allowed" &&
        d.initializer !== null &&
        d.kind === "property",
    )!,
    out = result.declarations.find(
      (d) => d.file === "main.tf" && d.name === "result",
    )!;
  assert.ok(local && out);
  assert.ok(
    result.hclBindings.dependencyEdges.some(
      (edge) =>
        edge.targetDeclarationId === local.id &&
        edge.fromDeclarationId === out.id &&
        edge.depth === 2,
    ),
  );
  assert.equal(result.hclBindings.fullImpactFallback, true);
  assert.equal(result.hclBindings.nativeEvaluationVerified, false);
  assert.equal(result.hclBindings.moduleInputsVerified, false);
  assert.equal(result.hclBindings.moduleLoadingVerified, false);
  assert.equal(result.hclBindings.validationPlanUnchanged, true);
  assert.deepEqual(result.functions, []);
  assert.ok(result.calls.every((call) => call.targetFunctionId === null));
}
test("context-hcl broken acceptance", native, async (t) => {
  const { root, result } = await original(t);
  bindings(result);
  assert.deepEqual(await witness(root), [
    true,
    true,
    true,
    false,
    true,
    true,
    false,
  ]);
  const decision = result.decisions.find((d) => d.nodeType === "conditional")!;
  assert.equal(
    broken.slice(decision.start, decision.end),
    'startswith(var.role, "grant") ? true : false',
  );
  const old = { "policy/rules.tf": broken, "main.tf": consumer },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await rename(path.join(revision, "main.tf"), path.join(revision, "moved.tf"));
  await writeFile(
    path.join(revision, "moved.tf"),
    consumer.replace("module.policy.allowed", "module.policyExtra.allowed"),
  );
  await writeFile(path.join(revision, "policy/rules.tf"), fixed);
  const changed = analysis(
    await createReviewContext(revision, {
      ...input(undefined, ["main.tf", "moved.tf"]),
      track: "diff",
      baseCommit: base,
    }),
  );
  const before = changed.declarations.find(
    (d) =>
      d.revision === "base" &&
      d.file === "policy/rules.tf" &&
      d.name === "allowed",
  )!;
  assert.ok(before);
  assert.equal(
    changed.references.filter(
      (ref) => ref.revision === "base" && ref.file === "main.tf",
    ).length,
    2,
  );
  assert.equal(
    changed.hclBindings.references.filter(
      (ref) =>
        ref.revision === "current" &&
        ref.file === "moved.tf" &&
        ref.targetDeclarationId === null,
    ).length,
    1,
  );
  assert.ok(
    changed.declarations.some(
      (d) =>
        d.revision === "current" && d.name === "allowed" && d.id !== before.id,
    ),
  );
});
test("context-hcl fixed acceptance", native, async (t) => {
  const { root, result } = await original(t, fixed);
  bindings(result, 5);
  assert.deepEqual(await witness(root), [
    true,
    false,
    false,
    false,
    true,
    true,
    false,
  ]);
  const decision = result.decisions.find((d) => d.nodeType === "conditional")!;
  assert.equal(
    fixed.slice(decision.start, decision.end),
    '(var.role == "grant" || startswith(var.role, "grant:")) ? true : false',
  );
  const role = result.declarations.find(
    (d) => d.file === "policy/rules.tf" && d.kind === "parameter",
  )!;
  assert.ok(role.initializer);
  assert.equal(
    fixed.slice(role.initializer.start, role.initializer.end),
    '"other"',
  );
  assert.equal(
    result.references.filter((ref) => ref.targetDeclarationId === role.id)
      .length,
    2,
  );
});
test("context-hcl near-miss acceptance", native, async (t) => {
  const { root, result } = await original(t, near);
  bindings(result, 5);
  assert.deepEqual(await witness(root), [
    true,
    false,
    false,
    false,
    false,
    true,
    false,
  ]);
  await hclBoundariesFixture(t);
});
test("context-hcl prerequisite acceptance", async (t) => {
  const { root } = await original(t);
  for (const roots of [
    [".."],
    ["policy", "policy/nested"],
    Array.from({ length: 17 }, (_, i) => "root" + i),
  ])
    await assert.rejects(
      createReviewContext(root, input(undefined, undefined, roots)),
    );
  const outside = analysis(
    await createReviewContext(root, input(undefined, undefined, ["elsewhere"])),
  );
  assert.equal(outside.hclBindings.state, "partial");
  assert.ok(outside.hclBindings.omissions.includes("outside-module-roots"));
  assert.equal(outside.references.length, 0);
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
    content = "locals { allowed = true }\n",
    source = { path: "sample.tf", content, sha256: hash(content) };
  const capture = () =>
    isolated.collectReviewHclBehavior([source], [], [source.path], false, [
      ".",
    ]);
  const absent = await capture();
  assert.equal(absent.files[0]!.state, "error");
  assert.deepEqual(absent.declarations, []);
  await mkdir(path.join(copied, "assets/context-grammars"), {
    recursive: true,
  });
  const bytes = await readFile(
      path.join(
        await realpath(path.join(repository, "dist/src")),
        "../../assets/context-grammars/tree-sitter-hcl.wasm",
      ),
    ),
    changed = Buffer.from(bytes),
    position = changed.indexOf(Buffer.from("tree_sitter_hcl"));
  assert.notEqual(position, -1);
  changed[position + "tree_sitter_".length] = "x".charCodeAt(0);
  assert.doesNotThrow(() => new WebAssembly.Module(changed));
  const asset = path.join(
    copied,
    "assets/context-grammars/tree-sitter-hcl.wasm",
  );
  await writeFile(asset, changed);
  const altered = await capture();
  assert.equal(altered.files[0]!.state, "error");
  assert.deepEqual(altered.references, []);
  await writeFile(asset, bytes);
  const restored = await capture();
  assert.equal(restored.files[0]!.state, "collected");
  assert.equal(restored.declarations.length, 2);
  const missing = await runProcess(
    root,
    {
      executable: path.join(root, "missing-original-hcl-tool"),
      args: [],
      cwd: ".",
    },
    { timeoutMs: 1000 },
  );
  assert.equal(missing.errorCode, "ENOENT");
  assert.notEqual(missing.exitCode, 0);
  const { moduleRoots: _moduleRoots, ...legacySelection } = input();
  void _moduleRoots;
  const legacy = await createReviewContext(root, {
    ...legacySelection,
    schemaVersion: 6,
  });
  assert.equal(legacy.schemaVersion, 6);
  if (legacy.schemaVersion !== 6)
    throw Error("Original legacy profile required");
  assert.equal(legacy.analysis.profile, "selected-syntax-v1");
  assert.equal("hclBindings" in legacy.analysis, false);
});
test("context-hcl stale acceptance", async (t) => {
  const { context } = await original(t, fixed);
  for (const [mutate, message] of [
    [
      (v: ReturnType<typeof analysis>) => {
        v.hclBindings.moduleRoots = ["elsewhere"];
      },
      /roots differ/,
    ],
    [
      (v: ReturnType<typeof analysis>) => {
        v.hclBindings.counts.resolvedReferences++;
      },
      /counts do not reconcile/,
    ],
    [
      (v: ReturnType<typeof analysis>) => {
        v.hclBindings.dependencyEdges = [];
      },
      /closure does not reconcile/,
    ],
    [
      (v: ReturnType<typeof analysis>) => {
        v.hclBindings.omissions = [];
      },
      /omissions do not reconcile/,
    ],
    [
      (v: ReturnType<typeof analysis>) => {
        v.hclBindings.moduleCandidates[0]!.targetFiles = [];
      },
      /module candidates do not reconcile/,
    ],
    [
      (v: ReturnType<typeof analysis>) => {
        v.hclBindings.references[0]!.ownerDeclarationId = null;
      },
      /selected references do not reconcile/,
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
  const files = { "policy/rules.tf": broken, "main.tf": consumer },
    root = await fixture(t, files);
  fixtureGit(root, ["init", "--quiet"]);
  const base = await syntheticCommit(root, files);
  await writeFile(path.join(root, "policy/rules.tf"), fixed);
  fixtureGit(root, ["add", "policy/rules.tf"]);
  await writeFile(path.join(root, "policy/rules.tf"), near);
  for (const currentSource of ["index", "working-tree"]) {
    const context = await createReviewContext(root, {
        ...input(),
        track: "diff",
        baseCommit: base,
        currentSource,
      }),
      value = analysis(context);
    assert.equal(
      context.files.find((file) => file.path === "policy/rules.tf")!.content,
      currentSource === "index" ? fixed : near,
    );
    assert.equal(
      value.references.filter((ref) => ref.file === "main.tf").length,
      4,
    );
    for (const ref of value.references.filter(
      (ref) => ref.file === "main.tf",
    )) {
      const target = value.declarations.find(
        (d) => d.id === ref.targetDeclarationId,
      )!;
      assert.ok(target);
      assert.equal(target.revision, ref.revision);
    }
  }
});
test("context-hcl empty acceptance", async (t) => {
  for (const source of [
    "",
    "# inert var.role\n",
    "locals { broken =",
    "locals { value = local.missing }\n",
  ]) {
    const root = await fixture(t, { "sample.tf": source }),
      value = analysis(
        await createReviewContext(root, input(["sample.tf"], [])),
      );
    assert.equal(value.hclBindings.state, "partial");
    assert.equal(value.hclBindings.counts.resolvedReferences, 0);
    assert.deepEqual(value.hclBindings.dependencyEdges, []);
  }
  const large =
      "locals {\n" +
      Array.from({ length: 3000 }, (_, i) => "x" + i + "=1\n").join("") +
      "}\n",
    root = await fixture(t, { "sample.tf": large }),
    exhausted = analysis(
      await createReviewContext(root, input(["sample.tf"], [])),
    );
  assert.equal(exhausted.files[0]!.state, "budget-exhausted");
  assert.deepEqual(exhausted.hclBindings.dependencyEdges, []);
  const chain =
      "locals {\n" +
      Array.from(
        { length: 10 },
        (_, i) => "x" + i + " = " + (i ? "local.x" + (i - 1) : "1") + "\n",
      ).join("") +
      "}\n",
    linked = await fixture(t, { "sample.tf": chain }),
    value = analysis(
      await createReviewContext(linked, input(["sample.tf"], [])),
    ),
    x0 = value.declarations.find((d) => d.name === "x0")!;
  assert.equal(
    value.hclBindings.dependencyEdges.filter(
      (edge) => edge.targetDeclarationId === x0.id,
    ).length,
    8,
  );
  assert.ok(value.hclBindings.omissions.includes("depth-limit"));
  const roots = Array.from({ length: 16 }, (_, i) => "root" + i),
    paths = roots.flatMap((root) => [root + "/first.tf", root + "/second.tf"]),
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
test("context-hcl privacy acceptance", async (t) => {
  const selection = input(),
    root = await fixture(t, {
      "policy/rules.tf": fixed,
      "main.tf": consumer,
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
    assert.equal(result.stdout.includes("hclBindings"), flags.length > 0);
    const client = new Client(
      { name: "original-hcl-context-host", version: "1" },
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
test("context-hcl lifecycle acceptance", native, async (t) => {
  for (const mode of ["cancel", "timeout", "output"]) {
    const root = await fixture(t, {
      "main.tf":
        'resource "terraform_data" "original" {\n provisioner "local-exec" { command = "node worker.mjs ' +
        mode +
        '" }\n}\n',
      "worker.mjs": `import{spawn}from'node:child_process';import{writeFile,rename,readFile}from'node:fs/promises';import{setTimeout as delay}from'node:timers/promises';const child=spawn(process.execPath,['child.mjs',process.argv[2]],{detached:true,stdio:['ignore','inherit','inherit']});process.on('SIGTERM',()=>{});child.once('close',()=>process.exit(0));for(;;){try{await readFile('child.ready');break;}catch(error){if(error.code!=='ENOENT')throw error;await delay(10)}}await writeFile('parent.pending',JSON.stringify({parent:process.pid,child:child.pid}));await rename('parent.pending','parent.ready');`,
      "child.mjs": `import{writeFile,rename,access}from'node:fs/promises';import{setTimeout as delay}from'node:timers/promises';await writeFile('child.pending',String(process.pid));await rename('child.pending','child.ready');for(;;){try{await access('worker.release');break;}catch(error){if(error.code!=='ENOENT')throw error;await delay(10)}}if(process.argv[2]==='output'){const bytes='x'.repeat(4095)+'\\n';setInterval(()=>process.stdout.write(bytes),1)}else setInterval(()=>{},1000);`,
    });
    await initialize(root);
    const abort = new AbortController(),
      pending = runProcess(
        root,
        {
          executable: "terraform",
          args: [
            "apply",
            "-auto-approve",
            "-input=false",
            "-no-color",
            "-lock=false",
          ],
          cwd: ".",
        },
        {
          timeoutMs: mode === "timeout" ? 4000 : 15000,
          maxOutputBytes: mode === "output" ? 8192 : 65536,
          signal: abort.signal,
          environment: {
            CHECKPOINT_DISABLE: "1",
            TF_IN_AUTOMATION: "1",
            TF_INPUT: "0",
          },
        },
      );
    let ids: { parent: number; child: number } | undefined;
    try {
      for (let i = 0; i < 300; i++) {
        try {
          ids = JSON.parse(
            await readFile(path.join(root, "parent.ready"), "utf8"),
          );
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await delay(10);
        }
      }
      assert.ok(ids, "Original provisioner parent and child were not reached");
      assert.ok(ids.parent > 0 && ids.child > 0 && ids.parent !== ids.child);
      assert.equal(
        Number(await readFile(path.join(root, "child.ready"), "utf8")),
        ids.child,
      );
      process.kill(ids.parent, 0);
      process.kill(ids.child, 0);
      await writeFile(path.join(root, "worker.release"), "go");
      if (mode === "cancel") abort.abort();
      const ran = await pending;
      assert.equal(ran.errorCode, undefined, JSON.stringify(ran));
      assert.equal(ran.cancelled, mode === "cancel");
      assert.equal(ran.timedOut, mode === "timeout");
      assert.equal(ran.truncated, mode === "output");
      if (mode === "output")
        assert.equal(
          Buffer.byteLength(ran.stdout) + Buffer.byteLength(ran.stderr),
          8192,
        );
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
    } finally {
      abort.abort();
      await pending;
      for (const file of [
        "worker.release",
        "parent.ready",
        "child.ready",
        "parent.pending",
        "child.pending",
        "worker.mjs",
        "child.mjs",
      ])
        await rm(path.join(root, file), { force: true });
    }
    for (const file of [
      "worker.release",
      "parent.ready",
      "child.ready",
      "parent.pending",
      "child.pending",
      "worker.mjs",
      "child.mjs",
    ])
      await assert.rejects(
        access(path.join(root, file)),
        (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
      );
    const preabort = new AbortController();
    preabort.abort();
    const refused = await runProcess(
      root,
      { executable: "terraform", args: ["apply", "-auto-approve"], cwd: "." },
      { timeoutMs: 1000, signal: preabort.signal },
    );
    assert.equal(refused.cancelled, true);
    assert.notEqual(refused.exitCode, 0);
    await assert.rejects(
      access(path.join(root, "parent.ready")),
      (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  }
});
test("context-hcl installed acceptance", native, async () => {
  if (process.env.CHECKTRAIL_CONTEXT_HCL_INSTALLED === "1") {
    const runtime = await realpath(
      fileURLToPath(
        new URL("../src/review-hcl-resolution.js", import.meta.url),
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
    CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "context-hcl",
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
