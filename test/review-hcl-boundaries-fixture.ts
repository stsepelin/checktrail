import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createReviewContext } from "../src/review.js";
import { fixture } from "./helpers.js";
import { nameBoundariesFixture } from "./review-name-boundaries-fixture.js";
export async function hclBoundariesFixture(t: TestContext) {
  await nameBoundariesFixture(t, 22);
  async function capture(source: string, extra: Record<string, string> = {}) {
    const root = await fixture(t, { "sample.tf": source, ...extra }),
      capturePromise = createReviewContext(root, {
        schemaVersion: 22,
        track: "snapshot",
        currentSource: "working-tree",
        files: ["sample.tf"],
        supportFiles: Object.keys(extra),
        moduleRoots: ["."],
        topics: [],
      });
    await assert.doesNotReject(
      capturePromise,
      "Valid captured HCL source must pass intake",
    );
    const context = await capturePromise;
    assert.equal(context.schemaVersion, 22);
    if (context.schemaVersion !== 22) throw Error("Original HCL required");
    assert.ok(
      context.analysis.files.every((file) => file.state === "collected"),
      source,
    );
    return context.analysis;
  }
  const own =
    'variable "role" { default = "member" }\nlocals { first=var.role\n second=local.first\n}\n';
  const simple = await capture(own);
  assert.equal(simple.references.length, 2);
  const variable = simple.declarations.find((d) => d.kind === "parameter")!,
    first = simple.declarations.find((d) => d.name === "first")!,
    second = simple.declarations.find((d) => d.name === "second")!;
  assert.equal(simple.references[0]!.targetDeclarationId, variable.id);
  assert.equal(simple.references[1]!.ownerDeclarationId, second.id);
  assert.equal(simple.references[1]!.targetDeclarationId, first.id);
  assert.ok(
    simple.hclBindings.dependencyEdges.some(
      (edge) =>
        edge.targetDeclarationId === variable.id &&
        edge.fromDeclarationId === second.id &&
        edge.depth === 2,
    ),
  );
  assert.ok(variable.initializer);
  assert.equal(
    own.slice(variable.initializer.start, variable.initializer.end),
    '"member"',
  );
  for (const name of ["Role", "roleExtra"]) {
    const value = await capture(
      'variable "role" { default = "member" }\nlocals { value=var.' +
        name +
        " }\n",
    );
    assert.equal(value.hclBindings.references.length, 1);
    assert.equal(value.hclBindings.references[0]!.targetDeclarationId, null);
  }
  const namespace = await capture(
    'variable "role" { default="var" }\nlocals { role="local"\n value=local.role\n}\n',
  );
  assert.equal(namespace.references.length, 1);
  assert.equal(
    namespace.declarations.find(
      (d) => d.id === namespace.references[0]!.targetDeclarationId,
    )!.kind,
    "property",
  );
  const extended = await capture(
    'variable "role" { default="member" }\nlocals { value=var.role.extra }\n',
  );
  assert.equal(extended.references.length, 0);
  assert.equal(extended.hclBindings.references[0]!.targetDeclarationId, null);
  assert.equal(
    own.slice(simple.references[0]!.start, simple.references[0]!.end),
    "var.role",
  );
  const inert = await capture(
    'variable "role" { default = "member" }\nlocals { note="var.missing local.missing"\n real=var.role # var.fake\n}\n',
  );
  assert.equal(inert.references.length, 1);
  assert.equal(inert.hclBindings.counts.unresolvedReferences, 0);
  const forward = await capture("locals { first=local.last\n last=2\n}\n");
  assert.equal(forward.references.length, 1);
  assert.equal(
    forward.references[0]!.targetDeclarationId,
    forward.declarations.find((d) => d.name === "last")!.id,
  );
  const sibling = await capture("locals { value=var.role }\n", {
    "defaults.tf": 'variable "role" { default = "member" }\n',
  });
  assert.equal(sibling.references.length, 1);
  assert.equal(
    sibling.declarations.find(
      (d) => d.id === sibling.references[0]!.targetDeclarationId,
    )!.file,
    "defaults.tf",
  );
  const neighbor = await capture("locals { value=var.role }\n", {
    "other/defaults.tf": 'variable "role" { default = "member" }\n',
  });
  assert.equal(neighbor.references.length, 0);
  assert.equal(
    neighbor.hclBindings.references[0]!.resolution,
    "no-selected-definition",
  );
  const duplicate = await capture(
    'variable "role" { default="member" }\nlocals { value=var.role }\n',
    { "defaults.tf": 'variable "role" { default="other" }\n' },
  );
  assert.equal(duplicate.hclBindings.references.length, 1);
  assert.equal(
    duplicate.hclBindings.references[0]!.resolution,
    "ambiguous-definition",
  );
  assert.equal(duplicate.references.length, 0);
  const output = 'output "allowed" { value = true }\n';
  const imported = await capture(
    'module "policy" { source="./policy" }\noutput "result" { value=module.policy.allowed }\n',
    { "policy/outputs.tf": output, "policy/locals.tf": "locals { inert=2 }\n" },
  );
  assert.equal(imported.references.length, 1);
  assert.deepEqual(imported.hclBindings.moduleCandidates[0]!.targetFiles, [
    "policy/locals.tf",
    "policy/outputs.tf",
  ]);
  assert.equal(imported.modules[0]!.targetFile, "policy/locals.tf");
  assert.equal(
    imported.declarations.find(
      (d) => d.id === imported.references[0]!.targetDeclarationId,
    )!.file,
    "policy/outputs.tf",
  );
  assert.equal(
    imported.references[0]!.ownerDeclarationId,
    imported.declarations.find(
      (d) => d.file === "sample.tf" && d.name === "result",
    )!.id,
  );
  const outputCase = await capture(
    'module "policy" { source="./policy" }\noutput "result" { value=module.policy.Allowed }\n',
    { "policy/outputs.tf": output },
  );
  assert.equal(outputCase.references.length, 0);
  const outputDuplicate = await capture(
    'module "policy" { source="./policy" }\noutput "result" { value=module.policy.allowed }\n',
    { "policy/one.tf": output, "policy/two.tf": output },
  );
  assert.equal(outputDuplicate.references.length, 0);
  assert.equal(
    outputDuplicate.hclBindings.references[0]!.resolution,
    "ambiguous-definition",
  );
  const alias = await capture(
    'module "policy" { source="./policy" }\noutput "result" { value=module.policyExtra.allowed }\n',
    { "policy/outputs.tf": output },
  );
  assert.equal(alias.references.length, 0);
  assert.equal(alias.hclBindings.references[0]!.targetDeclarationId, null);
  for (const source of [
    "https://example.invalid/policy",
    "/policy",
    "../../policy",
    "./missing",
    "./${var.path}",
  ]) {
    const value = await capture(
      'module "policy" { source="' +
        source +
        '" }\noutput "result" { value=module.policy.allowed }\n',
      { "policy/outputs.tf": output },
    );
    assert.equal(value.references.length, 0);
    assert.notEqual(value.modules[0]!.resolution, "selected");
    assert.deepEqual(value.hclBindings.moduleCandidates[0]!.targetFiles, []);
    if (source.startsWith("https:") || source.includes("${"))
      assert.equal(value.modules[0]!.resolution, "dynamic");
    if (source === "/policy" || source === "../../policy")
      assert.equal(value.modules[0]!.resolution, "outside-root");
  }
  const missing = await capture(
    'module "policy" { source="./policy" }\noutput "result" { value=module.policy.allowed }\n',
  );
  assert.equal(missing.modules[0]!.resolution, "external");
  assert.equal(missing.hclBindings.counts.unresolvedImports, 1);
  assert.equal(missing.hclBindings.counts.resolvedReferences, 0);
  for (const source of [
    'module "policy" {\n source="./policy"\n count=2\n}\noutput "result" { value=module.policy.allowed }\n',
    'variable "role" { default = "member" }\nlocals { value=[for var in [1,2] : var.role] }\n',
    'variable "role" { default = "member" }\nlocals { value=var.role[0] }\n',
    'variable "role" { default = "member" }\nresource "fictional" "sample" { value=var.role }\n',
  ]) {
    const value = await capture(source, { "policy/outputs.tf": output });
    assert.ok(value.hclBindings.references.length > 0);
    assert.ok(
      value.hclBindings.references.every(
        (ref) => ref.targetDeclarationId === null,
      ),
    );
    assert.equal(value.hclBindings.state, "partial");
  }
  const cycle = await capture(
    "locals { first=local.second\n second=local.first\n}\n",
  );
  assert.equal(cycle.references.length, 2);
  assert.ok(cycle.hclBindings.omissions.includes("dependency-cycle-unknown"));
  assert.equal(cycle.hclBindings.state, "partial");
  const conditional = "locals { allowed = true ? 1 : 0 }\n",
    whole = await capture(conditional);
  assert.equal(
    whole.decisions.filter((d) => d.nodeType === "conditional").length,
    1,
  );
  const decision = whole.decisions.find((d) => d.nodeType === "conditional")!;
  assert.equal(conditional.slice(decision.start, decision.end), "true ? 1 : 0");
  const type = await capture(
    'variable "role" { type=string\n default="member"\n}\nlocals { value=var.role }\n',
  );
  assert.equal(type.references.length, 1);
  assert.equal(type.hclBindings.counts.unresolvedReferences, 0);
  const excluded = await fixture(t, { "vendor/copied.tf": own });
  await assert.rejects(
    createReviewContext(excluded, {
      schemaVersion: 22,
      track: "snapshot",
      currentSource: "working-tree",
      files: ["vendor/copied.tf"],
      supportFiles: [],
      moduleRoots: ["."],
      topics: [],
    }),
    /excluded/,
  );
}
