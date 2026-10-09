import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fixtureGit, syntheticCommit } from "./git-fixture.js";
import type { TestContext } from "node:test";
import { createReviewContext } from "../src/review.js";
import { fixture } from "./helpers.js";
export async function yamlBoundariesFixture(t: TestContext) {
  async function capture(source: string, extra: Record<string, string> = {}) {
    const root = await fixture(t, { "sample.yaml": source, ...extra }),
      promise = createReviewContext(root, {
        schemaVersion: 23,
        track: "snapshot",
        currentSource: "working-tree",
        files: ["sample.yaml"],
        supportFiles: Object.keys(extra),
        moduleRoots: ["."],
        topics: [],
      });
    await assert.doesNotReject(
      promise,
      "Valid YAML source candidates must pass intake",
    );
    const context = await promise;
    assert.equal(context.schemaVersion, 23);
    if (context.schemaVersion !== 23) throw Error("Original YAML required");
    assert.ok(context.analysis.files.every((f) => f.state === "collected"));
    return context.analysis;
  }
  const simple = await capture("first: &policy 1\nresult: *policy\n");
  assert.equal(simple.references.length, 1);
  assert.equal(
    simple.decisions.filter((d) => d.nodeType === "block_mapping_pair").length,
    2,
  );
  const initial = simple.declarations.find(
    (d) => d.id === simple.yamlBindings.anchors[0]!.declarationId,
  )!;
  assert.ok(initial.initializer);
  assert.equal(
    "first: &policy 1\nresult: *policy\n".slice(
      initial.initializer.start,
      initial.initializer.end,
    ),
    "1",
  );
  assert.equal(simple.yamlBindings.anchors.length, 1);
  assert.equal(
    simple.references[0]!.targetDeclarationId,
    simple.yamlBindings.anchors[0]!.declarationId,
  );
  assert.equal(
    simple.declarations.find(
      (d) => d.id === simple.references[0]!.ownerDeclarationId,
    )!.name,
    "result",
  );
  for (const name of ["Policy", "policyExtra"]) {
    const value = await capture("first: &policy 1\nresult: *" + name + "\n");
    assert.equal(value.references.length, 0);
    assert.equal(value.yamlBindings.aliases[0]!.resolution, "no-prior-anchor");
  }
  for (const size of [256, 257]) {
    const name = "a".repeat(size),
      value = await capture("first: &" + name + " 1\nresult: *" + name + "\n");
    assert.equal(value.references.length, size === 256 ? 1 : 0);
    assert.equal(
      value.yamlBindings.anchors[0]!.name,
      size === 256 ? name : null,
    );
    if (size === 257)
      assert.ok(
        value.yamlBindings.omissions.includes("unsupported-anchor-name"),
      );
    const key = await capture(name + ": 1\n");
    assert.equal(key.declarations[0]!.name, size === 256 ? name : null);
    const quoted = await capture(JSON.stringify(name) + ": 1\n");
    assert.equal(quoted.declarations[0]!.name, size === 256 ? name : null);
  }
  const inert = await capture(
    'first: &policy 1\nreal: *policy # *fake\nnote: "*missing &missing"\nblock: |\n  *inert &inert\n',
  );
  assert.equal(inert.references.length, 1);
  assert.equal(inert.yamlBindings.anchors.length, 1);
  assert.equal(inert.yamlBindings.counts.unresolvedAliases, 0);
  const flow = await capture(
    "first: &policy {role: admin, nested: [1,2]}\nnext: {result: *policy}\n",
  );
  assert.equal(flow.references.length, 1);
  const anchor = flow.declarations.find(
    (d) => d.id === flow.yamlBindings.anchors[0]!.declarationId,
  )!;
  assert.ok(anchor.initializer);
  assert.equal(
    "{role: admin, nested: [1,2]}",
    "first: &policy {role: admin, nested: [1,2]}\nnext: {result: *policy}\n".slice(
      anchor.initializer.start,
      anchor.initializer.end,
    ),
  );
  assert.ok(
    flow.decisions.some(
      (d) =>
        d.nodeType === "flow_pair" &&
        "first: &policy {role: admin, nested: [1,2]}\nnext: {result: *policy}\n".slice(
          d.start,
          d.end,
        ) === "result: *policy",
    ),
  );
  const reuse = await capture(
    "first: &policy 1\nbefore: *policy\nsecond: &policy 2\nafter: *policy\n",
  );
  assert.equal(reuse.references.length, 2);
  assert.equal(
    reuse.references[0]!.targetDeclarationId,
    reuse.yamlBindings.anchors[0]!.declarationId,
  );
  assert.equal(
    reuse.references[1]!.targetDeclarationId,
    reuse.yamlBindings.anchors[1]!.declarationId,
  );
  const forward = await capture("before: *policy\nfirst: &policy 1\n");
  assert.equal(forward.references.length, 0);
  assert.equal(forward.yamlBindings.aliases[0]!.resolution, "no-prior-anchor");
  const docs = await capture("first: &policy 1\n---\nresult: *policy\n");
  assert.equal(docs.references.length, 0);
  assert.equal(docs.yamlBindings.aliases[0]!.resolution, "no-prior-anchor");
  const files = await capture("resultXXXX: *policy\n", {
    "other.yaml": "a: &policy 1\nb: [1]\n",
  });
  assert.equal(files.references.length, 0);
  assert.equal(files.yamlBindings.aliases[0]!.targetDeclarationId, null);
  assert.equal(files.yamlBindings.aliases[0]!.resolution, "no-prior-anchor");
  assert.equal(
    "resultXXXX: *policy\n".length,
    "a: &policy 1\nb: [1]\n".length,
    "Document bounds must not accidentally enforce file isolation",
  );
  const revisionFiles = {
      "sample.yaml": "first: &policy 1\nresult: *policy\n",
    },
    revisionRoot = await fixture(t, revisionFiles);
  fixtureGit(revisionRoot, ["init", "--quiet"]);
  const base = await syntheticCommit(revisionRoot, revisionFiles);
  await writeFile(
    path.join(revisionRoot, "sample.yaml"),
    revisionFiles["sample.yaml"].replace("policy 1", "policy 2"),
  );
  const revisionPromise = createReviewContext(revisionRoot, {
    schemaVersion: 23,
    track: "diff",
    baseCommit: base,
    currentSource: "working-tree",
    files: ["sample.yaml"],
    supportFiles: [],
    moduleRoots: ["."],
    topics: [],
  });
  await assert.doesNotReject(
    revisionPromise,
    "Equal source spans must retain revision isolation",
  );
  const revisionContext = await revisionPromise;
  assert.equal(revisionContext.schemaVersion, 23);
  if (revisionContext.schemaVersion !== 23)
    throw Error("Original YAML context required");
  assert.equal(revisionContext.analysis.references.length, 2);
  for (const ref of revisionContext.analysis.references)
    assert.equal(
      revisionContext.analysis.declarations.find(
        (d) => d.id === ref.targetDeclarationId,
      )!.revision,
      ref.revision,
    );
  const chain = await capture(
    "first: &first 1\nsecond: &second {nested: *first}\nresult: *second\n",
  );
  assert.equal(chain.references.length, 2);
  const first = chain.yamlBindings.anchors.find((a) => a.name === "first")!;
  assert.ok(
    chain.yamlBindings.dependencyEdges.some(
      (e) =>
        e.targetDeclarationId === first.declarationId &&
        e.depth === 2 &&
        chain.declarations.find((d) => d.id === e.fromDeclarationId)!.name ===
          "result",
    ),
  );
  const recursive = await capture("first: &policy [*policy]\n");
  assert.equal(recursive.references.length, 0);
  assert.equal(
    recursive.yamlBindings.aliases[0]!.resolution,
    "recursive-alias",
  );
  assert.ok(
    recursive.yamlBindings.omissions.includes("recursive-alias-unknown"),
  );
  for (const source of [
    "first: !application &policy 1\nresult: *policy\n",
    "first: &policy 1\nresult: !application [*policy]\n",
    "first: &policy {role: admin}\nresult: {<<: *policy}\n",
  ]) {
    const value = await capture(source);
    assert.equal(value.references.length, 0);
    assert.equal(
      value.yamlBindings.aliases[0]!.resolution,
      "unsupported-alias",
    );
    assert.equal(value.yamlBindings.state, "partial");
  }
  const odd = await capture("first: &policy.name 1\nresult: *policy.name\n");
  assert.equal(odd.references.length, 0);
  assert.ok(odd.yamlBindings.omissions.includes("unsupported-anchor-name"));
  const unicode = await capture(
    'note: "é😀"\nfirst: &policy 1\nresult: *policy\n',
  );
  assert.equal(unicode.references.length, 1);
  assert.equal(
    'note: "é😀"\nfirst: &policy 1\nresult: *policy\n'.slice(
      unicode.references[0]!.start,
      unicode.references[0]!.end,
    ),
    "*policy",
  );
  const excluded = await fixture(t, {
    "vendor/copied.yaml": "first: &policy 1\nresult: *policy\n",
  });
  await assert.rejects(
    createReviewContext(excluded, {
      schemaVersion: 23,
      track: "snapshot",
      currentSource: "working-tree",
      files: ["vendor/copied.yaml"],
      supportFiles: [],
      moduleRoots: ["."],
      topics: [],
    }),
    /excluded/,
  );
}
