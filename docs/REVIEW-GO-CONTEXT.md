# Captured Go bindings

Opt-in selection/context version 9 adds `go-selected-bindings-v1` through the shared library, CLI and MCP engine. Versions 1–8 retain their previous behavior. Version 9 uses the expanded bounds: 32 selected paths, 64 KiB UTF-8 bytes per source, 1 MiB combined immutable-base/current bytes, 64 revision views and an independent 8 MiB context ceiling.

```json
{
  "schemaVersion": 9,
  "track": "snapshot",
  "currentSource": "working-tree",
  "files": ["policy/policy.go"],
  "supportFiles": ["consumer/consumer.go", "go.mod"],
  "moduleRoots": ["."],
  "topics": []
}
```

One to sixteen explicit disjoint relative roots identify captured module manifests. Select each root's `go.mod` as a primary or support path; it shares the source budget. Each revision retains the exact manifest path and digest, its literal module declaration and captured/missing/unsupported state. Module names come from captured directives, never the directory basename, ambient Go environment or an operator-supplied import name. Missing, duplicate or unsupported declarations leave module imports unresolved. This bounded declaration parser does not validate every directive or establish native module resolution.

Package groups use captured directories and package clauses. Named package functions can resolve across selected files in the same directory, even when module metadata is unavailable. Literal imports resolve only to selected same-revision package groups under captured module identities. An unaliased import uses the captured package name; explicit aliases use exact names. Duplicate import identities across selected roots and mixed package names remain ambiguous. File import bindings shadow package declarations in other files, while parameters, receivers, named results and local declarations mask outer names. A short declaration's initializer reads the preceding scope; its local names apply after that declaration. Qualified calls resolve only through a selected package receiver and an exported exact function name.

Whole selected function, declaration/initializer and decision ranges retain revision-bound addresses. Reverse caller closure starts at primary Go functions, follows selected lexical calls and stops at eight levels or its edge ceiling. Deleted/moved base consumers and current/index consumers remain distinct. Captured `go.mod` metadata does not count as a collected Go syntax tree: syntax and binding states retain their partial/unsupported information separately.

Methods and arbitrary object calls, generic calls/functions, function literals, dot imports, range/type-switch/receive scope mutations and unsupported identifier or string spellings remain unresolved or partial. Blank imports do not introduce callable names; init functions do not introduce ordinary callable bindings. An unresolved unaliased import leaves its package name unknown and prevents inferred outer package bindings in that file; explicit alias names still mask exactly. Build tags, target platforms, generated/test file selection, replacements, workspaces, dependency packages, reflection, cgo and runtime dispatch are not inferred. Explicitly selected generated files receive syntax scrutiny; inventory-excluded dependency directories cannot be selected. Full impact fallback, unknown runtime reachability, unverified native module resolution and unchanged validation planning remain mandatory.

Capture reads bounded strings with pinned bundled parser assets and never invokes Go or project code. Parser absence/tampering, malformed source and exhausted syntax remain error/unsupported/budget states. Additional metadata beyond its ceiling rejects capture. Reconstruction reconciles selected roots, independently re-derived manifest metadata, call/import counters, omission states and exact caller closure. A recomputed context digest cannot bypass these checks. Summaries withhold source and binding metadata; MCP arguments cannot grant source disclosure or native execution.

The original `context-go` acceptance callbacks use only synthetic public fixtures. They exercise broken/fixed predicate witnesses, complete producer ranges, moved/deleted and shadowed consumers, base/current/index bindings, exact namespaces, manifest ambiguity, parser-byte prerequisites, empty/exhausted evidence, depth/source/root limits and CLI/MCP privacy and trust. Trusted native controls run with module downloads disabled. Reached cancellation, timeout and output exhaustion require observed parent and reaped child processes to disappear; owned compiler caches and binaries are removed. Fresh offline installation runs the same compiled callbacks against the installed production engine. Compiling mutations must fail original assertions and pass after restoration.

These controls invoke no AI inference or field evaluation and establish no accuracy comparison. Wider language/assembly profiles, complete runtime acceptance, artifact/notice closure and independent evaluation remain Gate A obligations.

Exact local and pinned Linux ARM64 source/fresh offline installation evidence and original compiling guard controls are recorded in [go-context-2026-10-08.json](measurements/go-context-2026-10-08.json). Gate A remains open.

The shared [nested-call identity repair](REVIEW-CALL-IDENTITY.md) adds fresh original source and installed-package controls for calls that share a start offset. Its supplemental record binds the changed resolver and callback bytes.
