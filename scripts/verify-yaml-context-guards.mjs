import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const callback = new URL(
  "../dist/test/gate-context-yaml.test.js",
  import.meta.url,
);
const originalCallback = await readFile(callback);
const boundaryFixture = new URL(
    "../dist/test/review-yaml-boundaries-fixture.js",
    import.meta.url,
  ),
  originalBoundaryFixture = await readFile(boundaryFixture);

const guardCallback = new URL(
    "../dist/test/review-yaml-boundaries.test.js",
    import.meta.url,
  ),
  originalGuardCallback = await readFile(guardCallback);
const callbackFor = (name) =>
  name === "context-yaml selected bindings guard acceptance"
    ? guardCallback
    : callback;
const callbackBytes = (name) =>
  name === "context-yaml selected bindings guard acceptance"
    ? originalGuardCallback
    : originalCallback;

const digest = (value) => createHash("sha256").update(value).digest("hex");
const controls = [
  {
    id: "yaml-anchor-name-size",
    file: "review-yaml-bindings.js",
    name: "context-yaml selected bindings guard acceptance",
    before: "node && node.text.length <= 256 &&",
    after: "node && node.text.length <= 512 &&",
  },
  {
    id: "yaml-plain-key-size",
    file: "review-yaml-bindings.js",
    name: "context-yaml selected bindings guard acceptance",
    before: "return node.text.length <= 256 ? node.text : null;",
    after: "return node.text.length <= 512 ? node.text : null;",
  },
  {
    id: "yaml-quoted-key-size",
    file: "review-yaml-bindings.js",
    name: "context-yaml selected bindings guard acceptance",
    before:
      'return typeof value === "string" && value.length <= 256 ? value : null;',
    after:
      'return typeof value === "string" && value.length <= 512 ? value : null;',
  },
  {
    id: "yaml-identifier-case",
    file: "review-yaml-resolution.js",
    name: "context-yaml selected bindings guard acceptance",
    before: "a.name === alias.name &&",
    after: "a.name?.toLowerCase() === alias.name?.toLowerCase() &&",
  },
  {
    id: "yaml-identifier-prefix",
    file: "review-yaml-resolution.js",
    name: "context-yaml selected bindings guard acceptance",
    before: "a.name === alias.name &&",
    after: 'alias.name?.startsWith(a.name??"not-selected") &&',
  },
  {
    id: "yaml-source-file",
    file: "review-yaml-resolution.js",
    name: "context-yaml selected bindings guard acceptance",
    before: "a.file === alias.file &&",
    after: "true &&",
  },
  {
    id: "yaml-revision",
    file: "review-yaml-resolution.js",
    name: "context-yaml selected bindings guard acceptance",
    before: "a.revision === alias.revision &&",
    after: "true &&",
  },
  {
    id: "yaml-document-boundary",
    file: "review-yaml-resolution.js",
    name: "context-yaml selected bindings guard acceptance",
    before:
      "a.documentStart === alias.documentStart &&\n        a.documentEnd === alias.documentEnd &&",
    after: "true &&",
  },
  {
    id: "yaml-preceding-anchor",
    file: "review-yaml-resolution.js",
    name: "context-yaml selected bindings guard acceptance",
    before: "a.start < alias.start",
    after: "true",
  },
  {
    id: "yaml-latest-anchor",
    file: "review-yaml-resolution.js",
    name: "context-yaml selected bindings guard acceptance",
    before: ".sort((a, b) => b.start - a.start)[0]",
    after: ".sort((a, b) => a.start - b.start)[0]",
  },
  {
    id: "yaml-recursive-alias",
    file: "review-yaml-resolution.js",
    name: "context-yaml selected bindings guard acceptance",
    before:
      "const recursive = target !== undefined && target.end > value.start;",
    after: "const recursive = false;",
  },
  {
    id: "yaml-target-tag",
    file: "review-yaml-resolution.js",
    name: "context-yaml selected bindings guard acceptance",
    before: "value.unsupported || !beneath(unit.file, roots) || target?.tagged",
    after: "value.unsupported || !beneath(unit.file, roots)",
  },
  {
    id: "yaml-source-tag",
    file: "review-yaml-bindings.js",
    name: "context-yaml selected bindings guard acceptance",
    before: 'unsupported ||= p.namedChildren.some((c) => c.type === "tag");',
    after: "unsupported ||= false;",
  },
  {
    id: "yaml-merge-alias",
    file: "review-yaml-bindings.js",
    name: "context-yaml selected bindings guard acceptance",
    before: 'keyName(p.childForFieldName("key") ?? undefined) === "<<"',
    after: "false",
  },
  {
    id: "yaml-anchor-owner",
    file: "review-yaml-bindings.js",
    name: "context-yaml selected bindings guard acceptance",
    before: "(anchorOwner ?? owner)?.id ?? null",
    after: "owner?.id ?? null",
  },
  {
    id: "yaml-alias-range",
    file: "review-yaml-bindings.js",
    name: "context-yaml selected bindings guard acceptance",
    before:
      "...range(node),\n            name,\n            ownerDeclarationId:",
    after:
      "...range(node),start:range(node).start+1,\n            name,\n            ownerDeclarationId:",
  },
  {
    id: "yaml-anchor-name-boundary",
    file: "review-yaml-bindings.js",
    name: "context-yaml selected bindings guard acceptance",
    before: "/^[A-Za-z_][A-Za-z_0-9-]*$/.test(node.text)",
    after: "/^[A-Za-z_][A-Za-z_0-9.-]*$/.test(node.text)",
  },
  {
    id: "yaml-anchor-initializer",
    file: "review-yaml-bindings.js",
    name: "context-yaml selected bindings guard acceptance",
    before:
      'initializer: node.namedChildren.find((c) => !["anchor", "tag"].includes(c.type))',
    after: 'initializer: node.namedChildren.find((c) => c.type === "anchor")',
  },
  {
    id: "yaml-whole-block-decision",
    file: "review-polyglot.js",
    name: "context-yaml selected bindings guard acceptance",
    before: '    "attribute",\n    "block_mapping_pair",\n    "flow_pair",\n',
    after: '    "attribute",\n    "flow_pair",\n',
  },
  {
    id: "yaml-whole-flow-decision",
    file: "review-polyglot.js",
    name: "context-yaml selected bindings guard acceptance",
    before: '    "attribute",\n    "block_mapping_pair",\n    "flow_pair",\n',
    after: '    "attribute",\n    "block_mapping_pair",\n',
  },
  {
    id: "yaml-depth",
    file: "review-yaml-resolution.js",
    name: "context-yaml empty acceptance",
    before: "if (depth > 8)",
    after: "if (depth > 7)",
  },
  {
    id: "yaml-roots-intake",
    file: "review-yaml-resolution.js",
    name: "context-yaml stale acceptance",
    before:
      "if (JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))",
    after: "if (false)",
  },
  {
    id: "yaml-counts-intake",
    file: "review-yaml-resolution.js",
    name: "context-yaml stale acceptance",
    before: "if (JSON.stringify(counts) !== JSON.stringify(bindings.counts))",
    after: "if (false)",
  },
  {
    id: "yaml-aliases-intake",
    file: "review-yaml-resolution.js",
    name: "context-yaml stale acceptance",
    edits: [
      {
        before: "if (alias.documentStart > alias.start ||",
        after: "if (false && (alias.documentStart > alias.start ||",
      },
      {
        before:
          '(alias.resolution !== "selected-anchor" &&\n                alias.targetDeclarationId !== null))',
        after:
          '(alias.resolution !== "selected-anchor" &&\n                alias.targetDeclarationId !== null)))',
      },
    ],
  },
  {
    id: "yaml-references-intake",
    file: "review-yaml-resolution.js",
    name: "context-yaml stale acceptance",
    before:
      "if (JSON.stringify(publicReferences.map(referenceKey)) !==\n        JSON.stringify(resolved.map(referenceKey)))",
    after: "if (false)",
  },
  {
    id: "yaml-omissions-intake",
    file: "review-yaml-resolution.js",
    name: "context-yaml stale acceptance",
    before:
      'if (mandatory.some((o) => !bindings.omissions.includes(o)) ||\n        JSON.stringify(bindings.omissions) !==\n            JSON.stringify([...new Set(bindings.omissions)].sort()) ||\n        bindings.state !==\n            (bindings.omissions.some((o) => !fixed.includes(o))\n                ? "partial"\n                : "collected"))',
    after: "if (false)",
  },
  {
    id: "yaml-closure-intake",
    file: "review-yaml-resolution.js",
    name: "context-yaml stale acceptance",
    before:
      "if (JSON.stringify(bindings.dependencyEdges) !== JSON.stringify(closure.edges))",
    after: "if (false)",
  },
  {
    id: "yaml-grammar-intake",
    file: "review-behavior-validation.js",
    name: "context-yaml stale acceptance",
    before: "analysis.grammarManifestDigest !== grammarManifestDigest",
    after: "false",
  },
];
const environment = { ...process.env };
delete environment.NODE_TEST_CONTEXT;
function run(name) {
  const pattern = "^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern",
      pattern,
      fileURLToPath(callbackFor(name)),
    ],
    {
      cwd: repository,
      env: environment,
      encoding: "utf8",
      timeout: 90000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stdout + result.stderr);
  return result;
}
const selected = new Set(process.argv.slice(2));
assert.ok(
  [...selected].every((id) => controls.some((control) => control.id === id)),
  "Unknown guard control",
);
const evidence = [];
const baselines = new Map();
const originals = new Map();
for (const control of controls.filter(
  (control) => selected.size === 0 || selected.has(control.id),
)) {
  const source = new URL("../dist/src/" + control.file, import.meta.url);
  const original = await readFile(source, "utf8");
  if (!baselines.has(control.name)) {
    const baseline = run(control.name);
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    baselines.set(control.name, baseline);
  }
  if (originals.has(source.href))
    assert.equal(
      originals.get(source.href),
      original,
      "A prior guard changed source bytes",
    );
  else originals.set(source.href, original);
  let mutant = original;
  for (const edit of control.edits ?? [control]) {
    assert.equal(
      mutant.split(edit.before).length,
      2,
      "Exact control address: " + control.id,
    );
    mutant = mutant.replace(edit.before, edit.after);
  }
  try {
    await writeFile(source, mutant);
    const compile = spawnSync(
      process.execPath,
      ["--check", fileURLToPath(source)],
      { encoding: "utf8" },
    );
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const result = run(control.name);
    assert.equal(
      result.status,
      1,
      "Original assertion must kill " +
        control.id +
        "\n" +
        result.stdout +
        result.stderr,
    );
    assert.match(result.stdout, /ERR_ASSERTION/, control.id);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /SyntaxError|TypeError|ReferenceError/,
    );
    assert.ok(result.stdout.includes("not ok 1 - " + control.name));
    assert.deepEqual(
      await readFile(callbackFor(control.name)),
      callbackBytes(control.name),
      "Original callback changed",
    );
    assert.deepEqual(
      await readFile(boundaryFixture),
      originalBoundaryFixture,
      "Original boundary assertions changed",
    );
    evidence.push({
      id: control.id,
      callback: control.name,
      callbackSha256: digest(callbackBytes(control.name)),
      fixtureSha256: digest(originalBoundaryFixture),
      sourceSha256: digest(original),
      mutantSha256: digest(mutant),
      originalPassed: true,
      mutantCompiled: true,
      mutantFailedAssertion: true,
    });
  } finally {
    await writeFile(source, original);
  }
  assert.equal(
    await readFile(source, "utf8"),
    original,
    "Original source bytes were not restored",
  );
}
for (const [source, original] of originals)
  assert.equal(
    await readFile(new URL(source), "utf8"),
    original,
    "Final source byte restoration failed",
  );
for (const name of baselines.keys()) {
  const restored = run(name);
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  for (const control of evidence.filter((control) => control.callback === name))
    control.restoredPassed = true;
}
process.stdout.write(
  JSON.stringify({
    scope:
      "Original synthetic YAML captured-binding controls; no model inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
