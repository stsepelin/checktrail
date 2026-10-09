# Selected mixed, generated and script Kotlin compilation

`jvm.kotlin` accepts the opt-in `linux-arm64-mixed-generated-script-v1`
extension declaration through the shared library, CLI and MCP engine. It compiles
one bounded cohort of inventoried Java/Kotlin sources, fresh declared generated
Kotlin primary classes and application `.kts` files. Scripts are compiler inputs;
this check does not execute their bodies or report script results. Running a
script remains a separate operator-trusted check.

Add `extensions` to the [baseline Kotlin declaration](KOTLIN.md):

```json
{
  "profile": "linux-arm64-mixed-generated-script-v1",
  "javaSources": ["producer/JavaProducer.java"],
  "scripts": ["scripts/Compile only.kts"],
  "generators": [
    {
      "source": "generators/BuildKotlinGenerator.java",
      "className": "BuildKotlinGenerator",
      "outputs": [
        {
          "file": "src/main/kotlin/policy/Rules.kt",
          "className": "policy.Rules"
        },
        {
          "file": "src/main/kotlin/policy/GeneratedMarker.kt",
          "className": "policy.GeneratedMarker"
        }
      ]
    }
  ]
}
```

Declare every inventoried Java input exactly once as a main source or generator,
and every application script exactly once. Ordinary `.kt` inputs are inventoried.
Gradle build/settings scripts stay outside the application cohort. Generated paths
must be fresh conventional primary-class paths, disjoint from original sources
and other outputs. Source-only, script-only and generated-only cohorts are also
supported. Scala, JPMS Java descriptors, additional compiler plugins and arbitrary
script execution options are unavailable under this declaration.

Planning reads declarations, source scope, the pinned compiler archive and local
JARs. It checks the selected Linux ARM64 Java, javac, jar and JDK module bytes
without launching them. Execution requires operator trust; MCP arguments cannot
grant it. The version probe compiles only the original observers and returns
before running generators. A declared generator is trusted project execution:
its main method receives an owned output directory and must emit exactly the
listed files. The engine validates the complete output set and bounded UTF-8
bytes before staging them. Original caller build output is preserved.

The compiler/runtime is Kotlin 2.4.10 with Temurin 25.0.4+7. The baseline six
compiler/runtime JARs and four selected scripting JARs are extracted from the
same byte-pinned archive; their identities are in `kotlin-artifacts.ts` and
`kotlin-extension-artifacts.ts`. Manifest classpaths and declared dependency JARs
retain the baseline closure checks. Validation performs no downloads or dependency
resolution. These selected pins do not establish whole-distribution publisher,
dependency or license closure.

Kotlin resolves the cohort's Java symbols while its original observer accounts
for every Kotlin/script FIR source, resolved annotations, complete IR files and
fresh class/output bindings. A separate native Java compiler task then compiles
the declared Java bodies against those fresh Kotlin classes, with annotation
processing and implicit source lookup disabled. Parsing, analyzed declarations,
resolved suppressions, diagnostics and physical class metadata must reconcile.
A Java body that resolves from Kotlin can still fail this second compilation.
Both compilers retain JVM target 17, 21 or 25 and the declared warning policy.

Every declared generated primary class additionally needs a native ClassFile
witness for its qualified name and `SourceFile` origin, matching the fresh Kotlin
output's physical bytes and digest. Missing, extra, stale, malformed, suppressed,
truncated or incomplete evidence cannot pass. Current original source, compiler
declaration, compiler archive and dependency bytes are checked when reconciling
receipts. Original and staged inputs are checked again after execution. Staged compiler/dependency libraries, original observer classes and its plugin are byte-checked after generators finish and after native compilation. Generated
compiler findings identify the original generator, with the generated path and
native line in their message; the engine does not invent a line in generator code.

Child streams are forwarded live and retained with raw byte counts and hashes.
The outer mirrored stream must match the captured invocations, while the baseline
Kotlin evidence parser still validates its native record and exact pinned runtime
warnings. Successful collection and compiler success are separate claims.
Compilation errors retain actionable source findings with incomplete overall
compiler coverage.

The [local record](measurements/kotlin-extensions-2026-10-10.json) binds preserved
native callbacks, the nine required source cases and the same cases against a
fresh offline production installation, compiling evidence controls, native
regressions and the project check. The source cases reach cancellation, timeout
and output exhaustion after both a Java generator and its detached child start;
their process identities and owned temporary cleanup are asserted. The independent
`kotlin-extensions-arm64` CI job runs the same controller. Optional host skips are
separate from required native results.

This selected cohort does not establish Gradle project compilation, incremental
builds, Kotlin multiplatform, annotation processors, arbitrary script definitions,
framework behavior, application runtime correctness, review quality or Gate A
completion. Wider tool/artifact closures and the final platform matrix remain
required. No inference or real-project field evaluation is invoked.
