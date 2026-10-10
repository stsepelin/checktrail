# Selected JVM analyzer extensions

The shared `jvm.spotbugs` and `jvm.detekt` checks accept two opt-in declarations
for current Java class cohorts and full Kotlin type analysis. Planning reads
configuration, source scope and pinned artifact bytes without executing project
code. Execution requires operator trust supplied by the CLI or MCP server startup;
a tool argument cannot grant it. Generators and custom detector plugins execute
trusted project code. These checks are not an OS sandbox.

## Full Kotlin type analysis

Select `jvm.detekt` in `checktrail.json` and declare this inventoried
`checktrail.detekt.json` after explicitly preparing the detekt and Kotlin archives:

```json
{
  "schemaVersion": 1,
  "jar": ".checktrail/detekt-cli-2.0.0-alpha.6-all.jar",
  "sha256": "d46ca62ea4d62769b5d5c3ba94d49fa9b80ba11c7dba74ddb6df7fcc2c19c5fd",
  "profile": "core-default-full-all-selected-v1",
  "types": {
    "profile": "linux-arm64-full-types-v1",
    "kotlinArchive": ".checktrail/kotlin-compiler-2.4.10.zip",
    "kotlinSha256": "473dd66c7a3ef4b182065b3da670466c1bf2773a9dbb0ed8b33a39fe9d4f876d",
    "jvmTarget": "17",
    "classPath": []
  }
}
```

The selected runtime is Temurin 25.0.4+7 on Linux ARM64, with detekt
2.0.0-alpha.6 and Kotlin 2.4.10. Configuration accepts JVM targets 17, 21 and 25;
the native acceptance recorded here exercises target 17. Dependency JARs use the
baseline Kotlin declaration's explicit path/SHA-256 pairs. Scripts require a
separate profile; full analysis accepts selected `.kt` sources only. Preparation
and copying into the project are explicit operations; validation does not download
or resolve dependencies.

The original observer uses native full analysis, rather than promoting light
rules to typed results. It retains resolved source symbols and annotations, SDK
module roots, compiler diagnostics, rule implementations, loaded rule origins and
type-dependent rule markers. Selected sources and compiler diagnostics must agree
with current physical bytes and locations. The collector checks physical project
configuration bytes as well as parsed policy, including after execution. Resolved
`kotlin.Suppress` aliases cannot turn an active-rule suppression into a complete
pass; lookalike annotations are separate near misses.

A native compiler error is a failed check with incomplete analysis. A verified
rule finding fails a complete analysis; a clean complete run passes. Missing type
roots, source symbols, rule identity, compiler participation or raw output remains
inconclusive. The pinned native deprecation warning is accepted only with its
exact staged analyzer URL. The [light profile](DETEKT.md) remains separately
available with its existing declaration.

## Java class cohorts and SpotBugs plugins

Select `jvm.spotbugs`, retain an inventoried [Java compiler declaration](JAVA.md),
and use `core-default-max-class-scopes-plugins-v1` in `checktrail.spotbugs.json`.
The archive and checksum stay those in [the baseline profile](SPOTBUGS.md).
Add an `extensions` object such as:

```json
{
  "profile": "linux-arm64-class-scopes-plugins-v1",
  "stages": [
    {
      "id": "library",
      "path": "library",
      "analyze": false,
      "sources": ["library/src/main/java/provider/Library.java"],
      "dependsOn": []
    },
    {
      "id": "application",
      "path": "application",
      "analyze": true,
      "sources": ["application/src/main/java/demo/Application.java"],
      "dependsOn": ["library"]
    }
  ],
  "generators": [],
  "jpms": [],
  "plugins": []
}
```

Every inventoried Java source needs exactly one cohort or original-generator
role. Cohorts compile in declared order against fresh earlier dependencies.
`analyze: false` supplies library classes without claiming they are selected
application classes. At least one cohort must be selected for analysis. Native
class identities, nested siblings, compiler `SourceFile` origins, output byte
counts and post-compilation hashes are reconciled. Auxiliary classes can appear
in the first dependency pass; reporting passes must contain exactly the selected
application classes. Missing classes, skipped methods, incomplete passes and an
empty selected application scope cannot pass.

Generators use the [JVM wrapper generator contract](JVM-WRAPPERS.md): an
inventoried original Java main emits exactly declared fresh conventional Java
source paths into owned storage. Generated findings cite the original generator
file and describe the generated relative source location. JPMS declarations use
conventional `src/main/java/module-info.java` paths and explicit module names,
requires and exports. Native descriptors must match the declared fresh cohort
graph. All cohorts are named or all are unnamed. Named cohorts require release 9
or newer; external module JARs need a separate profile. `package-info.java`, mixed
Kotlin/Scala cohorts and non-ASCII binary class names are unsupported here.

Each optional plugin declares a local JAR path and SHA-256, exact plugin ID,
detector class/report sets and bug pattern type/abbreviation/category sets. See the
[original synthetic plugin fixture](../test/spotbugs-extensions-fixture.ts) for a
complete declaration. Planning parses bounded ZIP and XML data without loading
classes. It rejects undeclared metadata, duplicate providers, source-bearing or
nested archives, services, native payloads, multi-release entries and implicit
manifest classpaths. Native execution observes actual loaded detector code
origins and pattern providers, including built-in detectors. This validates the
declared identity and participation; a custom detector's reported claim still
needs independent review.

The version probe returns before running declared generators or custom detectors.
Compilation disables annotation processors and implicit source compilation.
Ordinary summaries withhold raw paths and findings. Detailed local evidence
retains bounded raw native invocations and source-bound diagnostics. Cancellation,
deadline and output exhaustion remain incomplete outcomes and remove owned
processes and temporary artifacts. Original project build outputs are preserved.

## Required acceptance and remaining scope

The required `jvm-analyzer-extensions` inventory contains nine named callbacks:
broken, paired repair, valid near miss, prerequisite, stale, empty, privacy,
lifecycle and fresh installation. Lifecycle controls reach actual generator and
full-analysis JVMs before checking cancellation, timeout and output exhaustion.
The full container controller additionally runs the preserved Java, SpotBugs and
light-detekt callbacks, native regressions and compiling guard removals with
unchanged assertions and restored originals.

```sh
npm run build
node scripts/prepare-detekt-tools.mjs
node scripts/prepare-spotbugs-tools.mjs
node scripts/prepare-kotlin-tools.mjs
node scripts/prepare-jvm-analyzer-tools.mjs
node scripts/prepare-package-cache.mjs
docker build --file scripts/jvm-analyzer-tools.Dockerfile \
  --tag checktrail-jvm-analyzer-test:local .checktrail/jvm-analyzer-tools
CHECKTRAIL_JVM_ANALYZER_EXTENSIONS_IMAGE=checktrail-jvm-analyzer-test:local \
  node scripts/verify-jvm-analyzer-extensions-container.mjs
```

Agents use the shared managed runner. CI runs this controller as a non-root user
with no network, a read-only source/cache mount and bounded resources. Fresh
installation uses locked production dependencies offline without lifecycle scripts,
with its test harness outside the installed package.

The [local measurement](measurements/jvm-analyzer-extensions-2026-10-10.json)
records the exact runtime, source and installed ledgers, guard controls and project
check. It does not establish other runtime/platform acceptance, whole archive,
publisher or license closure, cryptographic attestation, reviewer accuracy or
confidence calibration. Remaining profiles and freeze decisions keep Gate A open.
No AI inference or real-project field evaluation is invoked.
