# Native NUnit method provenance

The opt-in `dotnet.test` profile now binds custom NUnit case names to native
method identities for declared C#, F# and Visual Basic test classes. It shares
the [fresh build](DOTNET-BUILD.md) and [native test](DOTNET-TEST.md) contracts:
SDK 10.0.401, runtime 10.0.12, NUnit package 4.6.1, adapter 5.0.0 and Test SDK
18.10.1. This is source readiness, not part of the published alpha.5 package.
E12 remains partial and Gate A remains open.

## Native identity and reconciliation

A custom `TestName` can replace the method portion of VSTest's fully qualified
name, while its code-file and line fields are empty. Display text cannot establish
a compiled method identity. The engine writes and pins its own escaped runsettings,
selecting complete NUnit discovery, zero native workers and a fresh owned result
directory. Repository runsettings and case filters cannot narrow this invocation.
Planning only inspects data; native execution still requires operator trust.

The selected adapter's discovery dump supplies the exact native full name, class
and method. Its clean result XML supplies the same identities and native outcomes.
The diagnostic result dump is disabled: its surrounding diagnostic text is not a
complete XML document. Each captured artifact must be a fresh regular canonical
file in its exact selected output path, with bounded UTF-8 bytes and matching digest.

The parser validates the complete structural tree, unique node identities, every
suite's descendant count, effective native settings and selected framework/runtime.
Structural nodes hidden inside auxiliary elements are rejected. When a fixture is
ignored or its setup fails, the measured adapter leaves an empty parameterized-method
placeholder and promotes its cases to the fixture. That exact shape must retain the
discovered suite identity/count, zero placeholder execution counters and every
promoted case's discovered identity/outcome; other count mismatches remain incomplete. It reconciles every
native case with the VSTest discovery/results and existing TRX evidence. Predefined
XML entities in literal names are decoded; DTDs and declared entities are rejected.
The native result's command line must agree with the selected testhost path and
actual VSTest launcher recorded by the original observer. Native host PID fields
are coherence checks, not independent OS attestations of NUnit's XML claims.

An exact native class and method must select one declared class and one compiled
method whose portable symbols belong to the declared source. Duplicate full names
and overloaded method names remain incomplete: this profile has no native signature
identity that distinguishes the overloads. Generic, inherited, dynamic and other
framework/name conventions require separate acceptance. Test-file findings address
the bound registered case, without asserting its production cause or remedy.
A validated source-bound native failure remains failed if later result XML is
missing; completeness remains false.

## Required test plan

The `dotnet-method` profile in
[required-native-tests.json](../scripts/required-native-tests.json) requires exact
original callback identities with zero skips. Its coverage target is complete
case identity, source binding and failure accounting rather than line coverage.

| Type              | Required behavior and controls                                                                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings          | Owned complete discovery, escaped output path, zero workers and clean result output instead of a diagnostic dump.                                                                                                                                     |
| Native execution  | C#/F#/VB custom names with literal XML boundaries; actual production boundary regression, source-bound assertion failure and repair; ordinary names remain valid; ignored and setup-failed fixtures retain promoted case counts and source addresses. |
| Evidence contract | Missing/foreign paths, settings and bytes; unknown class/method, runtime, work directory, worker policy, PID/launcher; omitted/duplicate/hidden cases, bad counts and malformed XML.                                                                  |
| Ambiguity         | Duplicate custom full names and actual compiled method overloads cannot produce complete source evidence.                                                                                                                                             |
| CLI/MCP           | Native assertion failures, repaired pass, negotiated protocol, summary privacy and startup/operator-only trust.                                                                                                                                       |
| Lifecycle         | Reach the actual NUnit body and its child before cancellation; reap VSTest/testhost descendants and remove owned scratch/output directories.                                                                                                          |

Run `node scripts/verify-dotnet-method-container.mjs` with the prepared pinned
image/cache described in DOTNET-BUILD.md. Source tests and a fresh offline
production installation are separate required runs; the external harness imports
shipped runtime bytes and invokes the installed CLI. Native and installed controls,
compiling guard mutations, preserved .NET profiles and source pins are recorded in
[the receipt](measurements/dotnet-method-native-2026-10-06.json).

These original synthetic controls use no model inference, prior review verdicts
or real-project field evaluation. Hosted CI is configured but has no measured
result for this revision. Full SDK/publisher/license attestation, native Windows
and macOS .NET profiles, wider framework/target support and hostile-project OS
containment remain unverified. Fresh directories and the prepared offline container
provide development isolation, without an OS security sandbox claim.

## Primary references

- [NUnit adapter settings](https://docs.nunit.org/articles/vs-test-adapter/Tips-And-Tricks.html)
- [Pinned adapter 5.0.0 settings source](https://github.com/nunit/nunit3-vs-adapter/blob/V5.0.0/src/NUnitTestAdapter/AdapterSettings.cs)

The documentation describes the adapter options; the required original native
controls establish the selected installed profile's actual evidence behavior.
