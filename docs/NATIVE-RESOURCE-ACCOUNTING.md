# Native resource accounting

The repository-owned POSIX observer supplies a bounded resource receipt for one
child reaped through `wait4`. It records the actual observer and child PIDs,
monotonic elapsed time, kernel user/system CPU counters, exit code or signal, and
raw and normalized peak RSS. Darwin raw RSS is converted from bytes; Linux raw
RSS is retained in KiB. A failed or signalled child remains failed or signalled.
A completed receipt is evidence of collection, not successful validation.

A namespace-init observer may report PID 1. Its forked child must have a distinct
PID greater than 1. Source controls compare user and system CPU separately with
the measured child, bound the observer interval by the parent monotonic
observation, and reject unsafe PID, CPU, RSS and exit-accounting values. Zero CPU
remains valid for a short-lived child.

This is operator measurement tooling. Prepare it from the repository with
`node scripts/prepare-native-resource-observer.mjs /absolute/private-empty-directory`.
Preparation requires an existing canonical, caller-owned private empty directory
and the host's `/usr/bin/cc`. It compiles only Checktrail's own observer source,
records the actual compiler executable, source and binary hashes, and publishes
`native-resource-observer/{observer,build.json}` together by directory rename.
A compilation failure removes its owned staging directory and publishes neither
artifact. Compiler, SDK, library and publisher provenance remain incomplete.

The native executable accepts a new receipt path, a 32-character lowercase hex
request ID, an absolute executable path and its literal argument array. It does
not invoke a shell. The caller must have operator authority to execute the target;
these scripts add no CLI/MCP execution permission. Use the shared bounded process
runner when measuring invoked project code. No project execution is sandboxed by
this helper. The observer remains outside the distributed product package.

The receipt file is exclusively created with private permissions. The reader
requires a canonical non-symlink path, a caller-owned regular single-link file,
unchanged file identity, bounded valid UTF-8 and exactly one canonical record.
It refuses duplicate keys, extra records, malformed or stale request identities,
contradictory exit accounting, unsafe counters and incompatible RSS units.
Interrupted observers cannot manufacture completed evidence. Receipts and raw
output belong in private measurement storage.

`wait4` peak RSS is **not summed process-tree RSS**. Descendant coverage has not
been established by this foundation. The existing performance harness's engine
CPU and peak RSS also exclude child processes. Representative small, large and
polyglot/native workload accounting, integrating the separate child counters, output/archive
storage accounting, Windows measurements, final schema/package/privacy/upgrade
readiness and the resource-release-readiness profile remain pending.

[The scoped measurement](measurements/native-resource-observer-2026-10-11.json)
records the original required controls and their original source bindings on
macOS Node 24 and 26 and Linux Node 22,
against source and fresh offline production installs of the unchanged runner.
The unchanged repository harness stays outside each installed package. Paired
mutations prove the nonce, RSS normalization, canonical record, private file,
native kernel counter, exclusive creation and failed-compilation cleanup guards.
The current boundary, CPU-field, wall and namespace-init regressions extend that
original harness; the dated receipt keeps its historical inputs unchanged.
Linux receipts bind the borrowed immutable local compiler image and actual Node,
compiler and observer executable hashes; they do not certify its artifact or
license closure. Owned measurement containers were removed and the borrowed image
was preserved. Windows acceptance and Gate A remain open. No inference or field
evaluation was run.

## Separate self and reaped-child counters

The repository-owned Node-API 8 binding reads `getrusage(RUSAGE_SELF)` and
`getrusage(RUSAGE_CHILDREN)` in the collecting process. It retains the actual PID,
separate user/system CPU counters, raw RSS units and normalized KiB for each scope.
Its reader refuses stale PIDs, incompatible scopes/units, unsafe or negative
counters, malformed UTF-8, duplicate keys and extra records. Kernel/API failures
throw rather than returning invented successful zero counters.

PID 1 is valid for a namespace-init collecting process and still has to match the
expected process identity. Current controls compare each self CPU field with
readings from the same process and each child CPU field with the measured
children. Both counter scopes have valid boundary and invalid numeric cases.
Artifact controls exercise file identity during capture and recheck both the
binding and its build receipt after native loading.

Prepare it with
`node scripts/prepare-native-child-resource.mjs /absolute/private-empty-directory /absolute/canonical-node-header-directory`.
The explicit existing header directory is an operator input. Preparation hashes
the actual compiler, own C source, produced binary, Node executable and five
selected Node header files, then publishes `native-child-resource/{binding.node,build.json}`
together. Failed compilation removes owned staging. Those selected header hashes
do not constitute a complete SDK or publisher closure.

`loadNativeChildResource` accepts that canonical private caller-owned bundle and
checks exact artifacts, metadata, current C source and binary hashes before loading.
It rechecks binary and receipt bytes after loading. Its `snapshot()` takes no
arguments. Preparation and native loading require operator authority; this does
not add an MCP permission or execute repository project source.

[The counter measurement](measurements/native-child-resource-2026-10-11.json)
records original controls on macOS Node 24/26 and Linux Node 22, in source and
fresh offline production installation layouts. Package engine bytes are checked
against source; these counter controls execute the external harness and do not
exercise installed-engine validation. The unchanged external harness compiles outside
a fresh collecting worker. Two sequential children touch 64 and 96 MiB and perform
CPU work; assertions compare their own reported counters with the parent's kernel
counters, distinguish child CPU from self CPU, and reject summing child RSS peaks.
Eight paired guard removals fail for their intended assertions and pass on restoration,
including the fresh-worker boundary that excludes compiler children.
The current namespace-init, separate CPU-field, numeric-boundary and artifact
lifecycle regressions extend those original callbacks. The dated measurement
retains its original source and callback bindings.

`RUSAGE_CHILDREN` describes reaped child resource accounting. It is not summed
concurrent process-tree RSS, and this foundation does not establish coverage of
unreaped descendants. The binding and harness remain outside the product package.
Representative workload, output/archive storage, Windows and final release checks
remain pending. Gate A stays open; no inference or field evaluation was invoked.

## Synthetic native workload and archive measurements

`node scripts/measure-native-resources.mjs --node-headers /absolute/canonical-node-header-directory --samples 5`
prepares the own observer and counter binding, creates original fixtures outside
the measurements, and runs five to thirty samples per case in rotated order.
Each sample uses a fresh worker and the shared bounded process runner. The small
fixture imports ten JavaScript modules, the large fixture imports a thousand and
emits Unicode output, and the polyglot fixture executes both JavaScript and native
Go tests. The Go profile requires the actual Go 1.27.1 executable, records its
hash/version, and declares `GOCACHE`; the operator worker supplies a private cache
through existing engine environment permissions. The engine's allowlist is preserved.

[The workload measurement](measurements/native-resource-workloads-2026-10-11.json)
retains the original native control ledger and each sample on macOS Node 24/26 and
Linux Node 22, in source and fresh offline production installation layouts.
Unlike the counter-only controls, these workload controls invoke the actual
source or installed engine. Compiler preparation, fixture creation and the initial
harness inventory precede validation counter collection. Separate kernel self and
reaped-child CPU counters cover validation; peak RSS describes the worker lifetime,
not a memory delta. The outer `wait4` receipt covers the whole worker, including
startup and later durable storage, and binds its actual PID and terminal status.
Neither RSS scope is a sum of concurrently resident processes. Unreaped descendant
coverage remains unverified.

Every selected check must pass its original non-skipped test with unchanged source
and complete physical output. Failed, skipped, stale, malformed or truncated
results cannot become measurements. Retained stdout/stderr lengths and hashes
must reconcile with observed process bytes. The measurement exposes counts and
hashes, retaining raw reports, output and local paths privately.

The worker records exact report JSON bytes, inline envelope bytes, archive bytes,
chunk count and the physical SQLite store files after closing the store. Every
large sample reaches multi-chunk storage; reconstructing its chunks must match the
complete report's bytes and hash. Validation counters exclude those later writes;
the outer observer includes them. Physical database storage and logical archive
bytes are distinct quantities. Go build-cache storage is not counted as archive
storage. Its private profile cache is shared across samples, filesystem warmth is
uncontrolled, and no engine validation result is cached. No regression budget or
representative real-project performance conclusion is inferred from these samples.

Broken tests, source changed during a test and changed prepared bindings have
original native controls. The dated measurement retains seven original paired
removals for pass admission, freshness, raw output digest/byte accounting, snapshot
worker identity, the preparation boundary and physical database byte accounting.
Current accounting controls extend those callbacks with independent self and
child CPU fields, absolute RSS in both scopes, both raw streams, canonical base64,
process failure flags and valid zero and numeric-boundary cases. Compiler/SDK/standard-library
and publisher closures, Windows, final schema/package/privacy/upgrade readiness
and the whole resource-release-readiness profile remain pending. Gate A stays open;
no inference, field evaluation, tag or publication was performed.

## Experimental Windows process and job counters

The Windows supervisor can attach `resources` to its execution receipt after
confirming that its owned job has no active processes. `GetProcessTimes` supplies
the direct target's user and kernel CPU; `QueryInformationJobObject` supplies
separate job totals, including terminated members. These retain native 100 ns
ticks without rounding. `GetProcessMemoryInfo` supplies the direct target's peak
working set in bytes. That memory value excludes a sum of descendant peaks and
must not be described as job commit, total process-tree RSS or a validation-only
memory delta. The launcher and supervisor are outside the target job counters.

An API refusal or unsafe counter produces an explicit unavailable resource
record with its stage and observed native error. A zero last-error value stays zero; an engine counter-bound refusal has no native API error and records `null`. It supplies no invented successful zero
measurement and does not change the target's execution result. Required resource
measurement must reject unavailable counters. A nonzero target exit remains a
nonzero exit even if its resource counters were collected.

The fixed C# source now travels through a bounded, exclusively created file in
the runner's owned temporary namespace. The supervisor reads at most the expected
source byte count plus one, checks its embedded SHA-256, and compiles those exact
bytes before the project target resumes. This keeps the fixed encoded launcher
within the existing command-length allowance. Project arguments remain JSON data.
The existing namespace lifecycle removes the source along with other owned files. The namespace receives the existing native caller-only ACL before any data write, including when its selected temp parent has a broader read ACL. An access failure refuses before data or process launch. Portable ordering/refusal controls and the native broad-parent access-guard
removal have [recorded source and offline installed acceptance](measurements/windows-resource-foundation-2026-10-26.json)
on Windows with Node 22.23.3. The same observation records the native counter,
fixed-source integrity and retained ownership controls with removed/restored guards.
It is dated foundation evidence, not current package, representative workload,
whole-profile or final runtime-matrix qualification.
These controls are execution ownership and integrity checks; executed project code
is not sandboxed.

Portable contracts cover counter precision, numeric boundaries, incomplete
records and unavailable API stages. Native Windows witnesses compare target and
job CPU after two reaped children, compare direct peak working set with the
target's own observation, and preserve a deliberately failed target exit.
Windows qualification and the whole resource-release-readiness profile remain
pending. No resource performance budget or release readiness is established by
these prepared controls.

API contracts: [process CPU](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes),
[job CPU](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information),
and [working-set counters](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters).

## Prepared Windows workload measurement

The operator-only `measureWindowsResourceSample` export in
`scripts/measure-windows-resources.mjs` measures the original small, large and
polyglot fixtures through the actual engine in a fresh Windows worker. The
polyglot fixture requires the actual Go 1.27.1 executable and retains its version
and executable digest before and after execution. The operator worker receives a path containing only the verified Go and Node
executable directories; the host path remains unchanged. A deliberate second
`go.exe` still triggers the ordinary ambiguous-executable guard, while the
measurement worker uses its explicitly selected tool path. Fixture construction and
inventory capture precede validation counters. A private per-sample Go cache is
outside archive-byte accounting.

Separate self CPU readings use microseconds; native direct-process and job CPU
retain their original 100 ns units. Distinct validation jobs are summed only for
CPU. Direct target working-set peaks use the maximum observed lifetime peak and
never a sum of process-tree RSS. Tool-version invocations remain in physical
output and job accounting; an identical receipt alias is counted once, while
contradictory reuse is refused. The outer job binds the actual worker PID and
covers startup, validation and later storage.

Every original check must pass with complete native execution and physical
stdout/stderr. Broken or stale validation is refused before publishing task
storage. The worker reconstructs large archived reports byte for byte, checks
chunk and report digests, and measures physical SQLite files after closing the
store. Logical report/archive bytes and physical store bytes remain distinct.
Only counters, relative store names, counts and hashes are returned; raw reports
and local fixture paths remain private.

Portable controls cover CPU boundaries, unavailable native receipts, contradictory
job identities and malformed physical streams. These newly prepared workload
controls still require native Windows source and fresh-package acceptance. They
do not establish representative project performance, a regression budget, final
runtime-matrix qualification or the whole resource-release-readiness profile.
