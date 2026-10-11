# Required native CI evidence

## Workflow scheduling

Independent jobs and the OS/Node matrix are allowed to run in parallel. GitHub's
account and runner capacity decides when queued jobs receive a runner. Steps
within an individual job remain ordered.

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

The macOS matrix uses the commit-pinned `setup-php` 2.40.0-beta build-cache path
for PHP 8.5. The previous pinned action failed before tests on both current main
and the replacement PR run, leaving no PHP executable. The upstream cache path
tries prebuilt packages before Homebrew and fails if it cannot establish the
requested PHP version. Linux retains its existing action pin. This is a beta
setup dependency; current hosted acceptance must verify it. It does not replace
test execution or supply cached test results.

Pinned public image setup also retries the exact Docker daemon public ECR
`/v2/` connection/header timeout observed before the Rust context tests started.
The same digest, attempt ceiling, monotonic wall budget and cancellation guards
apply. Adjacent hosts/paths, extra authentication or manifest text, child signals
and command timeout/abort codes are not admitted by this new matcher. Synthetic
regressions bind the observed error; they do not simulate the registry or certify
a hosted delivery. See the
[delivery record](measurements/pinned-image-header-retry-2026-10-10.json).

## Acceptance time budgets

The main OS/Node matrix has a 75-minute job limit, including preparation, the full
suite, required profiles and fresh installed-package checks. The required-profile
runner normally applies its timeout to each entire selected test file. Sequential
controls therefore share that file budget even when each control has its own
timeout.

Full-suite runs allow ten minutes per file, including additional files outside
the selected required profiles. The `dotnet-method` profile allows ten minutes
per selected file. Existing per-control and engine execution limits remain in
force. Standalone profiles retain their existing file budgets, including five
minutes for `review-benchmark-multi`; any timeout still fails acceptance and
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

The Scala container job allows thirty minutes for artifact preparation, source
acceptance, compiling guard mutations with their original and restored callbacks,
and fresh installed-package acceptance. The verifier records phase progress on
stderr and retains the final JSON evidence on stdout. Existing control and engine
execution limits remain in force; a job cutoff is incomplete acceptance.

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
