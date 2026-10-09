import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createReviewContext } from "../src/review.js";
import { fixture } from "./helpers.js";
import { nameBoundariesFixture } from "./review-name-boundaries-fixture.js";
export async function cBoundariesFixture(t: TestContext) {
  await nameBoundariesFixture(t, 20);
  const input = (
    files: string[],
    supportFiles: string[] = [],
    moduleRoots = ["."],
  ) => ({
    schemaVersion: 20,
    track: "snapshot",
    currentSource: "working-tree",
    files,
    supportFiles,
    moduleRoots,
    topics: [],
  });
  async function capture(source: string, extra: Record<string, string> = {}) {
    const root = await fixture(t, { "sample.c": source, ...extra }),
      context = await createReviewContext(
        root,
        input(["sample.c"], Object.keys(extra)),
      );
    assert.equal(context.schemaVersion, 20);
    if (context.schemaVersion !== 20) throw Error("C context required");
    assert.ok(
      context.analysis.files.every((f) => f.state === "collected"),
      source,
    );
    return context.analysis;
  }
  const absolute = await capture(
    '#include "/rules.h"\nint Use(void){return Decision();}\n',
    { "rules.h": "int Decision(void){return 1;}\n" },
  );
  assert.equal(absolute.calls.length, 1);
  assert.equal(absolute.calls[0]!.targetFunctionId, null);
  assert.equal(absolute.modules[0]!.resolution, "outside-root");
  const comment = await capture(
    "/*\n#define absent 1\n*/\nint Decision(void){return 1;}int Use(void){return Decision();}\n",
  );
  assert.equal(comment.calls.length, 1);
  assert.equal(comment.calls[0]!.resolution, "lexical-binding");
  const typeOnly = await capture(
    "const int LIMIT=2;int Use(void){return sizeof(LIMIT);}\n",
  );
  assert.equal(typeOnly.references.length, 0);
  const address = await capture(
    "const int LIMIT=2;int Use(void){const int *p=&LIMIT;return *p;}\n",
  );
  assert.equal(address.references.length, 0);
  const vla = await capture(
    "int Decision(void){return 1;}int Use(int length){int values[length];return Decision()+sizeof values;}\n",
  );
  assert.equal(vla.calls.length, 1);
  assert.equal(vla.calls[0]!.targetFunctionId, null);
  assert.ok(vla.cBindings.omissions.includes("unsupported-scope"));
  const controls = await capture(
    "int Decision(void){return 1;}int Decision(void);int Use(void){return Decision();}\n",
  );
  assert.equal(controls.calls.length, 1);
  assert.equal(controls.calls[0]!.targetFunctionId, null);
  const headers = Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [
      "h" + i + ".h",
      i === 5 ? "" : ('#include "h' + (i + 1) + '.h"\n').repeat(3),
    ]),
  );
  const visited = await capture(
    '#include "h0.h"\nint Decision(void){return 1;}int Use(void){return Decision();}\n',
    headers,
  );
  assert.equal(visited.calls.length, 1);
  assert.equal(visited.calls[0]!.targetFunctionId, null);
  assert.ok(visited.cBindings.omissions.includes("include-depth-limit"));
  const depth = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [
      "d" + i + ".h",
      i === 8
        ? "int Decision(void){return 1;}\n"
        : '#include "d' + (i + 1) + '.h"\n',
    ]),
  );
  const bounded = await capture(
    '#include "d0.h"\nint Use(void){return Decision();}\n',
    depth,
  );
  assert.equal(bounded.calls.length, 1);
  assert.equal(bounded.calls[0]!.targetFunctionId, null);
  assert.ok(bounded.cBindings.omissions.includes("include-depth-limit"));
  const policy =
    "static const int LIMIT=2; static int Decision(void){return LIMIT;}\n";
  const own = await capture(
    policy +
      "int Use(void){int first=Decision(); int (*Decision)(void)=0;return Decision()+first;}\n",
  );
  const calls = own.calls.filter((c) => c.file === "sample.c");
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0]!.callerFunctionId,
    own.functions.find((f) => f.name === "Use")!.id,
  );
  assert.equal(calls[0]!.resolution, "lexical-binding");
  assert.equal(calls[1]!.targetFunctionId, null);
  assert.equal(own.references.length, 1);
  assert.equal(
    own.references[0]!.targetDeclarationId,
    own.declarations.find((d) => d.name === "LIMIT")!.id,
  );
  const initializer = await capture(
    policy + "int Use(void){int Decision=Decision();return Decision;}\n",
  );
  assert.equal(initializer.calls.length, 1);
  assert.equal(initializer.calls[0]!.targetFunctionId, null);
  const params = await capture(
    policy + "int Use(int (*Decision)(void)){return Decision();}\n",
  );
  assert.equal(params.calls.length, 1);
  assert.equal(params.calls[0]!.targetFunctionId, null);
  const caseSensitive = await capture(
    policy + "int Use(void){return decision();}\n",
  );
  assert.equal(caseSensitive.calls.length, 1);
  assert.equal(caseSensitive.calls[0]!.targetFunctionId, null);
  const prefix = await capture(
    policy + "int Use(void){return DecisionExtra();}\n",
  );
  assert.equal(prefix.calls.length, 1);
  assert.equal(prefix.calls[0]!.targetFunctionId, null);
  const inert = await capture(
    policy +
      'int Use(void){const char *text="DecisionExtra()";/* DecisionExtra() */return (Decision)();}\n',
  );
  assert.equal(inert.calls.length, 1);
  assert.equal(inert.calls[0]!.resolution, "lexical-binding");
  const blocks = await capture(
    policy +
      "int Use(void){if(1){int Decision=0;(void)Decision;}return Decision();}\n",
  );
  assert.equal(blocks.calls.length, 1);
  assert.equal(blocks.calls[0]!.resolution, "lexical-binding");
  const nested = await capture(
    policy +
      "int Use(void){if(1){int (*Decision)(void)=0;return Decision();}return Decision();}\n",
  );
  assert.equal(nested.calls.length, 2);
  assert.equal(nested.calls[0]!.targetFunctionId, null);
  assert.equal(nested.calls[1]!.resolution, "lexical-binding");
  const late = await capture("int Use(void){return Decision();}\n" + policy);
  assert.equal(late.calls.length, 1);
  assert.equal(late.calls[0]!.targetFunctionId, null);
  const prototype = await capture(
    "int Decision(void); int Use(void){return Decision();} int Decision(void){return 1;}\n",
  );
  assert.equal(prototype.calls.length, 1);
  assert.equal(prototype.calls[0]!.targetFunctionId, null);
  assert.ok(
    prototype.cBindings.omissions.includes("prototype-linkage-unknown"),
  );
  const imported = await capture(
    '#include "rules.h"\nint Use(void){return Decision();}\n',
    { "rules.h": policy },
  );
  assert.equal(imported.modules.length, 1);
  assert.equal(imported.modules[0]!.targetFile, "rules.h");
  assert.equal(imported.calls.length, 1);
  assert.equal(imported.calls[0]!.resolution, "lexical-binding");
  const laterInclude = await capture(
    'int Use(void){return Decision();}\n#include "rules.h"\n',
    { "rules.h": policy },
  );
  assert.equal(laterInclude.calls.length, 1);
  assert.equal(laterInclude.calls[0]!.targetFunctionId, null);
  const chain = await capture(
    '#include "first.h"\nint Use(void){return Decision();}\n',
    { "first.h": '#include "second.h"\n', "second.h": policy },
  );
  assert.equal(chain.calls.length, 1);
  assert.equal(chain.calls[0]!.resolution, "lexical-binding");
  const foreign = await capture("int Use(void){return Decision();}\n", {
    "other.c": policy,
  });
  assert.equal(foreign.calls.length, 1);
  assert.equal(foreign.calls[0]!.targetFunctionId, null);
  const unknown = await capture(
    '#include "missing.h"\n' + policy + "int Use(void){return Decision();}\n",
  );
  assert.equal(unknown.calls.length, 1);
  assert.equal(unknown.calls[0]!.targetFunctionId, null);
  assert.ok(unknown.cBindings.omissions.includes("unresolved-import"));
  const macro = await capture(
    "#define extra 1\n" + policy + "int Use(void){return Decision();}\n",
  );
  assert.equal(macro.calls.length, 1);
  assert.equal(macro.calls[0]!.targetFunctionId, null);
  assert.ok(macro.cBindings.omissions.includes("preprocessor-source-unknown"));
  const headerMacro = await capture(
    '#include "rules.h"\nint Use(void){return Decision();}\n',
    { "rules.h": "#define extra 1\n" + policy },
  );
  assert.equal(headerMacro.calls.length, 1);
  assert.equal(headerMacro.calls[0]!.targetFunctionId, null);
  const duplicate = await capture(
    '#include "rules.h"\n#include "rules.h"\nint Use(void){return Decision();}\n',
    { "rules.h": policy },
  );
  assert.equal(duplicate.calls.length, 1);
  assert.equal(duplicate.calls[0]!.resolution, "ambiguous-definition");
  const ambiguous = await capture(
    policy + policy + "int Use(void){return Decision();}\n",
  );
  assert.equal(ambiguous.calls.length, 1);
  assert.equal(ambiguous.calls[0]!.resolution, "ambiguous-definition");
  const computed = await capture(
    "static const int LIMIT=1+1; int Use(void){return LIMIT;}\n",
  );
  assert.equal(computed.references.length, 0);
  assert.ok(computed.cBindings.omissions.includes("nonliteral-global-unknown"));
  const ownership = await capture(
    "static const int LIMIT=2; static const int COPY=LIMIT; int Use(void){return LIMIT;}\n",
  );
  assert.equal(ownership.references.length, 2);
  assert.equal(
    ownership.references[0]!.ownerDeclarationId,
    ownership.declarations.find((d) => d.name === "COPY")!.id,
  );
  assert.equal(
    ownership.references[1]!.fromFunctionId,
    ownership.functions.find((f) => f.name === "Use")!.id,
  );
  const factory =
      "static int Answer(void){return 1;} static int (*Factory(void))(void){return Answer;} int Use(void){return Factory()();}\n",
    factories = await capture(factory),
    factoryCalls = factories.calls.filter((c) =>
      factory.slice(c.start, c.end).startsWith("Factory("),
    );
  assert.equal(factoryCalls.length, 2);
  assert.equal(new Set(factoryCalls.map((c) => c.start)).size, 1);
  assert.equal(new Set(factoryCalls.map((c) => c.end)).size, 2);
  assert.equal(
    factoryCalls.find((c) => factory.slice(c.start, c.end) === "Factory()")!
      .resolution,
    "lexical-binding",
  );
  assert.equal(
    factoryCalls.find((c) => factory.slice(c.start, c.end) === "Factory()()")!
      .targetFunctionId,
    null,
  );
  for (const source of [
    policy +
      "int Use(void){for(int i=0;i<2;i++){if(i)return Decision();}return 0;}\n",
    policy + "int Use(void){typedef int Decision;return Decision();}\n",
  ]) {
    const value = await capture(source);
    assert.equal(value.calls.length, 1);
    assert.equal(value.calls[0]!.targetFunctionId, null);
    assert.ok(value.cBindings.omissions.includes("unsupported-scope"));
  }
  const exported = await capture(
    '#include "rules.h"\nint Use(void){return Decision();}\n',
    { "rules.h": "static int Decision(void){while(0){} return 1;}\n" },
  );
  assert.equal(exported.calls.length, 1);
  assert.equal(exported.calls[0]!.targetFunctionId, null);
  const cycle = await capture(
    '#include "a.h"\nint Use(void){return Decision();}\n',
    { "a.h": '#include "b.h"\n' + policy, "b.h": '#include "a.h"\n' },
  );
  assert.equal(cycle.calls.length, 1);
  assert.equal(cycle.calls[0]!.targetFunctionId, null);
  assert.ok(cycle.cBindings.omissions.includes("include-depth-limit"));
  const decision = "int Use(int value){if(value){return 1;}else{return 0;}}\n",
    whole = await capture(decision);
  assert.equal(whole.decisions.length, 1);
  assert.equal(
    decision.slice(whole.decisions[0]!.start, whole.decisions[0]!.end),
    "if(value){return 1;}else{return 0;}",
  );
  const excluded = await fixture(t, { "vendor/copied.c": policy });
  await assert.rejects(
    createReviewContext(excluded, input(["vendor/copied.c"])),
    /excluded/,
  );
}
