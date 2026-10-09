import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createReviewContext } from "../src/review.js";
import { fixture } from "./helpers.js";
export async function nameBoundariesFixture(
  t: TestContext,
  version: 20 | 21 | 22,
) {
  const file =
    version === 20 ? "sample.c" : version === 21 ? "sample.cpp" : "sample.tf";
  async function capture(source: string, extra: Record<string, string> = {}) {
    const root = await fixture(t, { [file]: source, ...extra }),
      promise = createReviewContext(root, {
        schemaVersion: version,
        track: "snapshot",
        currentSource: "working-tree",
        files: [file],
        supportFiles: Object.keys(extra),
        moduleRoots: ["."],
        topics: [],
      });
    await assert.doesNotReject(
      promise,
      "Valid source names beyond the declaration bound must remain captured as unknown",
    );
    const context = await promise;
    assert.equal(context.schemaVersion, version);
    assert.ok(
      context.schemaVersion === 20 ||
        context.schemaVersion === 21 ||
        context.schemaVersion === 22,
    );
    assert.ok(context.analysis.files.every((f) => f.state === "collected"));
    return context.analysis;
  }
  for (const size of [256, 257]) {
    const name = "a".repeat(size);
    if (version === 20 || version === 21) {
      const body = "int " + name + "(void){return 1;}",
        value = await capture(
          body + "\nint Use(void){return " + name + "();}\n",
        );
      assert.equal(value.functions.length, 2);
      assert.equal(value.functions[0]!.name, size === 256 ? name : null);
      assert.equal(
        body,
        (body + "\nint Use(void){return " + name + "();}\n").slice(
          value.functions[0]!.start,
          value.functions[0]!.end,
        ),
      );
      assert.equal(value.calls.length, 1);
      const unbound = await capture("int Use(void){return " + name + ";}\n");
      const bindings =
        "cBindings" in unbound
          ? unbound.cBindings
          : "cppBindings" in unbound
            ? unbound.cppBindings
            : null;
      assert.ok(bindings);
      assert.equal(
        bindings.omissions.includes("unsupported-binding"),
        size > 256,
      );
      assert.equal(bindings.fullImpactFallback, true);
      assert.equal(bindings.nativeNameResolutionVerified, false);
      assert.equal(
        value.calls[0]!.targetFunctionId,
        size === 256 ? value.functions[0]!.id : null,
      );
    } else {
      for (const [producer, read, kind] of [
        ['variable "' + name + '" { default=1 }\n', "var." + name, "parameter"],
        ["locals { " + name + "=1 }\n", "local." + name, "property"],
      ] as const) {
        const value = await capture(
          producer + 'output "result" { value=' + read + " }\n",
        );
        assert.equal(value.references.length, size === 256 ? 1 : 0);
        const source = producer + 'output "result" { value=' + read + " }\n",
          wanted = kind === "parameter" ? producer.trim() : name + "=1",
          declared = value.declarations.find(
            (d) => d.kind === kind && source.slice(d.start, d.end) === wanted,
          );
        assert.ok(
          declared,
          "Complete producer declaration must remain captured",
        );
        assert.equal(declared.name, size === 256 ? name : null);
      }
      const output = await capture('output "' + name + '" { value=1 }\n');
      assert.equal(output.declarations[0]!.name, size === 256 ? name : null);
      for (const plain of [
        output,
        await capture('variable "' + name + '" { default=1 }\n'),
        await capture("locals { " + name + "=1 }\n"),
      ]) {
        assert.ok("hclBindings" in plain);
        assert.equal(
          plain.hclBindings.omissions.includes("unsupported-expression"),
          size > 256,
        );
        assert.equal(plain.hclBindings.fullImpactFallback, true);
        assert.equal(plain.hclBindings.nativeEvaluationVerified, false);
      }
      const module = await capture(
        'module "' +
          name +
          '" { source="./child" }\noutput "result" { value=module.' +
          name +
          ".answer }\n",
        { "child/output.tf": 'output "answer" { value=1 }\n' },
      );
      assert.equal(
        module.declarations.find((d) => d.kind === "import")!.name,
        size === 256 ? name : null,
      );
      assert.equal(module.references.length, size === 256 ? 1 : 0);
    }
  }
  if (version === 22) {
    const source = "./" + "a/".repeat(130) + "child",
      value = await capture(
        'module "selected" { source=' + JSON.stringify(source) + " }\n",
      );
    assert.equal(value.modules.length, 1);
    assert.equal(
      value.modules[0]!.specifier,
      source,
      "Declaration display-name bounds must not truncate module source strings",
    );
  }
}
