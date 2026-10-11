# Native resource accounting

The repository-owned POSIX observer supplies a bounded resource receipt for one
child reaped through `wait4`. It records the actual observer and child PIDs,
monotonic elapsed time, kernel user/system CPU counters, exit code or signal, and
raw and normalized peak RSS. Darwin raw RSS is converted from bytes; Linux raw
RSS is retained in KiB. A failed or signalled child remains failed or signalled.
A completed receipt is evidence of collection, not successful validation.

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
polyglot/native workload accounting, separate child counters, output/archive
storage accounting, Windows measurements, final schema/package/privacy/upgrade
readiness and the resource-release-readiness profile remain pending.

[The scoped measurement](measurements/native-resource-observer-2026-10-11.json)
records the original required controls on macOS Node 24 and 26 and Linux Node 22,
against source and fresh offline production installs of the unchanged runner.
The unchanged repository harness stays outside each installed package. Paired
mutations prove the nonce, RSS normalization, canonical record, private file,
native kernel counter, exclusive creation and failed-compilation cleanup guards.
Linux receipts bind the borrowed immutable local compiler image and actual Node,
compiler and observer executable hashes; they do not certify its artifact or
license closure. Owned measurement containers were removed and the borrowed image
was preserved. Windows acceptance and Gate A remain open. No inference or field
evaluation was run.
