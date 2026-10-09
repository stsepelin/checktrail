# Selected Java source bindings

Opt-in selection/context version 12 adds `java-selected-bindings-v1` through the shared library, CLI and MCP engine. Earlier versions keep their existing profiles. Version 12 retains the expanded limits: 32 selected paths, 64 KiB UTF-8 bytes per source, 1 MiB combined base/current source, 64 revision views and a separate 8 MiB context ceiling.

```json
{
  "schemaVersion": 12,
  "track": "snapshot",
  "currentSource": "working-tree",
  "files": ["src/policy/Policy.java"],
  "supportFiles": ["src/consumer/Consumer.java"],
  "moduleRoots": ["src"],
  "topics": []
}
```

One to sixteen disjoint canonical relative directories declare selected source roots. They are source-selection boundaries, not inferred Maven, Gradle, classpath or module identities. Fixed pinned parsers receive captured strings while their trees remain alive. Capture runs no Java, compiler, build wrapper, annotation processor, configuration or project initializer. Source ranges, declaration initializers, decisions and callers remain revision-specific, including deleted base consumers and working/index source.

The bounded name subset uses exact ASCII identifiers, package declarations and selected ordinary top-level or static nested classes. Explicit type and static-member imports retain selected candidates. Duplicate selected types, competing imports and same-name method overloads remain ambiguous. An absent explicit import prevents a competing selected import from becoming a guessed target. Classes resolve from declarations rather than file basenames; native compilation and source-file naming requirements remain separate.

Type, value and method names have separate roles. A value parameter does not mask an ordinary method invocation, but a value with the same name as a class prevents a guessed class-qualified call. Local variables are visible in their own initializers; local types start at their declarations. A later local type does not obscure an earlier call. These distinctions follow the captured subset of Java's [scope and name contracts](https://docs.oracle.com/javase/specs/jls/se25/html/jls-6.html).

Only selected static methods and static final field references retain targets. Private members are limited to the exact declaring class in this subset; wider nestmate access remains unresolved. Cross-package type access checks every enclosing class, including a package-private outer class containing a public nested class. Package/protected members outside the same package remain unresolved. Native module exports, inherited access and complete compiler accessibility remain unverified. The original compiler controls separately exercise [enclosing-type accessibility](https://docs.oracle.com/javase/specs/jls/se25/html/jls-6.html#jls-6.6.1).

Method-reference names are not same-name field reads; a field used as the receiver still retains its own reference. Labels are not constant reads. Calls use complete start/end addresses, so an outer dynamic invocation cannot inherit the named inner call's target. Object creation is retained as unresolved `construct` calls, with an explicit constructor omission. Ordinary instance dispatch, inheritance, generic/annotated types and methods, local/non-static nested types, interfaces, records, enums, wildcard/module imports, pattern scopes and unselected dependencies remain unknown or partial.

Java translates [Unicode escapes before tokenization and comments](https://docs.oracle.com/javase/specs/jls/se25/html/jls-3.html#jls-3.3). This raw-source profile does not perform that translation. Any backslash-u spelling makes its file's bindings unknown, including valid inert escaped-literal spellings. It does not claim an inert spelling is invalid Java. Original native controls prove the hidden-binding compiler failure and a valid inert-literal outcome. Intake derives the Unicode omission again from captured revision bytes; a recomputed digest cannot erase it. Constructor call records similarly require their omission.

Reverse caller closure starts at primary Java functions and stops at eight levels or its edge ceiling. Syntax, metadata, imports and references remain bounded. Missing/altered parser bytes, malformed or exhausted syntax, unselected roots and empty source cannot establish complete binding coverage. Intake reconciles roots, derived call/import counts, canonical omission state and caller closure. This is structural reconciliation, not native name-resolution verification. Full impact fallback, unchanged validation planning and false native resolution/loading/reachability flags remain mandatory. Summary views withhold source and binding details; MCP arguments grant neither disclosure nor execution trust.

The required `context-java` callbacks exercise original broken/fixed/near-miss native outcomes, whole source addresses, deleted consumers, base/current/index identities, scope/import/access boundaries, parser prerequisites, empty/exhausted capture, exact budgets, and library/CLI/MCP privacy. Reached native parent/child processes must disappear after cancellation, timeout and output exhaustion; owned class output is removed. A fresh locked offline production installation runs the same external harness against the installed engine. Each compiling guard mutation must fail an original assertion. Guard baselines are reused only by exact unchanged callback; source bytes are restored after each mutation and the callbacks run fresh after final restoration.

Profile-specific evidence is recorded in [java-context-2026-10-08.json](measurements/java-context-2026-10-08.json). Its acceptance package hashes identify the packages tested before the measurement record, not a final release artifact. Optional host-native callbacks remain skipped when the pinned JDK is absent. Wider context/assembly profiles, the runtime matrix, artifact/license closure and independent protocol remain Gate A obligations. No AI inference, field evaluation or comparative accuracy assessment is invoked.
