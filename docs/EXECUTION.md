# Autonomous execution ledger

This ledger tracks the full plan without treating a prepared scaffold as a
completed release. Work proceeds through independently testable implementations;
an unavailable runtime or external service does not count as verification.

## M0 and M1

- Implemented: public contracts, synthetic fixtures, CLI/library/MCP engine,
  trust controls, bounded execution, native Node/Python/Go checks, schemas and CI
  definition. Integration evidence is recorded in `STATUS.md`.
- Verified separately: PHP syntax against PHP 8.4.23 in an isolated official Linux
  container, using the actual engine integration test.
- Verified: fresh offline package installation with Claude Code health/discovery
  and Codex app-server direct tool calls; see `CLIENTS.md` for the precise profiles.
- Verified: strict standard compilation of exported schemas, equivalent URL/path
  boundary cases, and warning-free Claude Code discovery after correcting the
  nonstandard prefix format. Original frozen evaluation artifacts remain separate.
- Remaining: hosted CI runs and broader client profiles. PHP syntax
  planning still reports unavailable when PHP is absent from the consumer runtime.

## M2

- Published in alpha.5: named per-check Go build-tag profiles with independent
  exclusions, matching listing/execution settings, unchanged formatting scope,
  strict missing/ambiguous assignment handling and summary privacy. Native
  Go/Staticcheck/golangci-lint cases and CLI/library/MCP replay cover the selected
  configuration; repeated-check and cross-target matrices remain pending.
  See `GO-BUILD.md` and `examples/go-build`.

- Implemented: explicit local TypeScript and ESLint adapters with file accounting.
- Implemented: TypeScript project-reference solution validation using fresh
  in-memory declarations, source accounting and normalized compiler diagnostics.
- Implemented: Vitest execution, strict evidence parsing, and native regression
  cases for skipped/excluded tests, focused tests and snapshot/error bypasses.
- Implemented: Jest native execution and evidence, with conservative pending-test
  handling and collection-only/snapshot/result-processor bypass tests.
- Implemented: vue-tsc with native script/template error cases, file inclusion
  accounting and inherited template-check disabling rejection.
- Implemented: pytest lifecycle evidence, collection accounting, fixture and
  unexpected-pass failures; verified with prepared Python 3.12 Linux tooling.
- Implemented: Ruff file/settings/JSON evidence, disabled fixes, native diagnostics,
  exclusion and no-active-rule cases in prepared Linux tooling.
- Implemented: mypy source-count evidence, per-module broad suppression guard,
  no stub installation/cache writes, and native Linux regression fixtures.
- Implemented: opt-in Go race validation, with native racing and atomic-update
  fixtures on macOS. Native package/file and package-test participation accounting
  now reports excluded source and untested packages as incomplete.
- Implemented: PHPStan per-file/debug and native JSON accounting, with return-type,
  excluded-file and bad-configuration fixtures in PHP 8.5 Linux tooling.
- Implemented: PHPUnit fresh JUnit streaming, exact file/assertion accounting and
  native failures/skips/empty cases in PHP 8.5 Linux tooling.
- Implemented: standalone JUnit import through CLI/library, labeled as imported
  evidence, with bounded XML and aggregate-counter validation.
- Implemented: Pest fresh evidence, focused-sibling and dataset checks, explicit
  TIA disabling and missing-snapshot rejection in prepared PHP Linux tooling.
- Implemented: Pint native file/fixer accounting, dry-run formatting, empty-rule
  and unverified Blade integration guards, with native Linux fixtures.
- Implemented: Playwright native lifecycle/project/file evidence, focused-test and
  snapshot controls, flaky failure and explicit browser prerequisites, including
  real Chromium DOM assertions.
- Implemented: Staticcheck all-rule JSON analysis with surfaced suppressions,
  normalized findings and native regression cases.
- Implemented: a constrained configured golangci-lint profile, explicit linter
  selection, hidden-filter/fix prevention and native suppression accounting.
- Implemented: bounded native version probes and labeled package-metadata/runtime
  identities in detailed reports, with incomplete results for unknown identities.
- Implemented: normalized ESLint/Ruff/PHPStan findings and SARIF 2.1.0 export
  through CLI/library, with official-schema and native CLI regression evidence.
- Implemented: per-project environment requirements with operator CLI/MCP startup
  permissions, value-free command metadata and environment-scoped tool identity.
- Implemented: explicit workspace dependencies and Git base selection, transitive
  consumer expansion, full-plan fallback and post-run Git identity validation.
- Implemented: exact finding baselines and exceptions, owner/reason/expiry,
  occurrence-count reconciliation, stale entries, explicit limits and optional
  comparison against a previous baseline. CLI/library/MCP keep comparison status
  separate from native validation. Partial analysis cannot be baselined.
- Remaining: broader framework scope and hosted toolchain CI evidence.

## M3

- Implemented: schema-validated runtime inventory comparison through CLI/library/
  MCP, exact registration multiplicity and ordering, explicit incomplete collection
  accounting, and synthetic tests for every supported assembly category. Imported
  comparison remains distinct from native framework capture.

- Implemented: reusable public JSON check profiles, pinned private/local pack
  loading and additive operator-selected overlays, with post-execution policy
  verification and conservative Git selection. Native framework semantics remain
  separate from these check profiles.
- Implemented: captured producer/consumer JSON Schema contracts with strict
  non-mutating validation, bounded workers, CLI/library/MCP and synthetic native
  producer serialization. Live service integration remains separate.
- Implemented: an opt-in FastAPI flat native route collector and exact duplicate
  registration rule, after lifespan startup, with Linux native broken/fixed/near-
  miss fixtures and explicit unsupported-shape handling. Broader framework
  semantics and other assembly categories remain separate.
- Implemented: a Django native nested URL resolver collector and exact duplicate
  pattern-chain rule, with setup-time wiring, regex matching-mode preservation,
  protected test settings and Linux native regression evidence.
- Implemented: Laravel testing assembly collection for routes, middleware, exact
  and wildcard listeners, schedules and a defined container binding projection.
  Native PHP/Linux fixtures exercise actual Artisan initialization, framework-added
  routes, mutation comparisons, cold caches, dotenv exclusion and incomplete assembly.
- Verified: public synthetic FastAPI, Django and Laravel examples through their
  native collectors; no private application code is needed for these regressions.
- Implemented: explicit language-agnostic dependency graph policies, exact layer
  allowlists, iterative cycle detection, incomplete capture accounting and
  CLI/library/MCP surfaces. Native source import graph collection remains separate.
- Verified: a real TypeScript producer tarball installed offline into a synthetic
  consumer, with type and runtime checks for changed and misleading declarations;
  a declared package-graph boundary check accompanies the integration fixture.
- Implemented: a native Vue Router testing assembly profile with awaited registration,
  exact URL probe chains, alias/parent participation, bounded metadata projection
  and incomplete-record accounting. macOS/Linux native tests and installed-package
  library/CLI/MCP checks passed; see `VUE-ROUTER.md`.
- Implemented: a Nuxt SSR testing assembly using a fresh native build and in-process
  requests, final runtime route capture, stable-assembly checks and complete record
  participation. Native macOS/Linux fixtures and an offline read-only installed
  library/CLI/MCP example passed; see `NUXT.md`.
- Pending: broader framework semantics, native assembly/import graph collectors
  and live service integrations.
- Private repository results and proprietary narratives must stay out of public
  source, examples, reports and history.

## M4

- Implemented: a Rust/Cargo 1.98.1 single-package compilation profile, locked
  offline dependencies, fresh build directories, native target and source
  accounting, structured compiler diagnostics and Linux regression evidence.
  Rust test execution, formatting, Clippy and workspace matrices remain separate.
- Implemented: MRI Ruby syntax checking for source and Ruby DSL manifests,
  per-file native success accounting, disabled gem/preload behavior, synthetic
  broken/fixed cases and Linux/macOS native verification. Ruby tests and framework
  semantics remain separate capabilities.
- Implemented: Swift source/manifest grammar checking without SwiftPM evaluation,
  native macOS compiler identity, generated .build exclusion and explicit regression
  evidence distinguishing syntax from type checking. Swift build/test remain work.
- Implemented: prepared C/C++ Clang compilation-database checks with closed flag
  handling, native SARIF diagnostics, fresh dependency/source accounting and native
  macOS/Linux broken/fixed cases. Linking, CTest, clang-tidy and cross-target
  build matrices remain separate.
- Implemented: explicit Java release/classpath compilation with checksummed JARs,
  disabled annotation processing, native source/type accounting, Linux regression
  evidence and fresh packaged library/CLI/MCP verification. JVM build systems,
  modules, Kotlin/Scala and test runners remain separate. See `JAVA.md`.
- Implemented: explicit C# compilation through the prepared .NET SDK/Roslyn API,
  pinned DLL references, native syntax/semantic accounting, source-suppression
  handling and Linux regression evidence. MSBuild, restore, source generators,
  analyzers, F#/VB, framework-specific builds and test runners remain separate.
  See `DOTNET.md` for the precise profile and reproduction steps.
- Implemented: GitHub Actions workflow validation through actionlint with explicit
  labels/variables, copied local dependencies, repository-ignore bypass and native
  per-file completion evidence. Terraform, Helm and Kustomize remain unsupported.
  See `ACTIONLINT.md` for profile limits and reproduction steps.
- Verified: fresh offline tarball install; public library, installed CLI and
  packaged MCP stdio checks against eight synthetic JavaScript toolchain projects.
  Reproduce with `node scripts/smoke-package.mjs`. This now also exercises the
  Clang profile when a verified local compiler is present and records unavailable
  otherwise; a verified macOS compiler passed the installed profile.
- Implemented: bounded local private pack distribution with SHA-256 pinning.
- Implemented: production npm dependency metadata/notice audit reconciled with
  the installed tree and lockfile, including a pinned upstream notice for one
  distribution that omitted it. Development/native/container provenance remains
  separate; this is not a complete supply-chain or legal-compliance attestation.
- Implemented: bounded synthetic planning/execution performance measurement with
  raw samples, source/tool/harness identities and engine-only resource accounting.
  Recorded macOS/Linux snapshots and limitations are in `PERFORMANCE.md`.
- Implemented: operator-registered executable adapters with pinned manifests/files,
  exact scoped-file accounting, Node/Python/PHP/native runtimes and shared cancellation
  cleanup. Linux native fixtures and offline installed library/CLI/MCP checks passed;
  delegated tool metadata remains adapter-reported. See `EXTERNAL-ADAPTERS.md`.
- Implemented: explicit HTTPS data-only pack distribution with independently pinned
  digests, bounded TLS transfers, strict content validation and exclusive atomic
  file publication. Planning and MCP never download automatically. See
  `PACK-DISTRIBUTION.md`. Executable bundle distribution remains separate.
- Implemented: unpublished registry metadata with matching npm identity, a required
  local root, execution disabled by default, official-schema validation and a
  metadata-derived MCP startup regression. See `RELEASE.md` for concrete release
  gates.
- Pending: broader runtime/OS/performance matrices and external release gates.
- Windows execution needs actual process-tree cancellation evidence before it
  can be advertised. Hosted CI and a public release have not happened.
- Commits, remote creation and publication retain their existing explicit-action
  requirements; local implementation and release preparation can continue.

## M5

- Implemented: versioned public advisory guidance selected by exact check/topic
  triggers, with CLI/library/MCP surfaces, bounded schemas and summary projections.
  Retrieval is separate from automated findings and coverage claims.
- Implemented: targeted literal mutations for dependency-free flat Node tests,
  temporary source copies, assertion-specific kill evidence, survivor/incomplete
  accounting, baseline gating, cancellation and original-source preservation.
  Broader language/runner profiles and automatic mutation selection remain pending.
- Implemented: paired full/Git-selected native impact measurement with original
  transitive-consumer fixtures, baseline passes, exact assertion identities,
  conservative fallbacks, misdeclared-graph misses and raw cost observations.
  macOS/Linux evidence and limits are in `IMPACT-MEASUREMENT.md`.
- Implemented: optional local/model review exchange with bounded selected source,
  operator-gated disclosure, context/source digests, exact citation checks, explicit
  unreviewed-file accounting and declared model/version/token/cost metadata. Imported
  claims remain advisory and never alter deterministic results; see `REVIEW-EXCHANGE.md`.
- Pending: broader impact models. Review exchange does not itself establish model
  inference quality or independent evaluation.
- Implemented: a frozen post-implementation development corpus with per-family
  diagnostic-specific detection, false-positive and incomplete-result accounting,
  direct native-command comparisons, raw timing/tool/artifact identities and
  macOS/Linux observations. See `EVALUATION.md` for interpretation limits.
- Implemented: external ESLint integration evaluation using independently authored
  synthetic upstream cases and a verifier frozen before case inspection. Native
  and verifier diagnostics agree on the stated macOS/Linux cohort; raw labels,
  observations, artifact identities and exclusion accounting are retained in
  `EXTERNAL-EVALUATION.md`. It is not independent native-rule effectiveness or
  general review-quality evidence.
- Implemented: external Ruff diagnostic integration cohort with declared source
  selection and a frozen verifier, paired native/macOS/Linux observations and
  primary-location reconciliation. The mixed upstream files do not supply an
  independent clean-case denominator; see `EXTERNAL-RUFF-EVALUATION.md`.
- Pending independent measurement: broader end-to-end review cases and rule families,
  prior-workflow comparisons and representative cost/latency estimates. The
  development corpus is not an independent held-out sample.
- Implemented: library-only bounded local validation task storage with atomic
  transitions, exclusive process ownership, retained projected results, two-stage
  cancellation and explicit interruption errors after reopening. Native macOS/Linux
  crash and contention evidence is documented in `TASK-STORAGE.md`.
- Implemented: a library worker connecting durable storage to the shared engine,
  with startup-only permissions, responsive polling, overlap rejection, confirmed
  cancellation, parent-disconnect cleanup and retained native outcomes. See
  `VALIDATION-TASKS.md` for native macOS/Linux evidence and the explicit limitation
  on forcibly killing the worker itself.
- Durable MCP Tasks remains pending. The current SDK routing failure is reproduced
  by `npm run probe:mcp-tasks`; storage and worker lifecycle are implemented
  independently, but Tasks support must not be advertised before wire tests pass.

The dedicated Ruby and Swift CI paths now require their exact native regression
names, rather than accepting a successful suite that skipped native work. Local
Ruby/Linux/Node 22 and Swift/macOS execution pass. Runner regressions reject
missing names, wrong-file names, skips, TODOs, duplicate names, suite-only matches
and unrelated failures. Removing the missing-test rejection fails the named
regression. These profiles subsequently passed hosted CI at `52ba415`; see
`NATIVE-CI.md` for the complete workflow evidence.

The same exact-name gate now covers the prepared CI core, JavaScript, Python,
Go, PHP, framework and Rust profiles, plus the Clang, Java, C#, actionlint,
Vue Router, Nuxt, review and durable-task container suites. Local required-profile
runs passed and their accounting is retained in `NATIVE-CI.md`. Both dynamically
named cancel/close lifecycle cases are explicit requirements. Existing external
adapter per-runtime gates remain, and the PHP syntax shim now requires exactly
one successful native TAP case. Hosted CI remains a separate acceptance gate.

## External dependencies

The installed MCP server SDK is still 2.0.0. Its standard Tasks routing failure is
documented in `MCP-COMPATIBILITY.md`. Hosted CI, publication and independent target
OS/client evidence remain separate acceptance gates. A gate is completed only
when its implementation and corresponding evidence exist.
