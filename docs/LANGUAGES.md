# Language and ecosystem roadmap

The [setup guide](ONBOARDING.md) describes conservative
per-language configuration proposals and static tool diagnosis. Setup does not
extend the execution capabilities or native evidence listed below.

Capability levels are discovery, planning, execution, structured evidence,
semantic rules, and integration validation. None implies the next. This file's
initial scope column describes the experimental implementation. Node, Python,
Go, TypeScript, ESLint, Vitest, Jest and vue-tsc execution have been exercised locally. Vitest accepts stable major versions 4 and 5; native compatibility is exercised at 4.1.9 and 5.0.1 (see [Vitest validation](VITEST.md)). PHP syntax
has been verified separately in an isolated official Linux container. Tool versions and remaining gaps are tracked in `STATUS.md`.

| Family                        | Project boundaries                                                      | Initial scope                                                                                                                                        | Subsequent native integrations                      | Important constraints                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| JavaScript / TypeScript       | package.json                                                            | Discovery; Node/Vitest/Jest/Playwright tests; explicit local tsc/vue-tsc, solution references, ESLint and opt-in Vue Router/Nuxt SSR route contracts | framework scope profiles                            | ESLint JavaScript is exercised; parser/processor combinations need their own verification; TS tests need a loader/build |
| Python                        | pyproject.toml, setup.py, requirements.txt                              | Discovery; unittest/pytest, Ruff/mypy and opt-in FastAPI/Django route inventories                                                                    | Pyright                                             | Never import setup.py for discovery; virtual environments, namespace packages and plugins matter                        |
| Go                            | go.mod                                                                  | Discovery; gofmt, vet, tests, explicit race/Staticcheck/golangci-lint profiles; native scope accounting                                              | broader golangci-lint settings                      | Module/workspace boundaries, build tags, cgo, platform constraints and test caching                                     |
| PHP                           | composer.json                                                           | Discovery; syntax, PHPStan, PHPUnit, Pest, Pint and opt-in Laravel assembly capture                                                                  | Larastan integration, PHP-CS-Fixer                  | Syntax is not type/test validation; runtime extensions, generated proxies and framework bootstrapping matter            |
| Rust                          | Cargo.toml                                                              | Single-package Cargo check with locked offline dependencies and dep-info scope                                                                       | cargo fmt, clippy, test                             | Build scripts and proc macros execute code; feature/target matrix; offline dependencies                                 |
| Java / Kotlin / Scala         | pom.xml, build.gradle, build.gradle.kts                                 | Explicit Java classpath compilation with native parse/analysis evidence; Kotlin/Scala discovery only                                                 | Maven/Gradle test, Checkstyle, SpotBugs, detekt     | Multi-module builds, wrappers, JVM versions, generated sources and plugins                                              |
| C# / F# / Visual Basic / .NET | *.csproj, *.fsproj, *.vbproj, *.sln, *.slnx                             | Explicit C# compilation with native syntax/semantic evidence; F#/VB discovery only                                                                   | dotnet format, build, test                          | Restore policy, analyzers, target frameworks, generated code and TRX parsing                                            |
| Ruby                          | Gemfile, *.gemspec                                                      | MRI syntax checking of Ruby source and DSL manifests                                                                                                 | RuboCop, RSpec, Minitest                            | Bundler versions and runtime config execute code                                                                        |
| Swift                         | Package.swift                                                           | Native Swift grammar checking without manifest evaluation                                                                                            | swift build/test, SwiftLint                         | Manifest evaluation executes code; platform/SDK requirements                                                            |
| C / C++                       | CMakeLists.txt, meson.build, compile_commands.json                      | Prepared Clang front-end checks with native source/header accounting                                                                                 | clang-format, clang-tidy, compiler checks, CTest    | Compilation database, toolchain and build configuration are required                                                    |
| Infrastructure                | .github/workflows/*.yml or *.yaml, *.tf, Chart.yaml, kustomization.yaml | Static GitHub Actions analysis with explicit local inputs and native per-file evidence                                                               | terraform validate, helm lint/template, kubeconform | No workflow execution; remote actions are not downloaded; YAML aliases and merge keys require another profile           |

Nuxt, Vue Router, FastAPI, Django and Laravel profiles have separately pinned framework compatibility gates
and capture only their documented native assembly projections; see `FASTAPI.md`,
`DJANGO.md`, `LARAVEL.md`, `VUE-ROUTER.md` and `NUXT.md`.

Pint's macOS hosted check exposed a non-seekable cache-file failure. The adapter
now uses a fresh regular file with runner-owned cleanup; the corrected macOS
profile passed at `52ba415`. See `PINT.md` and `NATIVE-CI.md`.

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
different languages without changing the engine. It does not automatically add
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
on macOS/Node 26.8.1 and Linux/Node 22.23.2; it is not MCP Tasks support.

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
golangci-lint. This is one configuration per selected check, not a target matrix.
