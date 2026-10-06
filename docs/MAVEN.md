# Maven build and test evidence

`jvm.maven-test` is an opt-in Java reactor profile. It runs Apache Maven 3.10.0
under the verified Temurin 25.0.4+7 JVM, with Resources 3.5.0, Compiler 3.16.0,
Surefire 3.6.0 and JUnit Platform/Jupiter 6.1.3. The default JVM check remains
`jvm.javac`; Checkstyle has its separate profile in [CHECKSTYLE.md](CHECKSTYLE.md).
This implementation is not in the published alpha.5 package.

## Preparation and selection

Discovery and planning read bounded data and pinned artifact bytes. They do not
invoke Maven, wrappers, plugins, Java source helpers or project code. Prepare the
local distribution and dependency cache explicitly before selecting execution.
The engine never installs or downloads them.

From a built source checkout, the original public fixture can prepare acceptance
artifacts with:

```sh
node scripts/prepare-maven-tools.mjs
docker build --file scripts/maven-tools.Dockerfile --tag checktrail-maven-test:3.10.0 .checktrail/maven-review-tools
node scripts/prepare-maven-dependencies.mjs
```

The first command downloads only the exact Apache distribution, checks its pinned
SHA-256 and verifies every extracted file before publication. It preserves a
corrupt existing cache and rejects links. The dependency preparer executes the
original `examples/maven` fixture with network access and strict Maven checksums.
It requires an absent dependency-cache destination and publishes the verified
artifact tree and manifest together. Its reported `repositorySha256` pins that
particular acquisition; metadata can differ between preparations. The operator preparer retries only a failed Central artifact acquisition reporting HTTP 429, for at most three attempts with 5- and 15-second waits. Each retry recreates the private artifact tree; test/compiler failures, checksum errors, signals and timeouts remain failures. The receipt records the actual acquisition attempt count. Publisher
signatures and the complete component/license closure have not been verified.

These are operator preparation commands, not engine actions. Agents use the shared
foreground environment runner required by their local instructions. A consumer
prepares its own compatible, pinned dependency closure inside its configured root;
this fixture cache is not a dependency installer for arbitrary projects.

Select the reactor root in `checktrail.json`:

```json
{
  "schemaVersion": 1,
  "projects": [{ "path": ".", "checks": ["jvm.maven-test"] }]
}
```

An example `checktrail.maven.json` follows. Replace the manifest digest with the
value from the preparer; the placeholder is intentionally not valid configuration.

```json
{
  "schemaVersion": 1,
  "distribution": ".checktrail/maven-review-tools/apache-maven-3.10.0",
  "repository": ".checktrail/maven-dependencies/artifacts",
  "repositoryManifest": ".checktrail/maven-dependencies/repository.json",
  "repositorySha256": "REPLACE_WITH_THE_REPORTED_SHA256",
  "modules": [
    {
      "path": ".",
      "packaging": "jar",
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

Declare every inventoried POM, including the root and aggregator modules. Paths
and test-source assignments are exact; each executable module needs test classes,
and every test Java source needs a test-class or support role. Aggregators cannot
hide Java inputs. The selected check covers the whole declared reactor, including
nested projects. Java sources use the conventional main/test roots; generated,
JPMS, nonstandard and mixed-language scopes need additional verified profiles.
Configuration and dependency manifests have published JSON Schemas.

## Execution and evidence

Execution requires `--trust-project` or MCP startup `--allow-execution`. Tool
arguments cannot grant it. Maven plugins, processors and tests are trusted project
execution; this is not an OS sandbox.

The runner creates an owned fresh source copy, output tree, user home and writable
copy of the pinned artifact cache. It uses empty user/global settings, skips Maven
startup rc files, clears protected Maven/JVM/shell overrides, selects offline
resolution and fails at the end of the reactor. Original build outputs, test
reports and user settings are not copied. Source bytes and original tool/cache
pins are verified before and after; dependency JAR/POM bytes in the temporary
repository must also retain their pins. These checks do not contain hostile
transient filesystem changes, detached processes or plugin network activity.

Original native collectors observe the reactor lifecycle and configured plugin
objects. The admitted lifecycle has exactly the resources, compile,
test-resources, test-compile and test goals with their pinned plugin versions.
Compiler roots, fresh native input lists, output paths, UTF-8, javac selection,
filters, skips and compiler arguments must reconcile. Resolved classpaths must
remain in the declared reactor outputs or the exact JAR set from the pinned
repository manifest. Internal packet version 2 retains the raw manifest bytes,
binds their digest to configuration and rejects invented, omitted or duplicate
JAR paths. The native observer also binds Maven home and its process ID to the
configured distribution and the runner's observed client PID. These identity
checks do not attest hostile project-generated packets or establish containment.

A service-loaded JUnit listener records discovery, dynamic registration, starts,
skips, terminal outcomes and plan completion. Test classes must originate in the
fresh test output, match class-file source metadata and bind to native parsed
source declarations. The launcher and engine must originate in the pinned 6.1.3
artifacts. Additional test classpath is limited to the owned observer. Filters,
engine selections, provider properties, retries, early failure skips and hidden
XML reports cannot establish this profile's completeness.

Fresh Surefire XML counters and cases must agree with native terminal counts.
Empty or entirely skipped execution cannot pass. Skipped/aborted tests remain
incomplete; compiler failures do not claim complete analysis or test execution.
A confirmed test failure stays failed when another dependent module is unrun,
with incomplete participation retained. Malformed, foreign, duplicate, stale,
truncated, missing and contradictory evidence cannot pass. Test counts are
validation evidence, not a new source-defect allegation.

Normal CLI/MCP summaries omit source paths, raw reports and assertion messages.
Detailed output is an explicit operator choice. Cancellation uses the existing
POSIX process group and owned temporary directory lifecycle. This does not verify
Windows process behavior, crash recovery or malicious descendant containment.

## Acceptance and remaining work

The exact `maven` profile in `scripts/required-native-tests.json` identifies the
original native, planning, integrity, reactor, protocol and cancellation controls.
Installed-package acceptance re-runs those controls with the official SDK client
outside the shipped production package. The local record is
[the initial source-bound measurement](measurements/maven-native-2026-10-05.json).
[The manifest-closure record](measurements/maven-closure-2026-10-06.json) binds
the repaired parser, native/installed controls and compiling guard mutations at
the later measured revision. Earlier receipts remain historical evidence.
The separate configured hosted job has not been run at this revision.

The controls include broken/repaired assertions, boundary inputs, missing test
classes, real source-binding counterexamples, independent and dependent reactor
failures, disabled/empty tests, parameterized and dynamic cases, protected startup
state, invalid native packets and observed running-test cancellation. They do not
establish every JUnit extension, inheritance, nested class, class loader, compiler
option, framework guard or language behavior.

E11 remains partial. Maven wrappers and wider Maven/Gradle profiles, generated
and JPMS scope, explicit Kotlin/Scala, SpotBugs and detekt remain required.
Broader native/runtime/client/platform profiles, full provenance, host isolation,
representative performance and the other reviewer tasks remain open. Gate A is
open; no inference, field trial or comparative-quality gate is established here.

Primary contracts: [Apache Maven 3.10.0](https://maven.apache.org/ref/3.10.0/),
[Compiler Plugin](https://maven.apache.org/plugins/maven-compiler-plugin/),
[Surefire parameters](https://maven.apache.org/surefire/maven-surefire-plugin/test-mojo.html),
[JUnit 6.1.3](https://docs.junit.org/6.1.3/overview.html) and
[JDK class-file attributes](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/classfile/Attributes.html).
The collectors were checked against the actual pinned distribution/plugin APIs;
website versions alone are not acceptance evidence.
