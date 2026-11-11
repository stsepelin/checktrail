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

The native timeout and direct foreground observer share this wall limit. At its
expiry the observer can stop the native container before its EXIT retention trap
finishes. Such an attempt remains incomplete; the observer's numeric exit status
does not establish the original package command's exit code or signal.

Current controller receipts use schema 2. Independent exclusive journals record
that command invocation was requested and, when observed, the genuine package
command exit before report collection and archive retention. A requested marker
alone never proves that the command ran or completed. The retained build
directory has a held descriptor; its identity must match before execution and
after positive producer stop. This is a boundary check, not a continuous trace
of build contents.

The C observer counts link and special-file entries without following them in
the writable build tree. Immutable inputs remain strict. Its fixed policy uses
ten-second sampling, at most 9,000 samples and a 256MiB transport bound. Its
separate observer container receives two CPUs, 128MiB and 16 PIDs for complete
scans under the existing 30-second deadline. Operators must include this CPU
allocation in their aggregate admission budget. The strict binutils observer
retains its quarter-CPU allocation. These are retained observations, not a peak
filesystem quota. Legacy controller
schema 1 keeps its original 16MiB transport bound; a receipt cannot select its
own limits.

After observing producer absence, an interrupted or incomplete attempt can run
a separate bounded Python report collector. It reads the retained build tree
without executing upstream code and writes a fresh report family. Original-trap
and post-stop reports retain separate manifests and paths. The version-3 report
transport preserves every original byte in independently hashed gzip chunks,
with at most 1 MiB decoded per chunk. Stored chunks keep the 64 MiB member and
512 MiB per-family bounds; each manifest has a separate 8 MiB bound. The closed
[c-report-encoding.v1.json](../scripts/producer-qualification/c-report-encoding.v1.json)
policy permits at most 512 MiB decoded per logical file, 2 GiB per family and
4 GiB across the original-trap and post-stop families. These decoded limits are
explicit new policy, separate from the unchanged historical raw-byte limits.
The receipt selects one family for outcome reconciliation; duplicate outcomes
across families are not added.

Both readers verify stored and decoded chunk identities, sequence and offsets,
then exhaust every report and associated log before checking the whole original
file identity. Truncated or concatenated streams, trailing data, missing chunks,
wrong log associations and incorrect outcome counts refuse completeness. A
failed capture publishes no complete manifest; available chunks remain partial
diagnostics. Verified canonical collector source pins select the report format.
Only the closed historical collector identities admit the legacy raw format;
a report or archive field cannot downgrade current or unknown source.
Missing command terminals, collection failures or incomplete cleanup remain
incomplete even when useful reports were recovered. Schema-2 raw exports retain
both available families, the command journals and the separate collector log.
Live verification validates the selected report family and the journal and
collector-log custody. Offline replay also reconciles both retained report
families independently.
An unreadable controller receipt can still be exported as unverified raw data,
which cannot qualify a completed original build.

The operator boundary captures the actual POSIX caller UID/GID. The collector
hands over only its exclusive new report/log chunks and manifest as0600 files
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

The selected GCC operator envelope allows twelve hours. This wall limit is an
operator choice; it does not change the original source, command, parallelism,
optimizations, default targets or tests. Receipts bind their exact catalog and
recorded limits; a longer selected envelope does not promote an older incomplete
attempt to a completed original build. GitHub-hosted
jobs have a [shorter platform limit](https://docs.github.com/en/actions/reference/limits); a hosted carrier may complete the unchanged
command before its cutoff, but cannot establish full twelve-hour platform
support. A cutoff is incomplete external-platform evidence. An existing
operator-provided native Linux x64 carrier is needed to support the full
profile. The hosted observer does not provision infrastructure or establish
full twelve-hour platform support. Native acceptance remains separate from
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

These receipts keep their compiler/SDK bootstrap, original notice and Gate A
closure fields unverified. Completion requires the finite selected original
producer/compiler/SDK builds, source attribution, original notices and intended
consumer evidence. Published binary equality, historical publisher consumption,
full repository history, ambient toolchain inventories and hardware certification
are outside that completion contract; historical unverified fields do not add
those requirements.

## Local GCC execution with an ARM daemon

The direct GCC qualifier also accepts the additional operator flag
`--allow-local-arm64-daemon`. It requires both execution flags and the unchanged
selected GCC12 source, command, twelve-hour budget, resources and pinned amd64
image. The default daemon architecture check remains x64; this opt-in admits
only the separately observed `aarch64` daemon with sufficient CPU and memory.
Preparation, GLIBC and unknown option combinations refuse the flag.

The controller must still report an actual Linux x64 Node runtime and x86_64
kernel view. Receipts retain raw daemon metadata alongside these observations,
the selected permission and the unknown emulation implementation. They do not
attest physical CPU architecture. The daemon policy is checked again after the
original command. A same-path, case-sensitive Linux volume and complete native
execution evidence remain separate prerequisites; the flag alone establishes
none of them. No local ARM-daemon GCC build is qualified by these source controls.

## Separate local GCC execution context

`--execution-policy local-gcc12-12h-v1` selects the separately pinned
[gcc-local-12h-policy.v1.json](../scripts/producer-qualification/gcc-local-12h-policy.v1.json)
context. Its native deadline remains the source profile's 43,200 seconds, with
unchanged command, CPU, memory, PID, work and log limits. It gives the controller
44,400 seconds for setup, the 43,290 second producer observation, post-stop
collection and finalization. The local carrier observes for 44,460 seconds and
reserves 600 seconds for cleanup and 1,200 seconds for export/replay. Together
with the 540 second bootstrap allowance these require an exactly 46,800 second
(13 hour) declared managed window.

The same operator-trust, coordinated heavy-slot, local ARM-daemon, startup,
capacity and source-pinning checks apply to both local policies. A new twelve-hour
carrier receipt records `executionPolicyChangesWallDeadline: false`; the
historical twenty-three-hour context records `true`. Selecting a policy or passing
synthetic controls does not establish that a native compiler completed. A hosted
carrier cutoff stays incomplete and cannot be relabeled as a full local run.

The following describes the preserved historical twenty-three-hour context.

`--execution-policy local-gcc12-23h-v1` selects the closed
[gcc-local-wall-policy.v1.json](../scripts/producer-qualification/gcc-local-wall-policy.v1.json)
context. It leaves the frozen catalog, source profile and its default twelve-hour
limits unchanged. A prepared plan and each new receipt separately bind the
selected policy and effective execution limits. Data-only preparation may inspect
this selection; execution also requires the existing operator-trust, coordinated
heavy-slot and local ARM-daemon flags. It cannot select GLIBC or a hosted job envelope.

The fixed native deadline is 82,800 seconds, with the existing 30 second GNU timeout
kill allowance. Preparation, the original command and its EXIT retention all consume
that same native allowance. The controller observes the producer for 82,890 seconds
and reserves time for the independent post-stop report collector and finalization.
Its setup, original observer, collector and finalization share one 84,000 second
monotonic controller window. Recovery cannot reset it. A preparation refusal clears
the pending controller timer; an exhausted collector allowance refuses a new collector.

The local carrier additionally requires `--managed-started-at` and
`--managed-deadline-at`, both canonical UTC timestamps, alongside the explicit
policy and ARM-daemon options. These are **operator declarations**, not an
attestation of the environment manager's lease. Their span must be exactly 24 hours.
The carrier captures UTC remainder once at entry, admits within the fixed bootstrap
allowance and subtracts its own monotonic elapsed time throughout observation and
cleanup. Its 84,060 second observation and 600 second cleanup leave at least 1,200 seconds
for export/replay inside the original declared window. The surrounding operator
must bind these declarations to the actual foreground start and TTL. Neither a
phase transition nor failed cleanup creates a fresh window. Insufficient remaining
time stays incomplete even if the compiler returned zero.

Fresh capacity admission still uses the existing filesystem observation. Raw build
files and the simultaneous EXIT worktree tar consume the same 64 GiB work allowance;
the policy does not predict peak size or export throughput, or claim a filesystem
quota. Bounded public evidence ZIPs continue to exclude binary package payloads
and the worktree tar. Full private raw retention remains separate work within the
original managed remainder.

Startup, live validation, export and offline replay must each explicitly select
this policy. Its extra pinned source is absent from legacy inventories; a receipt
cannot choose arbitrary limits or relabel a historical twelve-hour archive.
Synthetic timer, ownership and archive controls do not qualify a native 23 hour build,
full producer ancestry, original notices or Gate A closure.

## Opt-in hosted GLIBC observation

`upstream-glibc.yml` selects only the frozen GLIBC profile. Its narrow
`pr/upstream-producer/glibc-*` push namespace supports reviewed pre-merge
observations; dispatch becomes available after the workflow reaches the default
branch. It does not run for ordinary PR branches or select the GCC profile.
The job's six-hour carrier limit leaves preparation and export time around the
unchanged four-hour command budget. Platform cutoff or capacity refusal is
incomplete evidence. The original GCC twelve-hour profile remains unchanged and
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
GCC's original command, CPU, memory, targets and checks remain unchanged. The
selected operator wall envelope is twelve hours. The separate `gccCarrierLimits` controller window leaves time for
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

GCC report manifests use version 2 and select the literal `build`, `build-jit`,
`build-nvptx`, `build-gcn` and `build-hppa64` source directories. The existing
`build-cross` path remains an explicitly labeled compatibility root. Each root
records whether it was absent, present without reports, or present with reports;
these are collector observations, and replay checks their consistency with the
retained report inventory. Replay cannot independently establish whether an
original source directory was absent. None of these states establishes an
independent test run or complete coverage.
GLIBC report manifests retain version 1. Older GCC version-1 manifests remain
bound to their original source/runtime contract and cannot establish version-2
root coverage. They are not rewritten or promoted by the current verifier.

The original JIT recipe copies its reports into the main build tree. Both paths
keep their physical provenance; duplicate copies are not independent evidence.
Offload and HPPA64 build directories do not imply separate upstream test suites.
Original conditional checks, multilib probes, ignored check exits and optional
report repackaging/deletion remain unchanged. Configuration completeness stays
unverified until eligible phases and actual reports have been reconciled.
The fixed synthetic custody preflight still uses its separate GLIBC fixture;
it is not relabeled as a GCC upstream test. GCC does not select the GLIBC syscall
policy or its native predicate probes. A successful original command may retain
failed or unsupported test outcomes under its unchanged defaults. Full producer
ancestry, original notice closure, historical consumption and Gate A remain
unverified by the observer. Earlier GLIBC source revisions remain separate.

### Remaining whole-job envelope for a hosted GCC observation

The dedicated hosted job requests 355 minutes. Its metadata-only admission makes
one direct, bounded request for the current run attempt's singleton GCC job and
retains the original response before interpreting it. The job's actual start and
a fresh service clock determine the remaining envelope after preparation. Unknown,
stale, truncated or mismatched clocks refuse execution. The same carrier process
uses its monotonic clock to subtract metadata and retention time before spawning
the unchanged original controller.

The observation requests at most 330 minutes; this maximum is not a promise of
330 minutes of compiler time. Admission preserves ten minutes for producer cleanup,
five for observation completion, twenty for export, three for independent replay,
five for upload and five for runner finalization. It requires at least 270 useful
minutes immediately before original execution. Preparation consumes the same job
clock. The original producer command still has its 43,200-second deadline, original
resources, checks and export behavior. A carrier cutoff remains incomplete; natural
original completion can be assessed without claiming twelve-hour hosted capacity.
The job token is used only for metadata admission and is excluded from the original
controller's environment. No upstream build or new hosted observation is established
by the synthetic clock and transport controls.

The local GCC policy pauses the exact owned producer container during resource
measurements, verifies Docker acknowledged that paused state, then resumes it
before returning the measurement. This keeps temporary compiler/test files from
disappearing during the strict no-follow scan. The unchanged upstream command
and original wall deadline still include observation time. Every local sample
retains its container identity, pause/sample/resume actions and completion state;
a sampling or resume failure remains incomplete. Pre-admission and positively
observed post-terminal absence are separate cases. Default producer policies
continue to use their existing observer. This is a resource observation contract,
not a filesystem quota or a claim of compiler, test or notice closure.
