import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createReviewContext } from "../src/review.js";
import { fixture } from "./helpers.js";
const selection = (files: string[], supportFiles: string[] = []) => ({
  schemaVersion: 14,
  track: "snapshot",
  currentSource: "working-tree",
  moduleRoots: ["."],
  files,
  supportFiles,
  topics: [],
});
export async function scalaBoundaryFixtures(t: TestContext) {
  const excluded = await fixture(t, {
    "Sample.scala": "def useit(hidden: () => Boolean) = hidden()\n",
    "build/Excluded.scala": "def hidden() = true\n",
  });
  const selected = await createReviewContext(
    excluded,
    selection(["Sample.scala"]),
  );
  assert.equal(selected.schemaVersion, 14);
  if (selected.schemaVersion !== 14) throw Error("Original Scala required");
  assert.equal(selected.analysis.functions.length, 1);
  assert.equal(selected.analysis.calls.length, 1);
  assert.equal(selected.analysis.calls[0]!.targetFunctionId, null);
  await assert.rejects(
    createReviewContext(
      excluded,
      selection(["Sample.scala"], ["build/Excluded.scala"]),
    ),
  );
  async function capture(
    files: Record<string, string>,
    primary = "Sample.scala",
  ) {
    const root = await fixture(t, files),
      context = await createReviewContext(
        root,
        selection(
          [primary],
          Object.keys(files).filter((f) => f !== primary),
        ),
      );
    assert.equal(context.schemaVersion, 14);
    if (context.schemaVersion !== 14) throw Error("Original Scala required");
    return { analysis: context.analysis, files };
  }
  const policy =
    'package policy\nval FALLBACK = "grant"\ndef decision() = true\n';
  const text = (
    value: Awaited<ReturnType<typeof capture>>,
    call: (typeof selected.analysis.calls)[number],
  ) => value.files[call.file]!.slice(call.start, call.end);
  const bound = await capture({
    "Policy.scala": policy,
    "Sample.scala":
      'package consumer\nimport policy.{decision as decide, FALLBACK as DEFAULT}\ndef useit() = decide()\ndef prefix() = decideMore()\nval literal = "decide() DEFAULT"\n// decide() DEFAULT\ndef constant() = DEFAULT\n',
  });
  const decision = bound.analysis.functions.find(
    (f) => f.file === "Policy.scala" && f.name === "decision",
  )!;
  assert.ok(decision);
  assert.equal(bound.analysis.calls.length, 2);
  assert.equal(
    bound.analysis.calls.find((c) => text(bound, c) === "decide()")!
      .targetFunctionId,
    decision.id,
  );
  assert.equal(
    bound.analysis.calls.find((c) => text(bound, c) === "decideMore()")!
      .targetFunctionId,
    null,
  );
  assert.equal(
    bound.analysis.references.filter((r) => r.file === "Sample.scala").length,
    1,
  );
  assert.equal(bound.analysis.modules.length, 2);
  assert.ok(bound.analysis.modules.every((m) => m.resolution === "selected"));
  const arrow = await capture({
    "Policy.scala": policy,
    "Sample.scala":
      "package consumer\nimport policy.{decision => decide}\ndef useit() = decide()\n",
  });
  assert.equal(arrow.analysis.calls.length, 1);
  assert.equal(
    arrow.analysis.calls[0]!.targetFunctionId,
    arrow.analysis.functions.find((f) => f.name === "decision")!.id,
  );
  const shadow = await capture({
    "Policy.scala": policy,
    "Sample.scala":
      "package consumer\nimport policy.decision as decide\ndef useit(decide: () => Boolean) = decide()\ndef local(): Boolean = { val decide: () => Boolean = () => false; decide() }\n",
  });
  assert.equal(shadow.analysis.calls.length, 2);
  assert.ok(shadow.analysis.calls.every((c) => c.targetFunctionId === null));
  const ordered = await capture({
    "Policy.scala": policy,
    "Sample.scala":
      "package consumer\nimport policy.decision as decide\ndef useit(): Boolean = { def before() = decide(); def decide() = false; before() == decide() }\n",
  });
  const orderedCalls = ordered.analysis.calls.filter(
    (c) => c.file === "Sample.scala" && text(ordered, c) === "decide()",
  );
  assert.equal(orderedCalls.length, 2);
  const local = ordered.analysis.functions.find(
    (f) => f.file === "Sample.scala" && f.name === "decide",
  )!;
  assert.ok(local);
  assert.ok(orderedCalls.every((c) => c.targetFunctionId === local.id));
  const priority = await capture({
    "Policy.scala": policy,
    "Sample.scala":
      "package consumer\nimport policy.decision\ndef decision() = false\ndef useit() = decision()\n",
  });
  assert.equal(priority.analysis.calls.length, 1);
  assert.equal(
    priority.analysis.calls[0]!.targetFunctionId,
    priority.analysis.functions.find(
      (f) => f.file === "Sample.scala" && f.name === "decision",
    )!.id,
  );
  const importOrder = await capture({
    "Policy.scala": policy,
    "Other.scala": "package other\ndef decision() = false\n",
    "Sample.scala":
      "package policy\ndef early() = decision()\nimport other.decision as decision\ndef later() = decision()\n",
  });
  assert.equal(importOrder.analysis.calls.length, 2);
  assert.equal(
    importOrder.analysis.calls.find(
      (c) =>
        importOrder.analysis.functions.find((f) => f.id === c.callerFunctionId)
          ?.name === "early",
    )!.targetFunctionId,
    importOrder.analysis.functions.find(
      (f) => f.file === "Other.scala" && f.name === "decision",
    )!.id,
  );
  assert.equal(
    importOrder.analysis.calls.find(
      (c) =>
        importOrder.analysis.functions.find((f) => f.id === c.callerFunctionId)
          ?.name === "later",
    )!.targetFunctionId,
    importOrder.analysis.functions.find(
      (f) => f.file === "Other.scala" && f.name === "decision",
    )!.id,
  );
  const nested = await capture({
    "Sample.scala":
      "def choose(): () => Boolean = () => true\ndef useit() = choose()()\n",
  });
  const nestedCalls = nested.analysis.calls.sort((a, b) => b.end - a.end);
  assert.equal(nestedCalls.length, 2);
  assert.equal(nestedCalls[0]!.start, nestedCalls[1]!.start);
  assert.ok(nestedCalls[0]!.end > nestedCalls[1]!.end);
  assert.equal(nestedCalls[0]!.targetFunctionId, null);
  assert.equal(
    nestedCalls[1]!.targetFunctionId,
    nested.analysis.functions.find((f) => f.name === "choose")!.id,
  );
  assert.deepEqual(nested.analysis.scalaBindings.counts, {
    calls: 2,
    resolvedCalls: 1,
    unresolvedCalls: 1,
    imports: 0,
    resolvedImports: 0,
    unresolvedImports: 0,
  });
  for (const source of [
    "package consumer\nimport policy.*\ndef useit() = decision()\n",
    "package consumer\nimport policy.decision as decide\ndef useit() = () => decide()\n",
    "package consumer\nimport policy.decision as decide\ndef useit[T]() = decide()\n",
    "package consumer\nimport policy.decision as decide\ndef useit(): Boolean = { val `decide`: () => Boolean = () => false; decide() }\n",
    "package consumer\nimport policy.decision as decide\ndef useit() = policy.decision()\nval policy = 1\n",
    "package consumer\nimport policy.decision as decide\nobject Original { def useit() = decide() }\n",
    "package consumer\nimport policy.{decision as _}\ndef useit() = decision()\n",
    "package policy\ndef useit() = { import policy.decision; decision() }\n",
  ]) {
    const unknown = await capture({
      "Policy.scala": policy,
      "Sample.scala": source,
    });
    const calls = unknown.analysis.calls.filter(
      (c) => c.file === "Sample.scala",
    );
    assert.ok(
      calls.length > 0,
      "Original unresolved near miss retained a call",
    );
    assert.ok(calls.every((c) => c.targetFunctionId === null));
    assert.equal(unknown.analysis.scalaBindings.state, "partial");
  }
  const receiverImport = await capture({
    "Policy.scala": policy,
    "Sample.scala":
      "package consumer\nobject Stable { def decision() = false }\nval policy = Stable\nimport policy.decision as decide\ndef useit() = decide()\n",
  });
  assert.equal(
    receiverImport.analysis.calls.filter((c) => c.file === "Sample.scala")
      .length,
    1,
  );
  assert.equal(
    receiverImport.analysis.calls.find((c) => c.file === "Sample.scala")!
      .targetFunctionId,
    null,
  );
  assert.ok(
    receiverImport.analysis.modules.every((m) => m.targetFile === null),
  );
  const receiverElsewhere = await capture({
    "Policy.scala": policy,
    "Other.scala":
      "package consumer\nobject Stable { def decision() = false }\nval policy = Stable\n",
    "Sample.scala":
      "package consumer\nimport policy.decision as decide\ndef useit() = decide()\n",
  });
  assert.equal(receiverElsewhere.analysis.calls.length, 1);
  assert.equal(receiverElsewhere.analysis.calls[0]!.targetFunctionId, null);
  assert.ok(
    receiverElsewhere.analysis.modules.every((m) => m.targetFile === null),
  );
  const duplicate = await capture({
    "Policy.scala": policy,
    "Duplicate.scala": policy,
    "Sample.scala":
      "package consumer\nimport policy.decision as decide\ndef useit() = decide()\n",
  });
  assert.equal(
    duplicate.analysis.calls.find((c) => c.file === "Sample.scala")!.resolution,
    "ambiguous-definition",
  );
  const overload = await capture({
    "Sample.scala":
      "def decide() = true\ndef decide(value: Int) = false\ndef useit() = decide()\n",
  });
  assert.equal(overload.analysis.calls[0]!.resolution, "ambiguous-definition");
  const absent = await capture({
    "Policy.scala": policy,
    "Sample.scala":
      "package consumer\nimport absent.decision as decide\ndef useit() = decide()\n",
  });
  assert.equal(absent.analysis.calls[0]!.targetFunctionId, null);
  assert.equal(absent.analysis.modules[0]!.resolution, "external");
  const privateValue = await capture({
    "Policy.scala": policy.replace("def decision", "private def decision"),
    "Sample.scala":
      "package consumer\nimport policy.decision as decide\ndef useit() = decide()\n",
  });
  assert.equal(privateValue.analysis.calls[0]!.targetFunctionId, null);
  const packagePrivate = await capture({
    "Policy.scala": policy.replace("def decision", "private def decision"),
    "Sample.scala": "package policy\ndef useit() = decision()\n",
  });
  assert.equal(packagePrivate.analysis.calls.length, 1);
  assert.equal(
    packagePrivate.analysis.calls[0]!.targetFunctionId,
    packagePrivate.analysis.functions.find((f) => f.name === "decision")!.id,
  );
  const script = await capture(
    { "Sample.sc": "def decision() = true\ndef useit() = decision()\n" },
    "Sample.sc",
  );
  assert.equal(script.analysis.calls.length, 1);
  assert.equal(script.analysis.calls[0]!.targetFunctionId, null);
  assert.ok(
    script.analysis.scalaBindings.omissions.includes("script-loading-unknown"),
  );
  const roles = await capture({
    "Sample.scala":
      'val value = "inert key"\nval TOKEN = "token"\ndef decision(value: String) = true\ndef useit() = decision(value = TOKEN)\n',
  });
  const token = roles.analysis.declarations.find((d) => d.name === "TOKEN")!,
    key = roles.analysis.declarations.find(
      (d) => d.name === "value" && d.kind === "variable",
    )!;
  assert.ok(token);
  assert.ok(key);
  assert.equal(
    roles.analysis.references.filter((r) => r.targetDeclarationId === token.id)
      .length,
    1,
  );
  assert.equal(
    roles.analysis.references.filter((r) => r.targetDeclarationId === key.id)
      .length,
    0,
  );
  const construct = await capture({
    "Sample.scala":
      "class Original { def member() = true }\ndef useit() = new Original()\n",
  });
  assert.equal(construct.analysis.calls.length, 1);
  assert.equal(construct.analysis.calls[0]!.kind, "construct");
  assert.equal(construct.analysis.calls[0]!.targetFunctionId, null);
  assert.ok(
    construct.analysis.scalaBindings.omissions.includes(
      "constructor-dispatch-unknown",
    ),
  );
  assert.ok(construct.analysis.declarations.some((d) => d.kind === "class"));
}
