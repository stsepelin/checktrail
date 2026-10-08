# Selected C# source bindings

Opt-in context version 15 adds `csharp-selected-bindings-v1` through the shared library, CLI and MCP engine. Earlier versions retain their profiles. It keeps the expanded 32-path, 64 KiB per-file, 1 MiB combined revision-source, 64-view and separate 8 MiB context limits.

```json
{
  "schemaVersion": 15,
  "track": "snapshot",
  "currentSource": "working-tree",
  "files": ["src/policy/Policy.cs"],
  "supportFiles": ["src/consumer/Consumer.cs"],
  "moduleRoots": ["src"],
  "topics": []
}
```

One to sixteen disjoint canonical relative directories select captured source. They do not infer assemblies, project XML, reference packs or compiler symbols. Fixed pinned parsers receive immutable captured strings while their trees remain alive. Capture executes no C#, compiler, initializer, MSBuild, NuGet or repository configuration. Whole function/default/constant ranges, touched decisions and callers retain base/current/index identities, including deleted consumers.

The literal subset accepts ordinary ASCII identifiers, a single flat file-scoped or block namespace, plain classes, selected static methods and literal `const` field reads. Mixed global/block namespaces, nested namespaces and unsupported declarations remain partial. Exact type and namespace aliases and selected namespace imports can retain candidates. A namespace alias remains an unresolved module record because a namespace has no single source owner; calls into a uniquely selected class can still retain a target. Missing competing namespace/static imports, alias/type conflicts, duplicate types and same-name overloads remain unresolved or ambiguous.

C# [using directives](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/using-directive) distinguish namespace/type aliases from static-member imports. This source subset does not perform assembly lookup, inherited or extension-member resolution, overload selection or native accessibility verification. Cross-file candidate types and every enclosing class must be public; non-public nested types remain unresolved even where the compiler permits access. Private static members bind only from the exact declaring class. Internal/protected access outside the captured subset is not inferred.

Parameters, block locals and callable fields mask same-name method candidates. Ordinary class methods take precedence over imported static candidates. [Local functions](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/classes-and-structs/local-functions) can be referenced before their declarations; original compiler witnesses exercise the forward binding and delegate shadowing separately. Block locals conservatively mask their entire block rather than claiming definite assignment. Named-argument keys and type/import names are not constant reads. Calls use complete start/end identities, so an outer delegate invocation cannot inherit a named inner call's target. Explicit and implicit object creation remain unresolved `construct` calls.

Instance dispatch, inheritance, generic/annotated declarations, records/interfaces/structs, properties/patterns, loops/catches, query and anonymous-method scopes, lambdas, top-level statements, async/other unsupported modifiers and escaped identifiers remain unknown or partial. The raw-source profile conservatively marks any backslash-u/backslash-U, `global using` spelling or line beginning with a preprocessing marker unknown; inert text can therefore also make capture partial. Selected global-using source affects all selected files of that revision. This is a conservative boundary, not preprocessing or a claim that inert text is invalid C#. Intake derives these raw-source omissions again from both captured revisions; rebinding a context digest cannot erase them.

Reverse callers start at selected primary C# functions and stop after eight levels or the edge ceiling. Syntax and metadata budgets remain bounded. Missing/changed parser bytes, empty, malformed or exhausted capture and outside roots cannot establish complete coverage. Intake reconciles roots, call/import counts, canonical omission state, constructor omissions and caller closure. Full impact fallback and unchanged validation planning remain mandatory; native name resolution, assembly loading and runtime reachability flags remain false. Summary views withhold source and bindings. MCP arguments grant neither disclosure nor operator execution trust.

The required `context-csharp` controls exercise original broken/fixed/near-miss native outcomes, selected aliases/static imports, forward functions and callable shadowing, exact source ranges, revision changes, parser prerequisites, empty/exhausted capture, exact budgets and shared CLI/MCP privacy. Native witnesses directly invoke the pinned SDK's Roslyn compiler against its fixed reference pack, with `-noconfig` and no SDK project evaluation or restore. Reached C# runtime parent/child controls must disappear after pre-start cancellation, reached cancellation, timeout and output exhaustion; owned assembly output is removed. These are runtime lifecycle controls, not compiler-process cancellation certification.

A fresh locked offline production installation runs the external original harness against the installed engine. Each compiling guard mutation must fail an original assertion; each mutated source is restored immediately, and original callbacks run again after final byte restoration. [csharp-context-2026-10-09.json](measurements/csharp-context-2026-10-09.json) records the measured profile. Package hashes identify tested packages before that measurement record, not a final release artifact. Optional host-native callbacks are skipped when the pinned SDK is absent; the required Linux ARM64 profile requires every callback. Wider language, assembly, runtime matrix, artifact/license and independent evaluation obligations keep Gate A open. No inference, field evaluation or comparative accuracy is measured here.
