import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  readContextRuntimeProofInput,
  selectedContextRuntimeProof,
} from "./context-runtime-proof.js";
import {
  grammarAssets,
  grammarManifestDigest,
  grammarRuntimeAssets,
  grammarRuntimeManifestDigest,
} from "./review-grammar-assets.js";
import {
  vbGrammarAsset,
  vbGrammarManifestDigest,
} from "./review-vb-grammar-assets.js";

const hash = (body: Uint8Array) =>
  createHash("sha256").update(body).digest("hex");
export function contextRuntimeInstallationProof(
  grammars: readonly string[] = [],
) {
  const proof = selectedContextRuntimeProof();
  if (!proof) return undefined;
  for (const [member, expected] of [
    ["context-grammars/manifest.json", grammarManifestDigest],
    ["context-grammars/runtime-manifest.json", grammarRuntimeManifestDigest],
    ["context-vb-grammar/manifest.json", vbGrammarManifestDigest],
  ] as const) {
    const body = readContextRuntimeProofInput(
      fileURLToPath(new URL("../../assets/" + member, import.meta.url)),
      65536,
    );
    assert.equal(
      hash(body),
      expected,
      "Context manifest identity differs: " + member,
    );
  }
  const code = new URL(import.meta.resolve("web-tree-sitter"));
  for (const [member, location] of [
    ["web-tree-sitter.js", code],
    [
      "web-tree-sitter.wasm",
      new URL(import.meta.resolve("web-tree-sitter/web-tree-sitter.wasm")),
    ],
    ["LICENSE", new URL("LICENSE", code)],
  ] as const) {
    const expected = grammarRuntimeAssets[member];
    const body = readContextRuntimeProofInput(
      fileURLToPath(location),
      expected.bytes,
    );
    assert.equal(
      body.length,
      expected.bytes,
      "Context runtime size differs: " + member,
    );
    assert.equal(
      hash(body),
      expected.sha256,
      "Context runtime identity differs: " + member,
    );
  }
  const supportedGrammars = new Map<
    string,
    (typeof grammarAssets)[number] | typeof vbGrammarAsset
  >(
    [...grammarAssets, vbGrammarAsset].map((grammar) => [
      grammar.grammar,
      grammar,
    ]),
  );
  assert.ok(
    grammars.length <= supportedGrammars.size,
    "Selected grammar cohort exceeds bound",
  );
  assert.equal(
    new Set(grammars).size,
    grammars.length,
    "Duplicate selected grammar",
  );
  for (const name of grammars) {
    const grammar = supportedGrammars.get(name);
    assert.ok(grammar, "Unknown selected grammar");
    const folder = name === "vbnet" ? "context-vb-grammar" : "context-grammars";
    const body = readContextRuntimeProofInput(
      fileURLToPath(
        new URL("../../assets/" + folder + "/" + grammar.file, import.meta.url),
      ),
      grammar.bytes,
    );
    assert.equal(body.length, grammar.bytes, "Selected grammar size differs");
    assert.equal(
      hash(body),
      grammar.sha256,
      "Selected grammar identity differs",
    );
  }
  return proof;
}
