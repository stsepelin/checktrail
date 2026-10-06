# Gradle build and test evidence

`jvm.gradle-test` is an opt-in Java build profile using Gradle 9.8.0, Temurin
25.0.4+7 and JUnit Platform/Jupiter 6.1.3. It covers declared conventional Java
modules and aggregators with Groovy or Kotlin DSL build/settings scripts. Kotlin
DSL does not imply Kotlin source compilation. Default JVM validation remains
`jvm.javac`. This implementation is not in the published alpha.5 package.

## Prepare and select

Discovery and planning read bounded source and pinned artifact bytes. They do not
execute build scripts, wrappers, helpers, plugins or project source. From a built
source checkout, prepare the original public fixture artifacts explicitly:

```sh
node scripts/prepare-gradle-tools.mjs
docker build --file scripts/gradle-tools.Dockerfile --tag checktrail-gradle-test:9.8.0 .checktrail/gradle-review-tools
node scripts/prepare-gradle-dependencies.mjs
```

The tool preparer bounds HTTPS redirects to the upstream distribution hosts,
checks the exact archive length and pinned SHA-256 before extraction, and verifies
every extracted file before publication. It preserves corrupt existing caches and
rejects links. The dependency preparer downloads only the fixed public fixture's
pinned Maven-layout JAR/POM closure as data. It requires an absent destination and
publishes the verified tree and manifest together. Neither command activates
execution. Publisher signatures and the full component/license closure remain
unverified. Agents use their configured foreground environment runner for native
execution. A consumer prepares and pins its own compatible closure; these scripts
are not a dependency installer for arbitrary projects.

Select the build root in `checktrail.json`:

```json
{
  "schemaVersion": 1,
  "projects": [{ "path": ".", "checks": ["jvm.gradle-test"] }]
}
```

Declare `checktrail.gradle.json` using the [published schema](../schemas/gradle-config.schema.json).
Replace the intentionally invalid digest placeholder with the preparer's result:

```json
{
  "schemaVersion": 1,
  "distribution": ".checktrail/gradle-review-tools/gradle-9.8.0",
  "repository": ".checktrail/gradle-dependencies/artifacts",
  "repositoryManifest": ".checktrail/gradle-dependencies/repository.json",
  "repositorySha256": "REPLACE_WITH_THE_REPORTED_SHA256",
  "modules": [
    {
      "path": ".",
      "kind": "java",
      "testClasses": [
        {
          "file": "src/test/java/example/CounterTest.java",
          "className": "example.CounterTest"
        }
      ],
      "supportTests": []
    }
  ]
}
```

Declare every inventoried build script and include the root. A module has exactly
one `build.gradle` or `build.gradle.kts`. There is one root settings script;
physical module paths map to Gradle project paths. Every Java module declares its
test classes and assigns all test source files exactly once. Aggregators cannot
hide Java source or native test tasks. Native declarations and class-file source
metadata bind configured classes to actual source files. Remapped project dirs,
composites, buildSrc/build-logic, wrappers, generated/nonstandard/JPMS scope and
Kotlin/Scala/Groovy source compilation need separate verified profiles.

## Run and reconcile

Execution requires CLI `--trust-project` or MCP startup `--allow-execution`.
A model tool argument cannot grant trust. Build scripts, plugins and tests run
with the process user's privileges; this is not an OS sandbox.

The engine uses a fresh source copy, output tree, user home and writable copy of
the pinned artifact repository. Original reports, build outputs and user Gradle
settings are not copied. It forces offline resolution, no daemon/configuration
cache/build cache/file watching, reruns, one worker and continue-on-failure.
Matching engine-owned JVM settings run this pinned build in the client process,
whose PID must match the native init receipt; this prevents the observed
single-use daemon escape from ordinary process-group cancellation. Protected
JVM/Gradle/shell settings cannot be supplied through project environment grants.
This does not contain deliberately detached project processes or network calls.

Original native observers record modules, source sets, task graphs, compiler
inputs and configured Test/JavaCompile objects. All declared lifecycle tasks must
participate. Exact task implementations/actions, fresh outputs, UTF-8, release,
JVM, classpaths and unfiltered test policy are reconciled. Missing, disabled,
filtered, altered, cached or omitted tasks cannot pass. The packet's artifact
closure must match the raw operator-pinned manifest, and original source/tool/
artifact bytes and temporary JAR/POM/helper bytes are rechecked after execution.

An independent original JUnit listener records discovery, dynamic registration,
class/source origins, starts and terminal outcomes. Gradle native test events and
fresh XML must agree on classes, display names, counts and outcomes. Parameterized
and dynamic tests use their native display names. Every declared test class must
be discovered; empty, skipped or aborted execution is incomplete. A compiling
source failure is distinguished from an infrastructure/bootstrap error. Confirmed
test failures remain failed if another module cannot complete, with incomplete
accounting retained. Summary CLI/MCP output omits raw source, paths and process logs.

## Acceptance and limits

The required `gradle` native profile exercises original broken/fixed controls,
scale boundaries, task bypasses, stale original reports, compiler/bootstrap
errors, wrong source declarations, dynamic/parameterized/disabled/empty tests,
artifact/native receipt corruption, multi-module accounting, Kotlin DSL,
operator-only trust, summary privacy, negotiated CLI/MCP behavior and reached-test
cancellation cleanup. `verify-gradle-container.mjs` requires source, preserved
Java and fresh offline installed-package profiles. A configured CI job is not
hosted CI evidence. Current local receipt and mutation evidence are recorded in
`measurements/gradle-native-2026-10-05.json` after acceptance completes.

The required-test harness allows at most 300 seconds per test file because each
file performs several fresh Gradle validations. Failure records retain a bounded
native failure type, code and message so a failed file can be distinguished from
missing required callbacks. Skipped, failed or unfinished controls remain
incomplete. This acceptance deadline does not change engine command limits.

The implementation bounds source inputs, manifests, captured records, reports,
console buffers and command wall/output admission. These are not a complete
aggregate raw-output/archive budget or a hermetic identity. Wider platforms,
wrappers, analyzers, JVM languages, native provenance and performance remain
required. This profile does not close Gate A or demonstrate reviewer quality.

The [official daemon documentation](https://docs.gradle.org/current/userguide/gradle_daemon.html)
describes the single-use daemon behavior when JVM settings differ. The
[TestDescriptor API](https://docs.gradle.org/current/javadoc/org/gradle/api/tasks/testing/TestDescriptor.html)
distinguishes internal and display names. Both behaviors were checked against
the pinned distribution before their native acceptance assertions were added.

Distribution preparation retries request failures from the pinned origin at most
three times under one 120-second abort signal. Each attempt permits at most five
HTTP hops, cancels rejected response bodies and preserves the exact HTTPS host
and distribution/release-path boundaries. A final unexpected response reports
its numeric HTTP status and host without logging signed redirect queries. The
archive's exact byte count, SHA-256 and every extracted-file digest still gate
installation; retries cannot accept different bytes. Preparation is setup, not
native acceptance.

The first observed new-head Gradle CI failure stopped on an unexpected HTTP
status, before archive verification or native tests. Its original assertion did
not retain that status, so its cause is not established. Subsequent live requests
to the official pinned distribution reached HTTP 200 with the declared content
length. Original controls now exercise request failure/recovery, exhausted
attempts and redirects, abort, rejected hosts/paths/credentials and a direct valid
response. This does not claim that all remote failures are temporary.

The [dated preparation repair](measurements/gradle-ci-preparation-2026-10-06.json)
records the fresh pinned download, original request controls and preserved native
source/installed profiles. Hosted acceptance of the repaired head remains pending.
