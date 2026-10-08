# Kotlin JVM source compilation

The opt-in `jvm.kotlin` check uses the shared engine through the library, CLI and
MCP. Prepare `checktrail.kotlin.json` and explicitly select this check in project
policy. Discovery/planning inspect data only and do not run Java, project code,
Maven, Gradle, scripts or plugins. Execution still requires operator trust and is
not an OS sandbox.

```json
{
  "schemaVersion": 1,
  "archive": ".checktrail/kotlin.zip",
  "sha256": "473dd66c7a3ef4b182065b3da670466c1bf2773a9dbb0ed8b33a39fe9d4f876d",
  "profile": "jvm-source-frontend-ir-output-v1",
  "jvmTarget": "17",
  "warningsAsErrors": true,
  "classPath": []
}
```

The original preparation script acquires the exact Kotlin compiler 2.4.10 ZIP
from the [official release](https://github.com/JetBrains/kotlin/releases/tag/v2.4.10),
with bounded HTTPS redirects, bytes and SHA-256. Consumers prepare the local
archive themselves; validation never downloads it. Its release digest is an
integrity pin, not a verified publisher signature. The distribution's SPDX and
third-party license material do not establish a complete audited license closure.
The public package ships the original wrapper and observer, not compiler binaries.

The pinned Temurin 25.0.4+7 runtime and six compiler/runtime JAR identities are in
`src/kotlin-artifacts.ts`. Planning extracts only those exact byte-verified
libraries and inspects their manifest dependency closure. Compiler `Class-Path`
includes the script-runtime library; it must be present even though scripting is
disabled. The compiler's application classpath contains its pinned standard
library/annotations plus declared local dependency JARs. Dependencies need exact
SHA-256 pins, regular files, no symbolic-link traversal and bounded total bytes.
Source-bearing JARs, undeclared manifest classpaths, duplicate dependencies and
unsupported ZIP profiles are unavailable. No dependency resolution occurs.

Only inventoried `.kt` sources participate. Application `.kts` files and mixed
Java/Scala source require separate profiles. Gradle build/settings scripts are
not application compiler inputs and are not executed. The fixed profile uses
language/API 2.4, JVM target 17, 21 or 25, no default scripting, no project plugins,
one backend thread and fresh owned output. Annotation processing is disabled
while compiling the original observer. Project application initializers and
scripts are not invoked by this profile.

Before compilation, the engine copies bounded selected physical bytes, libraries
and declared dependencies into owned temporary storage. Original FIR declaration,
expression and type checkers record resolved annotation identities and native
source reads. Exact `kotlin.Suppress`, `java.lang.SuppressWarnings` or unknown
annotation identities prevent a passing result, even when no diagnostic survives.
Import/type aliases resolve natively; names such as `SuppressAdditional` do not
match that set. Repeated type-reference observations are retained. The native
source digest accounts for the compiler's observed UTF-8 BOM stripping while
keeping physical source identity and CRLF bytes separate.

A passing compilation additionally requires every selected source's native FIR
participation, one complete IR module with exactly those files, native output/source
bindings and a separate physical output inventory with matching bytes/digests.
Generated class headers must match the declared JVM target. The native compiler
announces output before writing it; byte checks run after compilation returns.
The source view, original inputs and snapshot bytes are rechecked before return.
Class output is discarded; it is not a persisted build artifact or app test.

All structured messages and physical stdout/stderr remain retained. The exact
observed pinned JVM `invokeCleaner` warning is accounted; unknown raw diagnostics,
truncation, byte disagreement, unavailable toolchains, errors and partial receipt
shapes cannot become passes. Source diagnostics retain native line/column and
line content; public findings carry the existing relative file/line contract.
Compiler error termination retains findings with `findingsComplete=false`: it
does not establish that every source completed semantic processing. Successful
compilation with `warningsAsErrors=false` can retain warning findings; the declared
warning policy determines the outcome.

Source/native controls, required terminal accounting, compiling guard mutations
with unchanged callbacks and offline installed-package acceptance are defined in
`test/kotlin*.test.ts`, `scripts/required-native-tests.json` and
`scripts/verify-kotlin-{container,guards,package}.mjs`. The independent CI job does
not depend on the other tool jobs. Optional local native skips are separate from
required-profile evidence. The [measured record](measurements/kotlin-native-2026-10-07.json) binds exact source, guard and installed-package evidence. The recorded native environment is Linux ARM64 with
Node 22.23.2; additional hosted/platform profiles remain separately required.

This profile does not establish whole-project Kotlin correctness, mixed/generated
compilation, scripts, build plugins, reflection/dynamic dispatch, framework behavior,
Scala support, review quality or Gate A completion. Detekt light rules remain a
separate check.

The compiler-guard harness reuses a passing positive control only for identical source and original callback bytes, verifies restoration after every mutant and runs a final fresh positive control. Every compiling mutant still executes the unchanged original callback and must fail its named evidence assertion. The source and installed compiler checks remain separate. [kotlin-guard-execution-2026-10-08.json](measurements/kotlin-guard-execution-2026-10-08.json) records the exact invocation accounting and native runtime; it does not compare performance across different runtimes or close broader Kotlin/Gate A scope.
