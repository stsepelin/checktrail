import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createReviewContext } from "../src/review.js";
import { fixture } from "./helpers.js";
export async function swiftBoundariesFixture(t: TestContext) {
  const inspect = async (source: string) => {
    const root = await fixture(t, { "Sample.swift": source });
    const context = await createReviewContext(root, {
      schemaVersion: 18,
      track: "snapshot",
      currentSource: "working-tree",
      files: ["Sample.swift"],
      supportFiles: [],
      moduleRoots: [{ directory: ".", module: "Sample" }],
      topics: [],
    });
    assert.equal(context.schemaVersion, 18);
    if (context.schemaVersion !== 18) throw Error("Swift context required");
    return { root, context, value: context.analysis };
  };
  const calls = (
    value: Awaited<ReturnType<typeof inspect>>["value"],
    name: string,
  ) => {
    const fn = value.functions.find((fn) => fn.name === name);
    assert.ok(fn);
    return value.calls.filter((call) => call.callerFunctionId === fn.id);
  };
  const param = await inspect(
    "func decision()->Bool{return true}\nfunc useit(decision:()->Bool)->Bool{return decision()}\n",
  );
  assert.equal(calls(param.value, "useit").length, 1);
  assert.equal(calls(param.value, "useit")[0]!.targetFunctionId, null);
  const conditional = await inspect(
    "func decision()->Bool{return true}\nfunc useit(_ value:(()->Bool)?)->Bool{if let decision=value {return decision()}\nreturn false}\n",
  );
  assert.equal(calls(conditional.value, "useit").length, 1);
  assert.equal(calls(conditional.value, "useit")[0]!.targetFunctionId, null);
  assert.equal(conditional.value.files[0]!.state, "collected");
  const local = await inspect(
    "func decision()->Bool{return true}\nfunc alternate()->Bool{return false}\nfunc useit()->Bool{let decision=alternate;return decision()}\n",
  );
  assert.equal(calls(local.value, "useit").length, 1);
  assert.equal(calls(local.value, "useit")[0]!.targetFunctionId, null);
  const forward = await inspect(
    "func decision()->Bool{return false}\nfunc useit()->Bool{return decision();func decision()->Bool{return true}}\n",
  );
  const nested = forward.value.functions
    .filter((fn) => fn.name === "decision")
    .find((fn) => fn.enclosingDeclarations.length > 0);
  assert.ok(nested);
  assert.equal(calls(forward.value, "useit")[0]!.targetFunctionId, nested.id);
  const defaults = await inspect(
    "let LIMIT=2\nfunc useit(LIMIT:Int,value:Int=LIMIT)->Int{return value}\n",
  );
  const constant = defaults.value.declarations.find(
      (decl) => decl.kind === "variable" && decl.name === "LIMIT",
    ),
    owner = defaults.value.declarations.find(
      (decl) => decl.kind === "parameter" && decl.name === "value",
    );
  assert.ok(constant && owner?.initializer);
  assert.equal(defaults.value.references.length, 1);
  assert.equal(defaults.value.references[0]!.targetDeclarationId, constant.id);
  assert.equal(defaults.value.references[0]!.ownerDeclarationId, owner.id);
  assert.equal(
    defaults.context.files[0]!.content.slice(
      defaults.value.references[0]!.start,
      defaults.value.references[0]!.end,
    ),
    "LIMIT",
  );
  const before = await inspect(
    "func decision()->Bool{return true}\nfunc useit()->Bool{let before=decision();let decision=2;return before}\n",
  );
  assert.notEqual(calls(before.value, "useit")[0]!.targetFunctionId, null);
  const inert = await inspect(
    'let LIMIT=2\n// LIMIT decision()\nlet TEXT="LIMIT decision()"\nfunc decision()->Bool{return true}\nfunc useit(LIMIT:Int)->Bool{return true}\n',
  );
  assert.equal(inert.value.references.length, 0);
  assert.equal(inert.value.calls.length, 0);
  const own = await inspect(
    "func decision()->Bool{return true}\nfunc useit()->Bool{return Sample.decision()}\n",
  );
  assert.notEqual(calls(own.value, "useit")[0]!.targetFunctionId, null);
  const masked = await inspect(
    "func decision()->Bool{return true}\nfunc useit(Sample:Int)->Bool{return Sample.decision()}\n",
  );
  assert.equal(calls(masked.value, "useit")[0]!.targetFunctionId, null);
  const complete = await inspect(
    "func leaf()->Bool{return true}\nfunc factory()->()->Bool{return leaf}\nfunc useit()->Bool{return factory()()}\n",
  );
  const composed = calls(complete.value, "useit");
  assert.equal(composed.length, 2);
  const outer = composed.find(
    (call) =>
      complete.context.files[0]!.content.slice(call.start, call.end) ===
      "factory()()",
  );
  assert.ok(outer);
  assert.equal(outer.targetFunctionId, null);
  for (const [source, expression] of [
    [
      "public func decision<T>(_ value:T)->Bool{return true}\n",
      'Policy.decision("grant")',
    ],
    [
      "@inline(__always) public func decision()->Bool{return true}\n",
      "Policy.decision()",
    ],
    [
      "public func decision()->Bool{let values=[true];return values.map { $0 }[0]}\n",
      "Policy.decision()",
    ],
    [
      "public func decision()->Bool{for _ in 0..<2 {}\nreturn true}\n",
      "Policy.decision()",
    ],
    [
      "public func decision()->Bool{var i=0;while i<2 {i+=1}\nreturn true}\n",
      "Policy.decision()",
    ],
    [
      'public func decision()->Bool{defer {print("cleanup")}\nreturn true}\n',
      "Policy.decision()",
    ],
    [
      "public struct Service {public static func decision()->Bool{return true}}\n",
      "Policy.Service.decision()",
    ],
    [
      "public func decision(_ value:inout Int)->Bool{return value>0}\n",
      "Policy.decision(&value)",
    ],
  ] as const) {
    const root = await fixture(t, {
      "policy/Policy.swift": source,
      "consumer/Consumer.swift":
        "import Policy\nfunc useit()->Bool{var value=2;return " +
        expression +
        "}\n",
    });
    const context = await createReviewContext(root, {
      schemaVersion: 18,
      track: "snapshot",
      currentSource: "working-tree",
      files: ["policy/Policy.swift"],
      supportFiles: ["consumer/Consumer.swift"],
      moduleRoots: [
        { directory: "policy", module: "Policy" },
        { directory: "consumer", module: "Consumer" },
      ],
      topics: [],
    });
    if (context.schemaVersion !== 18) throw Error("Swift context required");
    assert.equal(
      context.analysis.files.find(
        (file) => file.file === "policy/Policy.swift",
      )!.state,
      "collected",
      source,
    );
    const selected = context.analysis.calls.filter(
      (call) => call.file === "consumer/Consumer.swift",
    );
    assert.equal(selected.length, 1, source);
    assert.equal(selected[0]!.targetFunctionId, null, source);
  }
  const nonliteral = await inspect(
    "let LIMIT=2\nlet ALIAS=LIMIT\nfunc useit()->Int{return ALIAS}\n",
  );
  assert.equal(nonliteral.value.references.length, 1);
  const limit = nonliteral.value.declarations.find(
    (decl) => decl.kind === "variable" && decl.name === "LIMIT",
  );
  assert.ok(limit);
  assert.equal(nonliteral.value.references[0]!.targetDeclarationId, limit.id);
  const prefix = await inspect(
    "func decision()->Bool{return true}\nfunc decisionExtra()->Bool{return false}\nfunc useit()->Bool{return decision()}\n",
  );
  const exact = prefix.value.functions.find((fn) => fn.name === "decision");
  assert.ok(exact);
  assert.equal(calls(prefix.value, "useit")[0]!.targetFunctionId, exact.id);
  const neighborRoot = await fixture(t, {
    "policy/Policy.swift": "public func decision()->Bool{return true}\n",
    "consumer/Consumer.swift":
      "import Policy\nfunc useit()->Bool{return Policy.decision()}\n",
  });
  const neighbor = await createReviewContext(neighborRoot, {
    schemaVersion: 18,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["policy/Policy.swift"],
    supportFiles: ["consumer/Consumer.swift"],
    moduleRoots: [
      { directory: "policy", module: "PolicyExtra" },
      { directory: "consumer", module: "Consumer" },
    ],
    topics: [],
  });
  if (neighbor.schemaVersion !== 18) throw Error("Swift context required");
  assert.equal(calls(neighbor.analysis, "useit")[0]!.targetFunctionId, null);
  assert.equal(neighbor.analysis.modules[0]!.resolution, "external");
  const siblingsRoot = await fixture(t, {
    "Same.swift":
      "private func hidden()->Bool{return true}\nfunc own()->Bool{return hidden()}\nfunc visible()->Bool{return true}\n",
    "Other.swift":
      "func privateCall()->Bool{return hidden()}\nfunc internalCall()->Bool{return visible()}\n",
  });
  const siblings = await createReviewContext(siblingsRoot, {
    schemaVersion: 18,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["Same.swift"],
    supportFiles: ["Other.swift"],
    moduleRoots: [{ directory: ".", module: "Sample" }],
    topics: [],
  });
  if (siblings.schemaVersion !== 18) throw Error("Swift context required");
  assert.notEqual(calls(siblings.analysis, "own")[0]!.targetFunctionId, null);
  assert.equal(
    calls(siblings.analysis, "privateCall")[0]!.targetFunctionId,
    null,
  );
  assert.notEqual(
    calls(siblings.analysis, "internalCall")[0]!.targetFunctionId,
    null,
  );

  const root = await fixture(t, {
    "policy/Policy.swift":
      "public func decision()->Bool{return true}\nprivate func hidden()->Bool{return true}\nfunc internalDecision()->Bool{return true}\n",
    "consumer/Consumer.swift":
      "import Policy\nfunc publicCall()->Bool{return Policy.decision()}\nfunc privateCall()->Bool{return Policy.hidden()}\nfunc internalCall()->Bool{return Policy.internalDecision()}\n",
  });
  const context = await createReviewContext(root, {
    schemaVersion: 18,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["policy/Policy.swift"],
    supportFiles: ["consumer/Consumer.swift"],
    moduleRoots: [
      { directory: "policy", module: "Policy" },
      { directory: "consumer", module: "Consumer" },
    ],
    topics: [],
  });
  if (context.schemaVersion !== 18) throw Error("Swift context required");
  assert.notEqual(
    calls(context.analysis, "publicCall")[0]!.targetFunctionId,
    null,
  );
  assert.equal(
    calls(context.analysis, "privateCall")[0]!.targetFunctionId,
    null,
  );
  assert.equal(
    calls(context.analysis, "internalCall")[0]!.targetFunctionId,
    null,
  );
  const duplicate = await inspect(
    "func decision()->Bool{return true}\nfunc decision(_ value:Int)->Bool{return false}\nfunc useit()->Bool{return decision()}\n",
  );
  assert.equal(
    calls(duplicate.value, "useit")[0]!.resolution,
    "ambiguous-definition",
  );
}
