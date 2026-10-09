# Captured Rust bindings

Opt-in selection/context version 11 adds `rust-selected-bindings-v1` through the shared library, CLI and MCP engine. Versions 1–10 keep their existing profiles. Version 11 retains the expanded bounds: 32 selected paths, 64 KiB UTF-8 bytes per source, 1 MiB combined immutable-base/current bytes, 64 revision views and an independent 8 MiB context ceiling.

```json
{
  "schemaVersion": 11,
  "track": "snapshot",
  "currentSource": "working-tree",
  "files": ["src/policy.rs"],
  "supportFiles": ["src/consumer.rs", "src/lib.rs"],
  "crateRoots": ["src/lib.rs"],
  "topics": []
}
```

One to sixteen explicit canonical relative `.rs` entry files define selected source roots. These are operator declarations, not discovered Cargo crate identities. Capture reads captured strings and pinned parser assets; it never runs Rust, Cargo, build scripts or project configuration, and never loads a declared module. Whole selected functions, declarations and decisions retain revision-bound source ranges. Deleted/moved base consumers and working/index consumers remain distinct.

The edition-2024 path subset maps literal external `mod name;` declarations to selected `name.rs` or `name/mod.rs` files and supports inline modules. Both file layouts present at the same address are ambiguous. Missing modules, source outside the declared entries, multiple root memberships and attributed modules remain unknown or partial. Selected literal `crate`, `self` and `super` paths, grouped imports and explicit aliases retain source candidates. ASCII identifiers use exact case and complete path segments. External crates, leading external paths, glob imports, raw/Unicode identifiers, import cycles/depth exhaustion and macro expansion are not resolved.

Value and type namespaces remain separate. A value parameter does not mask a qualified module path, and a type alias does not mask an ordinary function call. Tuple/unit struct constructors do occupy the value namespace; named-field structs do not. Parameters and simple local bindings mask ordinary named calls. A `let` binding starts after its initializer. Item declarations are visible throughout their enclosing item scope. An inaccessible outer local still prevents a guessed link from a nested function to an outer function: the original native control retains the compiler's E0434 rejection. A valid non-colliding nested item remains separately exercised. These distinctions follow Rust's [namespaces](https://doc.rust-lang.org/reference/names/namespaces.html), [scopes](https://doc.rust-lang.org/reference/names/scopes.html) and [module layout](https://doc.rust-lang.org/reference/items/modules.html) contracts within the captured subset.

Simple wildcard patterns introduce no binding. Compound patterns, associated/trait scopes, generic functions, methods, object dispatch and unknown attributes retain conservative unresolved metadata. Parenthesized named function calls retain literal candidates. Constants and statics can retain selected declaration references; lifetime and label names are not constant reads. Compiler type checking, privacy, Cargo dependency resolution, conditional compilation and runtime reachability remain unverified even when a literal candidate is present.

Reverse caller closure starts at primary Rust functions and stops at eight levels or its edge ceiling. The module walk and import resolution are independently bounded. Syntax has node/depth/record ceilings and 256 KiB metadata bounds; additional binding metadata exceeding its ceiling rejects capture. Missing or changed parsers, malformed syntax, empty selections and exhausted records cannot establish a complete profile. Context intake reconciles declared roots, missing captured entry files, derived call/import counts, canonical omission states and caller closure. A recomputed context digest cannot bypass those checks; this is structural reconciliation rather than native name-resolution verification.

Full impact fallback, unchanged validation planning and false native-resolution/loading/reachability flags remain mandatory. Other languages retain their existing syntax metadata with unresolved language-specific bindings. Summaries withhold source and binding details; MCP tool arguments grant neither source disclosure nor execution trust.

The original `context-rust` callbacks cover broken/fixed predicate witnesses, complete declaration/decision ranges, moved consumers, base/current/index addresses, namespace and scope boundaries, module layouts, parser prerequisites, empty/exhausted capture, exact source/root/caller limits and library/CLI/MCP privacy. Trusted native cancellation, timeout and output exhaustion require reached parents and reaped children to disappear. Atomic identity publication prevents partial JSON reads; owned compiler artifacts are removed. A fresh locked offline production installation runs the same compiled callbacks against the installed engine. Compiling guard mutations must fail original assertions and pass again after restoration.

Exact synthetic evidence is recorded in [rust-context-2026-10-08.json](measurements/rust-context-2026-10-08.json). Optional native host callbacks remain skipped when the pinned compiler is absent; the required Linux ARM64 source and installed controls are separate acceptance. These controls invoke no AI inference or field evaluation and establish no accuracy comparison. Wider language/assembly profiles, the runtime matrix, artifact/notice closure and the independent protocol remain Gate A obligations.

The shared [nested-call identity repair](REVIEW-CALL-IDENTITY.md) adds fresh original source and installed-package controls for calls that share a start offset. Its supplemental record binds the changed resolver and callback bytes.
