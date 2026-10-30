# Required native CI evidence

## Workflow scheduling

Independent jobs and the OS/Node matrix are allowed to run in parallel. GitHub's
account and runner capacity decides when queued jobs receive a runner. Steps
within an individual job remain ordered. After the complete required suite, the
OS/Node matrix runs the unchanged host mutation and fresh-package command sets
in two concurrent lanes inside one runner. The mutation lane receives a private
copy of tracked/unignored working source and compiled files; package checks use
the unchanged checkout. Each lane has its own temporary namespace. Prepared
dependencies and caches are reused; test results are not cached. Every package
controller still performs its original fresh-install verification.

Within required full-suite execution, the complete physical JavaScript extension
test file runs in an exclusive process after the shared file wave. Its loader,
linter, build, lifecycle and fresh-install callbacks still run, including callbacks
outside the selected required profiles. It receives a private temporary namespace
that is removed after execution. Adjacent filenames stay in the parallel wave;
file and callback deadlines are unchanged. This scheduling boundary avoids
competition with other full-suite files without weakening native cleanup checks.

The controller waits for both lanes, rejects changed original inputs, and
requires restoration of mutation input bytes and inventory. The original command
inventory is retained in a fixture and checked by the full suite. Output is
bounded per command and retained in grouped CI logs. Cancellation and the bounded
lane deadline stop owned descendants; incomplete or failed commands cannot yield
a completed receipt. On the full verification path, the four matrix variants, full-suite command,
native jobs, callback assertions and 75-minute job limit are unchanged.

The package lane also requires the bounded attempt-output source controller and
its fresh locked offline installed-package controller on every existing host
variant. These controls use synthetic offline API responses and native Go
version/scope/test commands; they do not invoke a model or complete the frozen
attempt-archives profile.

The [dated lane comparison](measurements/ci-validation-lanes-2026-10-12.json)
records actual sequential and concurrent executions of the sealed multi-claim
mutation and installed-package controllers. This is one local subset comparison,
not current hosted acceptance or a prediction for total workflow duration.

Stack branches under `pr/**` use pull-request events for verification rather than
duplicating the full workflow on their branch push. Other branch pushes and all
tag pushes retain verification. A newly opened PR triggers its checks even when
its initial branch push did not. Each PR has its own workflow concurrency group;
a newer merge-candidate run supersedes older runs for that PR, including runs
caused by predecessor updates. This does not serialize jobs within a run or other
PRs. Branch pushes also share a group per branch, so a newer push cancels an older
run for that branch, including main during consecutive merges. Different
branches and tag refs have separate groups; running tag verification is not
cancelled by a newer push. Native profiles, matrix entries and assertions are unchanged.

Superseded results are cancelled, not credited as successful acceptance. Check
the current head and latest merge-candidate run before claiming hosted success.

The Linux and macOS matrices use commit-pinned `setup-php` 2.40.0 for PHP 8.5.
The macOS implementation uses the upstream prebuilt-package path; current hosted
acceptance must verify that setup establishes the requested PHP runtime before
tests execute. Runtime setup does not supply cached test results.

Pinned public image setup also retries the exact Docker daemon public ECR
`/v2/` connection/header timeout observed before the Rust context tests started.
The same digest, attempt ceiling, monotonic wall budget and cancellation guards
apply. Adjacent hosts/paths, extra authentication or manifest text, child signals
and command timeout/abort codes are not admitted by this new matcher. Synthetic
regressions bind the observed error; they do not simulate the registry or certify
a hosted delivery. See the
[delivery record](measurements/pinned-image-header-retry-2026-10-10.json).

Pinned Go analyzer preparation uses one fixed install/version helper in both
shared matrices and the Go extension job. Each analyzer gets at most three
acquisition attempts, with one-second and three-second waits. Only a terminal
`sum.golang.org` checksum-tile HTTP/2 `INTERNAL_ERROR` is retryable, and every
other diagnostic must be a download notice. Checksum mismatches, compiler errors,
mixed failures, command limits and signals still fail immediately; exhausted
transport attempts also fail. Each attempt prints its bounded captured stdout and stderr before reporting
failure. Acquisition attempts allow five minutes and 2 MiB of captured output;
version checks allow fifteen seconds and 64 KiB. Analyzer versions, Go checksum
verification and test
execution remain unchanged. Go's [module authentication](https://go.dev/ref/mod#authenticating)
remains responsible for verifying acquired module content.

The native Scala CLI/MCP surface and extension privacy controls explicitly select
120 seconds per validation, with 150-second parent process/request bounds. These
controls require complete compiler failures; a slower compiler exhausting the
30-second default correctly returns incomplete and cannot satisfy that assertion.
Their trust-injection refusals, privacy checks, fixed controls and existing callback
bounds remain in place. The production default and maximum execution limits are
unchanged.

The standalone Clang fixture retains its fixed compiler version and pins the LLVM
package revision in [`clang-tools.Dockerfile`](../scripts/clang-tools.Dockerfile).
Its previous revision stopped resolving through Alpine's live APK index before
any Clang checks could run. The separate C++ archive profile acquires original
hashed APKs directly through [`cpp-tools-archives.json`](../scripts/cpp-tools-archives.json);
its original archive pins are unchanged by this index-pin repair. Dated native
measurements retain the package identities actually observed at that time.

## Affected checks on pull requests

`ci-plan` compares the exact PR base and head with a NUL-delimited Git diff,
including both paths of renames as delete/add changes. It reads the full Git
inventory instead of workflow-level path filters or a truncated PR-files
response. `scripts/ci-native-inputs.json` records the declared native input
consumers. The generator follows controller references, finite matrix members,
required profiles and fixture imports; the contract must match the current
inventory before selective routing. Global CI controller source is not traversed
as a native fixture dependency. A literal example in CI control code therefore
cannot attach an unrelated language to a native job.

For a known native fixture or controller change, PRs select the union of its
recorded native consumers. The four shared OS/Node variants run type checking,
lint, formatting and artifact audits, followed by complete test files belonging
to those selected consumers. The artifact, CI routing, affected-runner and finite-inventory
control files always run as well. The shared runner requires named CI and
inventory controls to pass; an omitted or skipped required control fails.
It executes every callback in the selected files, not only the named controls.
Its receipt identifies the selected files and records skips separately.

The exact `docs/measurements/artifact-identities-2026-10-21/` namespace
contains retained observation data. Changes there select the shared artifact
audit and its complete regression file, including every named
`selected-artifact-evidence` guard. Missing or skipped artifact guards fail.
Declared native consumers, when present, are added to the selection. Added data
must still satisfy the audit's index, byte, source, notice and completion-claim
constraints. Adjacent directory names and other unclassified documentation data
retain full verification. This routing does not certify upstream builds or
native acceptance.

These affected runs avoid unrelated language tool preparation and the full
package/mutation phase. That phase is explicitly skipped at this revision.
Markdown-only PRs run the shared checks and control files without native stacks.
A successful full run on the exact base is no longer a scheduling prerequisite:
unavailable or failed historical CI does not broaden a known fixture change.
No prior job result substitutes for execution of selected current inputs.

Shared production source, schemas, dependency/configuration, CI, executable
inventories and unknown paths still select full verification. A missing, empty or
invalid diff and a stale ownership contract also select full verification.
Only the standalone source boundaries declared below can narrow production
source changes. Semantic manifest changes remain global. Adapter names do not
establish isolation from filename prefixes. Pushes, tags, manual runs and the weekly schedule retain
the complete shared suite, package/mutation phases and all native stacks.
The full path retains every original command and OS/Node variant.

Optional `CHECKTRAIL_CI_OBSERVE_BASELINE=1` records strictly validated historical
full-run context using read-only GitHub APIs. Its jobs/check-suite fallback keeps
the exact commit, successful attempt, complete distinct job names and Actions app
constraints. Failed, skipped, duplicate, foreign or malformed historical records
remain unqualified. This optional observation does not control PR routing and
cannot qualify an omitted native job against the new revision.

`ci-complete` requires the planner, shared matrix and every selected native job
to succeed. It requires unselected jobs, including the affected run's full
package/mutation phase, to be explicitly skipped. Its receipt reports whether
full-revision verification occurred, and never qualifies omitted jobs. Require
this aggregate check in branch protection when using selective CI. Gate A still
requires its separately specified complete current-revision native evidence.

A CI-policy change itself uses full verification. Hosted runtime improvements
must be measured after that run; local routing and refusal tests are not evidence
of a faster hosted workflow.

## JVM wrapper phase jobs

The JVM wrapper job has three independent matrix members: `baseline`,
`acceptance`, and `guards-regressions`. Each member verifies the pinned runtime
and wrapper artifacts. Baseline retains preparation ownership and the Java,
Maven and Gradle required profiles. Acceptance retains every source callback
and fresh offline installed callback. Guards and regressions retain every
compiling/restored control and both complete native regression files.

The controller accepts one exact phase argument; omitting it runs every phase
in the original order. Unknown or extra arguments fail before Docker or cache
queries. Each container retains two CPUs, 4 GiB memory, 256 PIDs, a 2 GiB
executable temporary filesystem, disabled networking, read-only source and root
filesystems, and its 20-minute deadline. The outer job limit remains 40 minutes.
Splitting duplicates preparation and can increase runner minutes; hosted timing
must be measured before claiming a speed improvement.

Each completed phase emits a distinct bounded job output and an explicitly
partial native receipt. `ci-complete` requires all three outputs with matching
source, compiled production code, compiled harness and native runtime identities,
from the same workflow run and source revision. A retained successful phase from
an earlier execution attempt of that run is allowed; missing or mismatched
receipts fail the aggregate even if the matrix job reports success. A successful
pre-split baseline cannot qualify the expanded job inventory. These phase receipts
do not close Gate A, provenance/license review, or final platform acceptance.
Dated measurements retain their original execution shape and outcomes.

## Native mutation target preflight

The shared local suite checks every compiled JVM wrapper and Rust extension
mutation target before native execution is selected. These commands also run the
same read-only target and mutant-syntax checks directly:

```sh
node scripts/verify-jvm-wrappers-guards.mjs --preflight
node scripts/verify-rust-extensions-guards.mjs --preflight
```

Preflight leaves compiled targets unchanged. It does not execute native callbacks
or count as native mutation acceptance; the native jobs still require the
original control to pass, the mutant to fail its assertion, and the restored
control to pass again.

## Acceptance time budgets

The shared suite and package/mutation OS/Node matrices each retain a 75-minute
job limit, including their own preparation and required verification. The required-profile
runner normally applies its timeout to each entire selected test file. Sequential
controls therefore share that file budget even when each control has its own
timeout.

Full-suite runs allow ten minutes per file, including additional files outside
the selected required profiles. The `dotnet-method` profile allows ten minutes
per selected file. Existing per-control and engine execution limits remain in
force. Standalone profiles retain their existing file budgets, including five
minutes for `review-benchmark`, `review-benchmark-judging`,
`review-benchmark-scoring`, `review-claim-probability` and
`review-benchmark-multi`. The first four profiles share the complete benchmark
callback file, including callbacks outside the selected required names; their
file allowance covers cumulative execution while existing callback and production
execution deadlines stay unchanged. Any timeout still fails acceptance and
leaves unobserved required cases visible.

Standalone `jvm-wrappers` source and installed acceptance instead select each of
the nine exact named top-level callbacks in a fresh process. One such
process runs at a time. Concurrent Gradle pipelines exhausted native threads
under the required 256-PID container limit and prevented a test JVM from starting;
that incomplete outcome remains a failure. Each
gets a separate owned temporary namespace, removed after its stream completes,
so lifecycle checks cannot observe another case's directories. Each process has a ten-minute file budget, and the callback's own existing deadline
still applies. The installed callback runs the same required inventory against a
fresh offline production installation; its nested worker ceiling is also one.
Full-suite execution continues to select every compiled file and test.

Standalone `scala-extensions` also gives each unchanged named callback its own
fresh process and ten-minute file budget, with one callback running at a time.
Hosted evidence reached seven passing callbacks before the shared file budget
expired and left lifecycle/installed outcomes unobserved. The repair preserves
callback and engine deadlines; it does not credit those missing outcomes. Native
cleanup snapshots and MCP startup use the assigned temporary namespace. Source
and fresh installed callbacks must still complete independently. The
[Scala case-budget record](measurements/scala-native-case-budgets-2026-10-10.json)
binds the repaired source and installed execution, preserved baseline, compiling
controls, regressions and project check.

The [case-isolation record](measurements/jvm-native-case-budgets-2026-10-10.json)
binds native source and installed execution, unchanged required names, compiling
controls and the project check. It also records the cleanup fixture repair: the
fixture waits for a physical native-start marker before cancellation or timeout
can establish removal of an owned temporary directory. JVM lifecycle checks use
their owned temporary namespace, and the CLI/MCP fixture supplies that namespace
through the server startup environment. Required names and lifecycle assertions
are preserved; the affected fixture bodies changed. Expiry before creation
remains a valid incomplete engine outcome.

The sealed multi-claim guard runner allows at most two minutes for each selected
original, mutant and restored callback. Those callbacks cover several paired
trials and invalid mapping variations. It reports each stage on stderr and still
requires the exact unchanged callback to pass, kill its compiling mutant, and
pass again after restoration. Nested review execution budgets remain unchanged.

The Scala container job retains its thirty-minute limit. It overlaps two isolated
read-only native lanes: preserved compilation/regressions/installed warning policy,
and extension source/fresh installation/compiling guards. Each lane owns its
container temporary filesystem and npm cache; named heavy callbacks remain serial
inside their container. Per-container limits stay at two CPUs, 2 GiB memory,
256 PIDs and 1 GiB temporary storage; aggregate admission is at most two containers
(four CPUs, 4 GiB memory, 512 PIDs and 2 GiB temporary storage). Both lanes must
finish all original assertions before complete evidence is emitted. Stage durations
are retained in the receipt. Control/file/engine deadlines remain unchanged.

Scala 2/3 setup retries only admitted transient network and HTTP 5xx failures,
starting each attempt at the exact original release URL. Manual redirects retain
the original HTTPS/host restrictions, adding explicit port rejection. At most three
attempts share the original sixty-second deadline; byte counts, SHA-256 pins,
atomic publication and fresh native tests remain required. The common acquisition
helper retains its default 128 MiB admission ceiling; Scala explicitly admits up to
256 MiB because its existing pinned Scala 3 archive exceeds the default. The actual
stream limit remains the declared archive byte count.

C++ acquisition rechecks the original main URL after both bounded repository
searches end in HTTP 404 across the existing CDN/mirror inventory. Those final primary attempts
share the original deadline and bring the worst case to nine requests. Neither
archive versions nor pins change. Integrity/permanent-response errors still fail
without alternate repository fallback; the offline image build still verifies APK
signatures. A download is preparation, not passing native acceptance.

The retired `zlib-1.3.2-r0.apk` pin has an unchanged repository copy in
`scripts/cpp-archive-fallbacks/`, with original public source attribution and
upstream license text. Only that exact basename, byte count and SHA-256 can
select it after the original bounded requests end in HTTP 404. Corrupt content,
adjacent pins, cancellation and permanent network errors cannot use this fallback.
It is CI preparation data outside the npm package's published file inventory;
the offline image build still verifies its original APK signature.

The CI cancellation control waits for complete PID contents rather than marker
existence. Its fixture deliberately publishes an empty marker and waits for an
observation acknowledgment before writing the PID, so the incomplete-publication
boundary is reached before cancellation and detached-child cleanup are checked.

## Kustomize transform extension acceptance

The `kustomize-extensions-arm64` job prepares the original infrastructure runtime
and repeats `verify-kustomize-extensions-container.mjs`. It requires preserved
kubeconform/Kustomize controls, named source and fresh offline installed
acceptance, original regressions and compiling unchanged-callback controls.
Native runs use no network, a read-only root/source/cache, bounded resources and
user 1000. Reached build/validator cancellation, timeout and output exhaustion
retain cleanup requirements. See [KUSTOMIZE-EXTENSIONS.md](KUSTOMIZE-EXTENSIONS.md)
and its [dated record](measurements/kustomize-extensions-2026-10-10.json). Wider
semantics/platforms, artifact closures and Gate A remain open.

## Kubernetes schema extension acceptance

The `kubernetes-extensions-arm64` job prepares the original infrastructure runtime
and adds thirteen pinned strict schemas in a separate directory. The controller
requires preserved kubeconform/Kustomize cases, source and fresh offline installed
acceptance, native regressions and compiling assertion controls. Current physical
source, raw policy, schema and binary drift invalidates saved extension receipts.
Validation runs without network as user 1000 with read-only root/source/cache,
two CPUs, 4 GiB memory, 256 PIDs and a 2 GiB temporary filesystem. The required
extension file has a five-minute budget; optional absent-native tests do not count.
See [KUBERNETES-EXTENSIONS.md](KUBERNETES-EXTENSIONS.md) and its
[measurement](measurements/kubernetes-extensions-2026-10-10.json). Wider cluster
semantics, kinds, versions, platforms and artifact/license closure remain open.

## JVM analyzer extension acceptance

The `jvm-analyzer-extensions-arm64` job prepares pinned detekt, SpotBugs and Kotlin
artifacts before atomically publishing a verified combined build context. The
Dockerfile explicitly makes those public artifacts readable by the controller's
non-root user, including when freshly prepared inputs have owner-only permissions.
The controller runs preserved Java/SpotBugs/light-detekt callbacks, nine required
source cases and the same nine fresh offline installed cases, native regressions
and compiling guard controls. A required skip, timeout, surviving guard or failed
restoration prevents acceptance. The selected-file budget is ten minutes; the job
limit is thirty minutes. These are upper bounds, not passing evidence.

The [local measurement](measurements/jvm-analyzer-extensions-2026-10-10.json) records
its exact selected Linux ARM64 runtime and outcomes. Fresh installation uses a
verified subset of the prepared lockfile cache with no network and no lifecycle
scripts. Source/cache mounts and the root filesystem are read-only. Resource
limits, operator trust and source-detail boundaries remain enforced. This
profile does not close the remaining native matrix or Gate A.

## Pinned image delivery

CI Dockerfiles, runtime preparation selectors and direct workflow pulls use the
public ECR Docker Official Image mirror with the original immutable SHA-256
image-index digests. The [mirror delivery receipt](measurements/ci-image-mirrors-2026-10-09.json)
records byte-verified index manifests, successful image pulls and local validation.
The change follows hosted failures during Docker Hub image preparation, before
native acceptance could run. Microsoft Container Registry image selectors retain
their existing registry and digest.

A registry replacement supplies no cached test result. Native source, compiling
controls and fresh installed-package checks remain required. Historical receipts
retain the registry used when they were captured; identical image-index bytes do
not establish broader license, publisher or whole-runtime provenance. Hosted CI
at a repaired PR head must still pass independently.

Pinned public image preparation retries only recognized rate-limit messages and
HTTP 429, 500, 502, 503 or 504 delivery responses. It admits at most five attempts,
with two-, five-, fifteen- and thirty-second waits, within one 180-second monotonic
wall budget. Every attempt uses the same digest reference. Cancellation, command
timeouts, authentication failures, unknown errors and exhausted attempts remain
failures. CI prepares the selected images before Docker's implicit first pull;
existing job matrices, conditions and native acceptance commands are preserved.

This follows two hosted preparation failures with `toomanyrequests: Rate exceeded`.
AWS documents a one-per-second anonymous pull quota in its
[public ECR service quotas](https://docs.aws.amazon.com/AmazonECR/latest/public/public-service-quotas.html).
The [bounded delivery receipt](measurements/ci-image-delivery-retries-2026-10-10.json)
records the observed failures, unchanged source assertions, compiling controls and
local check. Retries do not guarantee registry availability or completed hosted acceptance.

## Pinned infrastructure preparation

Infrastructure runtime setup allows at most three download attempts per artifact,
retrying recognized connection failures and HTTP 500, 502, 503 or 504 responses after one-second and three-second waits. All attempts and body
reads share the original 120-second deadline. Other HTTP errors, byte-bound violations,
incorrect lengths, checksum failures and an expired deadline fail preparation.
Pinned lengths and SHA-256 digests remain mandatory before extraction or use.

A failed parallel download batch waits for every in-flight download to settle
before removing its staging directory. Failure never publishes a prepared runtime
or counts as native acceptance; the source and fresh installed-package controls
still run separately after preparation succeeds.

## Required regression profiles

The ordinary test suite permits explicit skips for unavailable optional tools.
That makes it useful on a developer machine, but its aggregate exit code cannot
establish that a native adapter ran. CI's prepared profiles additionally use
`node scripts/verify-required-native-tests.mjs PROFILE`.

The [profile manifest](../scripts/required-native-tests.json) lists exact test
names and files. The runner requires each listed test to pass exactly once,
rejects any observed failure, skip or TODO, and distinguishes a passing suite
from a passing test. Default file execution covers every callback in the selected
files. Named case isolation covers only the selected callbacks and their hooks;
unselected callbacks cannot supply acceptance. A similarly named test, a test in another
file, or a passing unit test cannot stand in for a missing native regression.
Expected names are fixed inputs; the runner does not discover its requirements
from whichever tests happen to remain in the source tree.

Several profiles may be passed to one invocation. The runner validates all
selected manifests before starting tests, then executes the union of their files
once, with file execution still sequential. Identical file/name obligations
shared by profiles are checked once; duplicates within a profile remain errors.
The batch lists each selected profile and its requirement count, while `required`
is the number of unique obligations. A failed batch establishes none of its
selected profiles as complete. The single-profile JSON format remains available
for fresh installed-package harnesses. Each profile retains its 256-obligation
limit; a batch cannot exceed the bounded terminal-ledger ceiling. The runner
validates these bounds before executing any file. Every selected file, including additional full-suite
files, is fingerprinted before and after execution. Unavailable or changed bytes,
truncated names and truncated ledgers fail acceptance even when observed tests pass.

The main matrix uses `--full-suite` with its prepared profiles after type checking,
linting and building. This executes every compiled `dist/test/*.test.js` file
with the ordinary Node test runner's file parallelism, and checks the selected
profiles in the same fresh invocation, replacing the
separate ordinary suite and repeated source-profile passes. Explicit optional
skips from files outside the selected profiles are counted as `optionalSkipped`;
no such skip counts as a pass. A failure anywhere, or a skip/TODO anywhere in a
required file, fails the run. Missing and duplicate required cases still fail.
The separate Tasks-enabled MCP run, mutation checks and fresh package checks
remain separate executions. No saved test-result cache supplies acceptance.

GitHub also supports [parallel steps and background steps](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsparallel)
within one runner. The pinned actionlint 1.7.12 does not support those keys;
[upstream support is proposed](https://github.com/rhysd/actionlint/pull/694).
Do not bypass workflow linting to enable them. After checker support is pinned
and verified, independent setup in disjoint directories is a candidate for
parallel steps. Tests that mutate compiled files must finish before source or
package checks read those files. Step parallelism does not increase runner
capacity, and CPU-heavy steps still compete for the same runner's resources.

The main CI matrix prepares and requires `core`, `javascript`, `python`,
`frameworks`, `go` (including `go-matrix`), `php-tools`, `php-review`, `laravel`,
`rust`, `rust-format`, `clippy` and `rust-tests`. Dedicated container jobs
require `clang`, `java`, `dotnet`, `actionlint`, `vue-router` and `nuxt`.
Dedicated JVM jobs require `checkstyle`, `maven` and `gradle`, including offline
installed CLI/MCP profiles. The .NET job also prepares original public dependency artifacts and requires `dotnet-build`, `dotnet-test`, `dotnet-format`, `dotnet-generated` and `dotnet-method` against source and an offline production install; its newly configured hosted run remains unverified. Ruby and Swift have dedicated required-native jobs. The new `swift-tools`
job uses `ubuntu-24.04-arm`, prepares pinned runtime/release artifacts and requires
the native profile against both source and a fresh offline production install.
Its local acceptance is recorded in SWIFT-TOOLS.md; hosted execution of the new
job remains unverified. The new `cpp-tools` ARM64 job prepares checksum-pinned
Alpine runtime packages and requires the native profile against source and a fresh
offline production installation. CPP-TOOLS.md records local acceptance; hosted
execution of this job remains unverified. The new `kubeconform` ARM64 job uses the
pinned infrastructure runtime and requires source and offline installed-package
controls. KUBECONFORM.md records local acceptance; this hosted job remains
unverified. The new `terraform` ARM64 job uses that runtime for source and fresh
offline installed-module controls recorded in TERRAFORM.md; its hosted execution
is unverified. The packaged review and
durable-task helpers require `review` and `tasks` before their installed-package
checks. The Tasks wire profile separately requires `mcp-tasks`, with callback
contract checks in `mcp-task-dispatch`; ordinary MCP cases are also run with
Tasks configured. `verify-mcp-tasks-package.mjs` evaluates the shipped CLI/runtime
from a fresh offline production installation, with a separate acceptance harness. The separate PHP syntax helper checks its exact successful TAP test name;
the external-adapter helper already checks exact required native names for each
of its different runtime containers. The separate executable-bundle image requires
`executable-bundle`, `executable-bundle-interpreters`, `external-protocol` and
`policy-distribution`, plus an offline production installation with the official
client harness outside the installed package. See EXECUTABLE-BUNDLES.md.

The main matrix also prepares the separately locked TypeScript 4.9.5 compiler
from `scripts/typescript-legacy-tools/`. Its named native regression is mandatory
in the `javascript` profile; root build tooling stays on its existing compiler.

A tool version preflight remains useful but is not the acceptance condition.
Installing the expected binary cannot compensate for a skipped, renamed, removed
or failing required test. When intentionally renaming or replacing a regression,
review its behavior and update the manifest with that change. Do not remove a
requirement merely to make an unavailable toolchain green.

The native profiles supplement the full suite; they do not replace linting,
type checking, parser tests, privacy tests or package verification. Some selected
files contain both native and unit cases, so `passed` counts in their summaries
are test counts, not native-tool invocations. Profiles can overlap with the full
suite. Do not add their pass counts together as independent coverage.

Container helpers retain their existing prepared dependencies, network-disabled
execution and read-only source mounts. They do not install tools while measuring.
A main hosted job prepares dependencies before validation. Local container runs
are evidence for their actual versions and platforms only; the GitHub Actions
matrix requires its own successful run before being claimed as verified.

The runner's regression tests exercise required-test absence, exact name/file
identity, duplicates, skips, TODOs, suite-only matches and unrelated failures.
Deleting its missing-test rejection makes the absent-test case fail. To diagnose
a native assertion failure, rerun the named file directly with `node --test` in
the same prepared runtime for the full assertion diagnostics.

The [recorded local profile runs](measurements/required-native-profiles.json) retain
requirement/helper digests, result accounting and available container/package
identities for the expanded profiles. Each listed requirement passed in those
runs. The unchanged Ruby/Swift paths have their separate local evidence in
`RUBY.md` and `SWIFT.md`. These records do not claim that the hosted matrix ran,
that all profiles ran in a single environment, or that overlapping counts are
independent tests.

## Bounded terminal ledger

The required-profile report now includes a version 1 terminal ledger. It records
an ordered prefix of up to 1,024 terminal test/suite events, with bounded names,
observed outcomes and durations. Every preregistered case separately records
passed, failed, skipped, TODO, duplicate or not-observed state, even when no test
runs. Only one passing test event from the exact selected file/name can satisfy
a requirement. Suite events cannot satisfy it. Existing aggregate fields remain
available; their `passed` count includes non-required tests in the selected files.

Each distinct selected test file receives an opaque ID in manifest order and a
SHA-256 fingerprint before and after the run. The harness preflights every file
before starting any test. Missing/non-regular files and files exceeding 4 MiB
prevent execution; changed, removed or unreadable bytes afterward make acceptance
incomplete. Exact-limit files remain valid. This observes ordinary before/after
changes, not an atomic or adversarial source snapshot. The ledger does not capture
imports, product source, dependencies, raw output or whole-process identity.
Tool/container and installed-package identities need their separate records.

Truncated terminal events or names cannot yield complete acceptance, including
when the required test passed before truncation. The ledger bounds retained
terminal evidence, not every internal allocation made by Node's test runner.
Test names and failure messages are test-authored data; opaque file IDs do not
make those fields confidential. Retained failure metadata remains bounded.

The `native-acceptance-ledger` profile is mandatory in the existing Node/OS
matrix. Its original controls cover exact file/name identity, suite-only matches,
non-required outcomes, duplicates, missing targets, skips/TODOs, failure, timeout,
truncation, source changes/removal and byte/name boundaries. A multi-target
preflight control verifies that an otherwise runnable target has no side effect
when another required file is missing.

The `timeoutMs` option configures Node's test timeout. It is not a universal hard
process deadline or a claim of descendant cleanup: the tested Node 26 timer can
remain alive after a failure is reported. CI job limits and the product execution
runner's cancellation controls are separate. A harness exception exits without a
complete receipt and is not credited as acceptance. This ledger improves native
acceptance accounting; it does not close the wider R7/E6 all-attempt, raw-output,
provenance or host-isolation requirements.

The [dated ledger acceptance](measurements/native-acceptance-ledger-2026-10-06.json)
records exact runtime, helper/test identities, original guard mutations and native
source/fresh-installed adapter results. Its acceptance is scoped to the recorded
revision and profiles.

The `review-paired-scoring` profile requires original descriptive comparison
controls in the existing Node/OS matrix. Its offline package helper repeats the
same named assertions against shipped library/CLI/MCP bytes, with the acceptance
harness and official client outside the installed package. It invokes no model
and establishes no measured quality or observed independent-session claim.

## Fresh-runner package preparation

`npm ci` installs from the repository lockfile but does not necessarily cache
the registry metadata needed to resolve a new consumer's dependencies. Before
packaged checks, CI runs `node scripts/prepare-package-cache.mjs` with network
access. It packs the current build and installs it in a disposable consumer with
lifecycle scripts disabled, using the same npm cache as the later smoke helpers.
The disposable installation is removed; only the npm cache is reused.

The smoke helpers still create fresh consumers and install with `--offline`.
Native container checks still use `--network none`. Cache preparation is setup,
not evidence that a package can be installed without previously cached dependencies.
For local reproduction, run `npm run build`, the cache preparation script, then
`node scripts/smoke-package.mjs`, keeping the same npm cache configuration.

The [first hosted run](https://github.com/stsepelin/checktrail/actions/runs/35570317427)
exposed this missing setup: Java, C#, actionlint, external adapters, Vue Router and
Nuxt reached packaged installation after their native checks, then failed with
`ENOTCACHED`. All three Linux main-matrix jobs reached the same failure after
passing their full suites and required native profiles. Clang, Ruby and Swift
jobs passed. The macOS main job failed separately because Pint attempted to seek
within `/dev/null`; the adapter now uses a fresh regular cache file in a
runner-owned directory, with cleanup asserted after successful and failed checks.
See `PINT.md`. A later macOS assertion also needed canonical rather than aliased
temporary paths; its fixture now exercises a symlinked root on every platform.
All three fixes are included in the successful run below.

## Successful hosted baseline

[Run 35573066804](https://github.com/stsepelin/checktrail/actions/runs/35573066804)
passed all 13 jobs at commit `52ba415dfc5cfcaab459dc648baaa864627f1642`.
The [job and step record](measurements/hosted-ci-52ba415.json) retains the source
identity, run URLs, outcomes and timestamps. The main matrix covered Linux Node
22/24/26 and macOS Node 24; dedicated jobs covered Java, C#, Clang, actionlint,
external adapters, Vue Router, Nuxt, Ruby and Swift.

This establishes the configured profiles for that revision and those hosted
environments. Optional skips in the general suite still do not count as native
coverage. The `0.1.0-alpha.1` release metadata and documentation follow this
baseline; the release commit needs its own CI run before publication.

The `review-budget` required profile covers shared verification-run API admission
with original synthetic transports and native Boolean controls. The main CI
matrix runs the profile explicitly and invokes
`scripts/verify-review-budget-package.mjs` after preparing the offline package
cache. This checks installed library/CLI/MCP accounting and operator controls;
it starts no real provider inference or field review. Exact local runtime pins,
mutations and cleanup evidence are in
[the dated measurement](measurements/review-budget-native-2026-10-02.json).

The separate `php-review` job pins its Docker runtime and Composer lock, disables
plugins and lifecycle scripts during preparation, and requires the exact native
profile with no network. It also checks the fresh offline production installation;
the main matrix requires the same profile in its prepared host PHP runtime.
These configured hosted jobs are not evidence that they have run.

The `rust-format` profile requires the pinned stable formatter component in
addition to Cargo/rustc. Its helper repeats the exact native and CLI/MCP controls
against a fresh offline installed package; unavailable components remain failures
of required acceptance rather than skipped passes. See RUST-FORMAT.md.

The `rust-workspace` required profile prepares the pinned wasm32-unknown-unknown
standard library before validation and verifies compilation, Clippy and native
test profiles through the fresh offline package. Foreign tests remain unavailable
without a supported executor. The configured host jobs have not been run for this
revision; see RUST-BUILD.md for measured local acceptance.

The separate `checkstyle` job prepares the exact Checkstyle artifact and pinned
JVM image, disables networking during required native and installed-package
acceptance, and retains the preserved Java compiler profile. Local Linux arm64
source-bound evidence is in [CHECKSTYLE.md](CHECKSTYLE.md). This newly configured
hosted job has not been run at this revision.

The separate `maven` job prepares the pinned Apache distribution and executes only
the original public fixture to acquire a dependency cache. Required native and
installed acceptance then run with networking disabled and read-only source/cache
mounts, retaining the preserved Java compiler profile. Local Linux arm64 evidence
is in [MAVEN.md](MAVEN.md). The new hosted job has not run at this revision.

The separate `kustomize` job uses the prepared pinned infrastructure image and
requires the bounded local assembly/render/schema profile through source and a
fresh offline installed package. Native acceptance runs with no network. This
configured hosted job has not been run for this revision; see KUSTOMIZE.md.

The mandatory `review-benchmark-scoring` profile exercises the sealed synthetic
artifact-to-scorer connection, including missing/unusable slots, contradictory
labels, multiple claims and worker access boundaries. The matrix additionally
runs `verify-review-benchmark-score-package.mjs` against a fresh offline production
installation; its harness stays outside the installed product. These original
synthetic checks do not run model inference or real-project evaluation.

The mandatory `review-calibration` profile checks the original weighted analytic
controls, split/model boundaries, missing/unknown accounting, unavailable families,
artifact recomputation and read-only library/CLI/MCP agreement. The matrix runs
`verify-review-calibration-package.mjs` against a fresh offline production install
with its harness outside the product. This is configured development acceptance;
hosted results must be checked at the exact revision before claiming a pass. It
performs no model inference or field evaluation.

The mandatory `review-claim-probability` profile requires endpoint/legacy controls,
strict nullable injected-transport schemas, independent-stage projections, native
case identity siblings, sealed original probability accounting, hand-computed
losses, certainty errors, override/tamper/incomplete-slot controls and CLI/MCP
agreement. `verify-review-claim-probability-package.mjs` repeats the same callbacks
from a fresh offline production installation. No external model calls or field
reviews are part of this development profile.

## Full-suite worker capacity

`npm test` builds the project and runs every compiled `dist/test/*.test.js` file through `scripts/run-test-suite.mjs`. The worker pool is bounded by the smaller of four workers and the runtime's available parallelism. It stays parallel and does not select, omit, retry or weaken test callbacks. An empty compiled inventory, a worker failure or a terminated test run cannot pass.

Native controls can launch additional compilers, adapters and child processes within each test worker. Bounding test-file fanout prevents a high-core host from starting a full CPU-sized set of those nested workloads at once. Dedicated required-native profile runners and independent CI jobs keep their existing scheduling and strict completion checks.

The normal test launcher and required full-suite harness share a cap of up to four test-file workers, reduced to available parallelism. Each required receipt records the file-worker limit used. Profile-only acceptance retains serial file execution. The cap controls concurrent test files; native tools' descendant processes retain their separate execution/container limits. The original concurrency control uses multiple real overlapping files, accounts for every terminal outcome and confirms all active worker slots are released.

The `confidence-provenance` profile is required in the main OS/Node full-suite
matrix. Its frozen callbacks repeat against an offline production installation;
`verify-confidence-provenance-guards.mjs` removes one exact compiled protection
per control, requires an unchanged callback to fail an assertion, restores the
source and requires it to pass again. The [profile documentation](REVIEW-PROVENANCE.md)
separates current source-address checks, unverified host probabilities/operator
labels, unattested native imports and descriptive scoring. The local measurement
is scoped to its observed host; it does not close the wider runtime matrix or
independent evaluation. No inference or field evaluation is invoked.

The `dotnet-fsharp-format` profile requires nine frozen callbacks against source and a fresh offline production package. `verify-fsharp-format-container.mjs` binds the selected Linux ARM64/Node runtime, preserves the .NET build and C#/VB formatting baselines, and requires compiling controls including altered native C# observers. Tool preparation validates the exact downloaded NuGet package and installs only selected assemblies. FSHARP-FORMAT.md records current component and diagnostic limits; hosted CI and other platform acceptance are separate measurements.

The C#, F#, Ruby and Visual Basic context jobs explicitly pull the existing pinned
Microsoft SDK through `pull-pinned-image.mjs` before building their context images.
This uses the same bounded setup path as the formatter jobs instead of allowing
BuildKit to spend the entire job budget fetching that base. The subsequent build
steps disable networking for build commands; image digests, native callbacks and
job deadlines remain unchanged. A failed or incomplete pull still fails setup.

## Generator installation acceptance budget

The generator extension job participates in the planner, native input inventory
and final completion gate. It starts in the initial wave; F# format admission
waits for actionlint so the initial expanded wave stays within twenty jobs.
The existing four shared OS/Node variants and every native callback remain.

The installed generator acceptance callback repeats its original native cases
through a fresh offline production installation. Its subprocess deadline is
19.5 minutes and its callback deadline is twenty minutes. The harness grants the
same twenty-minute budget only to that exact physical compiled file and exact
installed callback during isolated execution with the ordinary ten-minute file
budget. Other file/callback selections, full-suite budgets, engine execution
limits, container resource limits and the sixty-minute native job limit remain
unchanged. Errors and terminating signals are asserted before receipt admission.

## Remaining official image delivery

The PHP review job stopped before tests when the public ECR Composer pull returned
`Data limit exceeded`. Remaining production ECR references now select the
byte-verified official Docker registry addresses with the same immutable digests.
[The delivery measurement](measurements/ci-official-index-delivery-2026-10-13.json)
records every changed production caller and each captured index hash. Existing
image versions, native callbacks, budgets and resource limits remain unchanged.
CI input discovery omits pinned image addresses when reading native profile tokens.
Explicit workflow and controller profiles still supply their required callbacks.
The fixed mirror allowlist rejects adjacent digests, registries and repositories;
byte identity does not establish publisher signatures or complete license closure.

Laravel supplemental acceptance now inventories the exact static callback names
in both supplemental files and requires each through the existing bounded
acceptance ledger. This replaces a stale aggregate TAP count. Empty, duplicate,
skipped, failed, missing, changed-file and truncated evidence stays non-passing;
the original callbacks are preserved.

The current Windows startup diagnostic independently compares the legacy
`New-Object` encoding path with a typed managed constructor. On the observed
Windows 2025/Node 22 runner, the former reached the diagnostic deadline while
the latter completed. The Tasks ACL inspector and its public-ACL negative
fixture now use typed encoding/security constructors. Caller-only ACL validation
and the original required Tasks/native Windows callbacks remain intact. Native
Tasks CI must pass before treating this change as platform acceptance.

The Windows Tasks diagnostic captured completed stdin followed by a JSON-cmdlet
stall in the minimal environment; inherited-environment probes then failed ACL
cmdlet autoloading. The inspector and public-ACL negative fixture now use fixed
shipped .NET Framework JSON and filesystem ACL APIs. Private ACL checks, literal
paths, the minimal environment and existing subprocess budgets remain in force.
Native Windows source and installed acceptance remain required.

The Tasks matrix fresh-install callback exceeded its unchanged 170-second child
budget in a shared Linux Node 22 full-suite wave, while dedicated Tasks acceptance
completed it within that budget. The full-suite harness now admits the exact
physical `gate-tasks-matrix.test.js` file in an exclusive process after the shared
wave, alongside the existing JavaScript file. Whole files and unlisted callbacks
remain included; adjacent names remain parallel. File, callback and production
execution budgets are unchanged.

The Tasks runtime verifier emits bounded named-case start, terminal, and finished diagnostics to stderr. These locate an interrupted source cohort without waiting for its final JSON report. A start or finished diagnostic does not establish acceptance; only the complete, stable terminal ledger can do that.

Tasks wire fixtures register resource teardown before temporary-directory removal.
Every owned server or worker is awaited before its SQLite files can be unlinked;
cleanup attempts the remaining resources even if one closer fails. A required
source and fresh-install control keeps two actual servers and owner databases
open, then checks both processes have exited while both databases still exist.
This ordering check is separate from native Windows ACL acceptance.

The packaged Linux review verifier emits its bounded full source ledger before
reporting a failed process or cohort. A nonzero exit remains a failure; retaining
the complete ledger prevents error-display truncation from hiding the evidence.

The Tasks fresh-install wrapper retains the 170-second child and 180-second
callback deadlines on POSIX. Its Windows aggregate uses a 590-second child
allowance inside a 600-second callback/file bound, because the complete native
cohort is repeated in the fresh production installation. Per-project execution,
other callbacks and job deadlines retain their existing limits. A dispatch
control observes the actual wrapper options for Windows, Linux and macOS and
checks that a refused child remains a failed callback.

Owned isolated test namespaces use Windows-only bounded filesystem retries for
transient busy-directory cleanup: ten retries with 100-millisecond linear delay
using the [Node filesystem retry options](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromisesrmpath-options).
A native Windows control holds a real child process's working directory open;
release permits removal, while a persistent lock exhausts the retries and remains
an error. POSIX removal keeps its existing immediate behavior. Namespace cleanup
and terminal acceptance remain separate obligations.

The hashed C++ preparation manifest selects the three LLVM 22.1.3 revision-r1
archives together (`llvm22`, `llvm22-libs` and `llvm22-linker-tools`). These
replace the original r0 archive pins after public r0 delivery returned HTTP 404.
Each replacement has its own measured byte count and SHA-256, and the offline
image build still verifies Alpine signatures. This changes toolchain bytes,
including the LLVM shared library; the tool version requirement remains 22.1.3.
Dated r0 measurements retain their original archive identities and do not qualify
the replacement runtime.

Tasks fixture completion observation uses a bounded 15-second monotonic deadline.
The previous four-second observation allowance could reject a valid task before
its five-second command allowance ended. Each status read is bounded by the
remaining observation time, late replies cannot become acceptance, and timeout
diagnostics retain the poll count and last observed status. Command execution
limits, cancellation/descendant assertions and terminal outcome expectations
remain required.

The Swift extension privacy fixture bounds CLI observation at 16 MiB to retain
the detailed report with native journals. It checks spawn errors, signals and
exit status, and requires CLI stdout to parse as JSON with the failed outcome.
The detailed SDK test client has an explicit 32 MiB receive bound for the MCP
reply's text and structured copies; summary uses its default transport bound.
The existing root/canary disclosure assertions still run through both CLI and
MCP. Validator process-output and execution limits are unchanged.

The detailed Tasks archive library controls use the same bounded wall-clock
completion observer as the Tasks wire controls. A real native command lasting
4.7 seconds exposed the earlier four-second polling loop before archive
completion. The observer keeps late or missing terminal replies as failures and
does not change worker execution, cancellation, retention or output limits.

Archive quota controls reopen a consistent store exactly at its shared byte
limit, then require refusal at one byte over it. The over-limit fixture preserves
all per-report, chunk, source and whole-report bindings, so another integrity
failure cannot stand in for the aggregate reopening check.

The C++ acquisition fallback also retains the original signed libexpat archive
at its existing manifest identity. Terminal HTTP 404 responses may select only
the two explicitly pinned repository copies, after the bounded official mirror
attempts. Byte counts, SHA-256 and offline APK signature checks remain required;
redirects, permanent failures, corrupt bodies and cancellation cannot select the
fallback. The toolchain versions and bytes do not change.

The Tasks wire fixtures select a 20-second execution budget on Windows for normal
native outcomes, with a separate 35-second completion-observation allowance.
The fixed two-test case in [job 119518084084](https://github.com/stsepelin/checktrail/actions/runs/39685173985/job/119518084084)
exhausted its previous five-second fixture limit and correctly returned
incomplete. POSIX fixtures retain their five-second execution and fifteen-second
observation defaults. Lifecycle cancellation, timeout and output controls select
an explicit five-second execution limit and retain their existing observation
bounds. Native outcomes must still finish with the exact original assertions;
incomplete results cannot satisfy a passing fixture. These are test startup
budgets; production defaults and the outer source/installed cohort deadlines
are unchanged.

The Tasks matrix acceptance cases are declared in `required-native-tests.json` as `tasks-matrix`. The source and fresh installed runtime selectors compare their exact addresses with the frozen profile before execution. A required `tasks-runtime-manifest` control rejects omitted, renamed, duplicated, foreign or extra bindings, checks all three supported platform selections and retains the Windows-only control family. Focused Tasks selections use exact named-callback isolation; full-suite runs keep every file and test in scope. The generic runner also selects the existing bounded Tasks file allowance for that profile. An adjacent profile name retains whole-file skip accounting. These bindings add no product permissions or execution defaults; exact current-source runtime acceptance remains separate.

## Declared standalone runner source boundaries

A finite catalog at `scripts/ci-source-boundaries.json` binds selected standalone
Node runner entrypoints to their existing native profiles and explicit source
references. The catalog also enumerates related component test files. Their
declared native consumers run alongside the shared checks and complete selected
test files, including every callback in those component files. This covers the catalog's Helm, Terraform, Scala,
Clang and analyzer entrypoints; it does not infer that every file bearing one of
those language names is isolated. General planners, evidence parsers, the engine,
process ownership, dependencies and unclassified source remain global.

Before narrowing a source change, the builder inspects all source literals and
requires the exact declared URL callers and validation references. New module
imports, changed callers/counts, unresolved runner construction, encoded aliases
from an undeclared caller and missing native consumers invalidate the contract.
Unknown same-name paths remain unresolved rather than being assumed foreign.
The planner then falls back to full verification. The source inspection parses
text and never loads a runner or evaluates repository modules.

The shared producer registry has one narrow exception, pinned to its exact
LF-normalized source identity. That implementation constructs the fixed identity
map and hashes only the selected program; its reference does not import a runner.
A registry change invalidates source isolation until the exception is reassessed.
The registry file itself always selects full verification. This is an explicit
reviewed boundary contract, not proof of every possible runtime dependency or
qualification of omitted jobs. Full main, scheduled and release verification
remain required for broader evidence and Gate A reconciliation.

The resource-readiness prerequisite case retains separate complete prepared-tool
copies for its corruption controls. Its Windows aggregate test deadline is five
minutes after the Windows case timed out at its former two-minute test limit.
The case includes an offline install with its own three-minute command budget
and separate corruption/cache controls.
Other hosts and each preparation/execution command keep their existing limits.
This changes the harness deadline; its byte, receipt, publication and cleanup
assertions remain required.

The Tasks runtime matrix also requires the whole consumer-impact source and
fresh offline installed cohort, preserving the original foundation callbacks and
nested event accounting. Windows consumer acceptance has its own matrix lane,
using the same pinned Windows slot as the task, review and lifecycle lane. Both
remain required by `ci-complete`, and each cohort keeps its execution limits.
The Windows installed callback has a separate aggregate observation allowance
for the complete packaged profile and original foundation cohort. Individual
execution limits and output caps stay fixed, and other hosts retain their
original package observation allowance.
The Linux ARM64 controller binds its selected base images and native Git
prerequisite. Local development evidence is recorded separately in
[CONSUMER-ACCEPTANCE.md](CONSUMER-ACCEPTANCE.md); hosted acceptance requires
complete source and fresh-install receipts. This wiring does not qualify omitted
native profiles, upstream producer closure or Gate A.

Native consumer acceptance preserves each existing selected controller behind a
fixed internal entrypoint. Successful jobs upload only sanitized current-source
capsules; `ci-complete` downloads separate artifacts from the current workflow
attempt and reconciles the complete selected inventory after requiring every
selected outer job to succeed. Unselected scopes remain visible and cannot close
the consumer profile. Full native qualification still requires every frozen
family/runtime scope, including the selected Clang witness; transport wiring and
synthetic controls are not native qualification. See
[CONSUMER-WITNESS-EVIDENCE.md](CONSUMER-WITNESS-EVIDENCE.md).
