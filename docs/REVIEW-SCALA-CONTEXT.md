# Selected Scala source bindings

Opt-in selection/context version 14 adds `scala-selected-bindings-v1` through the shared library, CLI and MCP engine. Versions 1–13 keep their binding profiles. Version 14 keeps the expanded limits: 32 selected paths, 64 KiB UTF-8 bytes per source, 1 MiB combined base/current source, 64 revision views and a separate 8 MiB context ceiling.

```json
{
  "schemaVersion": 14,
  "track": "snapshot",
  "currentSource": "working-tree",
  "files": ["src/policy/Policy.scala"],
  "supportFiles": ["src/consumer/Consumer.scala"],
  "moduleRoots": ["src"],
  "topics": []
}
```

One to sixteen disjoint canonical relative directories declare source-selection boundaries. They do not infer sbt projects, compiler classpaths or build modules. Fixed pinned parsers receive captured strings while their trees remain alive. Capture runs no Scala, script, compiler, build wrapper, plugin, project configuration or initializer. Whole functions, infix decisions, declaration defaults and source addresses remain revision-specific, including deleted base consumers and working/index source.

The bounded Scala 3 subset uses exact plain ASCII identifiers, a single flat package declaration, ordinary top-level functions, literal immutable top-level values, fully qualified package candidates and literal imports. Explicit grouped selectors and `as`/legacy arrow aliases retain separate addresses. Same-file definitions take precedence over imports. Scala 3 [top-level definitions](https://docs.scala-lang.org/scala3/reference/other-new-features/toplevel-definitions.html) are lifted after the file's imports; an import written after a top-level function can affect that function. Top-level `private` definitions remain package-scoped. Original compiled witnesses exercise both rules, including a later import competing with a definition in another source file.

Local function definitions are forward-visible. Parameters and local values mask callable names; local values conservatively mask the entire captured block. This does not prove definite assignment or compiler applicability. The native compiler rejects a forward reference that crosses a local value definition; syntax candidates do not certify that program. Selected duplicates and overloads remain ambiguous. Missing explicit imports retain unknown targets. Wildcard, hidden, contextual and unsupported import forms remain partial.

Scala imports can name stable values as well as packages. A captured same-file or same-package declaration, or an import alias, at the beginning of an import qualifier prevents a guessed package target. Value prefixes likewise prevent guessed fully qualified package calls. These are conservative selected-source boundaries; unselected package members, root qualification, compiler overload selection and implicit behavior remain unverified.

Nested calls use complete start/end addresses. The inner named call in `choose()()` retains its selected target; the outer value invocation remains unknown. Ordinary call names, named argument keys, type positions and inert strings/comments are not constant reads. Selected literal value references retain their declarations. Class/object bodies and constructor syntax remain visible; member/constructor dispatch, lambdas, generics, annotations, extensions, givens, exports, macros, nested packages, escaped identifiers and loop/case/catch scopes remain unknown or partial. `.sc` source can be captured by the packaged Scala grammar without script loading, and version 14 requires a script omission at intake.

Reverse caller closure starts at primary `.scala` functions and stops at eight levels or its edge ceiling. Syntax, metadata, imports and references remain bounded. Missing/altered parser bytes, malformed/exhausted syntax, unselected roots and empty source cannot establish complete coverage. Intake reconciles roots, derived call/import counts, canonical omission state, constructor/script omissions, grammar provenance and caller closure. Native name resolution, module loading and runtime reachability remain unverified. Full impact fallback and unchanged validation planning are mandatory. Summary views withhold source and binding details; MCP arguments grant neither source disclosure nor execution trust.

The required `context-scala` callbacks use original synthetic broken/fixed/near-miss producer and consumer programs compiled with the pinned Scala 3.9.0 compiler and its eight byte-verified runtime libraries. Separate reached JVM parent/child controls cover cancellation, timeout, output exhaustion, observed process cleanup and removal of an owned class artifact; the captured Scala initializer remains inert. These lifecycle controls do not claim Scala compiler-process lifecycle coverage. A fresh locked offline production installation runs the same external harness against the installed engine. Every compiling guard mutation must fail an unchanged original assertion. Baselines are reused only by exact callback; source bytes are restored after each mutation and callbacks run fresh after final restoration.

[Recorded synthetic evidence](measurements/scala-context-2026-10-08.json) binds the selected source, compiled callbacks, native runtime, guard controls and installed package. The independent `scala-context-arm64` CI job requires all nine callbacks without skips. Host native checks remain optional when the exact compiler is absent. Acceptance packages precede the measurement record, so this is not final release-artifact acceptance. Wider language/assembly slices, artifact/reference freeze decisions, the full runtime matrix and Gate A remain open. No AI inference, field evaluation or review-quality claim is made.
