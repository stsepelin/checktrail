import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createReviewContext } from "../src/review.js";
import { fixture } from "./helpers.js";
const module = (body: string, name = "Rules", namespace = "") =>
  (namespace ? "Namespace " + namespace + "\n" : "") +
  "Public Module " +
  name +
  "\n" +
  body +
  "End Module\n" +
  (namespace ? "End Namespace\n" : "");
const method = (
  name: string,
  body: string,
  parameters = "",
  type = "Boolean",
) =>
  "Public Function " +
  name +
  "(" +
  parameters +
  ") As " +
  type +
  "\n" +
  body +
  "\nEnd Function\n";
export async function vbBoundariesFixture(t: TestContext) {
  async function capture(
    sources: Record<string, string>,
    files = Object.keys(sources).slice(0, 1),
    supportFiles = Object.keys(sources).filter((p) => !files.includes(p)),
  ) {
    const root = await fixture(t, sources),
      context = await createReviewContext(root, {
        schemaVersion: 19,
        track: "snapshot",
        currentSource: "working-tree",
        files,
        supportFiles,
        moduleRoots: ["."],
        topics: [],
      });
    assert.equal(context.schemaVersion, 19);
    if (context.schemaVersion !== 19) throw Error("Original VB required");
    assert.ok(
      context.analysis.files.every((f) => f.state === "collected"),
      JSON.stringify(context.analysis.files),
    );
    return { context, value: context.analysis };
  }
  const decision = module(method("decision", "Return True"), "Rules", "policy");
  const folded = await capture({
    "Policy.vb": decision,
    "Use.vb":
      "Imports P=PoLiCy.RuLeS\nImports N=PoLiCy\n" +
      module(method("submit", "Return p.DeCiSiOn()"), "Useit", "consumer"),
  });
  const target = folded.value.functions.find((f) => f.name === "decision")!;
  const call = folded.value.calls.find((c) => c.file === "Use.vb")!;
  assert.equal(call.targetFunctionId, target.id);
  assert.equal(call.resolution, "lexical-binding");
  assert.equal(folded.value.modules.length, 2);
  assert.ok(folded.value.modules.every((m) => m.resolution === "selected"));
  const prefix = await capture({
    "Policy.vb": decision,
    "Use.vb":
      "Imports P=policy.Rules\n" +
      module(method("submit", "Return P.DecisionToken()"), "Useit", "consumer"),
  });
  assert.equal(
    prefix.value.calls.find((c) => c.file === "Use.vb")!.targetFunctionId,
    null,
  );
  for (const [body, parameters] of [
    ["Return decision()", "decision As Object"],
    [
      "Dim value As Boolean=decision()\nDim decision As Integer=2\nReturn value",
      "",
    ],
  ] as const) {
    const value = await capture({
      "Sample.vb":
        "Imports policy.Rules\n" +
        module(method("submit", body, parameters), "Useit", "consumer"),
      "Policy.vb": decision,
    });
    assert.equal(
      value.value.calls.find((c) => c.file === "Sample.vb")!.targetFunctionId,
      null,
    );
  }
  const receiver = await capture({
    "Sample.vb":
      "Imports P=policy.Rules\n" +
      module(
        method("submit", "Return P.decision()", "P As Object"),
        "Useit",
        "consumer",
      ),
    "Policy.vb": decision,
  });
  assert.equal(
    receiver.value.calls.find((c) => c.file === "Sample.vb")!.targetFunctionId,
    null,
  );
  const implicit = await capture({
    "Sample.vb":
      decision +
      module(method("submit", "Return DECISION()"), "Useit", "policy"),
  });
  assert.equal(
    implicit.value.calls[0]!.targetFunctionId,
    implicit.value.functions.find((f) => f.name === "decision")!.id,
  );
  const own = await capture({
    "Sample.vb":
      "Imports policy.Rules\n" +
      module(
        method("decision", "Return False") +
          method("submit", "Return decision()"),
        "Useit",
        "consumer",
      ),
    "Policy.vb": decision,
  });
  assert.equal(
    own.value.calls[0]!.targetFunctionId,
    own.value.functions.find(
      (f) => f.file === "Sample.vb" && f.name === "decision",
    )!.id,
  );
  const defaults = await capture({
    "Sample.vb": module(
      "Public Const LIMIT As Integer=2\n" +
        method(
          "decision",
          "Return LIMIT",
          "Optional LIMIT As Integer=LIMIT",
          "Integer",
        ),
    ),
  });
  const constant = defaults.value.declarations.find(
      (d) => d.name === "LIMIT" && d.kind === "variable",
    )!,
    parameter = defaults.value.declarations.find(
      (d) => d.name === "LIMIT" && d.kind === "parameter",
    )!,
    refs = defaults.value.references.filter(
      (x) => x.targetDeclarationId === constant.id,
    );
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.ownerDeclarationId, parameter.id);
  assert.ok(parameter.initializer);
  assert.equal(
    defaults.context.files[0]!.content.slice(refs[0]!.start, refs[0]!.end),
    "LIMIT",
  );
  const reads = await capture({
    "Sample.vb": module(
      "Public Const LIMIT As Integer=2\n" +
        method(
          "decision",
          '\' LIMIT inert\nDim label As String="LIMIT"\nReturn value + LIMIT',
          "Optional value As Integer=LIMIT",
          "Integer",
        ) +
        method("submit", "Return decision(value:=LIMIT)", "", "Integer"),
    ),
  });
  const literal = reads.value.declarations.find((d) => d.name === "LIMIT")!;
  assert.equal(
    reads.value.references.filter((x) => x.targetDeclarationId === literal.id)
      .length,
    3,
  );
  assert.ok(
    reads.value.references.some(
      (x) =>
        x.ownerDeclarationId ===
        reads.value.declarations.find((d) => d.kind === "parameter")!.id,
    ),
  );
  const typed = await capture({
    "Sample.vb": module(
      "Public Const LIMIT As Integer=2\n" +
        method(
          "decision",
          "Return LIMIT",
          "value As External.LIMIT",
          "Integer",
        ),
    ),
    "Types.vb":
      "Namespace External\nPublic Class LIMIT\nEnd Class\nEnd Namespace\n",
  });
  const typedConstant = typed.value.declarations.find(
    (d) => d.file === "Sample.vb" && d.name === "LIMIT",
  )!;
  assert.equal(
    typed.value.references.filter(
      (x) => x.targetDeclarationId === typedConstant.id,
    ).length,
    1,
  );
  const privateCase = await capture({
    "Policy.vb": module(
      "Private Const LIMIT As Integer=2\nPrivate Function decision() As Boolean\nReturn LIMIT=2\nEnd Function\n" +
        method("own", "Return decision()"),
      "Rules",
      "policy",
    ),
    "Use.vb": module(
      method("submit", "Return policy.Rules.decision()"),
      "Useit",
      "consumer",
    ),
  });
  assert.ok(
    privateCase.value.calls.some(
      (c) => c.file === "Policy.vb" && c.resolution === "lexical-binding",
    ),
  );
  assert.equal(
    privateCase.value.calls.find((c) => c.file === "Use.vb")!.targetFunctionId,
    null,
  );
  const overload = await capture({
    "Policy.vb": module(
      method("decision", "Return True") +
        method("Decision", "Return False", "value As Integer"),
      "Rules",
      "policy",
    ),
    "Use.vb":
      "Imports policy.Rules\n" +
      module(method("submit", "Return decision()"), "Useit", "consumer"),
  });
  assert.equal(overload.value.calls[0]!.resolution, "ambiguous-definition");
  const duplicate = await capture({
    "First.vb": decision,
    "Second.vb": decision.replace("Rules", "RULES"),
    "Use.vb": module(
      method("submit", "Return policy.Rules.decision()"),
      "Useit",
      "consumer",
    ),
  });
  assert.equal(duplicate.value.calls[0]!.resolution, "ambiguous-definition");
  const aliasDuplicate = await capture({
    "Policy.vb": decision,
    "Use.vb":
      "Imports P=policy.Rules\nImports p=policy.Rules\n" +
      module(method("submit", "Return P.decision()"), "Useit", "consumer"),
  });
  assert.equal(
    aliasDuplicate.value.calls[0]!.resolution,
    "ambiguous-definition",
  );
  const constantExpression = await capture({
    "Sample.vb": module(
      "Public Const LIMIT As Integer=1+1\n" +
        method("decision", "Return LIMIT", "", "Integer"),
    ),
  });
  assert.deepEqual(constantExpression.value.references, []);
  assert.ok(
    constantExpression.value.vbBindings.omissions.includes(
      "nonliteral-global-unknown",
    ),
  );
  const nested = await capture({
    "Sample.vb": module(
      method("factory", "Return Nothing", "", "Object") +
        method("submit", "Return factory()()"),
    ),
  });
  assert.equal(nested.value.calls.length, 2);
  const inner = nested.value.calls.find(
      (c) =>
        nested.context.files[0]!.content.slice(c.start, c.end) === "factory()",
    )!,
    outer = nested.value.calls.find(
      (c) =>
        nested.context.files[0]!.content.slice(c.start, c.end) ===
        "factory()()",
    )!;
  assert.equal(
    inner.targetFunctionId,
    nested.value.functions.find((f) => f.name === "factory")!.id,
  );
  assert.equal(outer.targetFunctionId, null);
  assert.equal(
    outer.callerFunctionId,
    nested.value.functions.find((f) => f.name === "submit")!.id,
  );
  for (const body of [
    "While True\nReturn decision()\nEnd While",
    "For i As Integer=0 To 2\nReturn decision()\nNext",
    "Try\nReturn decision()\nFinally\nEnd Try",
    "Dim value As Object=Function() decision()\nReturn value()",
    "With New Object()\nReturn decision()\nEnd With",
  ]) {
    const unsupported = await capture({
      "Sample.vb": module(
        method("decision", "Return True") + method("submit", body),
      ),
    });
    assert.ok(unsupported.value.calls.length > 0);
    assert.ok(
      unsupported.value.calls
        .filter(
          (c) =>
            c.callerFunctionId ===
            unsupported.value.functions.find((f) => f.name === "submit")!.id,
        )
        .every((c) => c.targetFunctionId === null),
    );
    assert.ok(
      unsupported.value.vbBindings.omissions.includes("unsupported-scope"),
    );
  }
  const byref = await capture({
    "Policy.vb": module(
      method("decision", "Return True", "ByRef value As Integer"),
      "Rules",
      "policy",
    ),
    "Use.vb": module(
      method("submit", "Return policy.Rules.decision(2)"),
      "Useit",
      "consumer",
    ),
  });
  assert.equal(byref.value.calls[0]!.targetFunctionId, null);
  assert.ok(
    byref.value.vbBindings.omissions.includes("unsupported-parameters"),
  );
  const untouched = await capture({
    "Sample.vb": module(
      method(
        "decision",
        "If value > 1 Then\nReturn True\nElse\nReturn False\nEnd If",
        "value As Integer",
      ),
    ),
  });
  const whole = untouched.value.decisions.find(
    (d) => d.nodeType === "if_statement",
  )!;
  assert.ok(whole);
  assert.match(
    untouched.context.files[0]!.content.slice(whole.start, whole.end),
    /Else[\s\S]*End If/,
  );
}
