import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createReviewContext, parseReviewContext } from "../src/review.js";
import { fixture } from "./helpers.js";
const policy =
  "module Policy\n  LIMIT = 2\n  def self.decision\n    true\n  end\nend\n";
async function capture(
  t: TestContext,
  source: string,
  extra: Record<string, string> = {},
) {
  const root = await fixture(t, { "Sample.rb": source, ...extra });
  const context = await createReviewContext(root, {
    schemaVersion: 17,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["Sample.rb"],
    supportFiles: Object.keys(extra),
    moduleRoots: ["."],
    topics: [],
  });
  assert.equal(context.schemaVersion, 17);
  if (context.schemaVersion !== 17) throw Error("Original Ruby required");
  assert.equal(
    parseReviewContext(context).contextDigest,
    context.contextDigest,
  );
  return context.analysis;
}
export async function rubyBoundariesFixture(t: TestContext) {
  for (const [body, expected] of [
    ["Policy.decision()", "lexical-binding"],
    ["::Policy.decision()", "lexical-binding"],
    ["Policy2.decision()", "no-selected-definition"],
    ["Policy.decisi()", "no-selected-definition"],
    ["policy.decision()", "unsupported-dispatch"],
    ["Policy&.decision()", "unsupported-dispatch"],
  ] as const) {
    const source =
        "module Sample\n def self.useit(policy)\n " + body + "\n end\nend\n",
      result = await capture(t, source, { "Policy.rb": policy }),
      call = result.calls.find(
        (call) =>
          call.file === "Sample.rb" &&
          source.slice(call.start, call.end) === body,
      )!;
    assert.ok(call, body);
    assert.equal(call.resolution, expected, body);
    assert.equal(
      call.targetFunctionId,
      expected === "lexical-binding"
        ? result.functions.find(
            (fn) => fn.file === "Policy.rb" && fn.name === "decision",
          )!.id
        : null,
      body,
    );
  }
  const localSource =
      "module Sample\n def self.decision\n true\n end\n def self.param(decision)\n decision()\n decision\n self.decision\n end\n def self.forward\n before = decision\n decision = 2\n after = decision\n decision()\n end\n def self.initializer\n decision = decision\n decision()\n end\nend\n",
    local = await capture(t, localSource),
    target = local.functions.find((fn) => fn.name === "decision")!.id;
  for (const [name, count] of [
    ["param", 2],
    ["forward", 2],
    ["initializer", 1],
  ] as const) {
    const fn = local.functions.find((fn) => fn.name === name)!;
    assert.ok(fn);
    const calls = local.calls.filter((call) => call.callerFunctionId === fn.id);
    assert.equal(calls.length, count, name);
    assert.ok(
      calls.every(
        (call) =>
          call.targetFunctionId === target &&
          call.resolution === "lexical-binding",
      ),
      name,
    );
  }
  const before = local.calls.find(
    (call) =>
      localSource.slice(call.start, call.end) === "decision" &&
      !localSource.slice(call.start - 5, call.start).endsWith("self."),
  )!;
  assert.ok(before);
  assert.equal(localSource.slice(before.start - 9, before.start), "before = ");
  const valueReceiver = await capture(
    t,
    "module Sample\n def self.decision\n true\n end\n def self.useit(policy)\n policy.decision()\n end\nend\n",
  );
  const unknownReceiver = valueReceiver.calls.find(
    (call) =>
      call.callerFunctionId ===
      valueReceiver.functions.find((fn) => fn.name === "useit")!.id,
  )!;
  assert.equal(unknownReceiver.targetFunctionId, null);
  assert.equal(unknownReceiver.resolution, "unsupported-dispatch");
  const defaults = await capture(
      t,
      "module Sample\n LIMIT = 2\n def self.useit(value = LIMIT)\n value\n end\nend\n",
    ),
    constant = defaults.declarations.find(
      (decl) => decl.name === "LIMIT" && decl.kind === "variable",
    )!,
    param = defaults.declarations.find(
      (decl) => decl.name === "value" && decl.kind === "parameter",
    )!;
  assert.ok(constant?.initializer);
  assert.ok(param?.initializer);
  assert.equal(
    defaults.references.filter(
      (ref) =>
        ref.targetDeclarationId === constant.id &&
        ref.ownerDeclarationId === param.id,
    ).length,
    1,
  );
  assert.deepEqual(defaults.calls, []);
  const shadow = await capture(
    t,
    "module Sample\n Policy = 2\n def self.useit\n Policy.decision\n ::Policy.decision\n end\nend\n",
    { "Policy.rb": policy },
  );
  assert.deepEqual(
    shadow.calls
      .filter((call) => call.file === "Sample.rb")
      .map((call) => call.resolution),
    ["unsupported-dispatch", "lexical-binding"],
  );
  const rootConstant = await capture(
    t,
    "module Sample\n LIMIT = 2\n def self.useit\n ::LIMIT\n end\nend\n",
  );
  assert.deepEqual(
    rootConstant.references,
    [],
    "Absolute root constant cannot inherit a module literal",
  );
  const alias = await capture(
    t,
    "module Sample\n P = Policy\n def self.useit\n P.decision\n end\nend\n",
    { "Policy.rb": policy },
  );
  assert.equal(
    alias.calls.find((call) => call.file === "Sample.rb")!.resolution,
    "unsupported-dispatch",
  );
  for (const extra of [
    { "Policy.rb": policy, "PolicyAgain.rb": policy },
    {
      "Policy.rb": policy.replace(
        "end\nend\n",
        "end\n def self.decision\n false\n end\nend\n",
      ),
    },
  ]) {
    const value = await capture(
      t,
      "module Sample\n def self.useit\n Policy.decision\n end\nend\n",
      extra,
    );
    assert.equal(value.calls[0]!.resolution, "ambiguous-definition");
    assert.equal(value.calls[0]!.targetFunctionId, null);
  }
  for (const source of [
    "module Sample\n def self.useit(value)\n Policy.decision while value\n end\nend\n",
    "module Sample\n def self.useit(value)\n Policy.decision until value\n end\nend\n",
    "module Sample\n def self.useit\n true\n ensure\n Policy.decision\n end\nend\n",
    "module Sample\n def self.useit\n yield\n Policy.decision\n end\nend\n",
    "module Sample\n def self.useit\n super\n Policy.decision\n end\nend\n",
    'module Sample\n def self.useit\n eval("inert original")\n Policy.decision\n end\nend\n',
    "module Sample\n include Policy\n def self.useit\n Policy.decision\n end\nend\n",
    "module Sample\n extend Policy\n def self.useit\n Policy.decision\n end\nend\n",
    "module Sample\n private_class_method :useit\n def self.useit\n Policy.decision\n end\nend\n",
    "module Sample\n def useit\n Policy.decision\n end\nend\n",
    "module Sample\n module Nested\n def self.useit\n Policy.decision\n end\n end\nend\n",
    "module Sample\n def self.useit\n [1].each { Policy.decision }\n end\nend\n",
    "module Sample\n def self.useit\n for value in [1]\n Policy.decision\n end\n end\nend\n",
    "module Sample\n def self.useit\n Policy.decision if decision = true\n end\nend\n",
    "module Sample\n def self.useit(&block)\n Policy.decision\n end\nend\n",
    "class Sample\n def self.useit\n Policy.decision\n end\nend\n",
  ]) {
    const value = await capture(t, source, { "Policy.rb": policy }),
      calls = value.calls.filter(
        (call) =>
          call.file === "Sample.rb" &&
          source.slice(call.start, call.end).includes("Policy.decision"),
      );
    assert.ok(calls.length > 0, source);
    assert.ok(
      calls.every((call) => call.targetFunctionId === null),
      source,
    );
    assert.equal(value.rubyBindings.state, "partial");
  }
  const unsupportedTarget = await capture(
    t,
    "module Sample\n def self.useit\n Policy.decision\n end\nend\n",
    {
      "Policy.rb":
        "module Policy\n def self.decision(&block)\n true\n end\nend\n",
    },
  );
  assert.equal(
    unsupportedTarget.calls.find((call) => call.file === "Sample.rb")!
      .targetFunctionId,
    null,
    "Unsupported exported method header cannot be a selected ordinary target",
  );
  const hidden = await capture(
    t,
    "module Sample\n LIMIT = 2\n private_constant :LIMIT\n def self.useit\n LIMIT\n end\nend\n",
  );
  assert.deepEqual(
    hidden.references,
    [],
    "Unknown module initialization must not certify constant visibility",
  );
  const imported = await capture(
    t,
    'require_relative "Policy"\nmodule Sample\n def self.useit\n Policy.decision\n end\nend\n',
    { "Policy.rb": policy },
  );
  assert.equal(imported.modules.length, 1);
  assert.equal(imported.modules[0]!.targetFile, "Policy.rb");
  assert.equal(imported.modules[0]!.resolution, "selected");
  const missing = await capture(
    t,
    'require_relative "Absent"\nmodule Sample\n def self.useit\n Policy.decision\n end\nend\n',
    { "Policy.rb": policy },
  );
  assert.equal(missing.modules[0]!.targetFile, null);
  assert.equal(missing.rubyBindings.fullImpactFallback, true);
  assert.ok(missing.rubyBindings.omissions.includes("unresolved-import"));
  const nestedSource =
      "module Sample\n def self.factory\n nil\n end\n def self.useit\n factory().call\n end\nend\n",
    nested = await capture(t, nestedSource),
    fn = nested.functions.find((fn) => fn.name === "useit")!,
    calls = nested.calls.filter((call) => call.callerFunctionId === fn.id);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.start, calls[1]!.start);
  assert.notEqual(calls[0]!.end, calls[1]!.end);
  assert.equal(
    calls.find(
      (call) => nestedSource.slice(call.start, call.end) === "factory().call",
    )!.targetFunctionId,
    null,
  );
  assert.equal(
    calls.find(
      (call) => nestedSource.slice(call.start, call.end) === "factory()",
    )!.targetFunctionId,
    nested.functions.find((fn) => fn.name === "factory")!.id,
  );
  const inert = await capture(
    t,
    'module Sample\n TEXT = "Policy.decision()"\n # Policy.decision()\n LIMIT = 2\n def self.useit\n TEXT\n end\nend\n',
  );
  assert.deepEqual(inert.calls, []);
  assert.equal(inert.references.length, 1);
  assert.equal(
    inert.references[0]!.targetDeclarationId,
    inert.declarations.find((decl) => decl.name === "TEXT")!.id,
  );
  const nonliteral = await capture(
    t,
    "module Sample\n LIMIT = 1 + 1\n def self.useit\n LIMIT\n end\nend\n",
  );
  assert.deepEqual(nonliteral.references, []);
  const decisionSource =
      "module Sample\n def self.decision(value)\n if value == 1 || value == 2\n true\n elsif value > 3\n false\n else\n nil\n end\n unless value != 4\n true\n end\n value ? true : false\n value && true\n end\nend\n",
    decisions = await capture(t, decisionSource);
  for (const type of ["if", "elsif", "unless", "conditional", "binary"]) {
    assert.ok(
      decisions.decisions.some((node) => node.nodeType === type),
      type,
    );
  }
  const whole = decisions.decisions.find((node) => node.nodeType === "if")!;
  assert.equal(
    decisionSource.slice(whole.start, whole.end),
    "if value == 1 || value == 2\n true\n elsif value > 3\n false\n else\n nil\n end",
  );
  const generated = await fixture(t, {
    "Sample.rb": "module Sample\nend\n",
    "obj/Generated.rb": policy,
  });
  await assert.rejects(
    createReviewContext(generated, {
      schemaVersion: 17,
      track: "snapshot",
      currentSource: "working-tree",
      files: ["Sample.rb"],
      supportFiles: ["obj/Generated.rb"],
      moduleRoots: ["."],
      topics: [],
    }),
    /excluded|generated|source path/i,
  );
}
