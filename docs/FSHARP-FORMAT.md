# Native F# formatting evidence

`dotnet.format-fsharp` is an opt-in, non-rewriting source-string formatting profile.
It uses Fantomas Core 8.0.7 with the selected Linux ARM64 SDK 10.0.401, runtime
10.0.12 and Node runtime. This profile is separate from the C#/VB whitespace
profile in [DOTNET-FORMAT.md](DOTNET-FORMAT.md). Gate A, broader .NET formatting,
artifact/license closure and platform acceptance remain open. It is not a claim
of compilation, semantic correctness or review quality.

## Declare the source cohort

Select `dotnet.format-fsharp` in the project's `checktrail.json`. Declare every
inventoried `.fs`, `.fsi` and `.fsx` document in `checktrail.fsharp-format.json`:

```json
{
  "schemaVersion": 1,
  "profile": "fantomas-core-default-v1",
  "formatterDirectory": ".checktrail/fsharp-format-tools",
  "files": ["Original.fs", "Public.fsi", "Original.fsx"]
}
```

This finite profile selects Fantomas Core's default configuration. It does not
apply `.editorconfig`, invoke the Fantomas CLI, evaluate scripts or project
configuration, resolve `#r`/`#load`, restore dependencies or compile the project.
All selected source strings reach native validation and formatting; `.fsi` uses
the native signature flag. Other project languages are outside this check's
scope and retain their separate checks.

Prepare the exact downloaded [NuGet package](https://api.nuget.org/v3-flatcontainer/fantomas/8.0.7/fantomas.8.0.7.nupkg):

```sh
npm run build
node scripts/prepare-fsharp-format-tools.mjs --archive PATH_TO_FANTOMAS_NUPKG
```

The preparer validates the package length and SHA256, expands and verifies every
selected payload before writing the advertised directory, and atomically installs
only `FSharp.Core.dll`, `Fantomas.Core.dll` and `Fantomas.FCS.dll`. An existing
partial or changed tree is refused. The selected byte identities are in
`fsharp-format-pins.ts`; no downloaded assemblies are shipped in this package.

Planning reads configuration, source and tool bytes without executing them.
Missing, changed, duplicated, omitted, linked, escaping or oversized inputs keep
prerequisites unavailable. Sources are bounded at 128 documents, 64 KiB per raw
file and 8 MiB in aggregate, including configuration; the invocation has a
100 KiB bound. Normal engine time/output limits still apply. An admitted input
size does not guarantee it fits the available execution/output budget.

## Execute and reconcile

Execution requires CLI `--trust-project` or MCP startup `--allow-execution`.
A model-supplied tool argument cannot grant execution or detailed output. CLI
`--detailed` or MCP startup `--detailed` discloses bounded raw native receipts and
source; summaries retain check IDs and outcomes without source, paths or logs.

The trusted wrapper verifies selected SDK, reference, compiler, runtime and host
bytes before execution and afterwards, admits an exact native-host/runtime
version inventory, and checks the current local formatter tree again. These
are selected component bindings, not a complete SDK, OS, container, publisher or
license audit. The wrapper constructs its own environment and fresh private
source copies. An original C# observer is compiled with explicit reference and
formatter assemblies, then calls `CodeFormatter.ValidateFSharpCodeAsync` and
`CodeFormatter.FormatDocumentAsync` for every source string. No source is rewritten.

Compilation retains the two exact observed CS1701 warnings about the bundled
FSharp.Core 10.1.0 assembly satisfying Fantomas references to version 10.0.0.
Native implementation, signature, script and conditional controls exercise this
combination. A different compiler warning or error prevents complete collection;
there is no blanket warning suppression.

Both native phases retain raw bounded stdout/stderr, physical byte digests,
fixed arguments, working directories, process IDs and captured stream accounting.
The observer retains raw source-byte and decoded-text hashes, BOM state, native
validation diagnostics, native formatter exceptions, formatted strings and their
digests, change flags and loaded assembly identities. The shared evidence parser
rechecks current source/configuration/tool bytes and reconciles the complete
source cohort, signature flags, helper/request/runtime identities, native phase
arguments, raw streams, loaded assemblies and proposed text changes.

`ValidateFSharpCodeAsync` returns intolerant diagnostics from the first failing
conditional combination only. Its narrower scope is explicit. Formatting is
attempted even after validation fails: `ParseException` retains its own complete
diagnostic array, which can have different ranges, while `DefineParseException`
returns the full failing combination list and exception message. That exception
does not expose per-combination parser ranges; none are invented. Diagnostics
retain the native range when it reconciles with the current decoded document;
otherwise contradictory ranges make evidence incomplete. File-level exceptions
remain file-level findings.

Malformed, empty, duplicated, foreign, stale, omitted, inconsistent or interrupted
receipts cannot pass. Unknown formatter failures remain inconclusive. Captured
receipts are reconciliation evidence, not cryptographic execution attestation.

## Lifecycle and acceptance

The observer writes an atomic process-entry marker and, separately, a marker
only after the first document has reached native validation and formatting.
Lifecycle controls wait for the second marker and verify the live native command
before cancellation, pausing for deadline expiry, or reaching output exhaustion.
They check descendant removal and owned directory cleanup. Process entry alone
is not treated as proof that the formatter API ran.

`dotnet-fsharp-format` requires all nine frozen callbacks against source and a
fresh offline production installation. The controller also preserves the
selected .NET build and C#/VB formatting baseline and runs compiling negative
controls against unchanged acceptance callbacks. Native observer mutations
additionally prove that the altered C# observer compiled and reached native
formatting. [The selected native measurement](measurements/fsharp-format-2026-10-10.json) records source and fresh installed-package acceptance, preserved baselines, paired compiling controls and the mandatory host project check. Optional host skips are not acceptance. The wider frozen matrix, full artifact/license closure and Gate A completion remain separate requirements.
