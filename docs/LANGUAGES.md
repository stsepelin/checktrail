# Language and ecosystem roadmap

The [setup guide](ONBOARDING.md) describes conservative
per-language configuration proposals and static tool diagnosis. Setup does not
extend the execution capabilities or native evidence listed below.

Capability levels are discovery, planning, execution, structured evidence,
semantic rules, and integration validation. None implies the next. This file's
initial scope column describes the experimental implementation. Node, Python,
Go, TypeScript, ESLint, Vitest, Jest and vue-tsc execution have been exercised locally. Vitest accepts stable major versions 4 and 5; native compatibility is exercised at 4.1.9 and 5.0.1 (see [Vitest validation](VITEST.md)). PHP syntax
has been verified separately in an isolated official Linux container. Tool versions and remaining gaps are tracked in `STATUS.md`.

| Family                        | Project boundaries                                                                                             | Initial scope                                                                                                                                                                                                                                                                                 | Subsequent native integrations                                             | Important constraints                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| JavaScript / TypeScript       | package.json                                                                                                   | Discovery; Node/Vitest/Jest/Playwright tests; explicit local tsc/vue-tsc, solution references, ESLint and opt-in Vue Router/Nuxt SSR route contracts                                                                                                                                          | framework scope profiles                                                   | ESLint JavaScript is exercised; parser/processor combinations need their own verification; TS tests need a loader/build |
| Python                        | pyproject.toml, pyrightconfig.json, setup.py, requirements.txt                                                 | Discovery; unittest/pytest, Ruff/mypy, pinned local Pyright and opt-in FastAPI/Django route inventories                                                                                                                                                                                       | Wider Python/tool configurations                                           | Never import setup.py for discovery; virtual environments, namespace packages and plugins matter                        |
| Go                            | go.mod                                                                                                         | Discovery; gofmt, production builds, vet/tests, race/Staticcheck/golangci-lint, repeated tag/target profiles; native scope accounting                                                                                                                                                         | broader golangci-lint settings                                             | Module/workspace boundaries, build tags, cgo, platform constraints and test caching                                     |
| PHP                           | composer.json                                                                                                  | Discovery; syntax, PHPStan with project-enabled Larastan, PHPUnit, Pest, Pint, PHP-CS-Fixer and opt-in Laravel assembly capture                                                                                                                                                               | Wider framework/type profiles                                              | Syntax is not type/test validation; runtime extensions, generated proxies and framework bootstrapping matter            |
| Rust                          | Cargo.toml                                                                                                     | Offline locked Cargo check, opt-in Clippy/libtest/doctests and Cargo/Rustfmt; explicit workspace feature/target profiles                                                                                                                                                                      | Other toolchain/platform/profile acceptance                                | Build scripts/proc macros execute code; exact source exclusions, installed targets and operator trust                   |
| Java / Kotlin / Scala         | pom.xml, build.gradle, build.gradle.kts, checktrail.detekt.json, checktrail.kotlin.json, checktrail.scala.json | Explicit Java classpath compilation, configured Checkstyle audits, opt-in SpotBugs bytecode analysis and pinned Java Maven reactor and Gradle module tests; opt-in Kotlin detekt light source analysis and pinned Kotlin JVM source compilation; opt-in pinned Scala 3 JVM source compilation | Wider Maven/Gradle/analyzer profiles, mixed/generated Kotlin and Scala     | Multi-module builds, wrappers, JVM versions, generated sources and plugins                                              |
| C# / F# / Visual Basic / .NET | *.csproj, *.fsproj, *.vbproj, *.sln, *.slnx                                                                    | Explicit C# compilation, opt-in pinned C#/F#/VB builds/NUnit tests, and C#/VB native whitespace formatting with fresh source and reconciled native evidence                                                                                                                                   | Code-style/analyzer formatting, wider test/build and generator profiles    | Restore policy, analyzers, target frameworks, generated code and TRX parsing                                            |
| Ruby                          | Gemfile, *.gemspec                                                                                             | MRI syntax checking; bounded source-bound RuboCop/RSpec/Minitest in RUBY-TOOLS.md                                                                                                                                                                                                             | Wider Gemfile DSL, binary platform and framework profiles                  | Frozen raw gem checksums, literal manifest grammar, native lifecycle/source evidence and operator trust                 |
| Swift                         | Package.swift                                                                                                  | Native grammar checks; bounded SwiftPM build, XCTest/Swift Testing and SwiftLint in SWIFT-TOOLS.md                                                                                                                                                                                            | Wider manifest, platform/SDK and framework/lint profiles                   | Manifest/code execution needs operator trust; native compiler/scope/case/lifecycle reconciliation                       |
| C / C++                       | CMakeLists.txt, meson.build, compile_commands.json                                                             | Prepared Clang checks; bounded C17/C++20 CMake builds, CTest, clang-format and clang-tidy in CPP-TOOLS.md                                                                                                                                                                                     | Wider CMake, target/toolchain, analyzer and framework profiles             | Compilation database, toolchain and build configuration are required                                                    |
| Infrastructure                | .github/workflows/*.yml or *.yaml, *.tf or *.tf.json, Chart.yaml, kustomization.yaml                           | Static GitHub Actions analysis; bounded offline kubeconform, provider-free Terraform JSON, local Kustomize assembly and Helm lint/rendering in KUBECONFORM.md, TERRAFORM.md, KUSTOMIZE.md and HELM.md                                                                                         | Terraform providers/modules, wider Helm, Kustomize and Kubernetes profiles | No workflow execution; remote actions are not downloaded; YAML aliases and merge keys require another profile           |

Nuxt, Vue Router, FastAPI, Django and Laravel profiles have separately pinned framework compatibility gates
and capture only their documented native assembly projections; see `FASTAPI.md`,
`DJANGO.md`, `LARAVEL.md`, `VUE-ROUTER.md` and `NUXT.md`.

Pint's macOS hosted check exposed a non-seekable cache-file failure. The adapter
now uses a fresh regular file with runner-owned cleanup; the corrected macOS
profile passed at `52ba415`. See `PINT.md` and `NATIVE-CI.md`.

The [Pyright profile](PYRIGHT.md) requires a pinned local compiler, explicit source
and native diagnostic accounting. Its JSON/TOML and namespace/virtual-environment
controls are bounded; suppression exceptions and native Windows are not promoted.

## Windows execution profile

[WINDOWS-EXECUTION.md](WINDOWS-EXECUTION.md) describes the experimental bounded
local-drive `.exe` runner and dedicated native source/offline-install CI profile.
Native acceptance remains pending. Other Windows tool/framework/Git/persistence
profiles are unverified; this does not promote them or close E4/E5.

## Advisory review context support

Review context collection accepts bounded UTF-8 regular source files regardless
of language; this does not add semantic rules for those languages. Version 1
selected-source contexts remain supported. Version 2 adds current-source snapshot
and immutable-base diff tracks through the library, CLI and MCP. Diff collection
uses host Git on supported POSIX systems and reports base/current bytes, exact
replacement ranges, identities and uncollected analysis. Version 3 adds the
bounded [JavaScript/TypeScript syntax profile](REVIEW-BEHAVIOR.md) with explicitly
selected support files, whole functions, declarations/defaults and lexical
caller links. Synthetic macOS arm64 Node 26.9.0 checks cover the library, CLI and
MCP; other platforms remain pending for this profile. This is advisory syntax
context, with explicit unsupported/malformed/exhausted states and unknown runtime
dispatch. Version 4 retains this syntax profile and adds explicit revision/digest
citations and unverified attribution/fix-scope declarations through assessment and
receipt version 2. Its synthetic macOS arm64 Node 26.9.0 library/CLI/MCP and offline
installed-package checks are locally verified; other platforms remain pending.
Version 5 additionally selects raw working-tree or stage-zero index source for
diffs and captures selected regular-file modes; snapshots remain working-only.
Original synthetic macOS arm64 Node 26.9.0 and Linux arm64 Node 22.23.2/Git 2.47.3
required profiles and a fresh offline Linux library/CLI/MCP package workflow pass.
Other target platforms and runtimes retain their separate acceptance gates.
These source addresses do not add native findings or semantic language support.
The [hypothesis catalogue and stateless API transport](REVIEW-PROVIDERS.md)
use the same source packets without adding language semantics. Offline synthetic
Per-assignment and optional shared verification-run API admission budgets do not
extend native language support. The shared profile accounts for calls, reported
tokens, estimated cost and transport bodies. Version 2 and 3 Node Boolean probes also
share native runner-call and delivered-output admission across their fresh cases;
version 3 retains bounded physical process bytes and replays valid observations,
with raw artifacts omitted from summaries and independent model packets. See
NATIVE-RAW-EVIDENCE.md for the bounded profile and its acceptance record.
wider native/tool budget profiles remain open. Host AI budgets are outside the
MCP server's control; native AI client orchestration is optional.
Exact development evidence is recorded in REVIEW-PROVIDERS.md and its measurements.
API/library/CLI/MCP acceptance passes on macOS arm64 Node 26.9.0 and
Linux arm64 Node 22.23.2; actual provider
inference and wider platform acceptance remain pending for that optional transport.
The required reviewer workflow is model-independent MCP exchange with host-owned
authentication. The bounded reviewer/refuter/native-probe/adjudicator exchange is
implemented through the shared library, foreground JSON-lines CLI and MCP tool.
Original synthetic required profiles pass on macOS arm64 Node 26.9.0 and Linux
arm64 Node 22.23.2/Git 2.47.3; offline production installation exercises all three
surfaces on macOS. Contexts require revision-aware versions 4/5; native
corroboration retains the plain Node Boolean profile. This adds neither language
semantics, actual AI-client acceptance, host isolation nor verified findings. See
REVIEW-MCP-WORKFLOW.md and measurements/review-workflow-2026-10-03.json.
Opt-in [durable workflow command audits](REVIEW-WORKFLOW-AUDIT.md) share the library,
CLI and MCP session wrapper on the recorded POSIX profiles. Required original
synthetic controls cover private storage, crash prefixes, ordering, budgets,
cleanup and protocol negotiation; offline production installation replays all
three interfaces. This adds no language semantics, host isolation, actual model
inference or complete benchmark attempt archive. See
measurements/review-workflow-audit-2026-10-03.json. Version 2 journals additionally
retain returned structured native receipts through early closure, partial budgets,
cancellation, timeout, stale source and memory-retention rejection. Metadata-only
inspection reconciles candidate, recipe, case, runtime and ledger bindings; version
1 native journals remain explicitly incomplete for receipt retention. Raw native
stdout/stderr and complete host-model attempt archives remain unsupported. See
measurements/review-workflow-native-audit-2026-10-05.json.
The shared [sealed synthetic benchmark intake](REVIEW-BENCHMARK.md) adds frozen
paired case/arm/settings identities, private predeclared journal paths, one-trial
MCP worker packets, complete planned-slot accounting and anonymous judging packet
preparation on the recorded POSIX development profiles. It collects structured
workflow evidence; it adds no language semantics, actual host isolation, complete
provider attempts, independent judging or quality result. Field evaluation remains
closed while Gate A is open. See measurements/review-benchmark-2026-10-05.json.
An optional frozen judge profile now supplies one anonymous source-bound judge
packet through the same CLI/MCP engine and seals every planned response path.
Original synthetic controls retain malformed/missing/foreign/incomplete responses,
validate claim citations and reject declared-session reuse or post-seal changes on
macOS arm64 Node 26.9.0 and Linux arm64 Node 22.23.2. A fresh offline production
package exercises the library, CLI and judge MCP view on macOS. Accepted/resolved
counts describe structural declarations; independent host isolation and verified
claim truth remain unimplemented. See
measurements/review-benchmark-judging-2026-10-05.json.
The bounded [native Boolean probe](REVIEW-PROBES.md) supports selected plain ESM
on POSIX with operator-pinned cases and measured V8 function/guard coverage. Wider
language probes, automatic callers and independent claim verification remain pending.
[Stateless refutation attempts](REVIEW-REFUTATION.md) can propose counterclaims
without adding semantic support or establishing their correctness. See
[REVIEW-EXCHANGE.md](REVIEW-EXCHANGE.md).

## Adapter contract

Every adapter declares stable ID/version, detection markers, capabilities,
supported OS/tool versions, check IDs, prerequisites, working-directory semantics,
scope, timeout, whether execution is required, and evidence parser behavior.
Keep language identity separate from framework packs and individual tool adapters.

Every result accounts for failure, missing executable, invalid config, zero tests,
all-skipped tests, partial output, timeout, cancellation and unexpected format.
Use native JSON/XML where available. Human-readable output parsing needs pinned
fixtures and a conservative fallback to inconclusive.

Native tools are provided by the consumer's environment. Do not download a tool
because a manifest mentions it. Use local package binaries and lockfile-compatible
versions. Do not equate an executable's presence with adapter compatibility.

## External implementations

Operator-registered Node, Python, PHP and compiled native bundles share the
[external adapter protocol](EXTERNAL-ADAPTERS.md). This permits checks written in
different languages without changing the engine. The separate
[pinned executable downloader](EXECUTABLE-BUNDLES.md) has original Linux
Node/Python/PHP/compiled-native and fresh offline installed-package acceptance,
with no implicit activation or execution. Other platform/runtime profiles remain
separate. It does not automatically add
semantic support for the languages they inspect. Each adapter needs its own native
regression cases, tool identities, platform profile and license provenance.

## Monorepos and polyglot repositories

Discover nested manifests without entering dependency caches or following symlinks.
Keep relative project roots and assign files to the closest detected project root;
avoid running a parent check over every child without reporting overlap.
One directory can carry multiple ecosystems. Language detection must preserve all
matches rather than selecting whichever marker happened to be visited first.

Workspace dependencies are explicit policy inputs; completeness is a maintainer
assertion, not inferred import analysis. Optional Git selection expands changed
projects to their transitive consumers and retains whole-project checks. See
`WORKSPACES.md`. This selection does not itself establish built-package or
producer/consumer contract validation.

## Promotion requirements

An adapter is experimental until it has real toolchain integration tests on its
advertised platforms, structured evidence tests, broken/fixed/near-miss fixtures,
scope and exclusion documentation, and a maintainer able to reproduce failures.
Framework-specific support is promoted separately. Recognition of a manifest
is always reported as discovery, never as completed validation.

The optional [review exchange](REVIEW-EXCHANGE.md) accepts selected inventoried
UTF-8 source in any language. Its bounds, freshness and quotation checks do not
add native analysis coverage or promote an ecosystem capability.

Optional [task storage](TASK-STORAGE.md) retains projected engine reports from any
adapter without adding language coverage. Its native storage profile is verified
on macOS/Node 26.8.1 and Linux/Node 22.23.2. The later optional MCP Tasks polling
profile has synthetic macOS arm64 Node 26.9.0 and Linux arm64 Node 22.23.2
wire and fresh-package acceptance with SDK 2.3.0; see `VALIDATION-TASKS.md`.
Other runtime/client profiles and full Tasks conformance remain unverified.

The [durable library worker](VALIDATION-TASKS.md) invokes the same adapter registry.
Worker-specific lifecycle evidence currently uses native Node fixtures on those
storage platforms; other adapters retain their existing separately verified profiles.

The [external ESLint integration evaluation](EXTERNAL-EVALUATION.md) adds
independently authored diagnostic cases for three JavaScript rule profiles. Its
macOS/Linux results do not extend coverage to other parsers, plugins or languages.

The [application-client checks](CLIENTS.md) exercise native Node evidence through
Codex and tool discovery through Claude Code. They do not independently verify
every adapter through either client.

Exported Vue/Nuxt profile schemas use standard JSON Schema patterns for route
prefixes and probe restrictions. Strict schema compilation and boundary fixtures
verify those constraints separately from the native framework cases.

The [external Ruff diagnostic cohort](EXTERNAL-RUFF-EVALUATION.md) adds native
macOS/Linux comparisons for the selected Python rule families. Mixed files do not
provide an independent clean-case denominator; the measurements verify diagnostic
preservation by the wrapper.

Ruby and Swift have dedicated CI definitions that require their named native
regressions to pass. Their local execution is recorded in `RUBY.md` and `SWIFT.md`;
both hosted jobs passed at `52ba415` (see `NATIVE-CI.md`). Other optional tests in the general suite can still
skip, so its aggregate pass count is not evidence for every native profile.

The prepared CI language profiles and native container helpers require exact
regression names through `NATIVE-CI.md`. Their required results are separate from
the optional skips allowed by a developer's general test suite.

[Public adoption measurements](PUBLIC-ADOPTION.md) record alpha.2 on pinned
JavaScript, TypeScript, Python, Go and PHP libraries. TypeScript 4.9.5 rejects
alpha.2's `--noCheck` option; that published artifact does not support this profile.
Go platform exclusions remain inconclusive even when native tests exit zero.

The alpha.3 [TypeScript compatibility fix](TYPESCRIPT.md) exercises plain
TypeScript 4.9.5 and 6.0.3 using native capability-aware arguments. Published
alpha.2 retains the recorded older-compiler limitation; Vue and solution-build
profiles retain their separately verified versions.

Alpha.4 adds a [Go scope policy](GO-SCOPE.md) for exact,
native-confirmed ignored files. It retains unverified exclusions in reports and
does not claim a build matrix or add custom build-tag execution. Published alpha.3
keeps the original strict exclusion behavior.

Alpha.5 adds [Go build-tag profiles](GO-BUILD.md) for
per-check tags and exclusions across vet, tests, race tests, Staticcheck and
golangci-lint. Published version 1 remains one configuration per selected check. The current
unpublished version 2 adds bounded repeated tag/target profiles, native target
preflight and production compile/link checks. Foreign tests require a target
executor that is not implemented; cross-compilation does not establish runtime
support. See the explicit contracts in GO-BUILD.md.

[Descriptive reviewer scoring](REVIEW-SCORING.md) accepts declared numerical
observations for the nine families; it does not add native language or calibrated
confidence support. Unknown labels/probabilities and unreviewed cases stay visible.

The experimental [verification profile](REVIEW-VERIFICATION.md) combines live
`node-export-boolean-v1` probes with fresh API refutation and raw-evidence
adjudication. It inherits the probe's plain ESM function and selected-dependency
limits. Native expectation mismatches do not establish production consequences
or widen language, framework or Windows support.

The bounded PHP formatter/Larastan profile and its explicit limits are in
[PHPCS-LARASTAN.md](PHPCS-LARASTAN.md). Its pinned Linux evidence does not
verify other native versions or platforms.

Rust workspace feature/target selections and exact source exclusions are recorded
in [RUST-BUILD.md](RUST-BUILD.md). Native tests stay host-only; a successful foreign
compiler/Clippy profile provides no runtime test evidence. The bounded macOS
arm64 Rust test/workspace repair and offline installed workspace profile are
recorded in [the CI repair measurement](measurements/rust-ci-repair-2026-10-06.json);
the [GNU loader repair](measurements/rust-gnu-loader-2026-10-06.json) separately
records Linux arm64 GNU source/installed controls and a macOS workspace regression;
other platform/runtime combinations and hosted CI remain separately unverified.

The [Checkstyle profile](CHECKSTYLE.md) adds pinned configured Java source audits,
with every-file completion, native rule/diagnostic reconciliation, source and
artifact identity controls, original near misses and offline installed CLI/MCP
acceptance. This bounded Linux profile leaves wider Maven/Gradle/analyzer profiles,
wider detekt, mixed/generated/script Kotlin, Scala and broader E11/platform requirements open.

The [Maven profile](MAVEN.md) reconciles a declared Java reactor, configured native
plugins, compiler inputs and source declarations, pinned test classpaths and fresh
JUnit/Surefire evidence. Original native and installed CLI/MCP controls retain
skips, empty tests, bootstrap/compile errors and partial reactor failures. Wrappers,
wider Maven/Gradle profiles, generated/JPMS scope, mixed/generated/script Kotlin and Scala, wider analyzer and detekt profiles remain required;
this bounded Linux profile does not close E11 or Gate A.

[Declared Roslyn generator participation](DOTNET-GENERATED.md) adds a separate
bounded C#/VB fresh build/test profile, with native producer/analyzer selection,
emission settings, generated-source hashes and consumer portable-symbol evidence.
Unsupported generator shapes and all generated-source formatting remain incomplete;
this does not close E12 or Gate A.

[Native NUnit method provenance](DOTNET-METHOD.md) binds C#/F#/VB custom case
names to complete native discovery/result identities and fresh compiled source
symbols. Duplicate full names and overloaded methods remain incomplete; this
profile does not close wider E12 or platform requirements.

The operator-only sealed synthetic scoring profile binds frozen case families,
common labels and retained benchmark/judgment artifacts to the shared paired
scorer. It supports at most one completed claim per trial; broader multi-claim
scoring stays unsupported. Its structural artifact/pairing checks do not establish
claim truth, independent host isolation, calibrated confidence or held-out quality.
See [REVIEW-BENCHMARK.md](REVIEW-BENCHMARK.md#scoring-sealed-synthetic-artifacts).

The [declared per-family calibration profile](REVIEW-CALIBRATION.md) supports
bounded numerical development fitting and reserved-protocol application through
the shared library/CLI/MCP engine. Exact declared trial/cluster/model binding and
unavailable/outside-support states do not authenticate labels, independent host
isolation, candidate probabilities or held-out calibration. This adds no native
language acceptance or field evaluation permission.

The [declared claim probability profile](REVIEW-CLAIM-PROBABILITY.md) binds
uncalibrated numerical predictions to original sealed single-claim candidates and
keeps unknown/incomplete predictions separately accounted. Shared independent
stage views withhold prior candidate metadata and native aggregate verdicts while
retaining exact source and per-case observations. This adds no native language,
authoritative label, host-isolation or held-out quality acceptance.

The `js-ts-selected-imports-v1` [consumer-context profile](IMPORT-CONTEXT.md) uses
the pinned engine TypeScript parser over inventoried strings under declared roots.
It collects static relative module edges and whole decisions/defaults, preserving
full fallback for unresolved or incomplete capture. Project compiler resolution,
other languages, historical consumers and runtime reachability remain unsupported
by this profile. Its exact runtime acceptance is recorded separately from adapter
execution acceptance.

The bounded [structured Node probe](NATIVE-JSON-PROBES.md) additionally observes
JSON values from selected plain ESM function exports, with physical replay and
original declared-contract controls for all nine hypothesis families. Its scope
shares the Boolean profile's source/module, trust and platform limits. It does not
add language collectors, automatic policy inference or framework assembly support.

The [SpotBugs profile](SPOTBUGS.md) adds pinned built-in analysis of freshly compiled
Java classes, exact detector and completed-pass accounting, current-source diagnostic
binding and native/installed CLI/MCP controls. Wider JVM languages, analyzers, wrappers
and platform profiles remain E11/E4–E6 requirements.

[Descriptive multi-claim scoring](REVIEW-MULTI-SCORING.md) supports multiple
retained claims and common expected defect mappings per case, distinct duplicate
precision and material recall, incomplete slots, proper claim losses and whole
incident clusters through one library/CLI/MCP engine. These operator declarations
remain unverified; authoritative independent judgments are still
required. No model or field evaluation is invoked by numerical scoring.

## POSIX process lifetime

The bounded observed-descendant cancellation profile is described in
[POSIX-CLEANUP.md](POSIX-CLEANUP.md). It confirms selected process identities
disappeared and reports unavailable cleanup evidence. Windows lifecycle acceptance
remains separate; process observation is not hostile-code containment.

[Sealed multi-claim synthetic scoring](REVIEW-BENCHMARK-MULTI.md) connects frozen
common defects, all retained reviewer claims, independent judgment intake and a
separate fresh matching declaration. macOS/Linux private storage and read-only
CLI/MCP matching workers are the bounded profile. Summary output withholds row
identities; missing, interrupted, malformed and unresolved slots remain visible.
This does not promote Windows private benchmark storage, authoritative truth,
observed host independence, calibration or quality acceptance.

The [Kotlin detekt light profile](DETEKT.md) adds selected-source analysis with a
pinned native rule plan, physical/PSI identity, lifecycle, exclusion, suppression
and raw-output accounting. Native type-dependent rules and compiler correctness
remain outside this profile. Wider Kotlin/Scala and E11/E4–E6 requirements stay open.

The [Kotlin JVM compiler profile](KOTLIN.md) adds opt-in pinned source compilation
with native FIR/IR participation, resolved suppression accounting and source-bound
physical output evidence. Its required source, guard and offline package profiles
keep compilation failures partial and retain warning policy. Mixed/generated/script
compilation, Scala and wider E11/platform scope remain open.

The [Scala JVM compiler profile](SCALA.md) adds opt-in pinned selected-source
compilation with early resolved tree/type annotations, declaration accounting,
complete native JVM/source callbacks and physical class/TASTy output bindings.
Suppressed or empty analysis cannot pass. Original source, compiling-guard and
installed-package acceptance remains profile-specific. Scala 2, scripts, mixed
source, inline/staging/macros, build wrappers, wider analyzers and the remaining
E11/platform/provenance requirements remain open.

The bounded `js-ts-historical-imports-v1` profile additionally captures immutable
base and working/index consumers, deleted/moved source and revision-specific
edges through the shared import interface. See
[HISTORICAL-IMPORTS.md](HISTORICAL-IMPORTS.md). Broader language, framework and
impact obligations remain open; this does not narrow validation plans.
