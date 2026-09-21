# C# compilation

`dotnet.csharp` compiles all inventoried `.cs` files in a project as one explicitly
configured assembly. It requires one project-root `.csproj` marker, a prepared
.NET SDK 10.0.401, Roslyn 5.9.0 from that SDK, and the .NET 10.0.12 runtime and
reference pack. This profile has native evidence on arm64 Linux.

The project-root `repo-verifier.dotnet.json` declares the complete supported
configuration. For example:

```json
{
  "schemaVersion": 1,
  "targetFramework": "net10.0",
  "assemblyName": "Example.Catalog",
  "languageVersion": "14",
  "outputKind": "library",
  "nullable": "enable",
  "warningsAsErrors": true,
  "allowUnsafe": false,
  "checkedArithmetic": true,
  "implicitUsings": false,
  "defines": ["NET", "NET10_0", "NETCOREAPP"],
  "references": []
}
```

The adapter does not infer these settings from project XML, environment variables,
`.editorconfig`, response files or build targets. C# language versions 12, 13 and
14 are accepted; preview versions are not. Nullable context accepts `enable`,
`disable`, `warnings` or `annotations`. The assembly name matters for accessibility,
including friend assemblies. Conditional symbols are exact explicit identifiers;
the adapter adds none automatically and does not check every preprocessor branch.

When requested, `implicitUsings` adds the fixed global imports for `System`,
`System.Collections.Generic`, `System.IO`, `System.Linq`, `System.Net.Http`,
`System.Threading` and `System.Threading.Tasks`. This owned syntax tree is counted
separately from project inputs. Source directives retain native compiler semantics.
The compiler enables its warning waves; `warningsAsErrors` controls promotion.
Diagnostics suppressed by the compiler cannot establish complete findings and
make an otherwise successful check inconclusive.

## Dependencies and execution

Each optional reference has the shape `{ "path": "…dll", "sha256": "…" }`.
Paths resolve from the project, must remain inside the operator root and cannot
traverse symbolic links. Prepared DLLs can live in the excluded `.repo-verifier/`
directory. Exact bytes are checked during planning, before native compilation
and afterwards. Limits are 128 references, 32 MiB per DLL and 128 MiB total.
Duplicates, unpinned changes, non-managed files, standalone modules and multi-file
assemblies are rejected. Assembly-file metadata cannot bring in unpinned sidecars.

The runner locates the exact SDK and invokes its `csc.dll` directly to prepare an
owned compiler helper in a fresh temporary directory. It uses existing local
reference assemblies. It does not run MSBuild, NuGet restore, workloads, project
targets, source generators, analyzers, application initializers or tests. Project
`global.json` does not select a different SDK. No project assembly is loaded for
execution; reference assemblies are read as metadata. SDK compiler libraries are
trusted tooling and are loaded by the owned helper.

Native processes receive the snapshotted PATH and fixed .NET settings, including
disabled telemetry/diagnostics and invariant globalization. Other inherited or
operator-supplied environment values, including startup hooks and profiler
configuration, are not forwarded. Operator trust is still required: native
compilers and metadata readers have the process user's privileges, and this is
not a sandbox.

Project output is emitted into a bounded memory stream and discarded. Owned
helper artifacts are temporary; no `bin`, `obj` or application DLL is written
inside the project. Output is limited to 32 MiB, diagnostics to 2,000 entries,
native stdout/stderr to 1 MiB per invocation and 4 MiB total, and the prepared
argument to 100 KiB. Native managed heaps have a 256 MiB bound, which does not
bound total process memory. The engine's normal time and process-group limits
also apply.

## Evidence and limitations

Every inventoried source must have a native syntax tree covering its complete
text and a completed semantic-model diagnostic query. Input paths are reconciled
exactly, including empty files and partial classes. The profile requires a
successful native emit with nonempty output, matching declared options and
reference counts. Compiler, runtime and SDK identities are retained, together
with a digest of the reference-pack DLLs and compiler assemblies checked before
and after the run. This is not a digest of the entire installed SDK or runtime.

The helper uses Roslyn's
[semantic model](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/get-started/semantic-analysis)
and compilation emit diagnostics. Errors retain their `CS…` codes and original
source locations. Failed compilation has incomplete findings. Missing, malformed,
inconsistent or suppressed evidence cannot pass. Native compiler diagnostics are
not analyzer, framework, authorization or business-logic coverage.

The result means that the inventoried files compile under the explicit profile.
It does not prove equivalence to an SDK project build. Generated source under
`obj`/`build` is excluded and never silently included. Prepare required generated
source as inventoried files or a pinned assembly. F#, Visual Basic, scripts,
Razor/XAML, source generation, multi-project builds, other target frameworks,
MSBuild properties, package restore, format checks and test runners require
separate profiles. Solution files, including `.slnx`, are detected; select actual
C# project roots for compilation.

## Reproduce

```sh
npm run build
docker build --file scripts/dotnet-tools.Dockerfile --tag repo-verifier-dotnet-test:10.0.401 scripts
node scripts/verify-dotnet-container.mjs
```

The helper checks the pinned native SDK/compiler, runs original synthetic cases
with networking disabled, and tests a fresh offline package installation through
the library, CLI and MCP. The host npm cache needs the production dependencies.
The hosted amd64 job passed at `52ba415`; see `NATIVE-CI.md`. Windows process-tree handling and
native macOS .NET execution remain unverified.
