import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createReviewContext, parseReviewContext } from "../src/review.js";
import { fixture } from "./helpers.js";
const policy =
  'namespace policy;public static class Policy{public const string LIMIT="grant";public static bool decision(){return true;}}';
async function capture(
  t: TestContext,
  source: string,
  extra: Record<string, string> = {},
) {
  const root = await fixture(t, { "Sample.cs": source, ...extra });
  const context = await createReviewContext(root, {
    schemaVersion: 15,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["Sample.cs"],
    supportFiles: Object.keys(extra),
    moduleRoots: ["."],
    topics: [],
  });
  assert.equal(context.schemaVersion, 15);
  if (context.schemaVersion !== 15) throw Error("Original C# required");
  assert.equal(
    parseReviewContext(context).contextDigest,
    context.contextDigest,
  );
  return context.analysis;
}
export async function csharpBoundariesFixture(t: TestContext) {
  for (const [source, expected] of [
    [
      "using policy;using absent;class Sample{static bool useit(){return Policy.decision();}}",
      "unsupported-dispatch",
    ],
    [
      "class Policy{public static bool decision(){return true;}}class Sample{static bool useit(){return Policy2.decision();}}",
      "no-selected-definition",
    ],
    [
      "using A=policy.Policy;class A{public static bool decision(){return true;}}class Sample{static bool useit(){return A.decision();}}",
      "ambiguous-definition",
    ],
    [
      "class Outer{private class Policy{public static bool decision(){return true;}}}class Sample{static bool useit(){return Outer.Policy.decision();}}",
      "unsupported-dispatch",
    ],
    [
      "class Sample{static bool decision(){return true;}static System.Func<bool> useit(){return delegate(){return decision();};}}",
      "unsupported-dispatch",
    ],
    [
      "using System.Linq;class Sample{static bool decision(){return true;}static object useit(){return from decision in new System.Func<bool>[]{()=>false} select decision();}}",
      "unsupported-dispatch",
    ],

    [
      "using A=policy.Policy;class Sample{static bool useit(){return A.decision();}}",
      "lexical-binding",
    ],
    [
      "using N=policy;class Sample{static bool useit(){return N.Policy.decision();}}",
      "lexical-binding",
    ],
    [
      "using policy;class Sample{static bool useit(){return Policy.decision();}}",
      "lexical-binding",
    ],
    [
      "using static policy.Policy;class Sample{static bool useit(System.Func<bool> decision){return decision();}}",
      "unsupported-dispatch",
    ],
    [
      "using static policy.Policy;class Sample{static System.Func<bool> decision;static bool useit(){return decision();}}",
      "unsupported-dispatch",
    ],
    [
      "using static policy.Policy;class Sample{static bool useit(){System.Func<bool> decision=()=>false;return decision();}}",
      "unsupported-dispatch",
    ],
    [
      "using A=policy.Policy;class Sample{static bool useit(object A){return A.decision();}}",
      "unsupported-dispatch",
    ],
    [
      "using static absent.Policy;using static policy.Policy;class Sample{static bool useit(){return decision();}}",
      "unsupported-dispatch",
    ],
    [
      "class Sample{static bool decision(){return true;}static bool decision(int x){return false;}static bool useit(){return decision();}}",
      "ambiguous-definition",
    ],
    [
      "class Sample:Base{static bool decision(){return true;}static bool useit(){return decision();}}",
      "unsupported-dispatch",
    ],
    [
      "class Sample{static bool decision(){return true;}static bool useit<T>(){return decision();}}",
      "unsupported-dispatch",
    ],
    [
      "class Sample{static bool decision(){return true;}static System.Func<bool> useit(){return ()=>decision();}}",
      "unsupported-dispatch",
    ],
    [
      "class Sample{static bool decision(){return true;}[Attribute]static bool useit(){return decision();}}",
      "unsupported-dispatch",
    ],
    [
      "#if FEATURE\nclass Sample{static bool decision(){return true;}static bool useit(){return decision();}}\n#endif",
      "unsupported-dispatch",
    ],
    [
      String.raw`class Sample{static bool decision(){return true;}static bool useit(){return deci\u0073ion();}}`,
      "unsupported-dispatch",
    ],
    [
      "using @A=policy.Policy;class Sample{static bool useit(){return @A.decision();}}",
      "unsupported-dispatch",
    ],
  ] as const) {
    const result = await capture(t, source, { "Policy.cs": policy });
    const calls = result.calls.filter((c) => c.file === "Sample.cs");
    assert.equal(calls.length, 1, source);
    assert.equal(calls[0]!.resolution, expected, source);
    if (expected !== "lexical-binding")
      assert.equal(calls[0]!.targetFunctionId, null, source);
    else
      assert.equal(
        calls[0]!.targetFunctionId,
        result.functions.find(
          (fn) => fn.file === "Policy.cs" && fn.name === "decision",
        )!.id,
        source,
      );
  }
  const local = await capture(
    t,
    "using static policy.Policy;class Sample{static bool useit(){bool before(){return decision();}bool decision(){return false;}return before();}}",
    { "Policy.cs": policy },
  );
  const localTarget = local.functions.find(
    (fn) => fn.file === "Sample.cs" && fn.name === "decision",
  )!;
  assert.ok(localTarget);
  assert.equal(
    local.calls.find(
      (c) =>
        c.callerFunctionId ===
        local.functions.find((fn) => fn.name === "before")!.id,
    )!.targetFunctionId,
    localTarget.id,
  );
  assert.equal(
    local.csharpBindings.callerEdges.filter(
      (e) => e.targetFunctionId === localTarget.id,
    ).length,
    2,
  );
  const own = await capture(
    t,
    "using static policy.Policy;class Sample{static bool decision(){return false;}static bool useit(){return decision();}}",
    { "Policy.cs": policy },
  );
  assert.equal(
    own.calls[0]!.targetFunctionId,
    own.functions.find(
      (fn) => fn.file === "Sample.cs" && fn.name === "decision",
    )!.id,
  );
  const nested = await capture(
    t,
    "class Sample{public class Policy{public static bool decision(){return true;}}static bool useit(){return Policy.decision();}}",
  );
  assert.equal(nested.calls[0]!.resolution, "lexical-binding");
  const blockSource =
    "namespace local{public static class Policy{public const int LIMIT=2;public static int useit(){return LIMIT;}}}";
  const block = await capture(t, blockSource);
  const limit = block.declarations.find((d) => d.name === "LIMIT")!;
  assert.ok(limit);
  assert.equal(
    block.references.filter((r) => r.targetDeclarationId === limit.id).length,
    1,
  );
  const named = await capture(
    t,
    "class Sample{const int LIMIT=2;static int accept(int LIMIT){return LIMIT;}static int useit(){return accept(LIMIT:3);}}",
  );
  assert.deepEqual(named.references, []);
  const literal = await capture(
    t,
    "class Sample{const int LIMIT=2;static int useit(int value=LIMIT){return LIMIT;}}",
  );
  assert.equal(literal.references.length, 2);
  const literalSource =
    "class Sample{const int LIMIT=2;static int useit(int value=LIMIT){return LIMIT;}}";
  const parameter = literal.declarations.find(
    (declaration) =>
      declaration.name === "value" && declaration.kind === "parameter",
  )!;
  assert.ok(parameter);
  assert.equal(
    literalSource.slice(parameter.start, parameter.end),
    "int value=LIMIT",
  );
  assert.ok(parameter.initializer);
  assert.equal(
    literalSource.slice(parameter.initializer.start, parameter.initializer.end),
    "LIMIT",
  );

  assert.ok(
    literal.references.every(
      (r) =>
        r.targetDeclarationId ===
        literal.declarations.find((d) => d.name === "LIMIT")!.id,
    ),
  );
  const inert = await capture(
    t,
    'class Sample{const string TEXT="Policy.decision()";/* Policy.decision() */}',
  );
  assert.deepEqual(inert.calls, []);
  const constructor = await capture(
    t,
    "class Sample{static Sample choose(){return new Sample();}}",
  );
  assert.equal(constructor.calls.length, 1);
  assert.equal(constructor.calls[0]!.kind, "construct");
  assert.equal(constructor.calls[0]!.targetFunctionId, null);
  assert.ok(
    constructor.csharpBindings.omissions.includes(
      "constructor-dispatch-unknown",
    ),
  );
  const nestedCalls = await capture(
    t,
    "class Sample{static System.Func<bool> choose(){return null;}static bool useit(){return choose()();}}",
  );
  assert.equal(nestedCalls.calls.length, 2);
  assert.equal(
    nestedCalls.calls.filter((c) => c.targetFunctionId !== null).length,
    1,
  );
  assert.equal(
    nestedCalls.calls.find((c) => c.end - c.start === 8)!.targetFunctionId,
    nestedCalls.functions.find((fn) => fn.name === "choose")!.id,
  );
  assert.equal(
    nestedCalls.calls.find((c) => c.end - c.start === 10)!.targetFunctionId,
    null,
  );
  const duplicate = await capture(
    t,
    "using A=policy.Policy;class Sample{static bool useit(){return A.decision();}}",
    { "Policy.cs": policy, "Copy.cs": policy },
  );
  assert.equal(duplicate.calls[0]!.resolution, "ambiguous-definition");
  assert.equal(duplicate.calls[0]!.targetFunctionId, null);
  const global = await capture(
    t,
    "using A=policy.Policy;class Sample{static bool useit(){return A.decision();}}",
    { "Policy.cs": policy, "Imports.cs": "global using static policy.Policy;" },
  );
  assert.equal(global.calls[0]!.targetFunctionId, null);
  assert.ok(global.csharpBindings.omissions.includes("global-using-unknown"));
  const namespaceMixed = await capture(
    t,
    "namespace one{public class Policy{public static bool decision(){return true;}}}class Sample{static bool useit(){return one.Policy.decision();}}",
  );
  assert.equal(namespaceMixed.calls[0]!.targetFunctionId, null);
  assert.ok(
    namespaceMixed.csharpBindings.omissions.includes("unsupported-namespace"),
  );
  const generatedRoot = await fixture(t, {
    "Sample.cs": "class Sample{static bool decision(){return true;}}",
    "obj/Generated.cs":
      "class Other{static bool useit(){return Sample.decision();}}",
  });
  await assert.rejects(
    createReviewContext(generatedRoot, {
      schemaVersion: 15,
      track: "snapshot",
      currentSource: "working-tree",
      files: ["Sample.cs"],
      supportFiles: ["obj/Generated.cs"],
      moduleRoots: ["."],
      topics: [],
    }),
    /excluded|generated|source path/i,
  );
}
