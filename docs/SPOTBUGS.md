# SpotBugs native profile

The opt-in `jvm.spotbugs` check compiles selected current Java sources and runs
SpotBugs 4.10.4 using its built-in default defect detectors at maximum effort. The native annotation
suppression collector is excluded from the fixed detector assembly. The shared
engine supplies CLI and MCP results. Discovery and planning read files and verify
checksums; they do not run Java, Maven, Gradle or project code. Execution requires
operator trust. Analysis is not an OS sandbox.

Prepare the pinned tool explicitly, then copy its archive into the selected
project's `.checktrail` directory. Discovery never downloads it:

```sh
npm run build
node scripts/prepare-spotbugs-tools.mjs
```

Select `jvm.spotbugs` in the project's `checktrail.json` check list. Prepare
`checktrail.java.json` with the declared compilation release, warning policy and
SHA-256-pinned local dependency JARs. The analyzer also requires this inventoried
`checktrail.spotbugs.json`:

```json
{
  "schemaVersion": 1,
  "archive": ".checktrail/spotbugs-4.10.4.tgz",
  "sha256": "72bc0d4edd686e462c0f71f42a049b27bf4da6708797ff7b2b56dd202714b4e5",
  "profile": "core-default-max-v1"
}
```

The [official release](https://github.com/spotbugs/spotbugs/releases/tag/4.10.4)
publishes that archive checksum. The preparer checks its exact size and digest
before publishing one complete archive through a no-overwrite hard link. It
rejects linked cache targets and verifies concurrent publication. Publisher PGP
signatures are not independently verified. The archive retains upstream licenses;
Checktrail does not republish the upstream JARs in its npm package. The distribution
contains LGPL and third-party license material; a full component/license audit
remains part of E6.

Execution checks Temurin 25.0.4+7-LTS, extracts only the enumerated hash-pinned runtime
JARs into engine-owned temporary storage and observes the loaded SpotBugs version.
It uses a fixed console logger; warning/error logs remain collection failures.
Project classes and dependencies never enter the helper JVM's runtime classpath.
Project dependency JARs are compiler inputs and analyzer auxiliary inputs.
Annotation processing, implicit source compilation, source-bearing dependency JARs
and implicit dependency manifest classpaths are disabled or rejected.

Fresh compiler output is bounded and retained privately. Every emitted class is
bound to its actual compiler source, byte count and SHA-256. The separate compiler
keeps the existing `jvm.javac` output-discard behavior unchanged. A passing receipt
requires successful native compilation, one parse per selected source, complete
native type analysis and at least one emitted class for every selected file.
An empty/comment-only selected file cannot establish this class-based profile.
This bounded profile accepts ASCII binary class names; Unicode class identifiers
are unsupported and cannot produce a passing receipt.

Analysis retains the effective per-pass detector membership separately from default
preferences. Training-only defaults are inactive without training; native ordering
dependencies can force additional built-in bookkeeping detectors into the plan.
Acceptance compares the observed membership to the pinned native profile, including
those dependencies and the annotation-collector exclusion.

Analysis retains native pass predictions, observed classes with matching finished
callbacks, class statistics, the exact configured detector inventory, bugs, missing
classes, recoverable errors and explicitly skipped methods. Every selected compiled
class must complete every pass. Reporting passes must contain exactly the selected
classes. Missing classes, oversized/skipped classes, incomplete passes, unknown
assembly or partial/error output cannot pass. An empty bug list alone is insufficient.
The annotation suppression collector is excluded because its active execution plan
installs a matcher independently of the engine's project-filter setting and can
forcibly re-enable a disabled collector through ordering dependencies. No project
filters, baseline exclusions, suppression annotations, custom detectors,
plugins, training inputs or cached results are enabled by this profile.

Native source locations use the compiler's class-to-source binding, rather than
assuming a basename uniquely identifies a file. Source digests and line counts are
checked against current bytes before a result is accepted. Positive native line
ranges must fit their physical source. Unknown line numbers retain a verified file
without inventing a line. Native priority maps to diagnostic level; it is not
consequence severity or confidence calibration. Distinct native bug codes remain
distinct tool findings; general defect deduplication remains an R5 requirement.

The native helper has a 256 MiB JVM heap ceiling. Compilation allows at most
32 MiB of class output; invocation, detector, source, pass and diagnostic counts
are bounded. Child collection has a 1 MiB output ceiling and participates in the
shared command deadline, output budget and cancellation lifecycle. The shared
engine removes owned class/tool artifacts even when cancellation interrupts the
helper's own `finally`. Ordinary summaries withhold raw paths and diagnostics.

The declared acceptance image uses pinned Node and Temurin base digests, no network,
a read-only repository mount, an init process and bounded CPU/memory. Required
identities in `scripts/required-native-tests.json` cover native broken/fixed/near-miss
behavior, nested classes, duplicate source names, inert initialization, exact tool
identity, malformed compilation, stale/forged/empty/skipped evidence, unsupported
prerequisites, source-line bounds, CLI/MCP privacy and operator trust, and cancellation
after observing the active analyzer JVM. The fresh-package harness installs locked
production dependencies offline without lifecycle scripts and exercises shipped
runtime bytes, CLI and negotiated MCP from outside the installed package.

```sh
node scripts/prepare-package-cache.mjs
node scripts/prepare-spotbugs-tools.mjs
docker build --file scripts/spotbugs-tools.Dockerfile \
  --tag checktrail-spotbugs-test:4.10.4 .checktrail/spotbugs-tools
node scripts/verify-spotbugs-container.mjs
```

Agents run these commands through the shared managed environment. Named acceptance
and measurements describe their exact revision and platform; broader OS/runtime,
Kotlin/Scala, generated/JPMS, custom plugin and build-wrapper profiles remain open.
This integration does not close E11, Gate A or any reviewer-quality gate. No AI
inference or field evaluation is part of these synthetic controls.
