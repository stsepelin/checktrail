# Checktrail

Local code validation with a CLI, MCP tools, and evidence of what actually ran.

The local MCP server works through the chosen MCP host. That host handles AI
selection and subscription/API authentication; Checktrail does not need to log
in to a model service. Direct provider calls are an optional separate interface.
See the [MCP review workflow](docs/REVIEW-MCP-WORKFLOW.md) for implemented tools,
planned review stages and the limits of fresh-session enforcement.

Formerly Repo Verifier. See the [rename guide](docs/RENAMING.md) for existing source checkouts.

**Published preview: 0.1.0-alpha.5.** Public source is available at
[stsepelin/checktrail](https://github.com/stsepelin/checktrail).
See [implementation status](docs/STATUS.md), the [plan](docs/PLAN.md) and the
[language matrix](docs/LANGUAGES.md) before relying on an adapter.
[Installation](docs/INSTALLATION.md) covers the CLI, Claude Code and Codex.
[Agent skills](docs/SKILLS.md) provides setup, validation and review workflows
installable with `npx skills add stsepelin/checktrail`.
[Project setup](docs/ONBOARDING.md) covers `init`, `doctor`
and MCP configuration generator.
[Release preparation](docs/RELEASE.md) records publication and verification gates. The
[milestone audit](docs/ACCEPTANCE.md) separates implemented profiles from open
acceptance work; [client checks](docs/CLIENTS.md) record actual application coverage.
[Public adoption](docs/PUBLIC-ADOPTION.md) records the published package on five
pinned libraries, including setup friction and compatibility gaps.
Alpha.3 fixes the recorded [TypeScript 4.9.5 incompatibility](docs/TYPESCRIPT.md).
The [setup scope guide](docs/SETUP-SCOPES.md) explains language, documentation and workflow coverage.
Alpha.5 adds named [Go build-tag profiles](docs/GO-BUILD.md) with per-check
exclusions. Its [release record](docs/measurements/release-alpha5.json)
includes package, client and upgrade/rollback verification.

The [hosted matrix](https://github.com/stsepelin/checktrail/actions/runs/35694375091)
passed at release commit `832a044` on Linux and macOS. The exact npm tarball and
fresh CLI/MCP installations were verified. The
[MCP Registry entry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.stsepelin%2Fchecktrail/versions/0.1.0-alpha.5)
is active; execution remains disabled by default.

Checktrail discovers projects, plans registered checks, invokes native tools
when explicitly trusted, and reports results without turning skipped or empty
checks into success. The same engine serves developers, CI and MCP clients.

The optional library [task store](docs/TASK-STORAGE.md) retains local validation
results across restarts. A [library worker](docs/VALIDATION-TASKS.md) adds native
execution, polling and cancellation. MCP reports still use memory; standard Tasks integration
remains pending.

## Try the local checkout

Requires Node.js 22 or newer. Execution currently targets macOS and Linux.

```sh
npm ci --ignore-scripts
npm run build
node dist/src/cli.js plan --root examples/javascript --detailed
node dist/src/cli.js run --root examples/javascript --trust-project --detailed
```

`plan` and `inspect` read files without executing project code. `run` requires
`--trust-project`: tests, compiler plugins and project configuration can execute
code with your user privileges. This is not a sandbox.

Successful commands return JSON except help/version; input errors use stderr. Exit codes:

| Code | Meaning                                                                                 |
| ---- | --------------------------------------------------------------------------------------- |
| 0    | Selected checks passed, read-only operation succeeded, or advisory experiment completed |
| 1    | At least one selected check failed                                                      |
| 2    | Required evidence is incomplete, execution is untrusted, or input is invalid            |

A passing run applies to the selected checks and scope only. PHP syntax passing
does not imply its application tests passed. Unknown frameworks and empty plans
are incomplete. A source change during validation prevents an aggregate pass.

## Initial adapters

| Ecosystem                    | Execution in this foundation                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| JavaScript                   | Native Node tests; explicit ESLint checking with per-file coverage evidence                                       |
| Python                       | Explicit unittest/pytest tests and Ruff/mypy checks                                                               |
| Go                           | gofmt check, go vet, uncached go test with JSON events                                                            |
| PHP                          | Syntax checks and explicit PHPStan analysis; native verification in status                                        |
| TypeScript                   | Explicit `javascript.typescript`: local tsc, no emit, file inclusion evidence                                     |
| Jest                         | Explicit `javascript.jest`: native result accounting; pending tests are incomplete                                |
| Vue                          | Explicit `javascript.vue-tsc`: SFC and TS checking; opt-in `javascript.vue-router` route contracts                |
| Vitest                       | Explicit `javascript.vitest`: native JSON counts and exact test-file accounting                                   |
| Playwright                   | Explicit `javascript.playwright`: native test/project evidence and prepared browsers                              |
| Other framework test runners | Manifest discovery; execution integrations planned                                                                |
| Rust                         | Locked offline Cargo builds, explicit workspace/target profiles, Clippy/libtest/doctests and Cargo/Rustfmt        |
| Ruby                         | MRI grammar checks; bounded opt-in RuboCop/RSpec/Minitest with source and lifecycle evidence                      |
| Swift                        | Grammar checks; bounded Linux ARM64 SwiftPM builds, XCTest/Swift Testing and explicit SwiftLint rules             |
| C / C++                      | Prepared Clang checks; bounded C17/C++20 CMake builds, CTest, clang-format and clang-tidy                         |
| Java                         | Explicit classpath compilation and bounded pinned Checkstyle, Maven reactor and Gradle module tests               |
| C# / .NET                    | Explicit C# compilation; bounded opt-in C#/F#/VB build/NUnit and C#/VB whitespace checks                          |
| GitHub Actions               | Static workflow checking with native per-file accounting                                                          |
| Kubernetes                   | Bounded offline kubeconform document/schema validation with physical source addresses                             |
| Kustomize                    | Bounded local resource/prefix/replica assembly with native render reconciliation and source-bound schema findings |
| Terraform                    | Bounded provider-free multi-file JSON module validation with native source diagnostics                            |
| Kotlin                       | Opt-in pinned detekt light analysis with every-selected-file rule, source, suppression and completion accounting  |
| Scala                        | Opt-in pinned Scala 2/3 compilation; explicit mixed/generated/compile-only script and ordered macro stages        |

Tools must already be installed. No dependency installation, automatic fixes,
service startup, migrations, commits or deployments are performed by the engine.
Go execution disables module proxy downloads and toolchain auto-downloads. The
[Rust profile](docs/RUST.md) uses locked offline Cargo and disables rustup auto-installation. Other
invoked tools and test code can still access the network.

## Select checks

Without configuration, registered defaults apply to each detected project.
Node tests are selected automatically only for the exact script `node --test`.
Python needs an explicit selection because a manifest does not identify a runner.
Create `checktrail.json` in the inspected root:

```json
{
  "schemaVersion": 1,
  "projects": [
    { "path": "web", "checks": ["javascript.node-test", "javascript.eslint"] },
    { "path": "library", "checks": ["javascript.typescript"] },
    { "path": "service", "checks": ["go.format", "go.vet", "go.test"] },
    { "path": "worker", "checks": ["python.unittest"] }
  ]
}
```

When present, this file selects only the listed projects/checks. Paths are exact
discovered project roots relative to `--root`; use `.` for that root itself.
Configuration cannot supply arbitrary commands or enable execution permissions.
The [schema](schemas/config.schema.json) rejects unknown fields and check IDs are
validated by the engine. Private configuration and rules need not be published.
Local public/private JSON packs and additive operator overlays are implemented;
see [policy packs](docs/POLICY-PACKS.md). An explicit
[`fetch-pack` command](docs/PACK-DISTRIBUTION.md) can download a pinned data-only
pack over HTTPS for later offline use. The explicit
[`fetch-adapter` command](docs/EXECUTABLE-BUNDLES.md) verifies every artifact in
a pinned executable bundle before publishing a private file; registration and
trusted execution are separate actions.

Operator-registered [external adapters](docs/EXTERNAL-ADAPTERS.md) can run a pinned
local Node, Python, PHP or native executable bundle. Repository configuration can
select their registered checks; execution still requires operator trust. The
protocol checks evidence completeness, while the adapter author remains responsible
for the correctness of its analysis.

The TypeScript check requires a local `tsconfig.json` and an installed compiler
inside the configured root (project-local or hoisted to an ancestor). It disables
`noCheck`, emission and incremental state. Every inventoried `.ts`, `.tsx`, `.mts`
and `.cts` file in that project must appear in the compiler's file list. A clean
compiler exit with excluded source is incomplete. Other compiler options, including
strictness and declaration checking, come from the project config. Use `javascript.typescript-build` for
[project-reference solutions](docs/TYPESCRIPT-BUILD.md) with fresh in-memory
declarations. Vue SFC checking uses its separate adapter.
TypeScript 6.0.3 is exercised in integration tests; other versions are unverified.

`javascript.vue-router` captures a selected native testing router and verifies
complete record participation in declared URL probes; see the
[Vue Router profile](docs/VUE-ROUTER.md) for versions and projection limits.
`javascript.nuxt-runtime` builds a fresh SSR testing assembly and checks native
router capture after in-process requests. Opt-in version 2 also verifies native
server handlers, middleware invocations, runtime config boundaries, generated API
consumer types and controlled responses. See the [Nuxt profile](docs/NUXT.md) and
[assembly contracts](docs/NUXT-ASSEMBLY.md) for versions and scope limits.
`python.fastapi-routes` captures a configured FastAPI application's native routes.
Opt-in configuration version 2 also checks declared mounted/hosted assembly,
security dependencies, response models, middleware/lifespan order and controlled
ASGI responses. See the [FastAPI profile](docs/FASTAPI.md) and
[assembly contracts](docs/FASTAPI-ASSEMBLY.md) for versions and scope limits.
`python.django-routes` captures supported nested URL resolver chains after Django
setup; see the [Django profile](docs/DJANGO.md).
`php.laravel-runtime` captures the testing assembly's routes, middleware, listeners,
schedules and container binding projection. Opt-in configuration version 2 compares
all declared native collections, selected model defaults and controlled HTTP
responses. See the [Laravel profile](docs/LARAVEL.md) and
[assembly contracts](docs/LARAVEL-ASSEMBLY.md) for bootstrap behavior and limits.

`javascript.eslint` uses an installed ESLint and a project-local JavaScript flat
config. Ignored files, unmatched configuration and files with no enabled rules
make the check incomplete. Errors and warnings fail it. It preserves existing
lint caches and performs no fixes. See the [ESLint contract](docs/ESLINT.md) for
scope, configuration requirements and verified tool support.

`javascript.vitest` runs an installed Vitest once, requires each planned test file
in the report, and rejects empty/all-skipped results. It disables focused tests,
snapshot updates and automatic dependency installation. See the
[Vitest contract](docs/VITEST.md) for tested versions and limitations.

`javascript.playwright` reconciles native tests, projects and retry outcomes,
requires preinstalled browsers, and protects snapshots. See the
[Playwright contract](docs/PLAYWRIGHT.md).

`javascript.jest` requires native assertion and file accounting and treats pending
tests conservatively as incomplete. See the [Jest contract](docs/JEST.md).
`javascript.vue-tsc` checks Vue SFCs and TypeScript without emitting output, and
rejects disabled template checking. See the [Vue contract](docs/VUE-TSC.md).

`python.pytest` reconciles native collection and setup/call/teardown evidence.
See the [pytest contract](docs/PYTEST.md) for scope and prepared runtimes.

`python.ruff` requires exact native file selection and active-rule evidence, with
fixes disabled. See the [Ruff contract](docs/RUFF.md).

`python.mypy` checks explicit source with native source-count evidence and rejects
broad module-error suppression. See the [mypy contract](docs/MYPY.md).

`go.test-race` adds opt-in native race instrumentation with uncached test evidence.
See the [Go race contract](docs/GO-RACE.md). Go checks reconcile native package
selection with inventoried source; `go.staticcheck` adds explicit all-rule analysis
and normalized findings. See [Go scope](docs/GO-SCOPE.md). The constrained
[`go.golangci-lint` profile](docs/GOLANGCI-LINT.md) accepts explicit native linter
selection while disabling hidden issue filters and fixes.
Alpha.5 adds [Go build-tag profiles](docs/GO-BUILD.md)
with one explicit configuration per selected native check. Alpha.4 does not
include this capability; a runnable example is in `examples/go-build`.
Current source also implements version 2 repeated tag/target profiles and explicit
production `go.build` checks; these additions are unpublished. Cross-target tests
remain unavailable without a target executor. See [Go build profiles](docs/GO-BUILD.md).

`php.phpstan` combines per-file analysis accounting with native JSON diagnostics.
See the [PHPStan contract](docs/PHPSTAN.md).

`php.phpunit` streams fresh native JUnit evidence with file and assertion
accounting. See the [PHPUnit contract](docs/PHPUNIT.md). Existing JUnit artifacts
can also be [imported separately](docs/JUNIT.md); import does not verify current
source or execution freshness.

`php.pest` runs focused siblings in CI mode and disables cached test-impact
replay; see [Pest](docs/PEST.md). `php.pint` validates formatting with native
file and rule accounting; see [Pint](docs/PINT.md).

Detailed reports include normalized source findings for ESLint, Ruff and
PHPStan, Staticcheck, golangci-lint and TypeScript solution builds. [SARIF export](docs/SARIF.md) preserves failures and incomplete execution
without treating an empty findings list as success.

Projects can [declare environment requirements](docs/ENVIRONMENTS.md), supplied
only through operator `--allow-env NAME` permissions or explicit library options.
MCP tool calls cannot grant environment access.

Use [workspace dependencies and Git selection](docs/WORKSPACES.md) with
`--base REVISION` to validate changed projects and their declared consumers.
Uncertain impact retains the full configured plan.

## MCP

Run the server from the built checkout:

```sh
node dist/src/cli.js serve --root /path/to/your/repository
```

For a client that accepts a command/arguments server definition:

```json
{
  "mcpServers": {
    "checktrail": {
      "command": "node",
      "args": [
        "/path/to/checktrail/dist/src/cli.js",
        "serve",
        "--root",
        "/path/to/your/repository"
      ]
    }
  }
}
```

The available tools are `project_context`, `validation_plan`, `validation_run`,
`validation_report`, `finding_comparison`, `runtime_comparison`, `contract_validation`,
`architecture_validation`, `review_guidance`, `review_context`, `review_receipt`,
`review_hypotheses`, `review_benchmark`, `review_workflow`, `review_run`, `review_refute`, `review_probe`, `review_verify`, `review_score`, `review_paired_score`, `review_calibration_fit`,
`review_calibration_apply`, `import_context`, and `mutation_experiment`. The first two currently return the same project/check
inventory; advisory guidance and source review use their separate tools. Reports are kept
in memory (the latest ten) and disappear when the process exits.

Add `--allow-execution` to server arguments only for trusted project execution.
The model cannot grant that permission through a tool argument. Add `--detailed`
only if the client may receive paths, commands and raw diagnostics. The default
summary omits those fields. Data returned through an MCP client may be sent to
that client's model provider.

The operator-only `review-benchmark-score` command derives descriptive paired metrics
from frozen, sealed synthetic benchmark artifacts; see [benchmark scoring](docs/REVIEW-BENCHMARK.md#scoring-sealed-synthetic-artifacts). Claims, labels, host isolation and quality remain unverified.

The `review_benchmark` worker view reads one startup-selected anonymous trial from
a pinned original synthetic readiness protocol. Operator commands freeze paired
cases, retain all predeclared journal slots and prepare anonymous judging packets.
Host isolation, complete model attempts and quality remain unverified; field trials
still wait for the required implementation gates. See [REVIEW-BENCHMARK.md](docs/REVIEW-BENCHMARK.md).

The model-independent `review_workflow` tool exchanges bounded reviewer/refuter/
adjudicator assignments with host-owned AI sessions and an operator-pinned live
probe. The foreground `review-session` CLI uses the same engine. Assignment output
requires startup `--detailed --allow-review-source`; native probes additionally
require execution trust. Completed stages keep findings and host isolation
unverified. See [workflow operations and limits](docs/REVIEW-MCP-WORKFLOW.md) and optional [private durable command audits](docs/REVIEW-WORKFLOW-AUDIT.md).

The implementation uses the official MCP v2 SDK. Automated tests exercise the
2026-07-28 protocol and the SDK's legacy negotiation over stdio. This does not
establish compatibility with every editor or agent application.

Ordinary validation calls run asynchronously and return their report on the original
call. Startup `--task-store` enables the bounded standard Tasks polling profile for
capable requests, preserving ordinary-call fallback. See
[MCP compatibility](docs/MCP-COMPATIBILITY.md) for the tested SDK 2.3.0 routing,
lifecycle evidence and remaining client/runtime profiles.

Exact finding baselines and exceptions are available through the CLI, library and
MCP. [Finding policy](docs/FINDING-POLICY.md) describes creation, expiration,
staleness and expansion checks. A successful comparison retains the separate
native validation outcome; it never changes a failed validation into a pass.

[Runtime inventory comparison](docs/RUNTIME-INVENTORY.md) checks local before/after
assembly artifacts for changed registrations, attributes, duplicates and order.
Imported artifacts retain explicit completeness and provenance limits.

[Public policy packs and private overlays](docs/POLICY-PACKS.md) compose registered
checks with pinned SHA-256 integrity. Use `--policy-overlay` at CLI invocation or
MCP startup for local additions to checked-in requirements.

[Captured contract checks](docs/CONTRACTS.md) validate producer JSON against strict
consumer schemas, with worker deadlines and separately labeled imported evidence.

## Limits and evidence

Detailed reports include [tool identity evidence](docs/TOOL-IDENTITY.md). Native
version probes share execution limits and require operator trust; missing identity
prevents a successful check from being reported as passed.

Inventory excludes dependency/build directories, symlinks and common secret-file
names. It does not apply `.gitignore`. Optional Git selection retains these exclusions. Limits are
20,000 entries, depth 32, 8 MiB per file and 64 MiB total file bytes. A source
fingerprint covers included contents and exclusion names, not ignored dependencies,
external configuration, tool binaries or services.

Execution has a run-wide time budget (30 seconds by default, configurable up to
120 seconds), 1 MiB output per command and 4 MiB across a run. Timeouts, cancelled
work, truncated output and malformed test evidence are incomplete. Detailed
reports include process output; do not publish reports from private repositories.

Results are not proof against malicious project code: a trusted test can forge
output, alter other files or start detached processes. Isolation and attestation
are separate future capabilities. See [security](SECURITY.md).

## Development

```sh
npm run check
npm run format:check
node scripts/smoke-package.mjs
```

Tests include real process execution, native adapter integration where tools are
available, source-change detection, output limits, schemas, CLI exit codes and
MCP calls. Missing native tools are explicitly skipped locally; CI prepares tools
and requires exact native regression names through [required profiles](docs/NATIVE-CI.md). Run `node scripts/generate-schemas.mjs` after building when
changing schema definitions; tests reject drift in the checked-in JSON schemas.

All examples and fixtures are synthetic. Contributions must include a minimal
broken case, its fix, and a valid near miss where applicable. See
[contributing](CONTRIBUTING.md). Licensed under [MIT](LICENSE).

Explicit [architecture policies](docs/ARCHITECTURE-POLICY.md) check captured project
dependencies against literal layer allowlists and optional cycle restrictions.
Imported graph completeness is declared evidence; native import discovery is not
implied. The public [built-package fixture](examples/package-contract/README.md)
exercises an installed producer through consumer type and runtime checks.

## Advisory review assistance

Use `guidance --root PATH` for public review questions selected from planned
checks, or add an explicit `--topic`. This read-only operation makes no coverage
claim and invokes no model. See [guidance](docs/GUIDANCE.md).

Use `mutate --root examples/mutations --input mutations.json --trust-project` for
a bounded experiment in temporary source copies. Its initial profile supports
flat Node tests in dependency-free projects. Assertion kills, survivors and
inconclusive execution are separate advisory results; see [mutation experiments](docs/MUTATIONS.md).

The [C/C++ profile](docs/CLANG.md) validates prepared Clang argument arrays and
requires native dependency coverage for inventoried translation units and headers.
The separate opt-in [native tools profile](docs/CPP-TOOLS.md) builds a finite C17/C++20
CMake declaration, generates integer-valued headers, links static libraries and
executables, runs registered CTest callbacks, and checks formatting and explicit
analyzer rules. Both profiles require operator trust for execution.

The [Java profile](docs/JAVA.md) compiles inventoried sources with an explicit
release and pinned local dependencies. Maven/Gradle, annotation processors and
application tests are not executed.
The opt-in [Checkstyle profile](docs/CHECKSTYLE.md) verifies configured Java source
audits with pinned tools and every-file completion. Opt-in [Maven](docs/MAVEN.md)
and [Gradle](docs/GRADLE.md) profiles compile declared Java modules and reconcile
native test evidence. The opt-in [SpotBugs profile](docs/SPOTBUGS.md) analyzes freshly
compiled Java bytecode. The [Kotlin detekt profile](docs/DETEKT.md) analyzes selected
Kotlin sources with pinned light rules. The [Kotlin compiler profiles](docs/KOTLIN.md) and [Scala compiler profiles](docs/SCALA-EXTENSIONS.md)
provide separately selected native compilation evidence. Wider analyzer/platform
profiles and generated/JPMS analyzer scopes remain required.

Reproduce synthetic planning and execution costs with the
[performance harness](docs/PERFORMANCE.md). Reports retain raw measurements and
artifact identities; the documented snapshots are observations, not speed guarantees.

The [C# profile](docs/DOTNET.md) uses a prepared .NET SDK and explicit compilation
settings. Project build targets, source generators and test runners are separate
capabilities.

The [GitHub Actions profile](docs/ACTIONLINT.md) checks inventoried workflows with
explicit runner labels and variables, local dependency checks and native completion
evidence. It does not execute workflow jobs or action code.

[Development evaluation](docs/EVALUATION.md) records per-family detection,
false-positive and incomplete-result counts against direct native commands.
These small synthetic observations do not establish independent review quality.
The [agent evaluation workflow](docs/AGENT-EVALUATION.md) freezes public-source cases,
separates native-only and MCP-assisted reviewers, seals assessments, and supplies
blinded adjudication and explicit incomplete-result accounting.
The [enforced cross-family pilot](docs/ENFORCED-CROSS-FAMILY-PILOT.md) records
fresh Claude/Codex attempts, delivery failures and independent execution audits.

[Impact measurements](docs/IMPACT-MEASUREMENT.md) compare full and Git-selected
validation, including missed consumer failures when dependency declarations are
wrong. Fewer selected checks alone do not establish a safe or faster run.

Optional [`review-context` and `review-receipt`](docs/REVIEW-EXCHANGE.md) exchange
bounded selected source and external reviewer assessments. Source and review prose
require `--detailed --allow-review-source`; claims and declared usage remain advisory.
Core validation does not call a model or upload code. Optional
[provider review](docs/REVIEW-PROVIDERS.md) requires separate operator inference
and source-disclosure grants; normal output hides source and candidate prose.

[Native review probes](docs/REVIEW-PROBES.md) bind operator-pinned controls to
selected source and measured function/guard execution. Native execution requires
operator trust; Boolean counterexamples remain advisory evidence.

[Independent refutation](docs/REVIEW-REFUTATION.md) sends one unverified hypothesis
to a fresh stateless verifier while withholding prior reviewer labels and verdicts.
Counterclaims stay advisory. [Native corroboration and independent adjudication](docs/REVIEW-VERIFICATION.md)
now combine fresh refutation, a live operator-pinned Node probe and a separate
raw-evidence assignment. Bounded observations do not verify production impact,
claim mechanism or severity; full independent findings remain unfinished.

[Reviewer scoring](docs/REVIEW-SCORING.md) reports proper probability losses,
reliability, risk/coverage and explicit incomplete/unknown accounting from declared
labels. It does not establish calibrated confidence or a quality gate.

[Declared per-family calibration](docs/REVIEW-CALIBRATION.md) fits numerical
development observations and applies them only to a disjoint reserved protocol
with the same declared model. Unavailable families and predictions outside the
training range stay unknown. Fitting does not establish calibrated confidence,
verified labels, independent host isolation or held-out quality.

[Declared claim probabilities](docs/REVIEW-CLAIM-PROBABILITY.md) keep numerical
predictions separate from severity and bind sealed scoring to the original
candidate. Independent refuters and judges receive hypothesis/source/native case
evidence with prior candidate metadata and aggregate verdicts withheld. These
structural checks do not establish claim truth, fresh host isolation or calibrated
confidence.

The bounded [import context](docs/IMPORT-CONTEXT.md) collects JS/TS source and
static consumer edges without executing project code. Unknown or incomplete
capture retains every declared project in advisory full fallback. It does not
narrow validation plans or establish runtime reachability.

The experimental bounded [Windows executable profile](docs/WINDOWS-EXECUTION.md)
has a dedicated native CI gate. Its acceptance is pending; broader Windows tools,
Git and private persistence profiles remain unverified.
