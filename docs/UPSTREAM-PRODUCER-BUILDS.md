# Original upstream producer builds

Gate A retains complete upstream compiler, SDK, bootstrap and original-notice
closure. An authenticated release, a successful source build, matching delivered
bytes, passing upstream tests and complete notices are separate evidence.

The initial development controller selects one finite producer: the original
Debian binutils 2.40-2 binary-package build. It preserves the source descriptor,
source archives, pinned image, complete selected dependency transaction, source
keyring and original command. It does not acquire inputs or execute from
discovery, planning, the published CLI or MCP. It is an explicit trusted-operator
repository maintenance command. Upstream package code executes with the supplied
container privileges and mounts; this is not a security sandbox for that code.

## Input preparation

[scripts/producer-qualification/binutils.v1.json](../scripts/producer-qualification/binutils.v1.json)
lists every required relative filename, byte count and SHA-256. Arrange those
exact public inputs beneath a separate bundle directory. Source download URLs
are recorded for the original source descriptor and archives. Dependency files
and signed APT metadata retain their exact selected filenames and hashes. The
recipe also records explicit public download locations for the dependency archives,
canonical Packages payloads checked against the pinned InRelease files, and the
original developer source-signing keyring package and member. The developer
keyring is distinct from the image-provided APT archive keyring. Empty generated
lock files are classified separately from downloaded archives.

The retained [APT preparation record](../scripts/producer-qualification/binutils-apt-index-preparation.v1.json)
binds fresh content-addressed Packages downloads to the signed canonical payloads
and exactly reconstructs the retained compressed indexes through the original
image-provided APT store method. It retains the exact control bytes and original
archive-keyring identities. Original release signatures verify with that archive
keyring; changed signed text fails and the unchanged original verifies again. An
earlier helper-based compression attempt did not reproduce every pinned compressed
file and remains a failed attempt. No compiler build ran and no pin was replaced.

The retained [input reacquisition record](../scripts/producer-qualification/binutils-input-reacquisition.v1.json)
records a fresh download of every required public object through the official
Debian Snapshot file API, followed by exact index regeneration, bounded regular
keyring-member extraction and an independent full bundle check. Each recipe
download records its immutable Snapshot location. SHA-1 selects the server object;
the frozen SHA-256, byte count and original signatures remain the integrity checks.
The two empty locks are generated locally. Downloaded-object and final-bundle
partitions are recorded separately because compressed index inputs and the
developer-keyring package become different final files.

Availability was observed at that record's timestamp; future execution still
requires all exact pinned bytes. The controller does not replace an expired or missing
snapshot with current packages,
disable authentication/freshness, or install on the host. Changed pins require a
reviewable recipe revision. Extra bundle files are not staged or executed.

Print the exact input operations before arranging the bundle:

```sh
node scripts/producer-qualification/binutils-acquisition-plan.mjs --plan-only
```

The planner checks local controller pins and records the frozen Snapshot downloads,
original APT transformations, fixed keyring member and empty locks. Its output binds
the transform image and retained preparation record, with a complete input partition.
It reports declaration coverage and local integrity; remote availability, produced
files and compiler builds require later execution evidence.

The separate explicit input utility performs that plan:

```sh
node scripts/acquire-binutils-inputs.mjs --output /absolute/new-input-attempt \
  --operator-trust-execution
```

It requires a POSIX host and the exact selected image already acquired locally.
[Raw registry metadata](../scripts/producer-qualification/binutils-image-identity.v1.json)
binds the selected manifest to its config and filesystem layers. Admission accepts
the manifest-ID and config-ID forms observed from Docker only with that same
pinned filesystem and exact repository reference. The older preparation record's
local image ID remains a historical observation, not a portable ID assertion.
Four workers download fixed Snapshot objects with exact SHA-256 and byte counts;
a failed or interrupted download cannot publish its final file. The original
image's APT store method regenerates the indexes without network access or package
installation. Original archive and developer signatures, canonical payloads and
rejected signature mutations are checked independently. Every original bundle file
is rehashed before the complete bundle is published. Failed attempts retain their
receipts and bounded private partial files.

The data transform has one CPU, 512 MiB, 64 PIDs and a two-minute deadline. Input
acquisition has a thirty-minute cancellation signal and per-file deadlines. Final
hashing and owned cleanup also run before publication. A monitored retained-byte
ceiling is distinct from a filesystem quota; no quota is claimed. These operations
compile no source and do not close producer or notice ancestry.

Use a managed foreground lease for every agent invocation. Preparation can run on
other hosts and only inspects data:

```sh
dev-env run --ttl 7200 TASK -- node scripts/qualify-binutils-producer.mjs \
  --inputs /absolute/public-input-bundle --output /absolute/new-result-directory \
  --prepare-only
```

Preparation validates all pinned inputs and the new destination, prints its plan
and creates no output directory. A missing, changed, linked or nonphysical input
fails before execution or publication. Input and output roots cannot overlap;
existing output directories are refused. The destination parent must already
exist. No executable, image, build-command or remote-Docker override is accepted.

## Explicit build

Actual execution additionally requires observed Linux/x64 Node, an x86_64 kernel,
a local Linux/AMD64 Docker daemon at `/var/run/docker.sock`, the already available
pinned image, a case-sensitive output parent and sufficient declared retention
capacity. These observations are not hardware attestation or independent emulator
qualification. The source tree is extracted in the container's Linux filesystem;
the original `Elf.h`/`elf.h` case distinction is verified before the build.

Omit `--prepare-only` to run the fixed command. The controller stages verified
copies, mounts source/keyring/controller inputs read-only, retains the original
APT/source authentication checks and runs:

```sh
dpkg-buildpackage -b -us -uc --jobs=4
```

Default targets and tests remain enabled. Only local output signing is disabled,
as in the selected original recipe. Docker runs in the foreground with no network,
fixed CPU/memory/PID bounds and an internal deadline as well as the host observer.
There is no detached child session. Cancellation, timeout, output exhaustion and
retention failures stop the owned container, with exact owner-label checks before
cleanup. The direct `dpkg-buildpackage` exit, wrapper/Docker exit and observer stop reason
are retained separately. The final receipt is replaced atomically after signal handling and
cleanup; an interrupted or stale `running` receipt cannot qualify a build.
A hard crash may prevent a terminal receipt, so retained ownership/receipt data
must be inspected rather than inferred to indicate success.

The retained-byte monitor covers staged inputs and produced files using a separate
foreground observer in the pinned immutable image. Its three mounts are read-only;
network access is disabled and its only added capability is `DAC_READ_SEARCH`, so
APT's private directories can be counted without changing their ownership or mode.
The observer has separate 0.25 CPU, 128 MiB and 16 PID bounds; each complete scan
has a 30-second deadline and finite entry/depth limits. Missing, unreadable, linked,
nonregular, stale or incomplete observations stop the original producer. Complete
request/response logs and exact owner-checked cleanup are required for a successful
build observation. A native Linux synthetic preflight first demonstrates actual
host permission denial and accurate counting of a private UID42 directory.
The selected recipe does **not** enforce a native container-filesystem disk quota;
that limitation stays explicit. Cleanup failures stay failures. Do not run these long
compiler builds alongside the timing-sensitive local native test suite.

## Reading the receipt

The private result directory retains `receipt.json`, bounded original process
output, exact output-package identities, the original case-preserving build tree
and per-file DejaGNU `.sum` and Automake `.trs` identities/counts. Associated
logs are retained and byte-bound separately; an Automake result requires its log.
Result files are limited to 1 MiB each and logs to 8 MiB each, beneath the aggregate
retention bound. The reader independently rederives all status/metadata fields
from physical bytes, including Automake skip, unexpected-pass and error outcomes.
A passed report cannot cover for another report with no executed non-skipped test.
Repeated configurations are not pooled into independent tests. Missing/empty
reports, contradictory metadata and unexpected outcomes cannot count as passing
evidence. Complete PGO/Automake phase selection remains separately unassessed. The report collector records observed generated
`builddir-*` configurations; it does not assert an independently complete
configuration inventory.

Preparation exits zero on successful data validation. Actual execution currently
returns a nonzero, explicitly incomplete qualification status even when the
original package command succeeds: the independent expected configuration/test
inventory is not yet closed. That limitation cannot be converted to passing
qualification by an observed report list alone. Original Debian rules can complete
the package build while retaining upstream test failures or skips. The receipt
preserves those test outcomes separately from package-command completion; it does
not turn them into passing tests or impose a different upstream test policy.

A completed original package command is distinct from publisher binary equality,
which is not assessed by this controller. Compiler/bootstrap/base-image ancestry
and complete original embedded/dependency notices remain open. All full-closure,
Gate A, inference and field-evaluation flags remain false. Synthetic controller
regressions demonstrate refusal, cancellation and accounting behavior only; they
are not native producer qualification.

The retained original Debian rules supply a static expected build-configuration
set and minimum explicit package-check report paths in
`binutils-expectations.v1.json`. Missing configurations or mandatory reports fail
even if the wrapper exits zero. Those minimums do not replace the still-open
complete PGO/Automake test inventory. The original rules retain their complete
upstream copyright and permission text.

The [dedicated upstream workflow](../.github/workflows/upstream-binutils.yml)
selects this one original producer on a Linux x86-64 hosted runner. It runs only
through an explicit dispatch or a push to `pr/upstream-producer/binutils-*`; ordinary pull
requests retain their existing validation jobs. Image acquisition, exact public
input preparation, the original package defaults and physical receipt reconciliation
remain separate stages. The frozen original command, native resource limits,
authentication and default upstream checks are preserved.

Standard [hosted-runner storage](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
is smaller than this producer's frozen work-retention ceiling. This dedicated job
reclaims a fixed list of unrelated preinstalled SDK directories only when measured
capacity is insufficient, and only after checking
that it runs on a disposable GitHub-hosted Linux x64 VM. It refuses linked roots
and does not prune shared Docker storage. The original producer still checks
actual available capacity before starting; its resource and retention limits are
unchanged.

The development producer controller deliberately exits with incomplete
qualification status even after the original package command succeeds. The
separate observation verifier requires that exact exit, the original command's
successful terminal result, native host identities, retained binaries, complete
minimum source obligations and independently reread physical reports and logs.
A successful build-observation job means that the package build and its evidence
collection completed. Original failed, skipped or unavailable upstream outcomes
remain visible and do not become passing tests. Full compiler/SDK/bootstrap,
complete test-configuration and original-notice qualification remain incomplete.

The workflow retains a bounded archive of original metadata, test reports and
associated logs for one day, including failed attempts. Input-admission and
producer-controller diagnostics are retained even when a preflight refusal
occurs before either result directory exists. Its manifest records each
raw file's length and SHA-256. The collector rereads the actual ZIP members before
publication. Native worktree archives and binary packages are hashed by the build
controller and retained during the job; they are not uploaded in this bounded
observation archive. A receipt does not promise indefinite artifact availability.

The workflow is prepared for native acceptance; its existence is not a successful
producer-build observation. Gate A remains open until the required original builds
and all other outstanding acceptance and closure obligations have evidence.

The separate [original web runtime controller](WEB-RUNTIME-PRODUCER.md) prepares
the pinned GitHub and npm publisher recipes through its own operator-only native
workflow. Its native acceptance, SDK/bootstrap ancestry and complete notice
closure remain pending; no existing producer completion flag is changed.
