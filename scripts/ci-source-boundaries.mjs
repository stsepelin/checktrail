import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { URL } from "node:url";
import ts from "typescript";
const catalogFile = "scripts/ci-source-boundaries.json";
// This exact implementation constructs a closed producer-identity registry and
// hashes the selected runner; the reference does not load a runner as a module.
// Any change requires reassessing the exception, and the shared file itself
// always selects full verification. LF normalization admits Git CRLF checkouts.
const producerRegistryFile = "src/native-journal-engine.ts";
const producerRegistrySha256 =
  "8bd46fc6b7a1dcf638aacc9e1b3e9f310fb7e1e1d518db1603379cf0908fb330";
const compiled = (file) => "dist/" + file.replace(/\.ts$/, ".js");
const source = (file) =>
  file.startsWith("dist/") ? file.slice(5).replace(/\.js$/, ".ts") : file;
const safe = (file) =>
  typeof file === "string" &&
  /^(?:src|test)\/[a-z0-9-]+(?:\.test)?\.ts$/.test(file);
const exactKeys = (value, keys) =>
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    "Unknown CI source-boundary field",
  );
const referenceKey = (row) => JSON.stringify([row.file, row.kind, row.count]);
function target(text, caller) {
  const url = new URL(text, "file:///__checktrail__/" + compiled(caller));
  assert.ok(
    !/%(?:2f|5c)/i.test(url.pathname),
    "Unresolved encoded source-boundary separator",
  );
  if (url.protocol !== "file:" || url.host) return null;
  const pathname = decodeURIComponent(url.pathname).toLowerCase();
  return pathname.startsWith("/__checktrail__/")
    ? source(pathname.slice("/__checktrail__/".length)).toLowerCase()
    : null;
}
function urlAncestor(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isNewExpression(parent) && parent.expression.getText() === "URL")
      return parent;
    if (ts.isStatement(parent)) return null;
  }
  return null;
}
/** Declared subprocess boundaries, not a proof of every possible runtime dependency. */
export async function sourceBoundaryInputs({
  files,
  requirements,
  jobs,
  inputs,
  readText,
}) {
  if (!files.includes(catalogFile)) return {};
  const catalog = JSON.parse(await readText(catalogFile));
  exactKeys(catalog, ["schemaVersion", "scope", "boundaries"]);
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.scope, "declared-standalone-subprocess-runners");
  assert.ok(
    Array.isArray(catalog.boundaries) &&
      catalog.boundaries.length > 0 &&
      catalog.boundaries.length <= 128,
  );
  const available = new Set(files),
    rows = new Map();
  for (const row of catalog.boundaries) {
    exactKeys(row, ["file", "profiles", "references", "testFiles"]);
    assert.ok(
      safe(row.file) &&
        row.file.startsWith("src/") &&
        row.file.endsWith("-runner.ts") &&
        available.has(row.file),
    );
    assert.ok(
      !rows.has(row.file.toLowerCase()),
      "Duplicate CI source boundary",
    );
    assert.ok(
      Array.isArray(row.profiles) &&
        row.profiles.length > 0 &&
        new Set(row.profiles).size === row.profiles.length,
    );
    const owners = new Set();
    for (const profile of row.profiles) {
      assert.ok(
        Object.hasOwn(requirements, profile) &&
          Array.isArray(requirements[profile]) &&
          requirements[profile].length > 0,
        "Unknown source-boundary native profile",
      );
      for (const item of requirements[profile]) {
        const file = source(item.file),
          consumers = inputs[file];
        assert.ok(
          Array.isArray(consumers) && consumers.length > 0,
          "Source boundary has no declared native consumer",
        );
        for (const id of consumers) {
          assert.ok(jobs.includes(id));
          owners.add(id);
        }
      }
    }
    assert.ok(
      Array.isArray(row.testFiles) &&
        row.testFiles.length > 0 &&
        row.testFiles.length <= 128 &&
        new Set(row.testFiles).size === row.testFiles.length,
      "Invalid source-boundary component test inventory",
    );
    for (const file of row.testFiles)
      assert.ok(
        safe(file) &&
          file.startsWith("test/") &&
          file.endsWith(".test.ts") &&
          available.has(file),
        "Missing source-boundary component test file",
      );
    assert.ok(
      Array.isArray(row.references) &&
        row.references.length > 0 &&
        row.references.length <= 32,
    );
    for (const reference of row.references) {
      exactKeys(reference, ["file", "kind", "count"]);
      assert.ok(
        safe(reference.file) &&
          reference.file.startsWith("src/") &&
          available.has(reference.file),
      );
      assert.ok(["module-url", "validation-literal"].includes(reference.kind));
      assert.ok(
        Number.isSafeInteger(reference.count) &&
          reference.count > 0 &&
          reference.count <= 32,
      );
    }
    assert.equal(
      new Set(
        row.references.map((reference) =>
          JSON.stringify([reference.file, reference.kind]),
        ),
      ).size,
      row.references.length,
    );
    assert.ok(
      row.references.some((reference) => reference.kind === "module-url"),
      "Source boundary has no declared subprocess caller",
    );
    rows.set(row.file.toLowerCase(), {
      ...row,
      owners: [...owners].sort(),
      observed: new Map(),
    });
  }
  const names = [...rows.values()].map((row) =>
    path.posix.basename(compiled(row.file)).toLowerCase(),
  );
  function potentiallyReferences(value) {
    let decoded;
    try {
      decoded = decodeURIComponent(value).toLowerCase();
    } catch {
      decoded = value.toLowerCase();
    }
    const matches = names.some((name) => decoded.includes(name));
    if (matches)
      assert.ok(
        value.length <= 2048 && !/[\r\n]/.test(value),
        "Unresolved bounded source-boundary literal",
      );
    return matches;
  }
  for (const file of files.filter(
    (file) => file.startsWith("src/") && file.endsWith(".ts"),
  )) {
    const text = await readText(file);
    if (file === producerRegistryFile) {
      assert.equal(
        createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex"),
        producerRegistrySha256,
        "Producer registry changed; source isolation must be reassessed",
      );
      continue;
    }
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node)) &&
        potentiallyReferences(node.text)
      ) {
        const url = urlAncestor(node);
        let destination, kind;
        if (url && url.arguments?.[1]?.getText(ast) === "import.meta.url") {
          destination = target(node.text, file);
          kind = "module-url";
        } else {
          destination = target(node.text, file);
          kind =
            node.text.includes("/") || node.text.includes("\\")
              ? "unclassified-reference"
              : "validation-literal";
        }
        const row = destination ? rows.get(destination) : null;
        let decoded = node.text;
        try {
          decoded = decodeURIComponent(decoded);
        } catch {
          /* Invalid path remains unclassified. */
        }
        if (
          !row &&
          names.includes(
            path.posix.basename(decoded.replaceAll("\\", "/")).toLowerCase(),
          )
        )
          assert.fail("Unresolved source-boundary path");
        if (row) {
          const key = JSON.stringify([file, kind]);
          row.observed.set(key, (row.observed.get(key) ?? 0) + 1);
        }
      }
      if (ts.isTemplateExpression(node)) {
        assert.ok(
          !potentiallyReferences(node.getText(ast)) &&
            !node.getText(ast).includes("-runner.js"),
          "Unresolved dynamic source-boundary reference",
        );
      }
      if (ts.isStringLiteral(node) && node.text === "-runner.js")
        assert.fail("Unresolved dynamic source-boundary reference");
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  const output = {};
  for (const row of rows.values()) {
    const observed = [...row.observed].map(([key, count]) => {
      const [file, kind] = JSON.parse(key);
      return { file, kind, count };
    });
    assert.deepEqual(
      observed.map(referenceKey).sort(),
      row.references.map(referenceKey).sort(),
      "Source-boundary reference inventory differs: " + row.file,
    );
    output[row.file] = row.owners;
  }
  return output;
}
