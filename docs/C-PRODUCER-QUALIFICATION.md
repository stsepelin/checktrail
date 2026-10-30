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
profile. No workflow, new infrastructure, or native acceptance is supplied by
this source-only slice.

Original result bytes and each report's outcomes remain separate by generated
path. Repeated top-level/subdirectory outcomes are not independent evidence.
Linked directories are excluded without traversing them and keep configuration
coverage incomplete. Unknown Automake metadata is retained without claiming
interpreted test outcomes. A successful original command does not require every
upstream test result to be PASS; failures, expected failures and unsupported
cases remain visible. A missing terminal observation or empty executed-result
inventory cannot become a successful completed-build observation.

All receipts retain compiler/SDK bootstrap, complete original notices,
historical publisher consumption and Gate A closure as unverified. Native runs,
their original configuration completeness, publisher output comparisons and
upstream producer ancestry remain required follow-up work.
