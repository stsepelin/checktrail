# Selected Scala compiler extensions

The opt-in `jvm.scala` check has two explicit extension declarations. Both use
operator-prepared public archives and the pinned Temurin JDK. Planning inspects
bounded files and tool identities without running project code, sbt, Scala CLI,
generators or compilers. Execution requires operator trust through the shared
library, CLI or MCP engine.

## Scala 2 source compilation

```json
{
  "schemaVersion": 1,
  "archive": ".checktrail/scala-2.13.18.zip",
  "sha256": "9c90562f29b0a316e269474d6752bc8ec45b1cabf61d5401d7ca50407b3a9d2b",
  "profile": "linux-arm64-scala2-typed-class-v1",
  "jvmTarget": "17",
  "warningsAsErrors": false,
  "classPath": []
}
```

The original native collector observes every selected source after typing and
JVM generation. Native declaration, tree and type counts and resolved annotation
identities reconcile with source bytes and physical class-file origins. Encoded
class names remain bound to their native binary names and `SourceFile` metadata.
There is no TASTy inventory for Scala 2. Empty declaration inventories and exact
resolved suppressions remain incomplete. Native warning escalation retains source
warnings and the exact global failure summary; unknown global diagnostics remain
incomplete. Scripts and Java/Kotlin mixtures are not part of this declaration.

The exact archive contributes five byte-pinned libraries. Its native standard
library has a larger manifest than ordinary dependency admission permits. Only
that verified library receives a 256 KiB manifest bound; ordinary dependency JARs
retain the existing 64 KiB bound. Dependencies require explicit local SHA-256
pins, no source entries and no implicit manifest classpath. No tool is downloaded
by planning or validation.

### Optional selected-JAR signature evidence

The explicit preparer can verify the detached signatures for the selected
compiler, library and reflect JARs:

```sh
node scripts/prepare-scala2-tools.mjs --verify-release-signatures /absolute/original-signature-inputs
```

The input directory supplies the literal public key and three `.asc` files named
by the [recorded release identities](measurements/artifact-identities-2026-10-21/scala2.json).
The preparer checks their complete byte identities, uses native GnuPG with a fresh
private keyring and no key retrieval, and publishes a complete archive/proof cohort
under `.checktrail/scala-signed-tools/<proof SHA-256>`. Existing unverified and
qualified caches are preserved. A failed verification cannot publish a qualified
cohort; an existing destination must match its actual physical bytes.

Copy the entire published two-file directory into the project's local tool cache,
retain its digest directory name, and select that directory's archive in
`checktrail.scala.json`. Set `CHECKTRAIL_SCALA2_RELEASE_PROOF_SHA256` to the
reported proof digest in the operator environment before starting the CLI or MCP
server. No project configuration or MCP argument can enable this mode. The shared
engine captures the selected digest in the planned command; later environment
changes cannot replace its authority during final admission.

Planning reads bounded data only. Execution checks the archive, complete selected
library membership and proof before use and after native compilation. Final
admission independently rereads the physical cohort and checks the captured
operator pin. A proof-bearing cache without that pin, a nonempty malformed pin,
a mismatched proof, or a missing/extra cohort member refuses qualification rather
than silently selecting the old mode. The original archive-only mode remains
explicitly unverified.

This is operator-pinned evidence of native preparation. Runtime admission does
not rerun OpenPGP cryptography and the JSON transcript cannot authenticate itself;
the operator's externally selected digest supplies its authority. The
[GnuPG verifier manual](https://www.gnupg.org/documentation/manuals/gnupg/gpgv.html)
explains that supplied keys are treated as trusted and key expiry/revocation is
not checked. The proof records verification against the pinned key snapshot. The signed JAR
subset is distinct from the complete selected library cohort. The ZIP, JLine and
java-diff-utils do not gain signature coverage from it. Key-owner trust, current
revocation, upstream compiler/build ancestry and complete notice closure remain
separate. Native acceptance of this new end-to-end mode is pending.

## Ordered Scala 3 compilation

Keep the baseline Scala 3 archive, digest, target and warning policy described in
[SCALA.md](SCALA.md), and add an `extensions` declaration:

```json
{
  "profile": "linux-arm64-scala3-mixed-generated-script-v1",
  "javaSources": ["producer/Producer.java"],
  "scripts": [
    { "file": "consumer/compile only.sc", "className": "scripts.Original" }
  ],
  "generators": [
    {
      "source": "generators/BuildScalaGenerator.java",
      "className": "gen.BuildScalaGenerator",
      "outputs": [
        {
          "file": "src/main/scala/policy/Rules.scala",
          "className": "policy.Rules"
        }
      ]
    }
  ],
  "stages": [
    { "id": "producer", "sources": ["producer/Macros.scala"] },
    {
      "id": "consumer",
      "sources": [
        "consumer/Consumer.scala",
        "consumer/compile only.sc",
        "src/main/scala/policy/Rules.scala"
      ]
    }
  ]
}
```

Every inventoried Java source or generator and every Scala/script compiler input
has exactly one declared role. Each compiler input belongs to one ordered stage.
A producer stage supplies its fresh class/TASTy output to later stages, allowing
separate inline and macro producers and consumers. The pinned staging library is
extracted from the same Scala 3 archive. Kotlin mixtures, Java modules, arbitrary
compiler options, compiler plugins and external dependency resolution are refused.

Java sources supply symbols to Scala compilation, then a separate native Java
compiler task checks their bodies against the fresh Scala outputs. Its parse,
analysis, declarations, annotations, diagnostics and physical class origins must
agree. Missing participation, exact suppression, output collisions and unknown
diagnostics cannot yield a pass. Each Scala stage retains the baseline typed-tree,
post-typer feature and backend observations. The explicit extension permits native
inline, quote/splice and macro feature flags; suspension remains incomplete.

A script is wrapped in a deterministic named object. Its original UTF-8 body is
preserved and diagnostic lines are mapped back through the wrapper prefix. Names
are quoted so valid keyword identifiers are accepted. Real directives, package
statements and shebangs require another profile; matching text in string literals
or nested block comments does not request tooling. No script or application
initializer is launched by the check.

Java generators execute in fresh owned directories and may emit only the exact
declared conventional Scala source paths. Generated source hashes, primary class
names and physical `SourceFile` witnesses must agree. Libraries and observer
classes are rechecked after generation and compilation. All original sources,
configuration, archives and dependencies are rechecked, as are earlier stage
outputs after later macro compilation. Existing caller build outputs are preserved.

Compilers and generators can execute project-controlled compile-time code with
the process user's privileges. Operator trust is necessary; these observations
are not a sandbox. The original macro control writes a compile-time marker while
its application/script markers remain absent. This does not constrain arbitrary
trusted compiler inputs.

The extension bounds eight ordered stages, 2,000 compiler inputs, eight generators,
32 outputs per generator, source and generated bytes, diagnostics and native
invocations. All class/TASTy output shares a 64 MiB / 4,001-file bound. Native
subprocess admission uses one 110-second wall bound and a 2 MiB live-output bound;
the outer runner separately handles cancellation and owned descendant cleanup.
Missing, stale, malformed or exhausted observations remain incomplete.

The public declaration schema is [scala-config.schema.json](../schemas/scala-config.schema.json).
The required development profile is `scripts/verify-required-native-tests.mjs
scala-extensions`; its container controller separately checks preserved native
compilation, fresh offline installation, compiling guard controls and additional
native regressions. Wider platforms, full license/provenance closure, the final
runtime matrix and Gate A remain open. This profile supplies compiler evidence,
not independent reviewer quality or real-project field evaluation.

Source-bound acceptance is recorded in
[scala-extensions-2026-10-10.json](measurements/scala-extensions-2026-10-10.json).
This closes the selected implementation profile only. The record separates
current native source/installed acceptance from optional host skips and from
unfinished hosted CI, final runtime matrix, provenance and Gate A obligations.

Mixed Java warning escalation can carry a selected Java source address while
retaining global positions `-1/-1`. The engine accepts one exact
`compiler.err.warnings.and.werror` summary only when the declared policy enables
warning escalation and selected source warnings remain. It retains those source
warnings and reports failed with incomplete compiler coverage; it does not invent
a source error for the global summary. The same source can pass when warning
escalation is disabled. Unknown, duplicate, mispositioned or foreign-source
summaries remain inconclusive. The [repair record](measurements/mixed-jvm-java-warning-policy-2026-10-10.json)
binds native and fresh installed warning regressions and the preserved acceptance
cases for both Kotlin and Scala.
The [baseline identity-guard repair](measurements/scala-identity-guard-fixtures-2026-10-10.json)
keeps physical original bytes and staged compiler bytes distinct in coherent
negative fixtures. It verifies that removing each corresponding digest comparison
makes the original callback fail. The native source and fresh installed baseline
inventories remain required alongside extension acceptance.
