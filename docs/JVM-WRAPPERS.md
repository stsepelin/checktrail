# Offline JVM wrappers, generated Java and JPMS

The opt-in `linux-arm64-wrappers-v1` extension adds verified offline wrappers to
`jvm.maven-test` and `jvm.gradle-test`. It selects Maven 3.10.0, Maven Wrapper
3.3.4, Gradle 9.8.0, Temurin 25.0.4+7 and the existing pinned JUnit 6.1.3 profile.
The default conventional Java profiles remain separately tested. This source
implementation is not part of the published alpha.5 package.

## Preparation and configuration

Prepare the distributions and public fixture dependencies described in
[MAVEN.md](MAVEN.md) and [GRADLE.md](GRADLE.md), then build the native image and
prepare the wrapper artifacts from a built source checkout:

```sh
docker build --network none --file scripts/jvm-extension-tools.Dockerfile --tag checktrail-jvm-wrappers:local .
CHECKTRAIL_JVM_WRAPPERS_IMAGE=checktrail-jvm-wrappers:local node scripts/prepare-jvm-wrappers.mjs
```

These are explicit operator setup commands. Agents use their configured managed
foreground task. The preparer checks all four archive identities, verifies the
three Maven detached signatures against pinned public key bytes, extracts the
selected Maven templates and runs the pinned Gradle wrapper-generation task.
All eight launcher/JAR/property artifacts must match their literal byte pins
before the complete cache is published. Existing caches are reverified, and a
corrupt cache is preserved and rejected. `--source` permits reproducing setup
from an already verified public artifact cache without downloading again.
Cryptographic signature verification does not establish key-owner trust or a
complete publisher/license audit. Gradle signature verification is not claimed.

Add `extensions` to the existing Maven or Gradle configuration. For example,
the Maven producer module can declare:

```json
{
  "profile": "linux-arm64-wrappers-v1",
  "archive": ".checktrail/apache-maven-3.10.0-bin.zip",
  "generators": [
    {
      "module": "policy",
      "source": "generators/BuildJavaGenerator.java",
      "className": "gen.BuildJavaGenerator",
      "outputs": [
        {
          "file": "src/main/java/policy/Rules.java",
          "className": "policy.Rules"
        }
      ]
    }
  ],
  "jpms": [
    {
      "module": "policy",
      "name": "original.policy",
      "requires": [],
      "exports": ["policy"]
    },
    {
      "module": "consumer",
      "name": "original.consumer",
      "requires": ["original.policy"],
      "exports": ["consumer"]
    }
  ]
}
```

For Gradle, select `.checktrail/gradle-9.8.0-bin.zip`. Copy that build system's
four exact wrapper artifacts from the prepared `wrapper-artifacts` tree into the
project. The original wrapper properties and archive must retain their pinned
bytes. Declare each inventoried generator exactly once; each output is a fresh
conventional Java class source in its selected executable module. Declare every
main `module-info.java`, including the module name, direct requirements and
unqualified exports. `java.base` is implicit. Test descriptors, open/automatic
modules, services, qualified exports and requirement modifiers are not admitted.

Discovery and planning inspect bounded data and artifact bytes. They execute no
wrapper, generator, build configuration or project source. Running still requires
operator CLI `--trust-project` or server startup `--allow-execution`; an MCP tool
argument cannot grant it. Project execution has the process user's privileges.

## Native execution and evidence

Each selected wrapper bootstraps its pinned local ZIP into a fresh owned cache.
Only the staged properties' distribution URL changes, to the verified local
`file:` URI; both original and derived hashes are retained. Every extracted
Maven/Gradle distribution file is verified before and after the build. The four
selected JDK artifacts (`java`, `javac`, `jar`, `lib/modules`) are also verified
before and after. This is a selected artifact identity, not whole-JDK or system
closure.

Generators are compiled and run natively into owned output directories. Every
output's path, size and digest is validated before copying the generator's
outputs into the fresh source tree. Native compiler/source-set observations must
include every declared generated source. The selected primary generated class
files are parsed natively for class identity and `SourceFile`; compiled JPMS
files are read with `ModuleDescriptor` and compared to the declaration. Generated
source bytes remain bound after tests complete. Additional nested or anonymous
classes are not a complete emitted-class inventory.

Existing native JUnit discovery, execution and fresh XML reconciliation still
apply to both producer and consumer. A failed test remains failed; missing,
empty, entirely skipped, stale, malformed or truncated evidence cannot pass.
Gradle wrapper execution records an observed process ancestry reaching the owned
launcher; the conventional direct-launch profile retains its exact client PID
contract. Child output is forwarded live into the engine's admission budget.

Normal library, CLI and MCP summaries omit physical paths, source names, assertion
messages and raw native output. Detailed output is an operator choice. Cancellation,
wall deadlines and output exhaustion account for reached generator descendants
and remove owned temporary artifacts while preserving caller-owned build data.
These checks do not establish hostile project containment, Windows behavior or
crash recovery.

## Acceptance and limits

The required `jvm-wrappers` callback names are recorded in
`scripts/required-native-tests.json`. The controller runs the preserved Java,
Maven and Gradle callbacks; all nine source cases; the same cases from a fresh
offline production installation; compiling guard controls using actual native
receipts; and native byte, post-build, live-output and schema regressions.

The original two-module fixture exposes an identifier-boundary defect through
the consumer, repairs it with an exact or delimiter-bound match, and retains
valid adjacent values. Its native generator emits two classes used by the
application, so output completeness is tested beyond a single generated file.
A consistent omission control must fail the output-accounting guard even when
all remaining class and compiler observations agree.

The [source-bound local record](measurements/jvm-wrappers-2026-10-09.json) binds
these required source, installed, baseline, mutation and regression results.
Optional native checks unavailable on the host remain explicit skips in the
mandatory project check; they are not counted as native profile acceptance.

Other platforms, mixed Kotlin/Scala, wider build layouts and analyzers, complete
dependency/license closure and final Gate A matrix bindings remain required.
This profile does not establish inference, field evaluation or comparative
reviewer quality.
