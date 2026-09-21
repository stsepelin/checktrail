# Java compilation

`jvm.javac` compiles all inventoried `.java` files in a Maven/Gradle-discovered
project as one classpath compilation. It requires a prepared full Temurin JDK
25.0.4+7 and an explicit project-root `checktrail.java.json`:

```json
{
  "schemaVersion": 1,
  "release": 21,
  "warningsAsErrors": true,
  "classPath": []
}
```

The supported release range is 8–25. The compiler uses UTF-8, all lint warnings,
disabled annotation processing and no implicit source compilation. No Maven,
Gradle, wrapper, dependency resolver or application test is run. Project trust
is still required. The source and JAR parsers are native tools with the process
user's privileges; this is not a sandbox.

Dependencies are optional explicit `{ "path": "…jar", "sha256": "…" }` entries.
Paths resolve from the project and must stay inside the operator root without
symlink traversal. Hashes cover exact file bytes and are verified during planning,
before compilation and afterwards. Prepared JARs may live in the excluded
`.checktrail/` directory. They are limited to 128 entries, 32 MiB per JAR and
128 MiB total. Duplicate paths, checksum mismatches, manifest `Class-Path`
attributes and source-bearing JARs cannot produce a pass. Hashes establish byte
identity, not publisher trust or a complete dependency provenance audit.

Compiler options cannot be supplied through this configuration. `CLASSPATH`,
`JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS` and `_JAVA_OPTIONS` are protected and
removed before invoking Java; PATH is fixed during planning. The owned compiler
helper runs in a fresh temporary directory. Its file manager discards generated
class bytes with a 32 MiB limit, so it writes no class files into the project.
Native output is bounded to 1 MiB, diagnostics to 2,000 entries, the JVM heap to
256 MiB and the prepared invocation to 100 KiB. Shared engine time and process
group limits also apply; the heap bound is not a total process-memory bound.

## Evidence and scope

Structured diagnostics retain compiler codes, severity, messages and inventoried
source locations. Native task events must account for each source parsed exactly
once and every declared top-level type analyzed. Empty files and package metadata
are valid near misses. Exactly one completed compilation event and no extra
unparsed compiler output are required. Errors fail the check with incomplete
findings; malformed or missing evidence cannot pass. Warnings remain visible and
`warningsAsErrors` selects whether the compiler rejects them.

The implementation uses the JDK [JavaCompiler API](https://docs.oracle.com/en/java/javase/25/docs/api/java.compiler/javax/tools/JavaCompiler.html)
and [completed task events](https://docs.oracle.com/en/java/javase/25/docs/api/jdk.compiler/com/sun/source/util/TaskListener.html).
The evidence establishes compilation under the declared settings. It does not
establish that these settings equal a Maven/Gradle build, that omitted generated
code is current, or that runtime behavior, packaging or tests work.

Mixed Kotlin/Scala source, application `.kts` scripts and `module-info.java` are
unavailable in this profile. Gradle build/settings `.kts` manifests are permitted
as inert discovery files. JPMS, multi-module compilation, annotation processing,
generated-source preparation, build plugins, framework semantics and JVM test
runners remain separate work. Excluded source is not automatically discovered by
the compiler; projects needing it must prepare an inventoried source or a pinned
compiled dependency.

## Reproduce native verification

```sh
npm run build
docker build --file scripts/java-tools.Dockerfile --tag checktrail-java-test:25.0.4 scripts
node scripts/verify-java-container.mjs
```

The helper requires the prepared image, verifies the native compiler, then runs
synthetic broken/fixed/near-miss cases with the network disabled. It also installs
a fresh package offline and exercises its library, CLI and MCP against the public
Java example. The host npm cache must contain the locked production dependencies.
The Dockerfile pins the multi-platform base image manifests. Local evidence is
arm64 Linux; the separate hosted amd64 job passed at `52ba415` (see `NATIVE-CI.md`).
Host macOS without a JDK
reports the native cases as skipped, not verified.
