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

`assets/context-grammars/manifest.json` retains the distributed grammar build
identities and the original `web-tree-sitter@0.27.0` build-time runtime.
`assets/context-grammars/runtime-manifest.json` binds the selected
`web-tree-sitter@0.27.1` runtime bytes to that unchanged grammar build manifest. The engine checks fixed runtime and language
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

The [runtime upgrade record](measurements/context-runtime-0.27.1-2026-10-30/observation.json)
binds the new WASM bytes to the pinned upstream release, tagged source and verified
release attestation. Its JavaScript and original MIT, Unicode and conditional musl
notices match the retained bytes. This is a runtime update; the existing grammar
binaries and their historical build records are unchanged. Full producer-build
closure for the new runtime remains a separate, open Gate A obligation.

## Operator-selected runtime release proof

Explicit preparation can run the pinned native GitHub attestation verifier against
the selected `web-tree-sitter@0.27.1` release archive, retained bundle and trust
roots. `scripts/prepare-context-runtime-proof.mjs` requires absolute operator paths
for the archive, original verification, trusted root, native `gh` executable and
output. It checks the exact release subject, certificate workflow identity, source
commit/ref, issuer, predicate and hosted-runner policy. Discovery, planning and
context collection do not invoke that verifier or download its inputs.

Preparation publishes a complete read-only cohort before returning its proof
path and SHA-256. Set `CHECKTRAIL_CONTEXT_RELEASE_PROOF` to that absolute
`proof.json` path followed by `#sha256=` and its lowercase SHA-256 before starting
the application. The proof module captures this selection when it first loads;
later environment edits and MCP arguments cannot grant authority. An absent or
empty selection retains the legacy context contract. A malformed nonempty
selection fails admission.

Qualified contexts include a bounded `runtimeArtifactProof` reference without
the private proof path. The shared engine rechecks the physical cohort, packaged
manifests, runtime JavaScript/WASM, separately bound runtime license and selected
grammars. Cached language objects still require the selected grammar's physical
bytes before parsing. Context intake and the actual final receipt independently
apply the same authority and physical-asset checks, including coherently rehashed
input. CLI/MCP summaries continue to withhold source and the proof path; source
disclosure requires the existing operator startup grant.

The signed release archive contains the selected runtime JavaScript and WASM;
it does **not** contain the separately bound `LICENSE`. The proof therefore does
not claim signed license membership, grammar signatures, complete notices,
current owner status or full upstream producer-build closure. The qualification
does not close Gate A or enable model calls and review trials.

`scripts/verify-context-runtime-proof-package.mjs` exercises every exported parser
collector and public language context through final receipt admission, the mixed
Visual Basic grammar boundary, actual warm-cache rejection, CLI/MCP disclosure and
startup authority through source
and a fresh locked offline production installation. The synthetic receipt declares
its files unreviewed. These controls validate the transport and admission paths;
they do not perform an AI or field review.

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

Opt-in version 8 layers selected Python lexical/import binding metadata over these fixed grammars and expanded source bounds. Versions 6–7 keep unresolved wider-language calls. See [REVIEW-PYTHON-CONTEXT.md](REVIEW-PYTHON-CONTEXT.md).

Version 9 retains this fixed syntax profile and adds selected Go lexical/import metadata before its captured tree is released. Explicitly selected go.mod directives bind literal module names separately from Go syntax collection. See [REVIEW-GO-CONTEXT.md](REVIEW-GO-CONTEXT.md).
