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
