import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createHash } from "node:crypto";
import { collectReviewJavaBehavior } from "../src/review-polyglot.js";
import { createReviewContext, parseReviewContext } from "../src/review.js";
import { fixture } from "./helpers.js";
const selection = {
  schemaVersion: 12,
  track: "snapshot",
  currentSource: "working-tree",
  files: ["Sample.java"],
  supportFiles: [],
  moduleRoots: ["."],
  topics: [],
};

export async function javaMethodReferenceFixture(t: TestContext) {
  const source =
    "class Sample{static final boolean decision=true;static boolean decision(){return false;}static java.util.function.BooleanSupplier reference(){return Sample::decision;}}";
  const root = await fixture(t, { "Sample.java": source });
  const context = await createReviewContext(root, selection);
  assert.equal(context.schemaVersion, 12);
  if (context.schemaVersion !== 12)
    throw Error("Original Java context required");
  const field = context.analysis.declarations.find(
    (value) => value.name === "decision" && value.kind === "variable",
  )!;
  assert.ok(field);
  assert.deepEqual(
    context.analysis.references.filter(
      (value) => value.targetDeclarationId === field.id,
    ),
    [],
    "The method reference denotes the method, not the constant",
  );
  assert.equal(
    parseReviewContext(context).contextDigest,
    context.contextDigest,
  );
  const receiverSource =
    "class Sample{static final Sample RECEIVER=new Sample();boolean decision(){return false;}static java.util.function.BooleanSupplier reference(){return RECEIVER::decision;}}";
  const receiverRoot = await fixture(t, { "Sample.java": receiverSource });
  const receiverContext = await createReviewContext(receiverRoot, selection);
  if (receiverContext.schemaVersion !== 12)
    throw Error("Original Java receiver context required");
  const receiver = receiverContext.analysis.declarations.find(
    (value) => value.name === "RECEIVER" && value.kind === "variable",
  )!;
  assert.ok(receiver);
  const reads = receiverContext.analysis.references.filter(
    (value) => value.targetDeclarationId === receiver.id,
  );
  assert.equal(
    reads.length,
    1,
    "A method-reference receiver still reads its selected static final field",
  );
  assert.equal(
    receiverSource.slice(reads[0]!.start, reads[0]!.end),
    "RECEIVER",
  );
}

export async function javaLocalTypeFixture(t: TestContext) {
  const source =
    "class Policy{static boolean decision(){return true;}}class Sample{static boolean useit(){boolean before=Policy.decision();class Policy{static boolean decision(){return false;}}return before;}}";
  const root = await fixture(t, { "Sample.java": source });
  const context = await createReviewContext(root, selection);
  assert.equal(context.schemaVersion, 12);
  if (context.schemaVersion !== 12)
    throw Error("Original Java context required");
  const policy = context.analysis.functions.find(
    (value) => value.name === "decision",
  )!;
  const call = context.analysis.calls.find(
    (value) => source.slice(value.start, value.end) === "Policy.decision()",
  )!;
  assert.equal(
    call.targetFunctionId,
    policy.id,
    "A later local type does not obscure the earlier top-level type call",
  );
  assert.equal(call.resolution, "lexical-binding");
}

export async function javaCompetingImportFixture(t: TestContext) {
  const source =
    "import first.Policy;import absent.Policy;class Sample{static boolean useit(){return Policy.decision();}}";
  const root = await fixture(t, {
    "Sample.java": source,
    "first/Policy.java":
      "package first;public class Policy{public static boolean decision(){return true;}}",
  });
  const context = await createReviewContext(root, {
    ...selection,
    supportFiles: ["first/Policy.java"],
  });
  assert.equal(context.schemaVersion, 12);
  if (context.schemaVersion !== 12)
    throw Error("Original Java context required");
  assert.equal(context.analysis.calls.length, 1);
  assert.equal(context.analysis.calls[0]!.targetFunctionId, null);
  assert.equal(context.analysis.calls[0]!.resolution, "ambiguous-definition");
}

export async function javaConstructorFixture(t: TestContext) {
  const source =
    "class Sample{Sample(){}static Sample choose(){return new Sample();}}";
  const root = await fixture(t, { "Sample.java": source });
  const context = await createReviewContext(root, selection);
  assert.equal(context.schemaVersion, 12);
  if (context.schemaVersion !== 12)
    throw Error("Original Java context required");
  assert.equal(context.analysis.calls.length, 1);
  const call = context.analysis.calls[0]!;
  assert.equal(source.slice(call.start, call.end), "new Sample()");
  assert.equal(call.kind, "construct");
  assert.equal(call.targetFunctionId, null);
  assert.equal(call.resolution, "unsupported-dispatch");
  assert.ok(
    context.analysis.javaBindings.omissions.includes(
      "constructor-dispatch-unknown",
    ),
  );
  assert.equal(context.analysis.javaBindings.counts.calls, 1);
  assert.equal(context.analysis.javaBindings.counts.unresolvedCalls, 1);
}

export async function javaAncestorAccessibilityFixture(t: TestContext) {
  const source =
    "package b;import a.Outer.Inner;public class Sample{public static boolean useit(){return Inner.decision();}}";
  const outer =
    "package a;class Outer{public static class Inner{public static boolean decision(){return true;}}}";
  const root = await fixture(t, {
    "Sample.java": source,
    "a/Outer.java": outer,
  });
  const context = await createReviewContext(root, {
    ...selection,
    supportFiles: ["a/Outer.java"],
  });
  if (context.schemaVersion !== 12)
    throw Error("Original Java accessibility context required");
  assert.equal(context.analysis.calls.length, 1);
  assert.equal(
    context.analysis.calls[0]!.targetFunctionId,
    null,
    "A public nested type does not make its package-private enclosing type accessible",
  );
  assert.equal(context.analysis.calls[0]!.resolution, "unsupported-dispatch");
  for (const [consumer, producer] of [
    [source, outer.replace("class Outer", "public class Outer")],
    [source.replace("package b;", "package a;"), outer],
  ] as const) {
    const allowed = await fixture(t, {
      "Sample.java": consumer,
      "a/Outer.java": producer,
    });
    const observed = await createReviewContext(allowed, {
      ...selection,
      supportFiles: ["a/Outer.java"],
    });
    if (observed.schemaVersion !== 12)
      throw Error("Original Java accessible near miss required");
    const target = observed.analysis.functions.find(
      (value) => value.file === "a/Outer.java" && value.name === "decision",
    )!;
    assert.equal(observed.analysis.calls[0]!.targetFunctionId, target.id);
    assert.equal(observed.analysis.calls[0]!.resolution, "lexical-binding");
  }
}
export async function javaUnicodeEscapeFixture(t: TestContext) {
  const source = String.raw`class Policy{static boolean decision(){return true;}}
class Sample{
 // \u000a static Object Policy=new Object();
 static boolean useit(){return Policy.decision();}
}`;
  const captured = await collectReviewJavaBehavior(
    [
      {
        path: "Sample.java",
        content: source,
        sha256: createHash("sha256").update(source).digest("hex"),
      },
    ],
    [],
    ["Sample.java"],
    false,
    ["."],
  );
  assert.ok(
    captured.calls.every((value) => value.targetFunctionId === null),
    "The producer must keep Unicode preprocessing unresolved before structural intake",
  );
  assert.ok(
    captured.javaBindings.omissions.includes("unicode-escapes-unknown"),
  );
  const root = await fixture(t, { "Sample.java": source }),
    context = await createReviewContext(root, selection);
  if (context.schemaVersion !== 12)
    throw Error("Original Java Unicode context required");
  assert.ok(source.includes("\\u000a"));
  assert.ok(
    context.analysis.calls.every((value) => value.targetFunctionId === null),
    "Raw Unicode preprocessing cannot establish a static selected call target",
  );
  assert.equal(context.analysis.javaBindings.state, "partial");
  assert.ok(
    context.analysis.javaBindings.omissions.includes("unicode-escapes-unknown"),
  );
}
