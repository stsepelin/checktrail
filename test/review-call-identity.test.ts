import { test } from "node:test";
import {
  callIdentityFixture,
  type CallIdentityLanguage,
} from "./review-call-identity-fixture.js";
for (const language of [
  "python",
  "go",
  "php",
  "rust",
] as const satisfies readonly CallIdentityLanguage[]) {
  test(
    "nested call ranges retain distinct " + language + " targets",
    async (t) => {
      await callIdentityFixture(t, language);
    },
  );
}

import assert from "node:assert/strict";
import { createReviewContext } from "../src/review.js";
import { fixture } from "./helpers.js";
test("nested JavaScript and TypeScript calls preserve direct AST identities", async (t) => {
  for (const extension of ["js", "ts"]) {
    const source =
      "export function choose(){return () => true;}\nexport function useit(){return choose()();}\n";
    const file = "sample." + extension;
    const root = await fixture(t, { [file]: source });
    const context = await createReviewContext(root, {
      schemaVersion: 3,
      track: "snapshot",
      files: [file],
      supportFiles: [],
      topics: [],
    });
    assert.equal(context.schemaVersion, 3);
    if (context.schemaVersion !== 3)
      throw Error("Original JavaScript binding context required");
    const calls = context.analysis.calls.sort((a, b) => b.end - a.end);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.start, calls[1]!.start);
    assert.ok(calls[0]!.end > calls[1]!.end);
    assert.equal(calls[0]!.targetFunctionId, null);
    assert.equal(calls[0]!.resolution, "unsupported-dispatch");
    assert.equal(
      calls[1]!.targetFunctionId,
      context.analysis.functions.find((fn) => fn.name === "choose")!.id,
    );
    assert.equal(calls[1]!.resolution, "lexical-binding");
  }
});

test("nested call ranges retain distinct Java targets", async (t) => {
  await callIdentityFixture(t, "java");
});
