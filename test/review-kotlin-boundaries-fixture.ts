import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createReviewContext } from "../src/review.js";
import { fixture } from "./helpers.js";
const selection = (files: string[], supportFiles: string[] = []) => ({
  schemaVersion: 13,
  track: "snapshot",
  currentSource: "working-tree",
  moduleRoots: ["."],
  files,
  supportFiles,
  topics: [],
});
export async function kotlinBoundaryFixtures(t: TestContext) {
  const excluded = await fixture(t, {
    "Sample.kt": "fun useit(hidden: () -> Boolean) = hidden()\n",
    "build/Excluded.kt": "fun hidden() = true\n",
  });
  const selected = await createReviewContext(
    excluded,
    selection(["Sample.kt"]),
  );
  assert.equal(selected.schemaVersion, 13);
  if (selected.schemaVersion !== 13) throw Error("Original Kotlin required");
  assert.equal(selected.analysis.functions.length, 1);
  assert.equal(selected.analysis.calls.length, 1);
  assert.equal(selected.analysis.calls[0]!.targetFunctionId, null);
  await assert.rejects(
    createReviewContext(
      excluded,
      selection(["Sample.kt"], ["build/Excluded.kt"]),
    ),
  );

  async function capture(files: Record<string, string>, primary = "Sample.kt") {
    const root = await fixture(t, files),
      context = await createReviewContext(
        root,
        selection(
          [primary],
          Object.keys(files).filter((f) => f !== primary),
        ),
      );
    assert.equal(context.schemaVersion, 13);
    if (context.schemaVersion !== 13) throw Error("Original Kotlin required");
    return { analysis: context.analysis, files };
  }
  const policy =
    'package policy\nconst val FALLBACK = "grant"\nfun decision() = true\n';
  const bound = await capture({
    "Policy.kt": policy,
    "Sample.kt":
      'package consumer\nimport policy.decision as decide\nimport policy.FALLBACK as DEFAULT\nfun useit() = decide()\nfun prefix() = decideMore()\nval literal = "decide() DEFAULT"\n// decide() DEFAULT\nfun constant() = DEFAULT\n',
  });
  const decision = bound.analysis.functions.find(
    (f) => f.file === "Policy.kt" && f.name === "decision",
  )!;
  assert.ok(decision);
  const callText = (
    value: typeof bound,
    call: (typeof bound.analysis.calls)[number],
  ) => value.files[call.file]!.slice(call.start, call.end);
  assert.equal(bound.analysis.calls.length, 2);
  assert.equal(
    bound.analysis.calls.find((c) => callText(bound, c) === "decide()")!
      .targetFunctionId,
    decision.id,
  );
  assert.equal(
    bound.analysis.calls.find((c) => callText(bound, c) === "decideMore()")!
      .targetFunctionId,
    null,
  );
  assert.equal(
    bound.analysis.references.filter((r) => r.file === "Sample.kt").length,
    1,
  );
  const shadow = await capture({
    "Policy.kt": policy,
    "Sample.kt":
      "package consumer\nimport policy.decision as decide\nfun useit(decide: () -> Boolean) = decide()\nfun local(): Boolean { val decide: () -> Boolean = { false }; return decide() }\n",
  });
  assert.equal(shadow.analysis.calls.length, 2);
  assert.ok(shadow.analysis.calls.every((c) => c.targetFunctionId === null));
  const ordered = await capture({
    "Policy.kt": policy,
    "Sample.kt":
      "package consumer\nimport policy.decision as decide\nfun useit(): Boolean { val before = decide(); fun decide() = false\nreturn before && !decide() }\n",
  });
  const orderedCalls = ordered.analysis.calls.filter(
    (c) => c.file === "Sample.kt",
  );
  assert.equal(orderedCalls.length, 2);
  assert.equal(
    orderedCalls[0]!.targetFunctionId,
    ordered.analysis.functions.find(
      (f) => f.file === "Policy.kt" && f.name === "decision",
    )!.id,
  );
  assert.equal(
    orderedCalls[1]!.targetFunctionId,
    ordered.analysis.functions.find(
      (f) => f.file === "Sample.kt" && f.name === "decide",
    )!.id,
  );
  const nested = await capture({
    "Sample.kt":
      "fun choose(): () -> Boolean = { true }\nfun useit() = choose()()\n",
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
  assert.deepEqual(nested.analysis.kotlinBindings.counts, {
    calls: 2,
    resolvedCalls: 1,
    unresolvedCalls: 1,
    imports: 0,
    resolvedImports: 0,
    unresolvedImports: 0,
  });
  for (const source of [
    "package consumer\nimport policy.*\nfun useit() = decision()\n",
    "package consumer\nimport policy.decision as decide\nfun useit() = { decide() }\n",
    "package consumer\nimport policy.decision as decide\nfun String.useit() = decide()\n",
    "package consumer\nimport policy.decision as decide\nfun <T> useit() = decide()\n",
    "package consumer\nimport policy.decision as decide\nfun useit(): Boolean { val `decide`: () -> Boolean = { false }; return decide() }\n",
    "package consumer\nimport policy.decision as decide\nfun useit() = policy.decision()\nval policy = Any()\n",
  ]) {
    const unknown = await capture({ "Policy.kt": policy, "Sample.kt": source });
    const unknownCalls = unknown.analysis.calls.filter(
      (c) => c.file === "Sample.kt",
    );
    assert.ok(
      unknownCalls.length > 0,
      "Original unresolved near miss retained a call",
    );
    assert.ok(unknownCalls.every((c) => c.targetFunctionId === null));
    assert.equal(unknown.analysis.kotlinBindings.state, "partial");
  }
  const duplicate = await capture({
    "Policy.kt": policy,
    "Duplicate.kt": policy,
    "Sample.kt":
      "package consumer\nimport policy.decision as decide\nfun useit() = decide()\n",
  });
  assert.equal(
    duplicate.analysis.calls.find((c) => c.file === "Sample.kt")!.resolution,
    "ambiguous-definition",
  );
  const overload = await capture({
    "Sample.kt":
      "fun decide() = true\nfun decide(value: Int) = false\nfun useit() = decide()\n",
  });
  assert.equal(overload.analysis.calls[0]!.resolution, "ambiguous-definition");
  const absent = await capture({
    "Policy.kt": policy,
    "Sample.kt":
      "package consumer\nimport absent.decision as decide\nfun useit() = decide()\n",
  });
  assert.equal(
    absent.analysis.calls.find((c) => c.file === "Sample.kt")!.targetFunctionId,
    null,
  );
  assert.equal(absent.analysis.modules[0]!.resolution, "external");
  const privateValue = await capture({
    "Policy.kt": policy.replace("fun decision", "private fun decision"),
    "Sample.kt":
      "package consumer\nimport policy.decision as decide\nfun useit() = decide()\n",
  });
  assert.equal(
    privateValue.analysis.calls.find((c) => c.file === "Sample.kt")!
      .targetFunctionId,
    null,
  );
  const script = await capture(
    { "Sample.kts": "fun decision() = true\nfun useit() = decision()\n" },
    "Sample.kts",
  );
  assert.equal(script.analysis.calls.length, 1);
  assert.equal(script.analysis.calls[0]!.targetFunctionId, null);
  assert.ok(
    script.analysis.kotlinBindings.omissions.includes("script-loading-unknown"),
  );
  const samePackage = await capture({
    "Policy.kt": policy,
    "Sample.kt": "package policy\nfun useit() = decision()\n",
  });
  assert.equal(
    samePackage.analysis.calls[0]!.targetFunctionId,
    samePackage.analysis.functions.find((f) => f.name === "decision")!.id,
  );
  const roles = await capture({
    "Sample.kt":
      'const val decision = "inert"\nconst val TOKEN = "token"\nconst val value = "inert key"\nconst val REFERENCE = "inert reference"\nval propertyReference = ::REFERENCE\nfun decision(value: String) = true\nfun useit() = decision(value = TOKEN)\nval reference = ::decision\n',
  });
  const token = roles.analysis.declarations.find((d) => d.name === "TOKEN")!;
  const decisionValue = roles.analysis.declarations.find(
    (d) => d.name === "decision" && d.kind === "variable",
  )!;
  assert.ok(token);
  assert.ok(decisionValue);
  assert.equal(
    roles.analysis.references.filter((r) => r.targetDeclarationId === token.id)
      .length,
    1,
  );
  assert.equal(
    roles.analysis.references.filter(
      (r) => r.targetDeclarationId === decisionValue.id,
    ).length,
    0,
  );
  assert.equal(roles.analysis.calls[0]!.targetFunctionId, null);
  for (const name of ["value", "REFERENCE"]) {
    const declaration = roles.analysis.declarations.find(
      (d) => d.name === name && d.kind === "variable",
    )!;
    assert.ok(declaration);
    assert.equal(
      roles.analysis.references.filter(
        (ref) => ref.targetDeclarationId === declaration.id,
      ).length,
      0,
    );
  }
}
