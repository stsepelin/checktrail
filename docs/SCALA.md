# Scala JVM source compilation

`jvm.scala` is an opt-in analysis check selected in `checktrail.json`. It requires
an inventoried `checktrail.scala.json`, the locally prepared official Scala 3.9.0
release archive and Temurin 25.0.4+7. Planning reads bounded archive, JAR and source
data. It never launches Scala CLI, sbt, a compiler or project code.

```json
{
  "schemaVersion": 1,
  "archive": ".checktrail/scala3-3.9.0.zip",
  "sha256": "2ec08ce51e400090058ad075fff0be764c7e16fb827d299c1be0d053d425770c",
  "profile": "jvm-source-typed-backend-output-v1",
  "jvmTarget": "17",
  "warningsAsErrors": false,
  "classPath": []
}
```

The public schema is `schemas/scala-config.schema.json`. Unknown keys, compiler
options and plugins cannot be supplied by the project. `jvmTarget` is one of
`17`, `21` or `25`; the warning policy must be explicit. Dependencies are local,
relative, regular JAR files with declared SHA-256 digests. A dependency may not
contain source entries, duplicate entries, escaping names or implicit manifest
classpath dependencies. A dependency cannot extend the runtime tool inventory.

The engine extracts eight compiler/runtime libraries from exact archive members,
verifies each byte count and digest and rejects implicit manifest classpaths.
The runtime closure is declared by the pinned compiler/library/interface POMs,
excluding test dependencies. The archive includes additional Scala CLI, REPL,
documentation and other artifacts; this check neither extracts nor invokes them.
The standard library is `scala-library-3.9.0.jar`; the distribution's separate
`scala3-library_3` JAR is retained in the pinned closure. Artifact identities are
in `src/scala-artifacts.ts`. Operator acquisition is separate from validation:
the engine does not download tools or resolve dependencies.

Execution requires operator trust at CLI invocation or MCP server startup.
Compilers can execute project-controlled compile-time code. This check is not an
OS sandbox. It does not launch the compiled application or run tests. Original
acceptance fixtures verify that their application and dependency initializers
remain unexecuted; those controls do not prove that arbitrary compiler inputs
cannot execute code.

Only the selected `.scala` files participate. Java/Kotlin source mixtures and
`.sc` scripts are unavailable. Build definitions are not executed. Scala 2,
sbt/wrappers, generated sources, mixed builds, compile-time staging, macros and
inline compilation require separate profiles and remain required inventory work.
Observed native inline/staging/macro/suspension flags prevent a pass in this
profile. They do not provide a pre-execution security boundary.

The engine makes stable, source-bound copies and compiles an original collector
using only the pinned native compiler runtime. The collector records:

- Exact compiler/JDK identity and the declared compiler phase plan.
- Every selected native source's byte digest, declarations, typed-tree/type traversal and
  resolved declaration, expression and type annotations immediately after typing.
- A final phase after JVM bytecode generation, driver completion and native
  `onSourceCompiled` callbacks for each selected source, including empty files.
- Native diagnostic IDs, severity, source ranges and exact source line contents.
- Native class-generation callbacks, their source and binary names, class/TASTy
  output inventories, byte digests and declared JVM class-file versions.

An annotation can survive only in a native type, rather than an annotation tree
node. The collector inspects both. Exact `scala.annotation.nowarn`,
`scala.unchecked`, the four pinned `scala.annotation.unchecked` classes and
`java.lang.SuppressWarnings`, or unresolved annotations, prevent a pass even
when no diagnostic survives. A similarly named annotation is a valid control;
prefix matching is not used. Broader suppression and analyzer profiles remain
separate obligations.

The wrapper retains physical stdout/stderr bytes and reconciles them with the
native JSON. Unexpected console output, unknown global diagnostics, hidden
warnings, missing or repeated completion, stale sources and output disagreement
remain incomplete. Originals, copies, tools and declared dependencies are
rechecked after execution. Physical output bytes are independently inventoried
by the wrapper and compared with the collector. TASTy files must correspond to
a source-bound generated class; unbound outputs cannot pass.

A compilation containing no native declarations stays incomplete even when the
compiler processes every empty or comment-only file successfully.

Native source errors retain source-relative findings and mark `findingsComplete`
false. Warning escalation retains the native warning and exact global failure
summary. An explicit `warningsAsErrors: false` permits a complete compile with
retained warning findings. The pinned compiler rejects a UTF-8 BOM as a source
syntax error; the engine preserves that diagnostic rather than removing bytes.
CRLF and same-named nested source controls preserve native source binding.

The profile bounds selected sources, source bytes, dependencies, native
tree/type/annotation counts, diagnostics, class outputs, physical output and
total compiler runtime. The wrapper uses a 110-second subprocess deadline and
512 MiB Java heap; the shared process runner retains its separate outer bound
and owned-directory/process cleanup. Detailed receipts are operator-controlled;
ordinary CLI/MCP summaries withhold raw logs and absolute paths.

The original required profile, compiling guard controls and offline installed
package harness are `scripts/verify-required-native-tests.mjs scala`,
`scripts/verify-scala-guards.mjs` and `scripts/verify-scala-package.mjs`.
Acceptance evidence belongs in the revision-pinned measurement, not in skipped
tests. Broader JVM, platform, provenance and Gate A obligations remain open.

The pinned release and compiler API documentation are primary references:
[Scala 3.9.0 release](https://github.com/scala/scala3/releases/tag/3.9.0) and
[Scala compiler plugins](https://docs.scala-lang.org/scala3/reference/changed-features/compiler-plugins.html).
Release checksum verification does not establish publisher signature or complete
license/provenance closure. Native artifacts are operator-prepared and are not
bundled in the npm package.

The bounded Scala 3 JVM profile has source, compiling-guard and offline installed
acceptance recorded at its code revision in
[scala-native-2026-10-07.json](measurements/scala-native-2026-10-07.json). This evidence closes that
declared profile only; the remaining Scala/JVM and Gate A obligations stay open.
