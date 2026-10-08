import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createReviewContext, parseReviewContext } from "../src/review.js";
import { fixture } from "./helpers.js";
const policy = "module Policy\nlet LIMIT = 2\nlet decision () = true\n";
const other = "module Other\nlet decision () = false\n";
async function capture(
  t: TestContext,
  source: string,
  extra: Record<string, string> = {},
) {
  const root = await fixture(t, { "Sample.fs": source, ...extra });
  const context = await createReviewContext(root, {
    schemaVersion: 16,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["Sample.fs"],
    supportFiles: Object.keys(extra),
    moduleRoots: ["."],
    topics: [],
  });
  assert.equal(context.schemaVersion, 16);
  if (context.schemaVersion !== 16) throw Error("Original F# required");
  assert.equal(
    parseReviewContext(context).contextDigest,
    context.contextDigest,
  );
  return context.analysis;
}
export async function fsharpBoundariesFixture(t: TestContext) {
  for (const [source, expected] of [
    [
      "module Sample\nopen Policy\nlet useit () = decision ()\n",
      "lexical-binding",
    ],
    [
      "module Sample\nmodule P = Policy\nlet useit () = P.decision ()\n",
      "lexical-binding",
    ],
    ["module Sample\nlet useit () = Policy.decision ()\n", "lexical-binding"],
    [
      "module Sample\nlet useit () = Policy2.decision ()\n",
      "no-selected-definition",
    ],
    [
      "module Sample\nopen Policy\nopen Absent\nlet useit () = decision ()\n",
      "unsupported-dispatch",
    ],
    [
      "module Sample\nopen Policy\nlet useit decision = decision ()\n",
      "unsupported-dispatch",
    ],
    [
      "module Sample\nmodule P = Policy\nlet useit P = P.decision ()\n",
      "unsupported-dispatch",
    ],
    [
      "module Sample\nopen Policy\nlet decision = 2\nlet useit () = decision ()\n",
      "unsupported-dispatch",
    ],
    [
      "module Sample\nopen Policy\nlet useit () = fun decision -> decision ()\n",
      "unsupported-dispatch",
    ],
    [
      "module Sample\nopen Policy\nlet useit () = for decision in [1] do decision ()\n",
      "unsupported-dispatch",
    ],
    [
      "module Sample\nopen Policy\nlet useit value = match value with | decision -> decision ()\n",
      "unsupported-dispatch",
    ],
    [
      "module Sample\nopen Policy\nlet rec useit () = decision ()\n",
      "unsupported-dispatch",
    ],
    [
      "module Sample\nopen Policy\nlet inline useit () = decision ()\n",
      "unsupported-dispatch",
    ],
    [
      "module Sample\nopen Policy\nlet useit a b = decision ()\n",
      "unsupported-dispatch",
    ],
    [
      "module Sample\nopen Policy\nlet useit<'T> () = decision ()\n",
      "unsupported-dispatch",
    ],
    [
      "module Sample\nopen Policy\nlet useit () = seq { yield decision () }\n",
      "unsupported-dispatch",
    ],
    [
      "module Sample\nopen Policy\nlet (decision, other) = ((fun () -> false), 2)\nlet useit () = decision ()\n",
      "unsupported-dispatch",
    ],
    [
      "module Sample\nopen type Policy\nlet useit () = decision ()\n",
      "unsupported-dispatch",
    ],
    [
      "module Sample\nopen Policy\n[<Unknown>]\nlet useit () = decision ()\n",
      "unsupported-dispatch",
    ],
    [
      "module Sample\n#if FEATURE\nopen Policy\nlet useit () = decision ()\n#endif\n",
      "unsupported-dispatch",
    ],
    [
      "module Sample\nmodule Inner =\n  let decision () = true\nlet useit () = Inner.decision ()\n",
      "unsupported-dispatch",
    ],
  ] as const) {
    const result = await capture(t, source, { "Policy.fs": policy });
    const calls = result.calls.filter((c) => c.file === "Sample.fs");
    assert.equal(calls.length, 1, source);
    assert.equal(calls[0]!.resolution, expected, source);
    assert.equal(
      calls[0]!.targetFunctionId,
      expected === "lexical-binding"
        ? result.functions.find(
            (fn) => fn.file === "Policy.fs" && fn.name === "decision",
          )!.id
        : null,
      source,
    );
  }
  const ordered = await capture(
    t,
    "module Sample\nlet decision () = false\nopen Policy\nlet own_before () = decision ()\nopen Other\nlet later_open () = decision ()\nlet local () =\n  let before () = decision ()\n  let decision () = true\n  before ()\nlet initializer () =\n  let LIMIT = LIMIT\n  LIMIT\n",
    { "Policy.fs": policy, "Other.fs": other },
  );
  const target = (file: string) =>
    ordered.functions.find((fn) => fn.file === file && fn.name === "decision")!
      .id;
  for (const [name, file] of [
    ["own_before", "Policy.fs"],
    ["later_open", "Other.fs"],
    ["before", "Other.fs"],
  ] as const) {
    const fn = ordered.functions.find((fn) => fn.name === name)!;
    assert.ok(fn);
    assert.equal(
      ordered.calls.find((c) => c.callerFunctionId === fn.id)!.targetFunctionId,
      target(file),
      name,
    );
  }
  const limit = ordered.declarations.find(
    (d) => d.file === "Policy.fs" && d.name === "LIMIT",
  )!;
  assert.ok(limit.initializer);
  assert.equal(
    policy.slice(limit.initializer.start, limit.initializer.end),
    "2",
  );
  const localLimit = ordered.declarations.find(
    (d) => d.file === "Sample.fs" && d.name === "LIMIT",
  )!;
  assert.ok(localLimit);
  assert.ok(
    ordered.references.some(
      (r) =>
        r.ownerDeclarationId === localLimit.id &&
        r.targetDeclarationId === limit.id,
    ),
  );
  for (const source of [
    "module Sample\nlet decision () = true\nlet useit () = Sample.decision ()\n",
    "module Sample\nlet decision () = true\nmodule P = Sample\nlet useit () = P.decision ()\n",
    "module Container.Sample\nlet decision () = true\nlet useit () = Container.Sample.decision ()\n",
  ]) {
    const self = await capture(t, source);
    assert.equal(self.calls[0]!.resolution, "unsupported-dispatch", source);
    assert.equal(self.calls[0]!.targetFunctionId, null, source);
  }
  const typed = await capture(
    t,
    "module Sample\nopen Policy\nlet useit (value: string) = decision ()\n",
    { "Policy.fs": policy },
  );
  assert.equal(typed.calls[0]!.resolution, "lexical-binding");
  const privateFn = await capture(
    t,
    "module Sample\nlet useit () = Hidden.decision ()\n",
    { "Hidden.fs": "module Hidden\nlet private decision () = true\n" },
  );
  assert.equal(privateFn.calls[0]!.resolution, "unsupported-dispatch");
  const duplicate = await capture(
    t,
    "module Sample\nlet useit () = Policy.decision ()\n",
    { "Policy.fs": policy, "Duplicate.fs": policy },
  );
  assert.equal(duplicate.calls[0]!.resolution, "ambiguous-definition");
  const scripts = await capture(
    t,
    "module Sample\nlet useit () = Policy.decision ()\n",
    { "Policy.fsx": policy },
  );
  assert.equal(scripts.calls[0]!.targetFunctionId, null);
  assert.ok(scripts.fsharpBindings.omissions.includes("script-source-unknown"));
  const signature = await capture(
    t,
    "module Sample\nlet useit () = Policy.decision ()\n",
    {
      "Policy.fsi": "module Policy\nval decision: unit -> bool\n",
      "Policy.fs": policy,
    },
  );
  assert.equal(signature.calls[0]!.targetFunctionId, null);
  assert.ok(
    signature.fsharpBindings.omissions.includes("signature-source-unknown"),
  );
  const nested = await capture(
    t,
    "module Sample\nlet choose () = fun () -> true\nlet useit () = choose () ()\n",
  );
  assert.equal(nested.calls.length, 2);
  const complete = nested.calls.find(
    (c) => c.resolution === "lexical-binding",
  )!;
  assert.ok(complete);
  const outer = nested.calls.find((c) => c !== complete)!;
  assert.equal(outer.targetFunctionId, null);
  assert.equal(outer.start, complete.start);
  assert.ok(outer.end > complete.end);
  for (const source of [
    "module Sample\nopen Policy\nlet private inline useit () = decision ()\n",
    "module Sample\nopen Policy\nlet internal useit () = decision ()\n",
  ]) {
    const modified = await capture(t, source, { "Policy.fs": policy });
    assert.equal(modified.calls[0]!.resolution, "unsupported-dispatch", source);
    assert.equal(modified.calls[0]!.targetFunctionId, null, source);
  }
  const grouped = await capture(
    t,
    "module Sample\nopen Policy\nlet rec first value = if value <= 0 then true else second (value - 1)\nand second value = first value\nlet useit () = first 4\n",
    { "Policy.fs": "module Policy\nlet first value = false\n" },
  );
  assert.equal(grouped.calls.length, 3);
  assert.ok(
    grouped.calls.every(
      (call) =>
        call.resolution === "unsupported-dispatch" &&
        call.targetFunctionId === null,
    ),
  );
  const mutable = await capture(
    t,
    "module Sample\nlet mutable private LIMIT = 2\nlet useit () = LIMIT\n",
  );
  assert.deepEqual(mutable.references, []);
  assert.ok(mutable.fsharpBindings.omissions.includes("unsupported-binding"));
  const nonliteral = await capture(
    t,
    "module Sample\nlet useit () = Policy.LIMIT\n",
    { "Policy.fs": "module Policy\nlet LIMIT = 1 + 1\n" },
  );
  assert.deepEqual(nonliteral.references, []);
  const inert = await capture(
    t,
    'module Sample\nlet TEXT = "Policy.decision ()"\n// Policy.decision ()\n',
  );
  assert.deepEqual(inert.calls, []);
  assert.deepEqual(inert.references, []);
  const ownInitializer = await capture(
    t,
    "module Sample\nlet LIMIT = 2\nlet useit () =\n  let LIMIT = LIMIT\n  LIMIT\n",
  );
  const outerLimit = ownInitializer.declarations.find(
    (d) => d.name === "LIMIT",
  )!;
  assert.equal(
    ownInitializer.references.filter(
      (r) => r.targetDeclarationId === outerLimit.id,
    ).length,
    1,
  );
  const exact = await capture(
    t,
    "module Sample\nmodule P = Policy\nlet useit () = P.LIMIT\n",
    { "Policy.fs": policy },
  );
  assert.equal(exact.references.length, 1);
  assert.equal(
    exact.references[0]!.targetDeclarationId,
    exact.declarations.find(
      (d) => d.file === "Policy.fs" && d.name === "LIMIT",
    )!.id,
  );
  const generatedRoot = await fixture(t, {
    "Sample.fs": "module Sample\nlet decision () = true\n",
    "obj/Generated.fs": "module Generated\nlet useit () = Sample.decision ()\n",
  });
  await assert.rejects(
    createReviewContext(generatedRoot, {
      schemaVersion: 16,
      track: "snapshot",
      currentSource: "working-tree",
      files: ["Sample.fs"],
      supportFiles: ["obj/Generated.fs"],
      moduleRoots: ["."],
      topics: [],
    }),
    /excluded|generated|source path/i,
  );
}
