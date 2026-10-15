# Native C#/VB style and analyzer formatting

`dotnet.format-extensions` is an opt-in, non-rewriting profile for selected SDK
code-style and analyzer diagnostics, proposed edits and declared generated
sources. It uses the selected Linux ARM64 SDK 10.0.401, runtime 10.0.12 and Node
runtime. It extends the whitespace-only profile in [DOTNET-FORMAT.md](DOTNET-FORMAT.md).
The separate F# source-string profile is in [FSHARP-FORMAT.md](FSHARP-FORMAT.md).
Broader generator profiles, artifact/license closure, the final platform matrix
and Gate A remain open. Formatting evidence does not establish review quality.

## Declare the cohort and policy

Select `dotnet.format-extensions` in `checktrail.json`. Declare the solution,
every C#/VB project and original source, local dependency closure, MSBuild output
and Roslyn generator output using [DOTNET-BUILD.md](DOTNET-BUILD.md) and
[DOTNET-GENERATED.md](DOTNET-GENERATED.md). Also declare this policy in
`checktrail.dotnet-format.json`:

```json
{
  "schemaVersion": 1,
  "profile": "sdk-code-style-and-analyzers-v1",
  "styleDiagnostics": ["IDE0005", "IDE0007"],
  "analyzerDiagnostics": ["CA1822"],
  "severity": "info",
  "includeGenerated": true
}
```

Both categories require one to 64 unique identifiers from the byte-pinned native
SDK catalogue for at least one declared language. C#-only rules need not exist
in VB. Unknown IDs, adjacent identifier spellings, wrong categories, unsupported
languages, extra configuration and disabled generated participation are refused.
The native observer retains the actual per-project catalogue and selected analyzer
assembly identities. Catalogue size is metadata, not exercised rule coverage.
Editor and admitted SDK analyzer configuration are compiler inputs with exact
byte bindings; the check does not guess rule identity from a name prefix.

Planning reads configuration, source, dependencies and selected tool bytes without
executing them. Execution requires CLI `--trust-project` or MCP startup
`--allow-execution`. MSBuild, analyzers and generators can execute project code.
MCP arguments cannot grant execution or detailed output.

The existing bounded build contract applies. This profile additionally requires
UTF-8 physical compiler documents no larger than 64 KiB, including dependency
and generated sources. Native inventories are bounded at 4,096 documents, 512
loaded assemblies, and 4,096 edits per document. Observer streams have a 2 MiB
aggregate bound. The wrapper has a 4 MiB per-command capture allowance within the
engine's existing total output budget. Admitted source size does not guarantee
that execution or its full receipt will fit the operator's time/output budget.
Exhaustion remains incomplete evidence.

## Native execution and physical reconciliation

The wrapper verifies selected SDK/runtime/reference/compiler and formatter
components before executing a version command, constructs its own environment,
and stages fresh project and dependency copies. The selected inventories include
the SDK formatter, native SDK analyzers, targeting-pack analyzers and exact
selected SDK root components. These bindings do not close the whole SDK, native
libraries, OS, container, publisher or license inventory.

An original C# observer is compiled with explicit selected references and calls
the SDK's pinned private formatter pipeline. It checks the actual constructor
ABI. The one observed CS1701 warning about Microsoft.Build.Locator's System.Runtime
reference is retained exactly; different warnings or errors prevent complete
collection. Whitespace, CodeStyle and Analyzers each start from the same original
solution. Changes remain proposed text in memory: neither the application files
nor the staged compiler sources are rewritten.

Every declared original, MSBuild-generated and Roslyn-generated source participates.
The ordinary SDK pipeline handles declared physical project documents. Roslyn
source-generated documents additionally reach native `Formatter.FormatAsync` for
whitespace, and native analyzer execution for semantic diagnostics. Semantic fixes
for Roslyn-generated documents are explicitly unsupported: their diagnostics remain
findings until the source/generator is repaired. SDK/package compiler documents
outside the declared formatting cohort stay unchanged and are fully accounted;
any diagnostics from that retained cohort are notes. Unexpected or omitted
compiler/generated documents prevent complete evidence.

SDK whitespace rows are document summaries at 1:1, not edit locations. They
reconcile with every ordinary changed document; actual native text changes bind
ordered UTF-16 spans, physical positions and the complete proposed text. Semantic
SDK rows can diagnose a document without proposing an edit, including VB import
cases. Multiple diagnostic rows for one document remain distinct.

Semantic SDK report positions are mapped positions. Native diagnostic records
retain both `GetLineSpan` and `GetMappedLineSpan`, the exact source span and source
text hash. The native document inventory also retains Roslyn line mappings,
including hidden regions. Checksumless virtual PDB documents are admitted only
for this profile when their exact project/path appears in a native mapping whose
physical source span is validated. Physical PDB documents retain their full source
checksum requirement. The parser checks physical ranges against the current decoded source
and connects mapped SDK rows to those physically bound diagnostics. C# `#line`
and VB `#ExternalSource` controls use virtual addresses outside the physical
file's line count; public findings still cite the physical file. The parser does
not independently implement Roslyn's directive-mapping algorithm. Retained mapped
values come from the selected native observer and its completed raw output.

Each native phase retains arguments, working directory, process ID, raw bounded
streams and capture accounting. A separate completion marker binds the observation
hash and full phase counts. The shared parser rechecks current source, policy,
dependency tree, selected tool bytes, loaded modules, helper/request/runtime
identities, source cohort, SDK reports and exact text reconstruction. Current
input checks also apply to failed compiler receipts, so fixing a compiler error
invalidates its old failure evidence. Imported receipts are reconciliation evidence,
not cryptographic execution attestation.

## Privacy, lifecycle and acceptance

Default library, CLI and MCP summaries omit source, paths and raw native receipts.
Operator-controlled CLI `--detailed` or MCP startup `--detailed` grants bounded
detailed output. A repository or tool argument cannot grant either permission.

Atomic markers distinguish process entry, completion of the first actual native
formatting document, and completed observation. Cancellation, timeout and output
exhaustion controls wait for reached native formatting, verify the live command
and source identity, and account for descendant removal and owned-directory
cleanup. Process entry alone is insufficient.

All nine frozen `dotnet-format-extensions` callbacks are required against source
and a fresh offline production installation. The native controller also retains
the declared .NET build, whitespace and generated-source baseline and pairs
compiling mutations with unchanged callbacks and fixtures. Native observer
mutations must compile and reach the formatter before their assertion failure
counts. Optional host skips are not native acceptance. [The profile measurement](measurements/dotnet-format-extensions-2026-10-10.json)
records the selected native receipts and mandatory host project check; the broader
matrix, provenance freezes, inference and field evaluation remain separate.
