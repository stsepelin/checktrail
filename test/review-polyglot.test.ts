import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
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
import { createHypothesisPlan } from "../src/review-hypotheses.js";
import {
  grammarAssets,
  grammarManifestDigest,
} from "../src/review-grammar-assets.js";
import { fixture } from "./helpers.js";
import { fixtureGit, syntheticCommit } from "./git-fixture.js";
import { syntheticSyntaxSources } from "./review-polyglot-fixture.js";

const selection = (files: string[], supportFiles: string[] = []) => ({
  schemaVersion: 6,
  track: "snapshot",
  currentSource: "working-tree",
  files,
  supportFiles,
  topics: [],
});
function syntax(context: ReviewContext) {
  if (context.schemaVersion !== 6)
    throw new Error("Expected selected-syntax context");
  return context.analysis;
}
const rehash = (context: { contextDigest: string }) => {
  const body: Record<string, unknown> = { ...context };
  delete body.contextDigest;
  return {
    ...body,
    contextDigest: createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex"),
  };
};

test("selected syntax retains whole functions decisions and declaration defaults across every pinned grammar", async (t) => {
  const root = await fixture(t, syntheticSyntaxSources);
  for (const [file, source] of Object.entries(syntheticSyntaxSources)) {
    const context = await createReviewContext(root, selection([file]));
    const result = syntax(context);
    assert.equal(result.state, "collected", file);
    assert.equal(result.files[0]!.state, "collected", file);
    assert.equal(result.grammarManifestDigest, grammarManifestDigest);
    assert.equal(result.grammarBindings.length, 1, file);
    const asset = grammarAssets.find(
      (asset) => asset.grammar === result.grammarBindings[0]!.grammar,
    )!;
    assert.equal(result.grammarBindings[0]!.sourceCommit, asset.sourceCommit);
    assert.equal(result.grammarBindings[0]!.wasmSha256, asset.sha256);
    if (
      !file.endsWith(".fsi") &&
      !file.endsWith(".yaml") &&
      !file.endsWith(".tf")
    ) {
      const fn = result.functions.find((fn) => fn.name === "assign")!;
      assert.ok(fn, file);
      assert.ok(
        source.slice(fn.start, fn.end).includes("fallback") ||
          source.slice(fn.start, fn.end).includes("FALLBACK") ||
          source.slice(fn.start, fn.end).includes('"member"'),
        file,
      );
      const submitted = result.functions.find((fn) => fn.name === "submit")!;
      assert.ok(submitted, file);
      assert.ok(
        result.calls.some((call) => call.callerFunctionId === submitted.id),
        file,
      );
      assert.ok(result.decisions.length > 0, file);
    }
    assert.equal(result.reachabilityVerified, false);
    assert.ok(
      result.calls.every(
        (call) =>
          call.targetFunctionId === null &&
          call.resolution === "unsupported-dispatch",
      ),
    );
    assert.equal(createHypothesisPlan(context).claimsVerified, false);
  }
  for (const [file, name, value] of [
    ["sample.py", "role", "fallback"],
    ["sample.php", "$role", "FALLBACK"],
    ["sample.kt", "role", "fallback"],
    ["sample.scala", "role", "fallback"],
    ["sample.cs", "role", "fallback"],
    ["sample.rb", "role", "FALLBACK"],
    ["sample.swift", "role", '"member"'],
    ["sample.cpp", "role", "fallback"],
    ["sample.tf", "default", '"member"'],
    ["sample.yaml", "default", "member"],
  ]) {
    const result = syntax(await createReviewContext(root, selection([file!])));
    assert.ok(
      result.declarations.some(
        (decl) =>
          decl.name === name &&
          decl.initializer &&
          syntheticSyntaxSources[file!]!.slice(
            decl.initializer.start,
            decl.initializer.end,
          ) === value,
      ),
      file!,
    );
  }
});

test("selected syntax separates repaired text from broken text without treating syntax as verified behavior", async (t) => {
  const original = syntheticSyntaxSources["sample.py"]!;
  const root = await fixture(t, { "sample.py": original });
  const before = await createReviewContext(root, selection(["sample.py"]));
  await writeFile(
    path.join(root, "sample.py"),
    original.replace('role == "owner"', 'role == "administrator"'),
  );
  const after = await createReviewContext(root, selection(["sample.py"]));
  assert.notEqual(before.contextDigest, after.contextDigest);
  assert.ok(
    syntax(before).decisions.some((d) =>
      original.slice(d.start, d.end).includes('role == "owner"'),
    ),
  );
  assert.ok(
    syntax(after).decisions.some((d) =>
      after.files[0]!.content.slice(d.start, d.end).includes(
        'role == "administrator"',
      ),
    ),
  );
  assert.equal(before.automatedCoverage, false);
  assert.equal(after.automatedCoverage, false);
});

test("selected syntax ignores comment and string lookalikes and leaves dynamic calls and imports unresolved", async (t) => {
  const root = await fixture(t, {
    "sample.py":
      'import unknown\nfrom .missing import pick\nprose="def ghost(): pick()"\n# def ghost(): pick()\ndef submit(pick):\n    return pick()\n',
    "trap.mjs":
      'import {writeFileSync} from "node:fs";writeFileSync(new URL("./executed",import.meta.url),"bad");\n',
  });
  const result = syntax(
    await createReviewContext(root, selection(["sample.py"], ["trap.mjs"])),
  );
  assert.ok(!result.functions.some((fn) => fn.name === "ghost"));
  assert.equal(
    result.functions.filter((fn) => fn.file === "sample.py").length,
    1,
  );
  const calls = result.calls.filter((call) => call.file === "sample.py");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.targetFunctionId, null);
  assert.deepEqual(
    result.modules
      .filter((m) => m.file === "sample.py")
      .map((m) => m.targetFile),
    [null, null],
  );
  assert.ok(result.omissions.includes("project-module-resolution"));
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
});

test("selected syntax retains malformed unsupported and empty views as distinct source outcomes", async (t) => {
  const root = await fixture(t, {
    "malformed.py": "def broken(\n",
    "unsupported.vb": "Public Class Original\nEnd Class\n",
    "empty.py": "",
  });
  const context = await createReviewContext(
    root,
    selection(["malformed.py", "unsupported.vb", "empty.py"]),
  );
  const result = syntax(context);
  assert.equal(result.state, "partial");
  assert.deepEqual(
    result.files.map((file) => [file.file, file.state]),
    [
      ["empty.py", "collected"],
      ["malformed.py", "malformed"],
      ["unsupported.vb", "unsupported"],
    ],
  );
  assert.deepEqual(result.functions, []);
  assert.deepEqual(result.decisions, []);
  assert.equal(context.files.length, 3);
  assert.equal(
    createHypothesisPlan(context).scope.runtimeReachability,
    "unknown",
  );
});

test("selected syntax keeps immutable base index and working views distinct across moves and deletions", async (t) => {
  const original = syntheticSyntaxSources["sample.py"]!;
  const root = await fixture(t, {
    "sample.py": original,
    "deleted.py": "def deleted():\n    return 1\n",
  });
  fixtureGit(root, ["init", "--quiet"]);
  const base = await syntheticCommit(root, {
    "sample.py": original,
    "deleted.py": "def deleted():\n    return 1\n",
  });
  const staged = original.replace('role == "owner"', 'role == "administrator"');
  await writeFile(path.join(root, "sample.py"), staged);
  await rm(path.join(root, "deleted.py"));
  fixtureGit(root, ["add", "--all"]);
  await writeFile(
    path.join(root, "sample.py"),
    "# moved original function\n" + original,
  );
  const input = {
    ...selection(["sample.py", "deleted.py"]),
    track: "diff",
    baseCommit: base,
    currentSource: "index",
  };
  const indexed = await createReviewContext(root, input);
  const working = await createReviewContext(root, {
    ...input,
    currentSource: "working-tree",
  });
  assert.equal(
    indexed.files.find((file) => file.path === "sample.py")!.content,
    staged,
  );
  assert.equal(
    working.files.find((file) => file.path === "sample.py")!.content,
    "# moved original function\n" + original,
  );
  assert.ok(
    syntax(indexed).functions.some(
      (fn) => fn.revision === "base" && fn.name === "deleted",
    ),
  );
  assert.ok(
    !syntax(indexed).functions.some(
      (fn) => fn.revision === "current" && fn.name === "deleted",
    ),
  );
  assert.ok(
    syntax(indexed).functions.some(
      (fn) =>
        fn.name === "assign" && fn.revision === "current" && fn.overlapsChange,
    ),
  );
  assert.notEqual(indexed.contextDigest, working.contextDigest);
  assert.equal(
    syntax(working).functions.find(
      (fn) => fn.revision === "current" && fn.name === "assign",
    )!.startLine,
    3,
  );
});

test("selected syntax rejects rehashed grammar source and decision address tampering and legacy promotion", async (t) => {
  const root = await fixture(t, {
    "sample.py": syntheticSyntaxSources["sample.py"]!,
  });
  const context = await createReviewContext(root, selection(["sample.py"]));
  for (const mutate of [
    (c: ReviewContext) => {
      syntax(c).grammarManifestDigest = "0".repeat(64);
    },
    (c: ReviewContext) => {
      syntax(c).grammarBindings[0]!.wasmSha256 = "0".repeat(64);
    },
    (c: ReviewContext) => {
      syntax(c).grammarBindings = [];
    },
    (c: ReviewContext) => {
      syntax(c).decisions[0]!.end += 1;
    },
    (c: ReviewContext) => {
      c.files[0]!.content += "# changed\n";
    },
  ]) {
    const changed = structuredClone(context);
    mutate(changed);
    assert.throws(() => parseReviewContext(rehash(changed)));
  }
  const legacy = await createReviewContext(root, {
    ...selection(["sample.py"]),
    schemaVersion: 5,
  });
  assert.equal(legacy.schemaVersion, 5);
  assert.equal(
    legacy.schemaVersion === 5 ? legacy.analysis.files[0]!.state : "",
    "unsupported",
  );
  const forged = { ...legacy, analysis: syntax(context) };
  assert.throws(() => parseReviewContext(rehash(forged)));
});

test("selected syntax reports missing or changed grammar prerequisites before parsing captured source", async (t) => {
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
  const imported = (await import(
    pathToFileURL(path.join(copied, "dist/src/review-polyglot.js")).href
  )) as typeof import("../src/review-polyglot.js");
  const content = syntheticSyntaxSources["sample.py"]!,
    source = {
      path: "sample.py",
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  const missing = await imported.collectReviewPolyglotBehavior(
    [source],
    [],
    [source.path],
    false,
  );
  assert.equal(missing.files[0]!.state, "error");
  assert.equal(missing.state, "partial");
  assert.deepEqual(missing.functions, []);
  await mkdir(path.join(copied, "assets/context-grammars"), {
    recursive: true,
  });
  const original = await readFile(
    path.join(
      await realpath(path.join(repository, "dist/src")),
      "../../assets/context-grammars/tree-sitter-python.wasm",
    ),
  );
  const changedBytes = Buffer.from(original),
    exportName = Buffer.from("tree_sitter_python");
  const position = changedBytes.indexOf(exportName);
  assert.notEqual(position, -1);
  changedBytes[position + "tree_sitter_py".length] = "s".charCodeAt(0);
  assert.doesNotThrow(
    () => new WebAssembly.Module(changedBytes),
    "The changed prerequisite remains valid WASM",
  );
  await writeFile(
    path.join(copied, "assets/context-grammars/tree-sitter-python.wasm"),
    changedBytes,
  );
  const changed = await imported.collectReviewPolyglotBehavior(
    [source],
    [],
    [source.path],
    false,
  );
  assert.equal(changed.files[0]!.state, "error");
  assert.deepEqual(changed.functions, []);
});

test("selected syntax bounds node and source exhaustion while preserving valid adjacent controls", async (t) => {
  const root = await fixture(t, {
    "wide.py": "x=1\n".repeat(12000),
    "near.py": "x=1\n".repeat(20),
    "oversize.py": "#".repeat(65537),
  });
  const exhausted = syntax(
    await createReviewContext(root, selection(["wide.py"])),
  );
  assert.equal(exhausted.files[0]!.state, "budget-exhausted");
  assert.equal(exhausted.state, "partial");
  assert.deepEqual(exhausted.declarations, []);
  const valid = syntax(await createReviewContext(root, selection(["near.py"])));
  assert.equal(valid.state, "collected");
  assert.equal(valid.declarations.length, 20);
  await assert.rejects(createReviewContext(root, selection(["oversize.py"])));
});

test("selected syntax library CLI and MCP share identical source-granted output and reject tool grants", async (t) => {
  const input = selection(["sample.py"]);
  const root = await fixture(t, {
    "sample.py": syntheticSyntaxSources["sample.py"]!,
    "selection.json": JSON.stringify(input),
  });
  const expected = await createReviewContext(root, input);
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
    const projected = projectReviewContext(expected, flags.length > 0);
    assert.deepEqual(JSON.parse(result.stdout), projected);
    assert.equal(result.stdout.includes("grammarBindings"), flags.length > 0);
    assert.equal(result.stdout.includes("fallback"), flags.length > 0);
    const client = new Client(
      { name: "original-selected-syntax-host", version: "1.0.0" },
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
      const response = await client.callTool({
        name: "review_context",
        arguments: input,
      });
      assert.equal(response.isError, undefined);
      assert.deepEqual(response.structuredContent, projected);
      assert.equal(
        (
          await client.callTool({
            name: "review_context",
            arguments: {
              ...input,
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
  const summary = JSON.stringify(projectReviewContext(expected, false));
  assert.ok(!summary.includes("fallback"));
  assert.ok(!summary.includes("analysis"));
});
