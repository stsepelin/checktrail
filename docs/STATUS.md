# Implementation status

This is an experimental foundation with public source at
[stsepelin/checktrail](https://github.com/stsepelin/checktrail).
Check the [installation guide](INSTALLATION.md) for package availability and setup.
The `0.1.0-alpha.2` preview is published on npm and active in the MCP Registry.
The [hosted run at 4ce8398](https://github.com/stsepelin/checktrail/actions/runs/35590670960)
passed all jobs. The published tarball matched the reviewed artifact; fresh
registry installation, CLI/library validation, generated npx startup and MCP
execution/trust behavior were verified. Earlier toolchain evidence remains in
`NATIVE-CI.md`; release details and tag limitations are in `RELEASE.md`.
The GitHub alpha.2 prerelease includes the verified artifact and checksum.
[Public adoption](PUBLIC-ADOPTION.md) records the published package on five pinned
libraries, including incomplete coverage and a TypeScript 4.9.5 incompatibility.

## Alpha.3 candidate (unpublished)

- [TypeScript compatibility](TYPESCRIPT.md): plain typechecking now passes the
  native 4.9.5 regression while retaining the 6.0.3 `noCheck` override and native
  file accounting. A packed CLI/library/MCP replay fixes the recorded mitt case.
  Published alpha.2 and its immutable adoption record retain the original failure.

## Implemented

- Alpha.2: conservative multi-language `init`, execution-free `doctor`,
  and version-pinned MCP configuration output for Codex, Claude Code/Desktop,
  Cursor and VS Code. Existing files are preserved. See [ONBOARDING.md](ONBOARDING.md)
  for scope, ambiguity handling and package upgrade/rollback verification.

- Exact required-test accounting across prepared CI language profiles and native
  container helpers, including dedicated Ruby/Swift jobs. Skipped, missing,
  duplicate, TODO or failing cases cannot satisfy these profiles. Hosted profiles
  passed at `52ba415`; see `NATIVE-CI.md` for the distinction from optional local tests.

- External Ruff integration evaluation against pinned upstream Python fixtures and
  snapshots, with native/verifier location comparisons on macOS/Linux and explicit
  incomplete/excluded accounting. See `EXTERNAL-RUFF-EVALUATION.md` for scope.

- Standard JSON Schema patterns for guidance URLs and exported Vue/Nuxt paths,
  strict compilation of published schemas, and regression checks for URL/path
  prefixes and request boundaries. The original external-evaluation runtime is
  preserved separately; its holdout evidence is not relabeled as this revision.

- Fresh offline package verification through actual Claude Code health/discovery
  and Codex app-server direct MCP calls, including native passing/failing/incomplete
  outcomes. Versioned profiles and limitations are in `CLIENTS.md`.

- External ESLint integration evaluation against independently authored synthetic
  upstream cases, a frozen verifier, exact diagnostic accounting and paired native
  comparisons on macOS/Linux. See `EXTERNAL-EVALUATION.md` for results and limits.

- Optional durable library worker using the shared validation engine, startup-only
  permissions, polling, cancellation and parent-disconnect cleanup. Native
  macOS/Linux and offline installed-package checks are in `VALIDATION-TASKS.md`;
  standard MCP Tasks is still not advertised.

- Optional library-only local task storage with bounded projected results, atomic
  transitions, exclusive ownership and process-crash recovery. CLI/MCP integration
  and standard Tasks remain pending; see `TASK-STORAGE.md`.

- CLI and reusable engine: inspect, plan, run, adapter inventory.
- Recursive project discovery across eleven ecosystem families, including
  polyglot roots and nested project boundaries.
- Registered execution checks for native Node tests, Python unittest, Go formatting,
  vet and tests, and PHP syntax. Python runner selection is explicit; Node default
  selection requires the exact `node --test` script. Explicit TypeScript checking
  uses a compiler installed within the root and verifies compiler file inclusion.
- Explicit ESLint validation with per-file configuration/rule evidence, exact
  path accounting, native diagnostic counts and cache-preserving execution.
- Explicit Vitest execution with per-file/per-assertion evidence, disabled
  automatic dependency installation, and guards against focused tests, snapshot
  updates and unhandled-error bypasses.
- Explicit Playwright native test/project evidence, snapshot and focus controls,
  flaky-test failure and prepared Chromium browser assertions; see `PLAYWRIGHT.md`.
- Explicit Jest execution with native file/assertion counters, collection-only
  rejection, disabled snapshot updates and conservative skipped-test handling.
- Explicit Vue SFC/TypeScript checks with file inclusion accounting and rejection
  of template-codegen disabling, including inherited configuration.
- Explicit pytest execution with native lifecycle events, collection/file
  accounting and failure handling for fixtures and unexpected passes.
- Explicit Ruff validation with exact file accounting, conservative enabled-rule
  evidence and disabled fixes/cache reuse.
- Explicit mypy validation with source/count evidence, module-level broad
  suppression detection and a verified native options-API version gate.
- Tool identity evidence in detailed plans/reports, using bounded native version
  probes and labeled package metadata; unknown identities prevent a passing check.
- Constrained configured golangci-lint profile with native JSON, source accounting
  and suppression guards; see `GOLANGCI-LINT.md`.
- Go native package/file accounting, per-package test participation and explicit
  Staticcheck analysis with surfaced suppressions. See `GO-SCOPE.md`.
- Explicit Go race tests, with a native race diagnostic regression and an atomic
  update counterpart that asserts the combined result.
- Explicit PHPStan checking with per-file debug accounting, native JSON counters
  and no result-cache reuse.
- Explicit workspace dependencies, Git base selection with transitive consumer
  expansion, conservative full-plan fallback and post-run Git identity checks.
- Project-specific environment requirements and operator startup permissions;
  values stay out of plans/command metadata. See `ENVIRONMENTS.md`.
- Normalized ESLint/Ruff/PHPStan diagnostics and SARIF 2.1.0 export with
  incomplete/stale execution metadata; see `SARIF.md`.
- Explicit Pint test-mode execution with exact native file/fixer accounting and
  version-gated PHAR integration; see `PINT.md`.
- Explicit Pest execution with fresh JUnit evidence, CI selection, disabled TIA
  and snapshot-creation rejection; see `PEST.md`.
- Explicit PHPUnit execution with streamed JUnit evidence and file/assertion
  accounting; standalone CLI/library JUnit imports carry distinct provenance.
- Strict declarative config, JSON schemas for plans/reports and summary projections.
- Operator-controlled execution trust and output detail; no tool-argument elevation.
- Process time/output limits, POSIX group cancellation, narrow environment
  inheritance, source fingerprints and post-run invalidation.
- Current MCP stdio serving through the official v2 SDK, with both modern and
  legacy negotiation integration tests, schema-validated tools and bounded in-memory reports.
- MCP request cancellation, concurrent-run rejection and worker cleanup on stdin
  EOF, SIGINT and SIGTERM, exercised with real processes.
- Original synthetic examples, contribution/security guidance, MIT license,
  package allowlist and CI definition with pinned action commits.

## Optional advisory review exchange

Selected-source contexts and imported human/model assessments are available through
library, CLI and MCP. Exact file bytes, context digests, current source, quotations
and declared file accounting are checked. Source and assessment prose require
operator-enabled review disclosure; model claims and token/cost metadata remain
unverified declarations and never affect native validation.

Synthetic regression cases passed on macOS arm64 Node 26.8.1 and Linux arm64
Node 22.23.2. Fresh offline installation passed library/CLI/MCP calls with container
networking disabled and read-only source mounts. Guard mutations reproduced
forged-source freshness and ungranted disclosure failures, then passed after
restoration. No model inference or review-quality improvement is claimed. See
`REVIEW-EXCHANGE.md`; independent M5 evaluation and durable Tasks remain pending.

## Nuxt SSR testing assembly

The opt-in Nuxt 4.5.2 / Nitro 2.13.4 profile builds a fresh testing assembly and
observes the actual router after in-process SSR requests complete. Native cases
passed on macOS arm64 Node 26.8.1 and Linux arm64 Node 22.23.2. Fresh offline
installation passed library/CLI/MCP verification with networking disabled and a
read-only public fixture, including a broken route-name contract. A reproduced
lifecycle regression now accounts for later awaited render hooks; cancellation
was tested against an observed live startup and verified temporary-directory
removal. The profile covers selected SSR requests, not browser hydration, every
route parameter or production equivalence. See `NUXT.md` for reproduction and limits.
The hosted Nuxt job passed at `52ba415`; see `NATIVE-CI.md`.

## Vue Router testing assembly

The opt-in native Vue Router 5.3.1 / Vue 3.5.43 profile passed on macOS arm64
Node 26.8.1 and Linux arm64 Node 22.23.2. It checks declared native resolution
chains and requires every final route record to participate in a probe. A fresh
offline package install passed library/CLI/MCP checks with the public synthetic
example, including a deliberately broken route contract. This does not establish
production assembly equivalence, navigation/guard behavior or Nuxt support. See
`VUE-ROUTER.md` for reproduction and projection limits.

## Impact measurement

The paired impact harness runs full and Git-selected native Node checks on identical
source/policy snapshots, verifies named failing consumer assertions and records raw
execution cost. It includes a deliberately misdeclared dependency graph whose
selected pass omits failures found by the full run. See `IMPACT-MEASUREMENT.md` for
macOS/Linux observations and limits; this is not independent held-out evaluation or
a general speedup/graph-completeness claim.

## Release preparation

`server.json`, the npm package and the engine identify the unpublished
`0.1.0-alpha.3` candidate. The currently published npm and Registry release is
alpha.2. The candidate adds legacy TypeScript compatibility; publication requires
its source commit to pass hosted CI and its exact tarball to pass release checks.
Historical publication evidence and the candidate sequence are in `RELEASE.md`.

## Pinned pack distribution

An explicit `fetch-pack` CLI/library operation retrieves bounded data-only policy
JSON over verified HTTPS, checks its digest/schema and publishes a new local file
without overwriting existing files. Local HTTPS regression cases exercise complete
transfers, failure paths, cancellation, privacy and simultaneous publication. These
cases passed on macOS Node 26 and Linux arm64 Node 22, including installed-package
CLI/library calls in a container with external networking disabled. No MCP
download tool or automatic network resolution was added. See `PACK-DISTRIBUTION.md`.

## External executable adapters

The local pinned-bundle protocol is implemented across library, CLI and MCP
startup configuration. Node, Python and compiled Go fixtures ran on macOS; Linux
fixtures additionally exercised PHP. The Linux verification used Node 22.23.2,
Python 3.12.13, Go 1.26.5 and PHP 8.5.6 with networking disabled. Fresh offline
package installation passed through the library, CLI and MCP using the public
Node example. These runs verify the protocol and fixtures, not arbitrary plugins.
See `EXTERNAL-ADAPTERS.md` for reproducible commands and trust limitations.
The hosted job passed native and installed-package checks at `52ba415`;
see `NATIVE-CI.md`.

## Verification and boundaries

The foundation suite has been run successfully on Node 22, 24 and 26 on macOS.
The current host suite explicitly skips native PHP and Python tools absent from
the host; separate container evidence is described below. `npm run check` (type checking, lint and tests)
and `npm run format:check` pass. A built npm tarball was installed into a fresh
temporary consumer; its CLI version and JavaScript validation smoke checks passed.
Packed contents were inspected against the package allowlist. Runtime dependency
metadata for the installed MCP server/core packages and Zod declares MIT licenses.
The expanded lifecycle, evidence and TypeScript tests also pass on Node 22 and 24.
A fresh offline tarball installation verified the public library import, packaged
TypeScript validation and CLI version with production dependencies only (plus the
consumer's separately installed TypeScript compiler).

Native Node, Python and Go execution has been exercised on macOS. PHP is not on
the host PATH, so the default host suite explicitly skips it. The same PHP adapter
integration test passed against PHP 8.4.23 in an already-installed official Linux
container with networking disabled and a read-only synthetic project mount. It
accepted valid PHP and rejected malformed PHP. `node scripts/verify-php-container.mjs`
reproduces that separate check after building; it requires the local `php:8.4-cli`
image and never pulls an image. The verifier itself does not start containers.

The automated suite checks CLI exit behavior, SDK wire calls, schema drift,
execution trust, literal arguments, environment filtering, path escape, nested
discovery, missing tools, timeout/cancellation, output limits and changed source.
Parser fixtures include zero tests, all-skipped tests, inconsistent counts,
duplicate summaries, malformed output and unfinished Go test/package streams.
Node's implicit passing result for an empty file is explicitly rejected using
file-level summary events.

The CI definition targets Node 22/24/26 on Linux and Node 24 on macOS, with Python,
Go and PHP provisioned and preflighted. The full matrix passed at `52ba415`;
see `NATIVE-CI.md`. Windows process execution is explicitly unsupported.

The SDK package version alone did not establish modern protocol serving. Tests
pinning 2026-07-28 initially rejected the legacy-only connection entry point. The
implementation now uses the SDK's `serveStdio` factory and the pinned-version
tests pass. The named Claude Code and Codex application-client profiles now have
separate fresh-install evidence in `CLIENTS.md`; other application profiles remain
unverified.

TypeScript integration exercises version 6.0.3: valid source, a real TS2322 error,
`noCheck` bypass prevention, excluded source with a zero exit code, paths containing
spaces, a root-hoisted compiler, no emitted/incremental files, missing tools and
an escaping dependency symlink. A missing file-list entry is incomplete. A separate `javascript.typescript-build` adapter now validates project references
with fresh in-memory declaration/build outputs; see `TYPESCRIPT-BUILD.md`.

ESLint 10.10.0 integration exercises synthetic JavaScript errors, warnings and
syntax failures; ignored/unconfigured files; disabled rules; broken configuration;
hoisted tools; literal filenames; and preservation of an existing lint cache.
CLI and MCP return equivalent check results for passed, failed and incomplete
cases while keeping diagnostics out of summaries. Malformed evidence and duplicate
or missing paths cannot produce a passing check. See `ESLINT.md` for support limits.
The ESLint tests and shared local-tool resolution regression tests pass on Node
22, 24 and 26 on macOS. A fresh offline tarball installation also passed ESLint
validation through both the exported library and installed CLI, using a separately
provisioned consumer ESLint installation.

Vitest 5.0.1 / Vite 8.3.0 integration verifies positive assertion counts, failure
counts, skipped/todo tests, omitted files, snapshot preservation, focused-test
rejection, unhandled rejections and missing environment dependencies. Structured
parser tests reject mismatched totals, duplicate/unexpected files and nonterminal
assertions. Configuration cannot make a missing dependency trigger installation.
The Vitest integration and parser tests pass on Node 22, 24 and 26 on macOS.
See `VITEST.md` for scope and compatibility limits.

Jest 30.5.2 integration verifies passing and failing assertions, files under
`__tests__`, import failures, empty files, intentional skips, focus omissions,
config exclusions and snapshot preservation. Collection-only configuration and
result processors cannot turn unexecuted tests into passing evidence. Pending
tests make the result incomplete; see `JEST.md` for this conservative boundary.

The [MCP compatibility record](MCP-COMPATIBILITY.md) distinguishes ordinary async
execution from the unimplemented durable Tasks extension. The optional routing
probe reproduces SDK 2.0.0 rejecting modern `tasks/get` and `tasks/cancel` with
`-32601` before registered handlers, while accepting `tasks/update`. The server
does not advertise this extension.

Vue integration exercises vue-tsc 3.3.11, Vue 3.5.43 and TypeScript 6.0.3 against
valid SFCs, script and template type errors, excluded source, inherited template
check disabling and no-emission checks. See `VUE-TSC.md` for limits.

Pytest 9.1.1 / Python 3.12.13 passed the native integration cases in a prepared
Linux container with no network and read-only synthetic source. The host has no
pytest and explicitly skips that native case. Parser/planning tests still run.
See `PYTEST.md` for the event contract and reproduction steps.

Ruff 0.16.8 passed native diagnostics, exclusions, disabled rules, per-file
ignore and no-fix/cache-preservation cases in the prepared Linux container. The
host lacks Ruff and skips that native case explicitly. See `RUFF.md` for the
conservative per-file-ignore accounting and text-format compatibility limits.

Mypy 2.3.1 / Python 3.12.13 passed native assignment, broad suppression, missing
import, unused-ignore and cache/no-install cases in the prepared Linux container.
The default host native test skips because mypy is absent. Other mypy versions
are explicitly unavailable until the native options API is verified; see `MYPY.md`.

The Jest, Vue, tool-identity and MCP regression tests also pass on Node 22.23.2
and 24.21.0 on macOS. A fresh offline npm tarball installation passed all eight
JavaScript check families through the public library import, installed CLI and
MCP stdio server with protocol 2026-07-28. `node scripts/smoke-package.mjs`
reproduces this against synthetic consumer projects and separately provisioned
local native tools; it validates the package file allowlist before installation.

Go 1.27.1 on macOS arm64 passed the race adapter regression: concurrent writes
failed with a native race report, while atomic updates passed with the exact
expected count. This does not cover unexecuted paths or all build tags.

PHPStan 2.2.14 / PHP 8.5.6 passed return-type, excluded-file and configuration-error
fixtures in the official Composer container with no network. The current
verification script creates synthetic fixtures inside Linux to avoid host bind-mount
visibility uncertainty observed when replacing fixtures between invocations.
The host skips this native test because PHP is absent. See `PHPSTAN.md` for the
locked development tool preparation and separate verification command.

PHPUnit 13.3.4 / PHP 8.5.6 passed assertion, exception, skip, empty, assertionless
and multiple-file cases in the isolated Composer container. JUnit parser/CLI
tests also cover malformed XML, entity declarations, nesting/size limits,
duplicate cases and aggregate counts. Imported reports are explicitly distinct
from live validation; see `PHPUNIT.md` and `JUNIT.md`.

Pest 5.2.1 and Pint 1.32.1 native regressions run in the same PHP 8.5.6 container
with Node 22.23.2. See `PEST.md` and `PINT.md` for evidence and limits. The fresh
offline package consumer also exercises JUnit through library and CLI exports.

Git 2.54.0 (Apple Git 157) on macOS exercised committed/index/working changes,
newline paths, renames, executable modes, linked worktrees, unresolved merges,
excluded tracked files and unsafe filter configuration. A changed producer selects
and fails its real synthetic consumer test; CLI and MCP return equivalent scope.
See `WORKSPACES.md` for bounds and fallback rules.

Playwright native tests also pass against real prepared Chromium: the correct DOM
assertion passes, its wrong-text counterpart fails, and an absent browser is
unavailable. A fresh offline package consumer passed Playwright alongside the
other JavaScript adapters through library, CLI and MCP. Targeted mutations of
focused-test rejection, snapshot-check protection and Git consumer expansion each
caused their named native regression tests to fail; original code was restored.

The Go scope, Staticcheck and TypeScript solution tests also pass on Node 24.21.0.
The fresh package smoke now includes the TypeScript solution adapter through
library, CLI and MCP, in addition to the earlier JavaScript families.

Exact finding reconciliation now covers baseline and exception ownership,
expiration, duplicate occurrence counts, stale entries and explicit expansion
ratchets. Native ESLint fixtures exercise partial repair while another issue
remains. CLI and MCP preserve the native failed outcome even when the separate
comparison passes; MCP tests also verify retained-report, path and output bounds.
See `FINDING-POLICY.md` for artifact freshness limits.

Runtime inventory comparison now handles exact assembly registrations,
attributes, multiplicity and order through CLI/library/MCP. Its synthetic tests
cover routes, listeners, middleware, schedules and bindings. Imported snapshots
are explicitly distinguished from verified native runtime collection; see
`RUNTIME-INVENTORY.md`.

Pinned local JSON packs and additive operator-selected overlays now compose
registered checks without changing trust or output settings. Native Node/ESLint
fixtures verify required-check preservation, missing environment permission,
MCP startup restrictions, content-integrity failures and hidden mid-run policy
changes. Public check profiles and their limits are documented in `POLICY-PACKS.md`.

Captured producer/consumer contract validation now uses strict JSON Schema
2020-12 with Ajv and format assertions, without coercion, default insertion or
field removal. Bounded workers isolate schema computation from MCP's event loop;
pathological-pattern, cancellation and shutdown tests verify lifecycle behavior.
A native synthetic producer demonstrates a string-to-integer contract break and
its repair. Artifact provenance and limitations are recorded in `CONTRACTS.md`.
The pinned Ajv and ajv-formats packages are now runtime dependencies; their versions
were unchanged from development use. Both declare MIT licenses.

The opt-in FastAPI route profile is verified with FastAPI 0.141.1, Starlette 1.6.0
and Python 3.12.13 in a network-disabled official Linux container. Native tests
cover framework defaults, exact duplicates, HTTP/WebSocket identity boundaries,
startup-added routes, cleanup failures and unsupported mounts. The collector emits
runtime artifacts for the supported flat projection; it does not infer routing
semantics or authorization. See `FASTAPI.md`.

The Django profile is verified against Django 6.1.1 on the same Python 3.12.13
Linux fixture runtime. It captures nested resolvers and setup-time registrations,
retains regex endpoint mode, and rejects unsupported route/converter shapes.
See `DJANGO.md` for the projection's limits. Framework profiles are loaded only
when selected, so an unused malformed profile cannot block another Python check.

The Laravel testing assembly profile is verified against Laravel 13.32.0 and PHP
8.5.6 with Node 22.23.2 in a network-disabled Linux container. It captures five
declared projections, including wildcard listeners and container factory targets,
and initializes Artisan before collecting `withSchedule()` registrations. Native
cases compare changed/fixed assemblies and reject unsupported, empty or failed
capture. The tests read the public synthetic Laravel example files directly.
See `LARAVEL.md`; this does not establish application authorization correctness or
complete container/object-state equivalence.

Public FastAPI and Django examples are also exercised through their native Linux
collectors, including their deliberately duplicated-registration counterparts.
Reproduce with `node scripts/verify-framework-container.mjs`.

Explicit architecture policies are implemented through CLI/library/MCP, with
literal project/layer matching, cycle components, input limits and complete
project/edge accounting. Results are labeled imported dependency evidence; native
import-graph extraction is not implemented. See `ARCHITECTURE-POLICY.md`.

The public built-package integration fixture compiles a TypeScript producer, packs
and installs it offline with lifecycle scripts disabled, then checks the installed
consumer through TypeScript and Node tests. A mismatched declaration/runtime case
proves why both checks matter. Complete failed Node, unittest and Go test evidence
now retains counters alongside failure status; malformed/interrupted evidence
still cannot invent counts. Native regressions cover all three parser families.

Rust/Cargo 1.98.1 compilation is verified in the official Alpine Linux image with
Node 22.23.2, networking disabled and synthetic fixtures. Native dep-info accounts
for inventoried Rust files, including spaces and build-script source; missing
feature targets, unlinked files and missing test-mode compilation prevent pass.
This profile does not run tests or support multi-package workspaces. See `RUST.md`
and `node scripts/verify-rust-container.mjs`.

Ruby syntax checking is verified with MRI 4.0.7 in an isolated Alpine container and
MRI 2.6.10 on the available macOS host. The profile includes Ruby DSL manifests,
disables gems and preload flags, and requires native success evidence per file.
Sentinel fixtures verify top-level/BEGIN code is not evaluated by syntax checking.
This adds no Ruby test, gem-resolution or Rails coverage. See `RUBY.md`.

Swift grammar checking is verified with Apple Swift 6.4 on arm64 macOS. It parses
inventoried source and Package.swift without evaluating the manifest, records the
native compiler and driver evidence, and excludes generated .build contents. The
native fixture explicitly distinguishes valid syntax from incorrect types. See
`SWIFT.md`; SwiftPM builds, type checks, tests and Linux support remain unverified.

Advisory guidance is now available through CLI/library/MCP using exact public
check/topic triggers. It returns review questions and references, never automated
findings or a passing result. Targeted mutation experiments use a separate
advisory report and the shared validator in fresh temporary copies. The initial
profile supports dependency-free flat Node tests and distinguishes native assertion
failures from syntax/import/runtime errors, changed identities and incomplete
execution. See `GUIDANCE.md` and `MUTATIONS.md` for limits and evidence.

The advisory guidance/mutation regression cases pass on Node 22.23.2, 24.21.0
and 26.8.1 on macOS. A fresh offline tarball install exercises their public library,
CLI and MCP surfaces, alongside the existing package smoke checks. Mutation MCP
cancellation keeps planning responsive and removes the temporary copy. Removing
the native assertion classification guard made the named runtime-error regression
fail; the original build was restored after the experiment.

Production npm dependency metadata and notice hashes now reconcile with the
installed tree and lockfile using `scripts/audit-dependencies.mjs`. A missing
bundled notice is supplemented from its pinned upstream commit, with the source
file comparison and manifest-version discrepancy recorded in `DEPENDENCIES.md`.
Development tools, native binaries and images remain outside this audit.

The C/C++ profile is verified with Apple Clang 21.0.0 on arm64 macOS and Alpine
Clang 22.1.3 on arm64 Linux. It executes prepared compilation-database argument
arrays without a build system, reconciles native SARIF and dependency evidence,
and requires inventoried translation units and headers to be observed. Native
cases exercise relative `__FILE__` preservation, configuration variants, headers
with spaces, generated/symlinked inputs, compiler errors and missing tools.
See `CLANG.md`; linking, code generation and test execution are not covered.
A fresh offline package install also passes this profile through library, CLI and
MCP on the verified macOS compiler. Removing the source-coverage reconciliation
made the omitted-source native regression fail; the original build was restored.
The dedicated Clang container job passed in the first hosted run; see `NATIVE-CI.md`.

The Java classpath profile is verified with Temurin JDK 25.0.4+7 on arm64 Linux.
Native fixtures cover public records, a type-error/fix pair, release mismatches,
raw-type warnings, empty/package files, multiple top-level types, excluded source,
pinned binary dependencies, disabled annotation processors, hidden manifest
classpaths and source-bearing JAR rejection. Static application initialization
was not executed and no class outputs appeared in the project. The prepared
container runs with its network disabled.

Fresh offline package installation passed the Java public library, CLI and MCP
checks. Removing the declared-type analysis guard made the native missing-analysis
regression fail; the original implementation was restored and native verification
rerun. `scripts/verify-java-container.mjs` reproduces both native and packaged checks.
The hosted amd64 job passed at `52ba415`; macOS has no prepared JDK.
See `NATIVE-CI.md`.
This is Java compilation under explicit settings, not Maven/Gradle, Kotlin/Scala,
JPMS, application tests or annotation-processor support. See `JAVA.md`.

A synthetic performance harness measures fresh-process planning and validation,
verifies expected execution counts, and records raw timings and artifact digests.
The recorded macOS/Node 26 and Linux/Node 22 samples are documented in
`PERFORMANCE.md`. Engine CPU and peak memory exclude child processes; these are
initial workload measurements, not speed guarantees or detection-quality evidence.

The C# compilation profile is verified on arm64 Linux with .NET SDK 10.0.401,
Roslyn assembly version 5.9.0.0 and runtime/reference pack 10.0.12. Native cases
exercise records, partial types, empty files, language-version restrictions,
nullable warnings, explicit symbols, unsafe settings, friend-assembly identity,
missing generated source and compiler suppressions. A compiled synthetic
reference includes both a module initializer and an incremental generator;
validation reads its metadata without executing them. The initializer has an
explicit execution control proving its observable marker works.

The semantic-accounting guard mutation caused the missing-analysis regression to
fail. Removing the assembly-file guard produced a false pass using an unpinned
`.netmodule`; the regression caught it. Both guards were restored. Fresh offline
installation passed the C# library, CLI and MCP checks. Reproduce native and
packaged verification with `scripts/verify-dotnet-container.mjs`. The hosted
amd64 job passed at `52ba415`; see `DOTNET.md` for compilation limits and
unsupported build, language and test profiles.

## GitHub Actions workflow verification

The `infrastructure.actionlint` profile uses the official actionlint 1.7.12
release. Native macOS arm64 and Linux arm64 tests passed for workflow errors,
YAML failures, local action assets, reusable inputs, literal environment settings,
repository ignore bypass and per-file evidence accounting. A manual mutation
removing the native completion-count guard made an omitted completion record pass;
the accounting regression caught that false pass. The guard was restored.

The explicitly prepared Linux image verifies its downloaded release archive's
SHA-256 digest. Network-disabled runs with read-only repository and consumer
mounts passed native tests and a fresh offline-installed package's library, CLI
and MCP surfaces. The hosted amd64 job passed at `52ba415`; see `NATIVE-CI.md`.
See `ACTIONLINT.md` and `scripts/verify-actionlint-container.mjs` for reproduction and
profile limits. Other infrastructure tools remain unsupported.

## Development evaluation

A separate original corpus now measures Node assertion, TypeScript type-contract
and GitHub Actions workflow cases against the shared engine and direct native
commands. Reports preserve every case, expected diagnostic signals, incomplete
observations, source/tool/artifact identities and raw timings. macOS arm64/Node 26
and network-disabled Linux arm64/Node 22 observations agree on classifications.
See `EVALUATION.md` and `docs/measurements/evaluation-*.json` for the actual counts.

This is post-implementation development evidence, not independent held-out
research or comparison with a private prior workflow. The measured TypeScript
improvement comes from forcing analysis on when the fixture disables it; the
other differences concern execution completeness and declared profile limits.
No general review-quality improvement, production false-positive rate or model
performance claim follows from these samples.

## Next implementation work

1. Broaden runtime matrices and native PHP tooling.
2. Framework-specific scope and integration contracts.
3. Framework integration and additional verified linter profiles.
4. Additional ecosystem adapters and their native evidence.
5. Semantic framework rules and native runtime collectors. Public check profiles,
   finding ratchets and local private policy overlays are implemented; existing
   private instruction files have not been migrated.
6. Durable Tasks support after a compatible SDK passes the routing probe; the
   lifecycle and persistence acceptance gates are in `MCP-COMPATIBILITY.md`.

Complete dependency/tool/environment fingerprints, automatically inferred workspace graphs,
remote/executable private plugins, native import-graph collection, remote serving, durable Tasks,
sandbox execution, automatic fixes and model-assisted review are not implemented.
The inventory intentionally does not read `.gitignore`; its fixed exclusions and
limits are documented in the README. Bundled adapter behavior is versioned with
the engine until adapters receive independent releases.

Tests and source fingerprints do not prove program correctness or secrecy against
malicious project code. The result means that the selected checks ran with the
reported evidence. It never means the entire repository has been reviewed.
