# Captured source syntax with fixed grammars

Selection/context version 6 adds `selected-syntax-v1` to the shared review
context engine. It preserves version 5's working/index source selection, immutable
base, regular-file modes and version 2 assessment/receipt contracts. Versions 1–5
retain their existing syntax contracts. JavaScript/TypeScript keeps its existing
captured-string TypeScript parser and selected lexical links.

```json
{
  "schemaVersion": 6,
  "track": "snapshot",
  "currentSource": "working-tree",
  "files": ["src/decision.py"],
  "supportFiles": ["src/defaults.py"],
  "topics": ["analysis-scope"]
}
```

The additional bundled Tree-sitter grammars cover Python, Go, PHP, Rust, Java,
Kotlin, Scala, C#, F#, Ruby, Swift, C, C++, HCL and YAML. F# signature files use a
separate grammar. `review-grammar-profile.ts` defines exact extensions: `.h` uses
the C grammar; `.hpp`, `.hh` and `.hxx` use C++. Visual Basic remains unsupported
for this syntax profile. Native compiler, framework and formatter support remains
separate in [LANGUAGES.md](LANGUAGES.md).

The collectors retain complete ranges for their selected function, declaration,
parameter/default and decision node forms. Comments and string lookalikes do not
create functions or calls. Captured calls retain their enclosing function, while
wider-language target resolution remains `unsupported-dispatch`. Static import
syntax is retained without importing modules or claiming project module resolution.
Wider-language lexical caller/consumer resolution, inherited defaults, broader node
forms and runtime assembly are still required work. `collected` describes syntax
capture for the selected profile, with the recorded omissions; it does not establish
semantic completeness, runtime reachability, a working fix or a verified finding.

Only fixed packaged parsers receive captured strings. No project configuration,
plugin, manifest, import, build or source module is executed. The same source
disclosure boundary applies through the library, CLI and MCP. Summary output
withholds source and syntax detail; tool input grants no disclosure or execution.

Version 6 keeps the existing file/source limits. Opt-in version 7 uses the finite
expanded capture bounds in [REVIEW-CONTEXT-LIMITS.md](REVIEW-CONTEXT-LIMITS.md). The new walk additionally caps
combined visited nodes, nesting, retained records and serialized analysis. Parsing
uses a cooperative elapsed-time callback; this is not an OS deadline. Malformed,
unsupported, missing/changed parser and exhausted views retain distinct states.
Captured source remains available to the authorized host even when syntax is
partial. No empty function list implies a clean repository.

## Artifact identities and build record

`assets/context-grammars/manifest.json` binds the distributed binaries and the
`web-tree-sitter@0.27.0` runtime bytes. The engine checks fixed runtime and language
bytes before initialization/loading and supplies the verified runtime WASM bytes
directly. Loaded language objects are retained in process memory; replacing a disk
asset does not replace an already loaded parser. Contexts record the immutable
grammar identities used by the process. Context intake validates those identities
and their captured ranges without executing a parser or project code.

`node scripts/audit-context-grammars.mjs` checks the complete distributed asset
inventory, binary/runtime digests, source commit selections, archive references,
notices and patches. The [build record](measurements/context-grammar-build-2026-10-08.json)
retains exact source-archive hashes, source-file identities, build commands,
generated/modified Swift source, compiler/optimizer archive pins and notices.
Grammar sources are the finite selections in `gate-a-profiles.v1.json`.
Compiler/optimizer transitive notice closure remains unverified; the artifact
binding audit does not close that separate Gate A requirement.

Preparation used the checksum-verified Tree-sitter 0.27.0 macOS arm64 builder,
WASI SDK 34.0 and Binaryen 132. Set `TREE_SITTER_WASI_SDK_PATH` and
`TREE_SITTER_BINARYEN_PATH` to the verified extracted tool archives to avoid
automatic tool downloads. In each recorded grammar directory, run the recorded
`tree-sitter build --wasm --output FILENAME DIRECTORY` command. Swift first uses
`tree-sitter generate src/grammar.json`, followed by the distributed
`patches/swift-wasm-oom.patch`. That patch uses the supported `abort` import on
WASM scanner allocation failure and preserves the native stderr/exit branch.
The build record distinguishes upstream source, generated files and the patch.
No upstream JavaScript grammar was evaluated for this preparation.

The runtime API and build mechanism are documented in the pinned
[Tree-sitter web binding documentation](https://github.com/tree-sitter/tree-sitter/blob/v0.27.0/lib/binding_web/README.md).
Normal context collection performs no download or compilation.

## Acceptance and remaining work

The required `selected-syntax-context` component profile exercises original text
in every distributed grammar, defaults, full ranges, repaired and adjacent text,
malformed/empty/unsupported views, immutable base/index/working history, forged
source/grammar/range evidence, valid-but-changed WASM, budget exhaustion and shared
library/CLI/MCP disclosure. The installed check runs with
`CHECKTRAIL_IMPORT_CONTEXT_PROFILE=selected-syntax-context node scripts/verify-import-context-package.mjs`.
The copied missing-parser control dereferences package symlinks so it cannot reuse
an initialized parser from the real installed module. Compiling mutations remove
functions, decisions, defaults, grammar byte binding and base functions; unchanged
original assertions must reject them before restored controls pass.

These are synthetic syntax and protocol controls. They do not close the full
selected language-context profiles, their lexical/import/consumer requirements,
compiler license closure or runtime matrix. No model inference, field review,
held-out evaluation or comparative quality claim is enabled. Gate A remains open.

Revision-specific source, compiling mutation and fresh offline installation evidence is recorded in
[selected-syntax-context-2026-10-08.json](measurements/selected-syntax-context-2026-10-08.json).
The component profile does not complete the wider finite context profiles.
