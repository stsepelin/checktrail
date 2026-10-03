import assert from "node:assert/strict";
import { access, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import { test } from "node:test";
import {
  createReviewContext,
  projectReviewContext,
  receiveReview,
  type ReviewAssessment,
} from "../src/review.js";
import {
  reviewBehaviorSchema,
  type ReviewBehavior,
} from "../src/review-behavior-schema.js";
import { fixture } from "./helpers.js";
import { fixtureGit, syntheticCommit } from "./git-fixture.js";

const primary =
  'export const fallback = "member";\nexport function assign(role = fallback) {\n  return role === "owner" ? "admin" : "member";\n}\nexport function adjacent() { return fallback; }\n';
const consumer =
  'import { assign as pick } from "./lib.js";\nexport function submit() { return pick(); }\nexport function shadow(pick: () => string) { return pick(); }\nexport function indirect(value: {pick: () => string}) { return value.pick(); }\nconst prose = "pick() { not a function }"; // pick()\n';
const input = {
  schemaVersion: 3,
  track: "snapshot",
  files: ["lib.ts"],
  supportFiles: ["app.ts"],
  topics: [],
};
function analysis(context: unknown): ReviewBehavior {
  assert.equal((context as { schemaVersion: number }).schemaVersion, 3);
  return reviewBehaviorSchema.parse(
    (context as { analysis: unknown }).analysis,
  );
}

test("lexical links account for namespaces, constructors, overloads and the whole rebinding family", async (t) => {
  const root = await fixture(t, {
    "definitions.ts":
      "export const arrow = () => 1;\nexport class Base { value = 3; }\nexport class Item extends Base { constructor(value = 2) { super(); this.value = value; } method() { return arrow(); } }\nexport function many(value: string): string;\nexport function many(value: number): number;\nexport function many(value: string | number) { return value; }\nexport let changed = () => 1; changed = () => 2;\n",
    "calls.ts":
      'import * as ns from "./definitions.js";\nimport type * as types from "./definitions.js";\nimport {type Item as TypedItem, Item, arrow, many, changed} from "./definitions.js";\nexport function run() { ns.arrow(); new Item(); many(2); arrow?.(); new TypedItem(); types.arrow(); changed(); }\nlet direct = () => 1; direct = () => 2; direct();\nlet array = () => 1; [array] = []; array();\nlet object = () => 1; ({object} = {}); object();\nlet named = () => 1; ({key: named} = {}); named();\nlet increment = () => 1; increment++; increment();\n',
  });
  const context = await createReviewContext(root, {
    ...input,
    files: ["calls.ts"],
    supportFiles: ["definitions.ts"],
  });
  const result = analysis(context);
  const calls = result.calls.filter((call) => call.file === "calls.ts");
  const sources = context.files;
  const at = (snippet: string) =>
    calls.find(
      (call) =>
        sources
          .find((source) => source.path === call.file)!
          .content.slice(call.start, call.end) === snippet,
    )!;
  for (const snippet of ["ns.arrow()", "new Item()", "many(2)", "arrow?.()"])
    assert.equal(at(snippet).resolution, "lexical-binding", snippet);
  assert.equal(at("arrow?.()").optional, true);
  assert.equal(
    result.functions.find((fn) => fn.id === at("new Item()").targetFunctionId)!
      .kind,
    "constructor",
  );
  for (const snippet of ["new TypedItem()", "types.arrow()"])
    assert.equal(at(snippet).resolution, "type-only-import", snippet);
  for (const snippet of [
    "changed()",
    "direct()",
    "array()",
    "object()",
    "named()",
    "increment()",
  ]) {
    assert.equal(at(snippet).resolution, "mutated-binding", snippet);
    assert.equal(at(snippet).targetFunctionId, null);
  }
  const item = result.declarations.find(
    (decl) => decl.name === "Item" && decl.kind === "class",
  )!;
  const base = result.declarations.find(
    (decl) => decl.name === "Base" && decl.kind === "class",
  )!;
  assert.ok(
    result.references.some(
      (ref) =>
        ref.ownerDeclarationId === item.id &&
        ref.targetDeclarationId === base.id,
    ),
  );
  const constructor = result.functions.find((fn) => fn.kind === "constructor")!;
  assert.ok(constructor.enclosingDeclarations.includes(item.id));
});

test("selected modules support cycles and reexports while ambiguous, missing, external and dynamic links stay unknown", async (t) => {
  const root = await fixture(t, {
    "entry.ts":
      'import {cycle} from "./a.js"; import {original as renamed} from "./barrel.js"; import {original as erased} from "./types.js"; import {original as erasedAll} from "./types-all.js"; import {original as starred} from "./runtime-all.js"; import {original as mixed} from "./mixed-all.js"; import {original as own} from "./own.js"; import {original as erasedTransitively} from "./transitive-types.js"; import * as erasedNamespace from "./types-all.js";\nimport {other} from "./dupe"; import {hidden} from "./hidden"; import {secret} from "../outside"; import {pkg} from "package";\nexport function run() { cycle(); renamed(); other(); hidden(); secret(); pkg(); erased(); erasedAll(); starred(); mixed(); own(); erasedTransitively(); erasedNamespace.original(); }\nimport("./a.js"); require("./a.js");\n',
    "a.ts":
      'import {cycleB} from "./b.js"; export function cycle() { return cycleB(); } export function original() { return 3; }\n',
    "b.ts":
      'import {cycle} from "./a.js"; export function cycleB() { return cycle(); }\n',
    "barrel.ts": 'export {original} from "./a.js";\n',
    "types.ts": 'export type {original} from "./a.js";\n',
    "types-all.ts": 'export type * from "./a.js";\n',
    "runtime-all.ts": 'export * from "./a.js";\n',
    "mixed-all.ts": 'export type * from "./a.js"; export * from "./a.js";\n',
    "own.ts":
      'export type * from "./a.js"; export function original() {return 4;}\n',
    "transitive-types.ts": 'export * from "./types-all.js";\n',
    "dupe.ts": "export function other() { return 1; }\n",
    "dupe.js": "export function other() { return 2; }\n",
    "hidden.ts":
      'throw new Error("unselected module must not execute"); export function hidden() { return 1; }\n',
  });
  const context = await createReviewContext(root, {
    ...input,
    files: ["entry.ts"],
    supportFiles: [
      "a.ts",
      "b.ts",
      "barrel.ts",
      "dupe.ts",
      "dupe.js",
      "types.ts",
      "types-all.ts",
      "runtime-all.ts",
      "mixed-all.ts",
      "own.ts",
      "transitive-types.ts",
    ],
  });
  const result = analysis(context);
  const source = context.files.find(
    (file) => file.path === "entry.ts",
  )!.content;
  const call = (text: string) =>
    result.calls.find(
      (node) =>
        node.file === "entry.ts" && source.slice(node.start, node.end) === text,
    )!;
  for (const text of ["cycle()", "renamed()", "starred()", "mixed()", "own()"])
    assert.equal(call(text).resolution, "lexical-binding", text);
  for (const text of [
    "other()",
    "hidden()",
    "secret()",
    "pkg()",
    "erased()",
    "erasedAll()",
    "erasedTransitively()",
    "erasedNamespace.original()",
  ])
    assert.equal(call(text).targetFunctionId, null, text);
  assert.ok(
    result.calls.some(
      (node) =>
        node.file === "a.ts" &&
        node.targetFunctionId ===
          result.functions.find((fn) => fn.name === "cycleB")!.id,
    ),
  );
  assert.ok(
    result.calls.some(
      (node) =>
        node.file === "b.ts" &&
        node.targetFunctionId ===
          result.functions.find((fn) => fn.name === "cycle")!.id,
    ),
  );
  assert.deepEqual(
    result.modules
      .filter((edge) => edge.file === "entry.ts")
      .map((edge) => edge.resolution),
    [
      "selected",
      "selected",
      "selected",
      "selected",
      "selected",
      "selected",
      "selected",
      "selected",
      "selected",
      "ambiguous",
      "missing",
      "outside-root",
      "external",
      "dynamic",
      "dynamic",
    ],
  );
  assert.ok(!result.files.some((file) => file.file === "hidden.ts"));
});

test("unsupported, malformed and exhausted syntax collections remain partial with intact captured source", async (t) => {
  const root = await fixture(t, {
    "valid.ts":
      'import {broken} from "./broken.js"; export function good() { return broken(); }\n',
    "broken.ts": "export function broken( {",
    "other.py": "def good():\n    return 1\n",
  });
  const context = await createReviewContext(root, {
    ...input,
    files: ["valid.ts"],
    supportFiles: ["broken.ts", "other.py"],
  });
  const result = analysis(context);
  assert.equal(result.state, "partial");
  assert.deepEqual(
    result.files.map((file) => [file.file, file.state]),
    [
      ["broken.ts", "malformed"],
      ["other.py", "unsupported"],
      ["valid.ts", "collected"],
    ],
  );
  assert.equal(context.files.length, 3);
  assert.equal(result.functions.length, 1);
  assert.equal(result.modules[0]!.resolution, "unparsed");
  assert.equal(result.calls[0]!.targetFunctionId, null);
  const large = await fixture(t, {
    "large.ts": Array.from(
      { length: 513 },
      (_, index) => "function f" + index + "() {}\n",
    ).join(""),
  });
  const exhausted = await createReviewContext(large, {
    ...input,
    files: ["large.ts"],
    supportFiles: [],
  });
  const packet = analysis(exhausted);
  assert.equal(packet.state, "partial");
  assert.equal(packet.files[0]!.state, "budget-exhausted");
  assert.equal(
    packet.functions.length,
    0,
    "no half-collected function graph survives exhaustion",
  );
  assert.equal(packet.declarations.length, 0);
  assert.ok(exhausted.files[0]!.content.includes("function f512"));
});

test("analysis address and pointer forgery is rejected before projection, including UTF-16 and CRLF anchors", async (t) => {
  const source =
    'const marker = "😀";\r\nexport function one() {\r\n  return marker;\r\n}\r\none();\r\n';
  const root = await fixture(t, { "one.ts": source });
  const context = await createReviewContext(root, {
    ...input,
    files: ["one.ts"],
    supportFiles: [],
  });
  const result = analysis(context);
  assert.equal(result.functions[0]!.startLine, 2);
  assert.equal(result.functions[0]!.endLine, 4);
  assert.equal(
    source.slice(result.functions[0]!.start, result.functions[0]!.end),
    "export function one() {\r\n  return marker;\r\n}",
  );
  for (const mutate of [
    (packet: ReviewBehavior) => {
      packet.functions[0]!.endLine = 3;
    },
    (packet: ReviewBehavior) => {
      packet.functions[0]!.id = "a".repeat(64);
    },
    (packet: ReviewBehavior) => {
      packet.references[0]!.targetDeclarationId = "b".repeat(64);
    },
    (packet: ReviewBehavior) => {
      packet.files[0]!.sha256 = "c".repeat(64);
    },
    (packet: ReviewBehavior) => {
      packet.calls[0]!.resolution = "unsupported-dispatch";
      packet.calls[0]!.targetFunctionId = "d".repeat(64);
    },
  ]) {
    const forged = structuredClone(context);
    mutate(analysisMutable(forged));
    const { contextDigest: _digest, ...body } = forged;
    void _digest;
    forged.contextDigest = createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex");
    assert.throws(() => projectReviewContext(forged, false), /anchors/);
  }
});

function analysisMutable(context: unknown): ReviewBehavior {
  return (context as { analysis: ReviewBehavior }).analysis;
}

test("selected extension families and anonymous default exports keep bodies while declarations remain non-runtime context", async (t) => {
  const root = await fixture(t, {
    "entry.ts":
      'import mts from "./default.mjs"; import {render} from "./view.jsx"; import {plain} from "./plain.mjs"; import {typed} from "./typed.cjs"; import {ambient} from "./ambient.mjs";\nexport function run() { mts(); render(); plain(); typed(); ambient(); }\n',
    "default.mts": "export default (value = 2) => value;\n",
    "view.tsx": "export function render() { return <div/>; }\n",
    "plain.mjs": "export function plain() { return 1; }\n",
    "typed.cts": "export function typed() { return 1; }\n",
    "ambient.d.mts": "export declare function ambient(): number;\n",
    "local.cjs": "function local() { return 1; } local();\n",
    "view.jsx": "export function render() { return <span/>; }\n",
  });
  const context = await createReviewContext(root, {
    ...input,
    files: ["entry.ts"],
    supportFiles: [
      "default.mts",
      "view.tsx",
      "plain.mjs",
      "typed.cts",
      "ambient.d.mts",
      "local.cjs",
      "view.jsx",
    ],
  });
  const packet = analysis(context);
  assert.equal(packet.state, "collected");
  const source = context.files.find(
    (file) => file.path === "entry.ts",
  )!.content;
  const call = (text: string) =>
    packet.calls.find(
      (node) =>
        node.file === "entry.ts" && source.slice(node.start, node.end) === text,
    )!;
  for (const text of ["mts()", "plain()", "typed()"])
    assert.equal(call(text).resolution, "lexical-binding", text);
  assert.equal(
    packet.functions.find((fn) => fn.id === call("mts()").targetFunctionId)!
      .kind,
    "arrow",
  );
  assert.equal(
    call("render()").targetFunctionId,
    null,
    "JSX and TSX candidates are ambiguous when both are selected",
  );
  assert.equal(
    packet.modules.find((edge) => edge.specifier === "./view.jsx")!.resolution,
    "ambiguous",
  );
  assert.equal(
    call("ambient()").targetFunctionId,
    null,
    "an ambient signature has no runtime body",
  );
  assert.ok(
    packet.declarations.some(
      (decl) => decl.file === "ambient.d.mts" && decl.kind === "function",
    ),
  );
  assert.ok(!packet.functions.some((fn) => fn.file === "ambient.d.mts"));
  assert.ok(
    packet.calls.some(
      (node) => node.file === "local.cjs" && node.targetFunctionId !== null,
    ),
  );
  assert.ok(
    packet.functions.some((fn) => fn.file === "view.jsx") &&
      packet.functions.some((fn) => fn.file === "view.tsx"),
  );
});

test("nested bodies, accessors and declaration defaults retain context without reading ambient or configured files", async (t) => {
  const source =
    '/// <reference path="./ambient.d.ts" />\nimport {configured} from "alias";\nexport type Shape = {count: number};\nexport interface Contract { count: number }\nexport enum Kind { One = 1 }\nexport const fallback = {count: 2};\nexport class Box {\n  value = fallback.count;\n  get count() { return this.value; }\n  set count(value) { this.value = value + fallback.count; }\n  method(input = fallback) { return () => input.count; }\n}\nexport const outer = function named(input = fallback) { function inner() { return input.count; } return inner(); };\nexport function run() { return [ambient(), configured(), outer()]; }\n';
  const root = await fixture(t, {
    "source.ts": source,
    "ambient.d.ts": "declare function ambient(): number;\n",
    "configured.ts": "export function configured() { return 1; }\n",
    "tsconfig.json":
      '{"compilerOptions":{"baseUrl":".","paths":{"alias":["configured.ts"]}}}',
  });
  const context = await createReviewContext(root, {
    ...input,
    files: ["source.ts"],
    supportFiles: [],
  });
  const packet = analysis(context);
  assert.equal(packet.state, "collected");
  assert.deepEqual(
    packet.files.map((file) => file.file),
    ["source.ts"],
  );
  for (const kind of ["getter", "setter", "method", "arrow"])
    assert.ok(
      packet.functions.some((fn) => fn.kind === kind),
      kind,
    );
  for (const kind of [
    "type",
    "interface",
    "enum",
    "class",
    "property",
    "parameter",
  ])
    assert.ok(
      packet.declarations.some((decl) => decl.kind === kind),
      kind,
    );
  const outer = packet.functions.find((fn) => fn.name === "named")!;
  const inner = packet.functions.find((fn) => fn.name === "inner")!;
  const declaration = packet.declarations.find(
    (decl) => decl.name === "outer",
  )!;
  assert.equal(outer.declarationId, declaration.id);
  assert.ok(inner.enclosingDeclarations.includes(declaration.id));
  assert.ok(source.slice(outer.start, outer.end).includes("function inner()"));
  const call = (text: string) =>
    packet.calls.find((node) => source.slice(node.start, node.end) === text)!;
  assert.equal(call("inner()").callerFunctionId, outer.id);
  assert.equal(call("inner()").targetFunctionId, inner.id);
  assert.equal(call("outer()").targetFunctionId, outer.id);
  for (const text of ["ambient()", "configured()"])
    assert.equal(call(text).targetFunctionId, null, text);
  const setter = packet.functions.find((fn) => fn.kind === "setter")!;
  const fallback = packet.declarations.find(
    (decl) => decl.name === "fallback",
  )!;
  assert.ok(
    packet.references.some(
      (ref) =>
        ref.fromFunctionId === setter.id &&
        ref.targetDeclarationId === fallback.id,
    ),
  );
  const recursive = await fixture(t, {
    "deep.ts":
      "const value = " + "(".repeat(150) + "1" + ")".repeat(150) + ";\n",
  });
  const limited = analysis(
    await createReviewContext(recursive, {
      ...input,
      files: ["deep.ts"],
      supportFiles: [],
    }),
  );
  assert.equal(limited.files[0]!.state, "budget-exhausted");
  const metadata = await fixture(t, {
    "wide.ts": Array.from(
      { length: 300 },
      (_, index) => "function f" + index + "(a = 1, b = 2) { return a + b; }\n",
    ).join(""),
  });
  const wide = analysis(
    await createReviewContext(metadata, {
      ...input,
      files: ["wide.ts"],
      supportFiles: [],
    }),
  );
  assert.equal(wide.files[0]!.state, "budget-exhausted");
  assert.equal(wide.references.length, 0);
});

test("behavior source and declaration metadata share exact library CLI MCP evidence and operator disclosure gates", async (t) => {
  const root = await fixture(t, {
    "lib.ts": primary,
    "app.ts": consumer,
    ".checktrail/keep": "",
  });
  const expected = await createReviewContext(root, input);
  await writeFile(
    path.join(root, ".checktrail/selection.json"),
    JSON.stringify(input),
  );
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  for (const flags of [
    [],
    ["--detailed"],
    ["--detailed", "--allow-review-source"],
  ]) {
    const response = spawnSync(
      process.execPath,
      [
        cli,
        "review-context",
        "--root",
        root,
        "--input",
        ".checktrail/selection.json",
        ...flags,
      ],
      { encoding: "utf8" },
    );
    assert.equal(response.status, 0, response.stderr);
    const projected = projectReviewContext(
      expected,
      flags.includes("--allow-review-source"),
    );
    assert.deepEqual(JSON.parse(response.stdout), projected);
    assert.equal(
      response.stdout.includes('"analysis"'),
      flags.includes("--allow-review-source"),
    );
    assert.equal(
      response.stdout.includes("fallback"),
      flags.includes("--allow-review-source"),
    );
    const client = new Client(
      { name: "synthetic-behavior-client", version: "1.0.0" },
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
      const actual = await client.callTool({
        name: "review_context",
        arguments: input,
      });
      assert.equal(actual.isError, undefined);
      assert.deepEqual(actual.structuredContent, projected);
      assert.equal(
        (
          await client.callTool({
            name: "review_context",
            arguments: { ...input, allowReviewSource: true },
          })
        ).isError,
        true,
      );
      assert.equal(
        (await client.callTool({ name: "validation_run", arguments: {} }))
          .isError,
        true,
        "collecting syntax grants no project execution",
      );
    } finally {
      await client.close();
    }
  }
});

test("behavior context retains whole functions, defaults, aliases and shadowed-call near misses without execution", async (t) => {
  const trap =
    'import {writeFileSync} from "node:fs";\nwriteFileSync(new URL(".checktrail/executed", import.meta.url), "executed");\n';
  const root = await fixture(t, {
    "lib.ts": primary,
    "app.ts": consumer,
    "trap.mjs": trap,
    "config.mjs": trap + 'throw new Error("configuration must never execute");',
    "tsconfig.json":
      '{"compilerOptions":{"plugins":[{"name":"./config.mjs"}]}}',
    ".checktrail/keep": "",
  });
  const context = await createReviewContext(root, {
    ...input,
    supportFiles: ["app.ts", "trap.mjs"],
  });
  const result = analysis(context);
  assert.equal(result.state, "collected");
  assert.equal(result.reachabilityVerified, false);
  const assign = result.functions.find((node) => node.name === "assign")!;
  const adjacent = result.functions.find((node) => node.name === "adjacent")!;
  assert.equal(
    primary.slice(assign.start, assign.end),
    'export function assign(role = fallback) {\n  return role === "owner" ? "admin" : "member";\n}',
  );
  assert.equal(
    primary.slice(adjacent.start, adjacent.end),
    "export function adjacent() { return fallback; }",
  );
  assert.equal(assign.overlapsChange, null);
  const fallback = result.declarations.find(
    (node) => node.name === "fallback",
  )!;
  assert.equal(
    primary.slice(fallback.initializer!.start, fallback.initializer!.end),
    '"member"',
  );
  assert.ok(
    result.references.some(
      (ref) =>
        ref.fromFunctionId === assign.id &&
        ref.targetDeclarationId === fallback.id,
    ),
  );
  const submit = result.functions.find((node) => node.name === "submit")!;
  const shadow = result.functions.find((node) => node.name === "shadow")!;
  const indirect = result.functions.find((node) => node.name === "indirect")!;
  assert.deepEqual(
    result.calls
      .filter((call) => call.callerFunctionId === submit.id)
      .map((call) => [call.resolution, call.targetFunctionId]),
    [["lexical-binding", assign.id]],
  );
  assert.deepEqual(
    result.calls
      .filter((call) => call.callerFunctionId === shadow.id)
      .map((call) => [call.resolution, call.targetFunctionId]),
    [["no-selected-definition", null]],
  );
  assert.deepEqual(
    result.calls
      .filter((call) => call.callerFunctionId === indirect.id)
      .map((call) => [call.resolution, call.targetFunctionId]),
    [["unsupported-dispatch", null]],
  );
  assert.equal(
    result.calls.filter((call) => call.file === "app.ts").length,
    3,
    "comments and strings cannot become call sites",
  );
  assert.deepEqual(
    result.modules
      .filter((edge) => edge.file === "app.ts")
      .map((edge) => [edge.file, edge.targetFile, edge.resolution]),
    [["app.ts", "lib.ts", "selected"]],
  );
  assert.deepEqual(
    result.files.map((file) => [file.file, file.role]),
    [
      ["app.ts", "support"],
      ["lib.ts", "primary"],
      ["trap.mjs", "support"],
    ],
  );
  assert.ok(
    !JSON.stringify(projectReviewContext(context, false)).includes("fallback"),
  );
  await assert.rejects(access(path.join(root, ".checktrail/executed")));
});

test("diff behavior retains moved helper behavior, unchanged decisions and deleted cross-project callers", async (t) => {
  const old = {
    "lib/pixel.ts":
      'export function pixel(id: string) { return "event={ID}".replace("{ID}", id); }\nexport function decision(role: string) { return role === "owner"; }\n',
    "app/use.ts":
      'import {pixel} from "../lib/pixel.js";\nexport function serve() { return pixel("sample"); }\n',
  };
  const root = await fixture(t, old);
  fixtureGit(root, ["init", "--quiet"]);
  const baseCommit = await syntheticCommit(root, old);
  const changed =
    'export function replace(id: string) { return "event={ID}".replace("{ID}", id); }\nexport function pixel(id: string) { return replace(id); }\nexport function decision(role: string) { return role === "owner"; }\n';
  await writeFile(path.join(root, "lib/pixel.ts"), changed);
  await rm(path.join(root, "app/use.ts"));
  const context = await createReviewContext(root, {
    schemaVersion: 3,
    track: "diff",
    baseCommit,
    files: ["lib/pixel.ts"],
    supportFiles: ["app/use.ts"],
    topics: [],
  });
  const result = analysis(context);
  const beforePixel = result.functions.find(
    (node) => node.revision === "base" && node.name === "pixel",
  )!;
  const afterPixel = result.functions.find(
    (node) => node.revision === "current" && node.name === "pixel",
  )!;
  const helper = result.functions.find(
    (node) => node.revision === "current" && node.name === "replace",
  )!;
  const decision = result.functions.find(
    (node) => node.revision === "current" && node.name === "decision",
  )!;
  const caller = result.functions.find(
    (node) => node.revision === "base" && node.name === "serve",
  )!;
  assert.ok(
    old["lib/pixel.ts"]
      .slice(beforePixel.start, beforePixel.end)
      .includes('replace("{ID}", id)'),
  );
  assert.ok(
    changed.slice(helper.start, helper.end).includes('replace("{ID}", id)'),
  );
  assert.equal(decision.overlapsChange, false);
  assert.equal(afterPixel.overlapsChange, true);
  assert.ok(
    result.calls.some(
      (call) =>
        call.revision === "current" &&
        call.callerFunctionId === afterPixel.id &&
        call.targetFunctionId === helper.id,
    ),
  );
  assert.ok(
    result.calls.some(
      (call) =>
        call.revision === "base" &&
        call.callerFunctionId === caller.id &&
        call.targetFunctionId === beforePixel.id,
    ),
  );
  assert.ok(
    !result.functions.some(
      (node) => node.revision === "current" && node.name === "serve",
    ),
  );
});

test("behavior packet rejects support escapes, overlap and exclusions, and forged analysis cannot remain fresh", async (t) => {
  const root = await fixture(t, {
    "lib.ts": primary,
    "app.ts": consumer,
    ".env": "SYNTHETIC_SECRET=true",
  });
  for (const supportFiles of [
    ["lib.ts"],
    ["app.ts", "app.ts"],
    ["../escape.ts"],
    [".env"],
  ])
    await assert.rejects(createReviewContext(root, { ...input, supportFiles }));
  const context = await createReviewContext(root, input);
  const value: ReviewAssessment = {
    schemaVersion: 1,
    contextDigest: context.contextDigest,
    reviewer: { kind: "human", name: "synthetic" },
    createdAt: "2026-09-30T00:00:00Z",
    usage: {
      inputTokens: null,
      outputTokens: null,
      elapsedMs: null,
      costUSD: null,
    },
    files: context.files.map((file) => ({
      path: file.path,
      disposition: "reviewed",
      note: "synthetic",
    })),
    observations: [],
  };
  assert.equal(
    (await receiveReview(root, context, value)).freshness,
    "current",
  );
  assert.equal(
    (await receiveReview(root, context, value)).coverage.selected,
    2,
  );
  const forged = structuredClone(context) as unknown as {
    analysis: ReviewBehavior;
    contextDigest: string;
  };
  forged.analysis.functions[0]!.name = "invented-name";
  const { contextDigest, ...body } = forged;
  void contextDigest;
  forged.contextDigest = createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex");
  assert.equal(
    (
      await receiveReview(root, forged, {
        ...value,
        contextDigest: forged.contextDigest,
      })
    ).freshness,
    "stale",
  );
});
