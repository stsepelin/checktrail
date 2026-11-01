# Original Node source producer

The operator-only [controller](../scripts/qualify-node-original-producer.mjs)
prepares one prospective Linux x64 observation of the exact Node 22.16.0 source
archive. The [closed profile](../scripts/producer-qualification/node-original.v1.json)
binds the public archive, documentation dependency archives, image and selected
compiler/interpreter/tool bodies. This profile is separate from product discovery,
CLI/MCP project validation and the web-runtime publisher recipes. Its existence
and generated regressions do not establish a successful native Node build.

The [dedicated workflow](../.github/workflows/upstream-node-original.yml) runs
only on explicit dispatch or a push to `pr/upstream-producer/node-original-*`.
Its isolated runner acquires its own exact public bytes; it never needs an
operator's private index, paths or staging receipts. Acquisition uses fixed HTTPS
URLs, whole-body hashes and finite request/body limits, with no redirects or
retries. The selected source identity comes from the previously authenticated
release; this acquisition does not execute a fresh signature verification.

The bounded XZ bridge verifies the complete compressed archive and expected
expanded intervals before interpreting the tar. It preflights the complete
selected source member set, then materializes the original source names, modes,
file and directory mtimes, empty files, UTF-8 names and GNU long-name records.
It derives new relative native member identities. These are new observations,
not a relabeling of a local retained index. Archive owner metadata and actual
materialized ownership remain separate.

The original command sequence is:

```text
./configure
make -j4
make test-only
```

`CC` and `CXX` remain unset. Metadata admission binds the original Linux
`gcc`/`g++` PATH lookups and the first available configure Python candidate to
the selected exact bodies. The actual `/bin/sh` resolution and optional gold
probe are recorded separately. No published Node executable is mounted into the
producer. After `make -j4`, the freshly built Node runs its original bundled npm
serially to add each exact local documentation archive into an owned cache.
The original `make test-only` recipe and its npm audit, lifecycle and fallback
arguments remain unchanged. Original/cache stages use the normal bridge network;
metadata preparation uses no network. Project execution is operator-authorized.

The prospective body profile admits four CPUs, 8 GiB memory, 1,024 PIDs and a
7,200-second shared work window, followed by a 300-second finalization reserve.
The independent observer counts the selected owned work tree under a 32 GiB
bound. This is an observed bound, not an instantaneous filesystem quota. It
counts build-created symbolic-link target bytes without following their target
contents, and counts mutable-work Unix socket objects without opening or reading
their endpoints. Immutable inputs and other nonregular work objects stay strict. Original stdout/stderr share a 256 MiB retained-log ceiling. Selected
output hashes stream under the declared work bound; this is not a claim about
whole-process RSS, loaded-library closure or an output's unmeasured native size.

The controller retains actual native container configuration/state, raw process
logs, source/image/input checks and selected output identities. It preserves a
copy of the freshly built Node before tests can change the source work tree.
Original test failures, skips and unrun groups remain in their reached raw
results. A completed source build is separate from every upstream test passing.
The observation verifier requires the scoped controller exit, natural original
command terminals and completed cleanup; it never upgrades a timeout, empty
result or unavailable observation to completion.

Publisher binary equality, historical producer consumption, full compiler/SDK
bootstrap ancestry, complete original notices and Gate A closure remain open.
