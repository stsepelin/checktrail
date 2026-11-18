import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import ts from "typescript";

const repository = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const maximumInputBytes = 8 * 1024 * 1024;
const names = [
  "grammarManifestDigest",
  "grammarRuntimeVersion",
  "grammarRuntimeManifestDigest",
  "grammarRuntimeAssets",
];
function literal(node) {
  while (ts.isAsExpression(node) || ts.isParenthesizedExpression(node))
    node = node.expression;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  assert.ok(
    ts.isObjectLiteralExpression(node),
    "Runtime pins must be literal data",
  );
  const entries = node.properties.map((property) => {
    assert.ok(
      ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)),
      "Runtime pins must use explicit literal properties",
    );
    return [property.name.text, literal(property.initializer)];
  });
  assert.equal(new Set(entries.map(([name]) => name)).size, entries.length);
  return Object.fromEntries(entries);
}
function sourcePins(text) {
  const source = ts.createSourceFile(
    "review-grammar-assets.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  assert.equal(
    source.parseDiagnostics.length,
    0,
    "Malformed runtime pin source",
  );
  const pins = new Map();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !names.includes(declaration.name.text)
      )
        continue;
      assert.ok(
        statement.declarationList.flags & ts.NodeFlags.Const &&
          statement.modifiers?.some(
            (item) => item.kind === ts.SyntaxKind.ExportKeyword,
          ),
        "Runtime pins must be exported constants",
      );
      assert.ok(
        !pins.has(declaration.name.text),
        "Duplicate runtime source pin",
      );
      assert.ok(declaration.initializer, "Missing runtime source pin value");
      pins.set(declaration.name.text, literal(declaration.initializer));
    }
  }
  assert.deepEqual(
    [...pins.keys()].sort(),
    [...names].sort(),
    "Missing runtime source pin",
  );
  return Object.fromEntries(pins);
}

// Parse and hash data only. The later grammar audit retains runtime compilation
// and provenance checks; this preflight neither imports project code nor loads WASM.
export async function checkContextRuntimeCoherence(root = repository) {
  root = path.resolve(root);
  assert.equal(await realpath(root), root, "Canonical coherence root required");
  const bytes = async (file) => {
    const withinLimit = (metadata) =>
      assert.ok(
        Number.isSafeInteger(metadata.size) &&
          metadata.size >= 0 &&
          metadata.size <= maximumInputBytes,
        "Coherence input exceeds " + maximumInputBytes + "-byte limit: " + file,
      );
    let handle;
    try {
      let current = root;
      const parts = file.split("/");
      for (const [index, part] of parts.entries()) {
        assert.ok(part && part !== "." && part !== "..");
        current = path.join(current, part);
        const metadata = await lstat(current);
        assert.ok(
          !metadata.isSymbolicLink(),
          "Coherence inputs cannot use symbolic links: " + file,
        );
        assert.ok(
          index === parts.length - 1
            ? metadata.isFile()
            : metadata.isDirectory(),
        );
      }
      assert.equal(await realpath(current), current);
      const before = await lstat(current);
      withinLimit(before);
      handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      withinLimit(opened);
      assert.ok(
        opened.isFile() &&
          opened.dev === before.dev &&
          opened.ino === before.ino,
      );
      // Read at most the admitted size plus one byte, even if the file grows.
      const buffer = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      withinLimit(await handle.stat());
      const after = await lstat(current);
      withinLimit(after);
      assert.equal(
        length,
        opened.size,
        "Coherence input changed while reading: " + file,
      );
      const content = buffer.subarray(0, length);
      assert.equal(await realpath(current), current);
      for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"])
        assert.equal(
          after[field],
          before[field],
          "Coherence input changed while reading: " + file,
        );
      return content;
    } catch (error) {
      if (error.code === "ERR_ASSERTION") throw error;
      assert.fail("Required context-runtime input unavailable: " + file);
    } finally {
      await handle?.close();
    }
  };
  const json = async (file) => JSON.parse((await bytes(file)).toString("utf8"));
  const pins = sourcePins(
    (await bytes("src/review-grammar-assets.ts")).toString("utf8"),
  );
  const version = pins.grammarRuntimeVersion;
  assert.match(
    version,
    /^\d+\.\d+\.\d+$/,
    "Runtime source version must be exact",
  );
  const manifest = await json("package.json");
  const lock = await json("package-lock.json");
  const installed = await json("node_modules/web-tree-sitter/package.json");
  assert.equal(
    manifest.dependencies?.["web-tree-sitter"],
    version,
    "Package runtime declaration differs from selected source pin",
  );
  assert.equal(
    lock.packages?.[""]?.dependencies?.["web-tree-sitter"],
    version,
    "Root lock runtime declaration differs from selected source pin",
  );
  assert.equal(
    lock.packages?.["node_modules/web-tree-sitter"]?.version,
    version,
    "Locked runtime version differs from selected source pin",
  );
  assert.equal(
    installed.name,
    "web-tree-sitter",
    "Installed runtime package identity differs",
  );
  assert.equal(
    installed.version,
    version,
    "Installed runtime version differs from selected source pin",
  );
  const grammar = await bytes("assets/context-grammars/manifest.json");
  assert.equal(
    hash(grammar),
    pins.grammarManifestDigest,
    "Grammar manifest bytes differ from selected source pin",
  );
  const runtimeBytes = await bytes(
    "assets/context-grammars/runtime-manifest.json",
  );
  assert.equal(
    hash(runtimeBytes),
    pins.grammarRuntimeManifestDigest,
    "Runtime manifest bytes differ from selected source pin",
  );
  const runtime = JSON.parse(runtimeBytes.toString("utf8"));
  assert.equal(runtime.schemaVersion, 1);
  assert.equal(runtime.package, "web-tree-sitter");
  assert.equal(
    runtime.version,
    version,
    "Runtime manifest version differs from selected source pin",
  );
  assert.equal(runtime.grammarBuildManifestSHA256, pins.grammarManifestDigest);
  assert.deepEqual(
    runtime.files,
    pins.grammarRuntimeAssets,
    "Runtime manifest file pins differ from selected source pins",
  );
  assert.deepEqual(Object.keys(runtime.files).sort(), [
    "LICENSE",
    "web-tree-sitter.js",
    "web-tree-sitter.wasm",
  ]);
  for (const [name, pin] of Object.entries(runtime.files)) {
    assert.deepEqual(Object.keys(pin).sort(), ["bytes", "sha256"]);
    assert.ok(Number.isSafeInteger(pin.bytes) && pin.bytes > 0);
    assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    const actual = await bytes("node_modules/web-tree-sitter/" + name);
    assert.equal(
      actual.length,
      pin.bytes,
      "Installed runtime byte count differs: " + name,
    );
    assert.equal(
      hash(actual),
      pin.sha256,
      "Installed runtime hash differs: " + name,
    );
  }
  return {
    package: "web-tree-sitter",
    version,
    sourcePinsMatchInstalledBytes: true,
    runtimeCodeExecuted: false,
    wasmCompiled: false,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    assert.equal(
      process.argv.length,
      2,
      "Runtime coherence preflight accepts no arguments",
    );
    process.stdout.write(
      JSON.stringify(await checkContextRuntimeCoherence()) + "\n",
    );
  } catch (error) {
    process.stderr.write(
      "Context runtime coherence failed: " +
        error.message +
        ". " +
        "Upgrade web-tree-sitter through a coordinated change to package.json, package-lock.json, source runtime pins, runtime manifests and retained upgrade evidence; a version-only dependency bump cannot qualify this runtime.\n",
    );
    process.exitCode = 1;
  }
}
