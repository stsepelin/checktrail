# .NET test evidence

`dotnet.test` is an opt-in profile for the [fresh .NET build contract](DOTNET-BUILD.md):
declared C#, F# and Visual Basic projects targeting `net10.0`, SDK 10.0.401,
runtime/reference pack 10.0.12, NUnit 4.6.1, NUnit adapter 5.0.0 and Test SDK
18.10.1 in the original prepared fixture. It is not in the published alpha.5
package. E12 and Gate A remain open. Formatting, Roslyn source generators,
custom-name method provenance, other frameworks/targets and wider native profiles
are unfinished.

## Select and execute

Prepare the public fixture and its raw-pinned offline artifact closure as described
in DOTNET-BUILD.md. Select `dotnet.test` in `checktrail.json`, using the same
`checktrail.dotnet-build.json` declarations. At least one project must have a test
role and declared source-bound classes. Every inventoried project and source still
belongs to the complete compilation scope. Planning reads data and never runs
MSBuild, a logger, project targets or tests.

Execution requires CLI `--trust-project` or MCP startup `--allow-execution`.
The shared engine first restores locked dependencies and rebuilds all declared
projects from fresh inputs. It never runs tests after an incomplete or failed
build. Native source errors retain build findings; failed locked restore is an
unavailable prerequisite, without an assertion claim.

An original logger is compiled against the selected SDK's VSTest ObjectModel.
Only its specific Runtime 8 versus Runtime 10 assembly-reference warning is
suppressed; other helper compiler output prevents collection. Discovery and
execution use the selected SDK `vstest.console.dll` directly, one fresh assembly
at a time, with explicit framework, original logger and pinned adapter paths.
The parser binds logger process IDs, selected runtime/ObjectModel paths, original
helper source and native helper digest, complete ordered native calls, rechecked
artifact digests and the full build packet.

There are no user filters, selected-case lists, project `VSTestTestCaseFilter`
arguments or implicit project runsettings in these invocations. A configured
filter cannot turn partial execution into complete coverage: the native original
filter control still reports every declared case. This profile does not execute
an arbitrary project's MSBuild test target or its custom test orchestration.

## Reconcile native evidence

Every declared test project must discover at least one case. Every discovered
case must produce exactly one native result and one matching TRX definition,
entry and outcome. Native IDs, assembly, executor URI, case/display names,
execution IDs, statuses, times, duration, statistics and exit codes must agree.
Lifecycle events cannot be duplicated, interrupted or placed outside their native
start/finish. Infrastructure errors and malformed, omitted, stale, foreign or
truncated evidence cannot yield a pass.

The selected adapter emits no source file for the original fixture. The parser
therefore requires the exact declared class and compiled method in fresh assembly
metadata, with that method's portable symbols bound to its declared source and
compiler-input checksum. Prefix/suffix class near misses and undeclared siblings
remain incomplete. A native `TestName` that replaces the method name without
method provenance also remains incomplete; its execution does not establish a
source binding. Other name/generic/dynamic conventions require their own native
profiles before promotion.

This pinned TRX logger emits per-case `NotExecuted` for NUnit skips, excludes
those cases from its `executed` counter and leaves `notExecuted` at zero. Native
VSTest statistics include them as reported results. The parser requires both
observed representations to agree with the individual cases. Any skip remains
inconclusive, including all-skipped runs. Empty discovery is incomplete. Failed
native cases produce a failed check with source-bound test-file findings, including
assertion and fixture setup failures. Those addresses bind the registered case,
not proof of entry into its method, production cause or a remedy. A validated
native case failure remains failed with incomplete findings if later TRX evidence
does not reconcile.

## Trust, packaging and limits

Caller-owned `bin`/`obj` trees are preserved. Fresh SDK scratch, restore state,
outputs and test artifacts belong to the owned command temporary directory and
are removed on completion. Required cancellation waits for an actual NUnit test
body, observes its child beneath the selected VSTest client and test host, then
checks native descendants are reaped and scratch/output directories removed.
This is process lifecycle evidence, not OS containment or a guarantee against
hostile detached children. Project code retains the user's privileges and may
access networks outside the separate offline acceptance container.

Native call digests, bytes, durations and exits are bounded and retained. SDK/tool,
dependency, source, compiled-source, observer and fresh artifact bytes are checked
again before completion. These observations do not attest the entire SDK or the
publisher/component/license closure. CLI, library and negotiated MCP use the same
engine and parser; summary output omits source, paths, assertion prose and raw
logs. Request arguments cannot grant execution trust.

The frozen `dotnet-test` names in `scripts/required-native-tests.json` cover
original native regression/repair, skip/zero, roles, near misses, altered packets,
restore/build boundaries, source preservation, CLI/MCP and reached-test cancellation.
The required harness has an explicit five-minute file timeout for `dotnet-test`;
other profiles retain their two-minute default. The timeout is retained in the
profile receipt and does not increase the engine's protected execution budget.
`scripts/verify-dotnet-test-container.mjs` requires those cases against source and
a fresh offline production install. The external harness imports shipped runtime
bytes and invokes the installed CLI. The configured hosted CI revision remains
unverified until that job actually runs. No field review, model inference or
quality score follows from this native readiness profile.

## Measured readiness

[The native receipt](measurements/dotnet-test-native-2026-10-06.json) binds source
pins, the compiled engine digest, source/installed acceptance, compiling guard
mutations, preserved profiles and repository validation. It records its exact
scope and unverified boundaries. The evaluated tarball predates this receipt and
final documentation links; its identity does not describe a later packed artifact.

## Primary references

- [VSTest command-line options](https://learn.microsoft.com/en-us/visualstudio/test/vstest-console-options?view=vs-2022)
- [VSTest adapter extensibility](https://github.com/microsoft/vstest/blob/main/docs/RFCs/0004-Adapter-Extensibility.md)
- [VSTest reporting](https://github.com/microsoft/vstest/blob/main/docs/report.md)

Native acceptance measures the selected installed SDK and original synthetic
fixtures; these references do not substitute for those observations.
