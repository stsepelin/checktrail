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
import { yamlBoundariesFixture } from "./review-yaml-boundaries-fixture.js";
const broken =
  "rules: &policy\n  mode: prefix\n  token: grant\nresult: *policy\nmirror: *policy\n";
const fixed = broken.replace("mode: prefix", "mode: exact-or-colon");
const near = broken.replace("mode: prefix", "mode: colon-only");
const yamlRuntime = import.meta.resolve("yaml"),
  yamlPackage = JSON.parse(
    await readFile(new URL("../package.json", yamlRuntime), "utf8"),
  );
const native = {
  skip:
    process.env.CHECKTRAIL_CONTEXT_YAML_NATIVE === "1" &&
    process.version === "v22.23.2" &&
    yamlPackage.version === "2.9.1"
      ? false
      : "Pinned supplementary YAML/Node witness unavailable",
  timeout: 120000,
};
const input = (
  files = ["policy.yaml"],
  supportFiles = ["extra.yaml"],
  moduleRoots = ["."],
) => ({
  schemaVersion: 23,
  track: "snapshot",
  currentSource: "working-tree",
  files,
  supportFiles,
  moduleRoots,
  topics: [],
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function analysis(context: ReviewContext) {
  assert.equal(context.schemaVersion, 23);
  if (context.schemaVersion !== 23)
    throw Error("Original YAML context required");
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
      "policy.yaml": policy,
      "extra.yaml": "# original inert support\n",
      ".checktrail/keep": "",
    }),
    context = await createReviewContext(root, input());
  return { root, context, result: analysis(context) };
}
async function witness(root: string) {
  const program = `import{parse}from${JSON.stringify(yamlRuntime)};import{readFile}from'node:fs/promises';const data=parse(await readFile('policy.yaml','utf8'));if(data.result!==data.rules||data.mirror!==data.rules)throw Error('Original alias identity required');const values=['grant:read','grantToken','grant2','other','grant','grant:write','g'].map(role=>data.rules.mode==='prefix'?role.startsWith(data.rules.token):data.rules.mode==='exact-or-colon'?role===data.rules.token||role.startsWith(data.rules.token+':'):role.startsWith(data.rules.token+':'));console.log(JSON.stringify(values));`;
  const ran = await runProcess(
    root,
    {
      executable: process.execPath,
      args: ["--input-type=module", "-e", program],
      cwd: ".",
    },
    { timeoutMs: 10000, maxOutputBytes: 65536 },
  );
  assert.equal(ran.exitCode, 0, ran.stdout + ran.stderr);
  assert.equal(ran.errorCode, undefined);
  assert.equal(ran.truncated, false);
  assert.equal(ran.timedOut, false);
  return JSON.parse(ran.stdout);
}
function bindings(result: ReturnType<typeof analysis>) {
  assert.equal(result.yamlBindings.counts.anchors, 1);
  assert.equal(result.yamlBindings.counts.aliases, 2);
  assert.equal(result.yamlBindings.counts.resolvedAliases, 2);
  assert.equal(result.yamlBindings.counts.unresolvedAliases, 0);
  assert.deepEqual(result.modules, []);
  const anchor = result.yamlBindings.anchors[0]!;
  for (const ref of result.references)
    assert.equal(ref.targetDeclarationId, anchor.declarationId);
  assert.equal(
    result.yamlBindings.dependencyEdges.filter(
      (e) => e.targetDeclarationId === anchor.declarationId,
    ).length,
    2,
  );
  assert.equal(result.yamlBindings.fullImpactFallback, true);
  assert.equal(result.yamlBindings.nativeSerializationVerified, false);
  assert.equal(result.yamlBindings.consumerSemanticsVerified, false);
  assert.equal(result.yamlBindings.mergeSemanticsVerified, false);
  assert.equal(result.yamlBindings.validationPlanUnchanged, true);
  assert.deepEqual(result.functions, []);
  assert.deepEqual(result.calls, []);
}
test("context-yaml broken acceptance", native, async (t) => {
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
  const whole = result.decisions.find((d) => d.start === 0)!;
  assert.ok(whole);
  assert.equal(
    broken.slice(whole.start, whole.end),
    "rules: &policy\n  mode: prefix\n  token: grant",
  );
  const old = { "policy.yaml": broken, "extra.yaml": "# inert\n" },
    revision = await fixture(t, old);
  fixtureGit(revision, ["init", "--quiet"]);
  const base = await syntheticCommit(revision, old);
  await writeFile(
    path.join(revision, "policy.yaml"),
    fixed.slice(0, fixed.indexOf("result:")),
  );
  await writeFile(
    path.join(revision, "moved.yaml"),
    "result: *policy\nmirror: *policyExtra\n",
  );
  const changed = analysis(
    await createReviewContext(revision, {
      ...input(undefined, ["extra.yaml", "moved.yaml"]),
      track: "diff",
      baseCommit: base,
    }),
  );
  const before = changed.yamlBindings.anchors.find(
    (a) => a.revision === "base",
  )!;
  assert.ok(before);
  assert.equal(
    changed.references.filter((r) => r.revision === "base").length,
    2,
  );
  assert.equal(
    changed.references.filter((r) => r.revision === "current").length,
    0,
  );
  assert.equal(
    changed.yamlBindings.aliases.filter(
      (a) => a.revision === "current" && a.targetDeclarationId === null,
    ).length,
    2,
  );
  assert.ok(
    changed.yamlBindings.anchors.some(
      (a) =>
        a.revision === "current" && a.declarationId !== before.declarationId,
    ),
  );
});
test("context-yaml fixed acceptance", native, async (t) => {
  const { root, result } = await original(t, fixed);
  bindings(result);
  assert.deepEqual(await witness(root), [
    true,
    false,
    false,
    false,
    true,
    true,
    false,
  ]);
  const anchor = result.declarations.find(
    (d) => d.id === result.yamlBindings.anchors[0]!.declarationId,
  )!;
  assert.ok(anchor.initializer);
  assert.equal(
    fixed.slice(anchor.initializer.start, anchor.initializer.end),
    "mode: exact-or-colon\n  token: grant",
  );
  const token = result.declarations.find((d) => d.name === "token")!;
  assert.ok(token.initializer);
  assert.equal(
    fixed.slice(token.initializer.start, token.initializer.end),
    "grant",
  );
  for (const ref of result.references)
    assert.equal(fixed.slice(ref.start, ref.end), "*policy");
});
test("context-yaml near-miss acceptance", native, async (t) => {
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
  ]);
  await yamlBoundariesFixture(t);
});
test("context-yaml prerequisite acceptance", async (t) => {
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
  assert.equal(outside.yamlBindings.state, "partial");
  assert.ok(outside.yamlBindings.omissions.includes("outside-module-roots"));
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
    content = "policy: &policy true\n",
    source = { path: "sample.yaml", content, sha256: hash(content) };
  const capture = () =>
    isolated.collectReviewYamlBehavior([source], [], [source.path], false, [
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
        "../../assets/context-grammars/tree-sitter-yaml.wasm",
      ),
    ),
    changed = Buffer.from(bytes),
    position = changed.indexOf(Buffer.from("tree_sitter_yaml"));
  assert.notEqual(position, -1);
  changed[position + "tree_sitter_".length] = "x".charCodeAt(0);
  assert.doesNotThrow(() => new WebAssembly.Module(changed));
  const asset = path.join(
    copied,
    "assets/context-grammars/tree-sitter-yaml.wasm",
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
      executable: path.join(root, "missing-original-yaml-tool"),
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
  assert.equal("yamlBindings" in legacy.analysis, false);
});
test("context-yaml stale acceptance", async (t) => {
  const { context } = await original(t, fixed);
  for (const [mutate, message] of [
    [
      (v: ReturnType<typeof analysis>) => {
        v.yamlBindings.moduleRoots = ["elsewhere"];
      },
      /roots differ/,
    ],
    [
      (v: ReturnType<typeof analysis>) => {
        v.yamlBindings.counts.resolvedAliases++;
      },
      /counts do not reconcile/,
    ],
    [
      (v: ReturnType<typeof analysis>) => {
        v.yamlBindings.dependencyEdges = [];
      },
      /closure does not reconcile/,
    ],
    [
      (v: ReturnType<typeof analysis>) => {
        v.yamlBindings.omissions = [];
      },
      /omissions do not reconcile/,
    ],
    [
      (v: ReturnType<typeof analysis>) => {
        v.yamlBindings.anchors[0]!.name = "other";
      },
      /anchor source addresses/,
    ],
    [
      (v: ReturnType<typeof analysis>) => {
        v.yamlBindings.aliases[0]!.documentStart = 1;
      },
      /alias candidates/,
    ],
    [
      (v: ReturnType<typeof analysis>) => {
        v.yamlBindings.aliases[0]!.ownerDeclarationId = null;
      },
      /selected references/,
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
  const files = { "policy.yaml": broken, "extra.yaml": "# inert\n" },
    root = await fixture(t, files);
  fixtureGit(root, ["init", "--quiet"]);
  const base = await syntheticCommit(root, files);
  await writeFile(path.join(root, "policy.yaml"), fixed);
  fixtureGit(root, ["add", "policy.yaml"]);
  await writeFile(path.join(root, "policy.yaml"), near);
  for (const currentSource of ["index", "working-tree"]) {
    const context = await createReviewContext(root, {
        ...input(),
        track: "diff",
        baseCommit: base,
        currentSource,
      }),
      value = analysis(context);
    assert.equal(
      context.files.find((f) => f.path === "policy.yaml")!.content,
      currentSource === "index" ? fixed : near,
    );
    assert.equal(value.references.length, 4);
    for (const ref of value.references) {
      const target = value.declarations.find(
        (d) => d.id === ref.targetDeclarationId,
      )!;
      assert.ok(target);
      assert.equal(target.revision, ref.revision);
    }
  }
});
test("context-yaml empty acceptance", async (t) => {
  for (const source of [
    "",
    "# inert *policy\n",
    "rules: [",
    "result: *missing\n",
  ]) {
    const root = await fixture(t, { "sample.yaml": source }),
      value = analysis(
        await createReviewContext(root, input(["sample.yaml"], [])),
      );
    assert.equal(value.yamlBindings.state, "partial");
    assert.equal(value.yamlBindings.counts.resolvedAliases, 0);
    assert.deepEqual(value.yamlBindings.dependencyEdges, []);
  }
  const large = Array.from({ length: 3000 }, (_, i) => "x" + i + ": 1\n").join(
      "",
    ),
    root = await fixture(t, { "sample.yaml": large }),
    exhausted = analysis(
      await createReviewContext(root, input(["sample.yaml"], [])),
    );
  assert.equal(exhausted.files[0]!.state, "budget-exhausted");
  assert.deepEqual(exhausted.yamlBindings.dependencyEdges, []);
  const chain = Array.from(
      { length: 10 },
      (_, i) =>
        "x" + i + ": &x" + i + " " + (i ? "[*x" + (i - 1) + "]" : "1") + "\n",
    ).join(""),
    linked = await fixture(t, { "sample.yaml": chain }),
    value = analysis(
      await createReviewContext(linked, input(["sample.yaml"], [])),
    ),
    x0 = value.declarations.find(
      (d) => d.name === "x0" && d.kind === "variable",
    )!;
  assert.equal(
    value.yamlBindings.dependencyEdges.filter(
      (edge) => edge.targetDeclarationId === x0.id,
    ).length,
    8,
  );
  assert.ok(value.yamlBindings.omissions.includes("depth-limit"));
  const roots = Array.from({ length: 16 }, (_, i) => "root" + i),
    paths = roots.flatMap((root) => [
      root + "/first.yaml",
      root + "/second.yaml",
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
test("context-yaml privacy acceptance", async (t) => {
  const selection = input(),
    root = await fixture(t, {
      "policy.yaml": fixed,
      "extra.yaml": "# original inert support\n",
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
    assert.equal(result.stdout.includes("yamlBindings"), flags.length > 0);
    const client = new Client(
      { name: "original-yaml-context-host", version: "1" },
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
test("context-yaml lifecycle acceptance", native, async (t) => {
  for (const mode of ["cancel", "timeout", "output"]) {
    const root = await fixture(t, {
      "policy.yaml": "seed: &seed 1\nresult: *seed\n",
      "worker.mjs": `import{parse}from${JSON.stringify(yamlRuntime)};import{spawn}from'node:child_process';import{writeFile,rename,readFile}from'node:fs/promises';import{setTimeout as delay}from'node:timers/promises';const data=parse(await readFile('policy.yaml','utf8'));if(data.result!==1)throw Error('Original YAML parser witness required');const child=spawn(process.execPath,['child.mjs',process.argv[2]],{detached:true,stdio:['ignore','inherit','inherit']});process.on('SIGTERM',()=>{});child.once('close',()=>process.exit(0));for(;;){try{await readFile('child.ready');break;}catch(error){if(error.code!=='ENOENT')throw error;await delay(10)}}await writeFile('parent.pending',JSON.stringify({parent:process.pid,child:child.pid}));await rename('parent.pending','parent.ready');`,
      "child.mjs": `import{writeFile,rename,access}from'node:fs/promises';import{setTimeout as delay}from'node:timers/promises';await writeFile('child.pending',String(process.pid));await rename('child.pending','child.ready');for(;;){try{await access('worker.release');break;}catch(error){if(error.code!=='ENOENT')throw error;await delay(10)}}if(process.argv[2]==='output'){const bytes='x'.repeat(4095)+'\\n';setInterval(()=>process.stdout.write(bytes),1)}else setInterval(()=>{},1000);`,
    });
    const abort = new AbortController(),
      pending = runProcess(
        root,
        {
          executable: process.execPath,
          args: ["worker.mjs", mode],
          cwd: ".",
        },
        {
          timeoutMs: mode === "timeout" ? 4000 : 15000,
          maxOutputBytes: mode === "output" ? 8192 : 65536,
          signal: abort.signal,
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
      assert.ok(ids, "Original parser worker and child were not reached");
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
      { executable: process.execPath, args: ["worker.mjs", mode], cwd: "." },
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
test("context-yaml installed acceptance", native, async () => {
  if (process.env.CHECKTRAIL_CONTEXT_YAML_INSTALLED === "1") {
    const runtime = await realpath(
      fileURLToPath(
        new URL("../src/review-yaml-resolution.js", import.meta.url),
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
    CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "context-yaml",
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
