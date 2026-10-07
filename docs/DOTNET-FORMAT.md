# Native .NET whitespace evidence

`dotnet.format-whitespace` is an opt-in, non-rewriting C#/Visual Basic profile
for SDK 10.0.401, runtime/reference pack 10.0.12 and `net10.0`. It uses the
[fresh build contract](DOTNET-BUILD.md) and the same project/dependency declarations.
It is not in the published alpha.5 package. E12 and Gate A remain open:
code-style/analyzer fixes, Roslyn generator participation, F# formatting and wider
native target/framework/platform profiles are unfinished.

## Select and execute

Select `dotnet.format-whitespace` in `checktrail.json`; prepare
`checktrail.dotnet-build.json` with every inventoried project and source, pinned
regular offline dependency artifacts and each locked restore input. Planning
reads these inputs without running project targets, MSBuild, Roslyn or formatting.

The selected solution must contain only declared C# and Visual Basic projects.
F# inputs keep the whole formatting check unavailable with their scope visible.
This follows an observed native SDK boundary: formatting a mixed-language original
solution can return zero and an empty report while reporting that it cannot format
its F# projects. That result is not complete formatting evidence. Declared Roslyn
generator outputs also keep the whole check unavailable until formatting
participation has its own verified native profile; build/test acceptance alone
does not establish formatting coverage.

Execution requires CLI `--trust-project` or MCP startup `--allow-execution`.
A shared runner restores locked dependencies and builds the complete declared
scope in fresh outputs before formatting. Native compiler errors retain their
source findings; incomplete builds cannot reach a passing formatting result.
The caller's existing outputs are neither reused nor rewritten.

## Native participation and reconciliation

An original helper is compiled against the selected SDK's Roslyn/MSBuild
workspace assemblies. The specific pinned MSBuild Locator Runtime 8 versus Runtime
10 assembly-reference warning is suppressed; any other helper compiler output
prevents collection. SDK DLL/JSON inputs copied beside the helper are observed
before copying and rechecked afterwards. This is observed tool-input provenance,
not attestation of the whole SDK installation or a publisher/license audit.

The helper loads each declared project through the native `MSBuildWorkspace`,
retains its diagnostics, enumerates every document and calls the native
`Formatter.FormatAsync` without applying changes. It records project/document
identities, language, actual source-byte and decoded-text hashes, selected source
text, effective indentation/tab/newline options and proposed UTF-16 text edits.
Every native document must reconcile with that project's actual fresh compiler
source parameter. SDK/package-generated documents remain explicitly accounted
outside the declared formatting scope; declared generated inputs stay selected.
Missing, duplicated, foreign or filtered documents cannot produce a pass.

Selected source text must reconstruct the observed file bytes, including an
optional UTF-8 BOM. Ordered edits must have valid source addresses and reconstruct
the exact native after-text hash. This profile bounds each document to 65,536 UTF-16
code units; larger or unsupported source encodings cannot produce complete evidence.

The runner separately invokes the selected SDK formatter DLL with `whitespace`,
`--no-restore`, `--verify-no-changes`, an owned report directory and the exact
selected source list. Microsoft's [formatter documentation](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-format)
describes whitespace as a separate formatting family. This profile does not
claim code-style or analyzer-fix coverage.

The parser requires every changed selected native document in the SDK JSON report,
actual edit intersections at the reported source addresses, matching native exits
and complete stderr diagnostic accounting. A clean empty report passes only when
every selected native document independently proves no proposed whitespace change.
Workspace failures, missing SDK inputs, stale source/dependencies, helper/PID
mismatches, partial calls, malformed reports and unexpected diagnostics stay
incomplete. Validated native source edits remain failed findings if later report
reconciliation is incomplete.

Source and SDK input pre/post checks, original helper source/native digest,
actual process ID/runtime and the bounded ordered native-call ledger bind the
receipt. Project targets execute with the operator's permissions; fresh directories
and the prepared development container are not an OS security sandbox.

## Required controls and limits

The exact `dotnet-format` profile in
[required-native-tests.json](../scripts/required-native-tests.json) requires original
broken/fixed C#/VB whitespace, literal/comment near misses, UTF-8 BOM, effective
per-file policy, omitted/forged/stale/malformed evidence, filtered compiler scope,
native source failures and caller-output preservation. CLI and negotiated MCP
controls preserve privacy and operator-only trust. Cancellation must reach the
actual native workspace BuildHost, then reap the original observer, BuildHost and
its reached project-target descendant and remove owned scratch/output directories.

[Recorded native formatting readiness](measurements/dotnet-format-native-2026-10-06.json)
binds exact source pins, source/installed acceptance, compiling guard mutations
and preserved .NET profiles. E12 and Gate A remain open.

The source profile and a fresh offline production-install harness are required
separately. The production harness imports shipped runtime bytes and exercises the
installed CLI; the official SDK client and original fixtures stay outside that
installation. Run `node scripts/verify-dotnet-format-container.mjs` after preparing
the original cache/image described in DOTNET-BUILD.md. The hosted CI step is
configured but has no recorded result for this revision.

These controls measure this finite synthetic profile. They neither assess review
quality nor use real-project field cases, model inference or prior review state.
Broader formatter families, frameworks, SDK versions, Windows and native macOS
.NET acceptance remain separate obligations.
