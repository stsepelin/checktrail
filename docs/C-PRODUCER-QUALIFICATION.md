# Original GCC and GLIBC producer preparation

These development scripts select the original Debian GCC12 source revision and
the GLIBC source revision matching the retained runtime package. The closed
catalog records exact archives, signed APT metadata, source descriptor signers,
and selected original notice/rule identities. Captured notice identities are
not exhaustive license closure. Earlier GLIBC source evidence has a different
Debian revision and is not relabeled as evidence for the selected revision.

Acquire the common signed APT/keyring inputs using the existing
`acquire-binutils-inputs.mjs` utility first. Its resulting `bundle` can supply
the common inputs below; no Binutils archive inventory or generic download
bound is changed. The C utility downloads only exact pinned public data and
copies the common byte-pinned metadata. The GCC source has its own finite
128MiB per-file admission limit. Transport success alone does not perform a
fresh signature check. Native extraction still requires valid source
signatures and strong checksums, and the original offline APT transaction
retains authentication and freshness checks.

```sh
node scripts/acquire-c-producer-inputs.mjs --profile glibc --common-inputs COMMON_BUNDLE --output NEW_INPUT_DIRECTORY
node scripts/qualify-c-producer.mjs --profile glibc --inputs NEW_INPUT_DIRECTORY/bundle --output NEW_ATTEMPT --prepare-only
```

Preparation reads and hashes data without executing subject source or invoking
Docker. Actual execution requires both `--operator-trust-execution` and
`--coordinated-heavy-slot` instead of `--prepare-only`, an observed Linux x64
host/kernel, the already available pinned image, and sufficient case-sensitive
retention storage. These are operator CLI choices; project data and MCP tool
arguments cannot grant execution.

Both profiles retain the original `dpkg-buildpackage -b -us -uc --jobs=4`
command, default languages, multilib targets and checks. The frozen CPU, RAM,
wall, retained-work and combined-log limits are machine-readable in the
catalog. The command wall includes dependency installation, extraction, original
build and its retention trap. Container cleanup has separate bounded observer
operations. Retained work is observed, not enforced by a native filesystem
quota. Input/control copies have an explicit additional retention allowance.

The operator boundary captures the actual POSIX caller UID/GID. The collector
hands over only its exclusive new report/log copies and manifest as0600 files
and0700 directories, using their verified file descriptors and directory inode
journal. It does not change source/build-tree permissions or use recursive
ownership changes. The host independently checks actual copy ownership and
modes before parsing. Failed collections attempt the same handoff for partial
copies and preserve the original diagnostic alongside any custody failure.

Before an original build, the controller runs a separate bounded synthetic
export preflight using the same pinned image and collector. Actual host reads,
UID/GID and mode checks must succeed before the hours-long command can start;
user-namespace/rootless ownership mismatches refuse the build early. A root
caller is admitted but is never reported as a nonroot cross-UID proof. Local
same-UID data controls do not qualify native Linux root-container/nonroot-host
handoff. That native preflight remains unexecuted for this source-only slice.

The GCC profile retains its original eight-hour command budget. GitHub-hosted
jobs have a [shorter platform limit](https://docs.github.com/en/actions/reference/limits); a hosted carrier may complete the unchanged
command before its cutoff, but cannot establish full eight-hour platform
support. A cutoff is incomplete external-platform evidence. An existing
operator-provided native Linux x64 carrier is needed to support the full
profile. The hosted observer does not provision infrastructure or establish
full eight-hour platform support. Native acceptance remains separate from
source and synthetic protocol controls.

Original result bytes and each report's outcomes remain separate by generated
path. Repeated top-level/subdirectory outcomes are not independent evidence.
Linked directories are excluded without traversing them and keep configuration
coverage incomplete. Unknown Automake metadata is retained without claiming
interpreted test outcomes. A successful original command does not require every
upstream test result to be PASS; failures, expected failures and unsupported
cases remain visible. A missing terminal observation or empty executed-result
inventory cannot become a successful completed-build observation.
A resolved PASS, FAIL, XFAIL or XPASS outcome and a physically nonempty package
are required. Skip-only, unsupported, untested, unresolved or error-only reports
remain unavailable; FAIL and XPASS results retain an explicit failed-evidence
state without being discarded or reported as passing tests.

All receipts retain compiler/SDK bootstrap, complete original notices,
historical publisher consumption and Gate A closure as unverified. Native runs,
their original configuration completeness, publisher output comparisons and
upstream producer ancestry remain required follow-up work.

## Opt-in hosted GLIBC observation

`upstream-glibc.yml` selects only the frozen GLIBC profile. Its narrow
`pr/upstream-producer/glibc-*` push namespace supports reviewed pre-merge
observations; dispatch becomes available after the workflow reaches the default
branch. It does not run for ordinary PR branches or select the GCC profile.
The job's six-hour carrier limit leaves preparation and export time around the
unchanged four-hour command budget. Platform cutoff or capacity refusal is
incomplete evidence. The original GCC eight-hour profile remains unchanged and
is not selected by this carrier.

The hosted job first captures a byte-bound committed operator source frame and
actual nonroot caller. It acquires the original authenticated Binutils bundle
to obtain the common APT/keyring inputs, then acquires the exact GLIBC inventory.
The existing root-to-nonroot custody preflight must succeed before the original
build. A live reconciliation separately rehashes package outputs, reports,
process/observer logs, source and harness files before writing its scoped
observation. Original failed, expected-failed and unsupported outcomes remain
unchanged; every upstream result need not be PASS for the original command to
have succeeded under its own defaults.

The C exporter preserves complete declared report/log members up to64MiB each
and512MiB aggregate, plus the bounded original build log, raw custody preflight,
observer transport, original command/installed-package manifests, admission
diagnostics and public operator harness. It retains failed/partial attempts
with missing or inaccessible members listed explicitly. Large input payloads,
binary packages and native worktree archives are excluded. Their live physical
identities remain observations; archive replay cannot rehash excluded payloads.

Offline replay never executes transported code. Use the reviewed checkout of
the exact original operator source revision:

```sh
python3 -I -S -B scripts/producer-qualification/c-producer-replay-evidence.py --profile glibc --repository REVIEWED_SOURCE_CHECKOUT --archive glibc-evidence.zip
```

Replay checks every exported raw hash, actual recorded native copy ownership,
source/Git binding, original terminal, separate report outcomes and durable
observer request/response sequence. Downloaded ZIP file owners are not relabeled
as native owners. Missing original terminal or nonempty observed package output
refuses a completed-build observation. A valid raw failure archive remains
incomplete. Complete configuration, original notices, publisher consumption,
compiler/SDK ancestry and Gate A flags remain false. The hosted carrier and its
native custody acceptance have not yet been executed for this source slice.

The GLIBC carrier admits only the reported Linux/amd64 Docker28.0.4 Engine
build6430e49 with its builtin seccomp profile. The original Moby profile,
LICENSE, NOTICE and AUTHORS bytes are pinned under
`scripts/producer-qualification/moby-28.0.4/`. The derived GLIBC-only policy
retains every original rule and adds exactly two argument predicates:
`clock_settime(1, ...)` and `personality(0xffffffea)`. No capability is added;
SYS_TIME and SYS_ADMIN must be absent from the effective, permitted and bounding
sets before the fixed probe can call either setter. The realtime near-miss uses
an invalid nanosecond argument, never a valid time-changing argument.

The invalid realtime control calls raw Linux x86_64 syscall 227 after checking
Linux, machine and LP64 timespec layout. The
[libc wrapper validates nanoseconds before its syscall](https://github.com/bminor/glibc/blob/glibc-2.36/sysdeps/unix/sysv/linux/clock_settime.c),
so its local EINVAL cannot witness kernel-policy denial. The
[x86_64 syscall table fixes the raw number](https://github.com/torvalds/linux/blob/v6.14/arch/x86/entry/syscalls/syscall_64.tbl).
Docker inspection also compares the exact compact generated policy body that
the [Docker client sends for `seccomp=file`](https://github.com/docker/cli/blob/v28.0.4/cli/command/container/opts.go),
while the original command vector retains the pinned file argument.

Before the unchanged upstream command, separate default-policy and derived-policy
containers must complete the fixed operator probe. The probe preserves the
original BZ19408 errno sentinel and legitimate negative persona return, checks
the monotonic EINVAL behavior, and requires the neighboring persona and realtime
arguments to remain denied. Both raw logs, complete terminals, image identities,
unchanged capability sets and cleanup are bound into the receipt and independently
replayed. An unknown Docker build/profile or failed probe refuses the original
build. Native acceptance of this revised carrier remains pending; reported Engine
metadata does not attest the daemon's profile bytes or historical consumption.

## Opt-in hosted GCC observation

`upstream-gcc.yml` uses only `pr/upstream-producer/gcc-*` pushes or operator
dispatch after default-branch merge. Startup, live observation, export and replay
all bind an explicit closed profile name to the frozen source/version/catalog.
GCC's original command, eight-hour timeout, CPU, memory, targets and checks remain
unchanged. The separate `gccCarrierLimits` controller window leaves time for
bounded cleanup and transport within the hosted job. Fresh capacity admission
is read-only and refuses insufficient observed storage before original execution.

The carrier uses the original controller's early atomic owner receipt to bind
its UUID and source frame before signaling or cleaning any container. Original
controller terminals, carrier logs, cleanup and owner snapshots remain separate
from the original package command. A carrier cutoff, interrupted observer,
missing original terminal, empty package or failed command cannot become a
completed-build observation. Raw logs and any available reports/partial files
are exported with missing members explicit; force-removal can preempt the
retention trap and does not prove that complete reports were retained.
The Node controller has its own POSIX process group. The carrier must observe
that group absent and reap the controller before owned container cleanup;
stopping only the direct child is insufficient. Both exit paths share one
cleanup attempt and a single monotonic deadline within the ten-minute reserve.
Unknown family absence or an exhausted reserve remains incomplete.

Real GCC reports use their selected `build` and `build-cross` configurations.
The fixed synthetic custody preflight still uses its separate GLIBC fixture;
it is not relabeled as a GCC upstream test. GCC does not select the GLIBC syscall
policy or its native predicate probes. A successful original command may retain
failed or unsupported test outcomes under its unchanged defaults. Full producer
ancestry, original notice closure, historical consumption and Gate A remain
unverified by the observer. Earlier GLIBC source revisions remain separate.
