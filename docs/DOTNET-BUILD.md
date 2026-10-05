# .NET build evidence

`dotnet.build` is an opt-in build profile for declared C#, F# and Visual Basic
projects targeting `net10.0`, using SDK 10.0.401, runtime/reference pack 10.0.12
and its selected native compiler tasks. Default .NET validation remains the
explicit `dotnet.csharp` compilation profile. This implementation is not part of
the published alpha.5 package. E12 and Gate A remain open: test/TRX and formatting
integration, Roslyn generator participation and wider profiles remain unfinished.

## Prepare and select

Discovery and planning read source, configuration and pinned dependency bytes;
they never invoke project targets, restore, compilers or helpers. From a built
source checkout, prepare the original public fixture explicitly:

```sh
docker build --file scripts/dotnet-tools.Dockerfile --tag checktrail-dotnet-test:10.0.401 scripts
node scripts/prepare-dotnet-build-dependencies.mjs
```

The preparer restores only the original public six-project fixture, with pinned
Test SDK 18.10.1, NUnit 4.6.1 and NUnit adapter 5.0.0. It checks bounded regular
artifacts, permits legitimate empty package files, excludes links, preserves an
existing destination and publishes the artifact tree, raw manifest and fixture
locks in one prepared directory. An exclusive preparation lease coordinates
cooperating preparers. This is an explicit network operation, not an engine
installer for arbitrary consumers. Publisher signatures and the complete
component/license closure remain unverified. Agents use their configured
foreground environment runner for native commands.

Select the root in `checktrail.json`:

```json
{
  "schemaVersion": 1,
  "projects": [{ "path": ".", "checks": ["dotnet.build"] }]
}
```

Prepare `checktrail.dotnet-build.json` against the
[configuration schema](../schemas/dotnet-build-config.schema.json). Declare the
selected solution/project, repository directory, manifest file and SHA-256 of
its exact raw bytes. Each project declares its file, language, assembly name,
`net10.0` target, library/test role, complete source list, generated-source paths
and test classes with source files. The
[original fixture declarations](../scripts/dotnet-build-fixture-projects.json)
illustrate these roles; consumers prepare their own closure and package locks.
Every inventoried project and non-output `.cs`, `.fs` and `.vb` source must be
assigned exactly once. Each project needs an inventoried `packages.lock.json`.
Generated sources belong inside that project's fresh `obj` tree. Test roles
require declared classes; library roles cannot declare test classes.

## Execute and account

Execution requires CLI `--trust-project` or MCP startup `--allow-execution`.
A model-supplied argument cannot grant it. MSBuild targets, tasks, analyzers and
project code run with the process user's privileges. This is not an OS sandbox
and does not contain deliberately detached processes or project network calls.

The shared engine copies inventoried non-output inputs and the exact regular
pinned dependency tree into a fresh workspace. Caller-owned `bin`/`obj` trees
are neither reused nor changed. A fresh user home, restore configuration and
native scratch directory live inside the owned command temporary directory.
Restore uses the copied local source, locked mode, no fallback folders and no
NuGet audit. The selected SDK's MSBuild client rebuilds with one node, node reuse
and shared compilation disabled, and analyzers enabled. The selected host path
is supplied explicitly for F# compilation. Protected runtime/restore/shell
settings cannot be granted through project environment requirements; other
explicitly selected variables reach the native tools.

An original logger compiled against the selected SDK records project evaluation,
compiler task assembly and context, source/reference/analyzer/config inputs,
commands, diagnostics and terminals. Metadata-only assembly and portable-symbol
inspection binds native class/method declarations and symbol checksums to fresh
compiler sources. The parser reconciles every project, source, declared generated
input, repository pin, selected compiler and output. Source diagnostics retain
relative addresses; early source errors fail with incomplete remaining coverage.
Build setup failures and missing locked dependencies are separate incomplete
outcomes. An enabled SDK analyzer's source error and its warning/repair variants
are native controls, not inferred analyzer coverage.

Native calls retain bounded byte counts, digests, durations and exits. Inputs,
observed SDK/tool/dependency files, observer/settings and both dependency copies
are checked again before completion. Observed digests are not attestation of the
entire SDK installation or of a hostile project. Ordinary cancellation is tested
after an original project target reaches the exact native MSBuild client, with
its descendant and owned scratch directories checked after cancellation.

## Evidence and limits

[The measured Linux profile](measurements/dotnet-build-native-2026-10-06.json) binds source/runtime identities, native and installed obligations, compiling guard mutations and preparation controls. Its evaluated package predates the added receipt; it does not identify a later package containing this record.

[The required profile](../scripts/required-native-tests.json) fixes exact test
names and files. `node scripts/verify-required-native-tests.mjs dotnet-build`
requires them all to pass without skips. Native controls cover all three
languages, failure/repair pairs, native analyzer diagnostics, declared generated
source, source/project omission, disabled compilation, locked restore failures,
corrupt dependencies, altered packets, protected environment, caller-owned
outputs, CLI/MCP privacy and trust, and reached-process cancellation.

`node scripts/verify-dotnet-build-container.mjs` runs that profile and preserved
C# compilation checks under the pinned offline container, then repeats the build
obligations against an offline production install. Its harness and official MCP
client are outside the installed package. Hosted amd64, other SDK/frameworks,
macOS and Windows are separate acceptance profiles; adding a CI job is not
hosted evidence. This work is original synthetic readiness evidence and invokes
no reviewer model or real-project field evaluation.

Only conventional SDK projects, portable symbols, default selected SDK analyzer
configuration, declared compiler inputs and the measured Linux profile are
covered. Source-generator-produced syntax not represented by the declared native
compiler inputs remains incomplete. Scripts, Razor/XAML, linked/outside sources,
multitargeting, remapped outputs, other adapters/frameworks and broader compiler
or plugin shapes need separate verified profiles. A passing build is not a test
execution result or proof that every possible analyzer rule was enabled.
