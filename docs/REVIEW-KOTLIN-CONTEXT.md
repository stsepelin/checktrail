# Selected Kotlin source bindings

Opt-in selection/context version 13 adds `kotlin-selected-bindings-v1` through the shared library, CLI and MCP engine. Versions 1–12 keep their profiles. Version 13 keeps the expanded limits: 32 selected paths, 64 KiB UTF-8 bytes per source, 1 MiB combined base/current source, 64 revision views and a separate 8 MiB context ceiling.

```json
{
  "schemaVersion": 13,
  "track": "snapshot",
  "currentSource": "working-tree",
  "files": ["src/policy/Policy.kt"],
  "supportFiles": ["src/consumer/Consumer.kt"],
  "moduleRoots": ["src"],
  "topics": []
}
```

One to sixteen disjoint canonical relative directories declare source-selection boundaries. They do not infer Gradle projects, classpaths or compiler modules. Fixed pinned parsers receive captured strings while their trees remain alive. Capture runs no Kotlin, script, compiler, build wrapper, annotation processor, project configuration or initializer. Whole functions, touched comparisons/Boolean decisions, declaration defaults and source addresses remain revision-specific, including deleted base consumers and working/index source.

The bounded subset uses exact plain ASCII identifiers, package declarations, top-level functions, top-level `const` properties, fully qualified package calls and explicit import aliases. File basenames do not determine package names. Selected duplicates and same-name overloads remain ambiguous. An absent explicit import retains an unknown target rather than falling through to a plausible selected declaration. Wildcard imports make the file's bindings unknown. This conservative subset follows Kotlin's [package/import contracts](https://kotlinlang.org/spec/packages-and-imports.html) without performing full compiler overload resolution.

[Kotlin statement scopes](https://kotlinlang.org/spec/scopes-and-identifiers.html) introduce local functions in declaration order. A later local function does not hide an earlier imported call; subsequent calls retain its selected local target. Parameters and local values mask callable names because invocation may use a value's `invoke` behavior. Local values conservatively mask their own initializer uses; this profile does not prove definite assignment or compiler applicability. A value or imported name at the beginning of a package qualifier prevents a guessed package call. Private top-level definitions remain file-bound.

Nested calls use complete start/end addresses. The named inner call in `choose()()` retains its selected target; the dynamic outer invocation remains unknown. Ordinary call names, named argument keys, labels, inert strings/comments and callable-reference names are not constant reads. Explicit top-level constant reads retain selected declarations, including aliases. Callable-reference receiver reads are outside this subset.

Classes, objects, constructors, methods, extensions, generics, annotations, delegated/destructured/accessor properties, implicit-receiver lambdas, loop/catch/when scopes, escaped identifiers, scripts and unselected dependencies remain unknown or partial. The pinned grammar can represent an `object` declaration through an infix/lambda shape; those scopes remain unknown. `.kts` syntax is captured without script loading and requires a script omission at intake. A native compiler result is separate from syntax collection, including whether a source form is accepted by the compiler.

Reverse caller closure starts at primary `.kt` functions and stops at eight levels or its edge ceiling. Syntax, metadata, imports and references remain bounded. Missing/altered parser bytes, malformed/exhausted syntax, unselected roots and empty source cannot establish complete binding coverage. Intake reconciles roots, derived call/import counts, canonical omission state, script omissions, grammar provenance and caller closure. This is structural reconciliation; native name resolution, module loading and runtime reachability remain unverified. Full impact fallback and unchanged validation planning are mandatory. Summary views withhold source and binding details; MCP arguments grant neither source disclosure nor execution trust.

The required `context-kotlin` callbacks exercise original broken/fixed/near-miss native Kotlin outcomes, source/default addresses, deleted consumers, base/current/index identities, import and scope boundaries, parser prerequisites, empty/exhausted capture, exact budgets, and library/CLI/MCP privacy. Original JVM parent/child controls compiled from Java exercise cancellation, timeout and output exhaustion; their reached processes disappear and owned class output is removed. These lifecycle controls do not claim Kotlin compiler-process lifecycle coverage. A fresh locked offline production installation runs the same external harness against the installed engine. Each compiling guard mutation must fail an unchanged original assertion. Baselines are reused only by exact callback; source bytes are restored after each mutation and callbacks run fresh after final restoration.

[Recorded synthetic evidence](measurements/kotlin-context-2026-10-08.json) binds the selected source, compiled callbacks, native runtime, guard controls and installed package. The independent `kotlin-context-arm64` CI job requires all nine callbacks without skips. Host native checks remain optional when the exact compiler is absent. Acceptance packages precede the measurement record, so this is not final release-artifact acceptance. Wider language/assembly slices, artifact/reference freeze decisions, the full runtime matrix and Gate A remain open. No AI inference, field evaluation or review-quality claim is made.
