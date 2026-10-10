# Milestone acceptance audit

This audit maps the original plan to implemented profiles and their recorded
verification. It does not replace the plan or promote an unverified capability.
Local implementation, local native evidence, hosted CI and publication are
separate states. Follow the linked evidence for tested versions and limits.

The expanded [reviewer roadmap](REVIEWER-ROADMAP.md) targets model-independent
MCP review and claim validation, with host-owned AI/authentication. The neutral stage
exchange has bounded synthetic acceptance; independent host-session evidence and
general claim validation remain unfinished. Engine-owned inference or native AI
client orchestration is optional. No achieved quality
claim follows from the current exchange. Its required inventory retains unfinished M0–M5 work and every
subsequent integration in `LANGUAGES.md`. Feature completion precedes any new
real-project MCP field evaluation; applicable operator permissions and a frozen
independent protocol precede measurement, and demonstrated quality is a separate
final gate.
Historical adoption/client/agent observations remain historical evidence.

| Milestone                         | Implemented scope and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Open acceptance work                                                                                                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0: public contracts              | Original public fixtures, MIT license, security/contribution guidance, schemas, explicit package allowlist, dependency notices and CI definitions. `STATUS.md`, `SECURITY.md`, `RELEASE.md`.                                                                                                                                                                                                                                                                                                          | Public source, npm alpha.5 and its MCP Registry entry are published. Hosted CI passed at `832a044`; fresh registry installation was verified.                                                                                                  |
| M1: executable foundation         | Shared CLI/library/MCP engine, bounded inventory/runner, startup trust, native Node/Python/Go/PHP profiles, protocol and lifecycle regressions. `ARCHITECTURE.md`, `STATUS.md`, `MCP-COMPATIBILITY.md`. Fresh installed application-client profiles now have evidence in `CLIENTS.md`.                                                                                                                                                                                                                | Application-client coverage beyond the named profiles. PHP remains unavailable when the consumer has no prepared runtime.                                                                                                                      |
| M2: practical language validation | Explicit JS/TS, Python, Go and PHP native tool profiles, structured diagnostics/test evidence, versions, environments, workspace selection, scope accounting, SARIF/JUnit and finding ratchets. `LANGUAGES.md`, adapter documents, `WORKSPACES.md`, `FINDING-POLICY.md`, `NATIVE-CI.md`.                                                                                                                                                                                                              | Hosted toolchain profiles passed at `52ba415`. Wider tool versions/framework configurations must be promoted separately; detection is not execution support.                                                                                   |
| M3: framework/contracts           | Native Laravel, Vue Router/Nuxt, Django/FastAPI assembly projections; imported runtime comparison, explicit architecture boundaries, producer/consumer schemas and a built package consumer. `RUNTIME-INVENTORY.md`, framework documents, `CONTRACTS.md`, `ARCHITECTURE-POLICY.md`, `examples/package-contract/README.md`.                                                                                                                                                                            | Broader native semantics/import collection and live service integration are not implemented. Synthetic evidence does not establish equivalent results in a private application; private integration feedback must remain private.              |
| M4: ecosystem/distribution        | Bounded Rust, Java, C#, Ruby, Swift, Clang and actionlint profiles; trusted external adapters, pinned data-only pack distribution, fresh offline package checks, production notice audit, measured performance and published MCP Registry metadata. `LANGUAGES.md`, `EXTERNAL-ADAPTERS.md`, `PACK-DISTRIBUTION.md`, `PERFORMANCE.md`, `RELEASE.md`.                                                                                                                                                   | npm tag cleanup remains unresolved. Windows execution and the unimplemented subsequent integrations in `LANGUAGES.md` remain unsupported. Runtime/container/development dependency provenance is broader than the production npm notice audit. |
| M5: measured assistance           | Advisory guidance, bounded Node mutation experiments, explicit-graph impact measurements, optional local/model review exchange, independent-session agent evaluation with a historical pilot, durable library task storage/worker, development evaluation and externally authored ESLint and Ruff integration cohorts. `GUIDANCE.md`, `MUTATIONS.md`, `IMPACT-MEASUREMENT.md`, `REVIEW-EXCHANGE.md`, `VALIDATION-TASKS.md`, `EVALUATION.md`, `EXTERNAL-EVALUATION.md`, `EXTERNAL-RUFF-EVALUATION.md`. | Wider standard MCP Tasks client/runtime profiles; held-out rule-family/review evidence, prior-workflow comparison and representative cost/latency measurement. No general equal-or-better review-quality claim is supported.                   |

## Remaining implementation and evaluation readiness work

Complete the required inventory in `REQUIRED-INVENTORY.md` before any new
real-project MCP field evaluation. Cohort acquisition, licensing checks and
protocol preparation may proceed independently. Running held-out reviews or the
prior-workflow comparison additionally requires Gate A and the concrete Gate B
authorizations; the historical results below do not authorize a new trial.

[Public adoption measurements](PUBLIC-ADOPTION.md) now cover five pinned
JavaScript, TypeScript, Python, Go and PHP libraries. They expose an older
TypeScript compiler-option incompatibility and workflow/documentation/platform
coverage friction. The [alpha.3 compiler fix](TYPESCRIPT.md) now passes the
known TypeScript 4.9.5 case. [Setup guidance](SETUP-SCOPES.md) distinguishes
workflow/documentation coverage; the alpha.4 [Go scope policy](GO-SCOPE.md)
accounts for explicitly acknowledged native exclusions. Alpha.5 [per-check build-tag profiles](GO-BUILD.md)
add explicit tag selection; broader target coverage remains follow-up work. The observations do not establish full upstream CI coverage or
general review effectiveness.

1. Prepare independently authored evaluation cohorts for additional implemented
   language/rule families, recording exact eligibility, licensing, exclusions,
   native baselines and the verifier-freeze protocol. Keep held-out reviews closed
   until the implementation and evaluation gates permit them. New fixtures authored
   after inspecting the implementation remain development tests.
2. Run the comparison prepared in `PRIOR-WORKFLOW-EVALUATION.md` after resolving
   the actual baseline, independently labeled public cases and reviewer/adjudicator. A native-tool comparison alone is not this baseline.
   Model-assisted comparisons need declared model/version and actual inference
   cost; review exchange by itself supplies neither effectiveness nor cost evidence.
3. Continue the requirement-specific validation of any newly promoted profile.
   Optional breadth is not a reason to mark already measured profiles unsupported,
   and a measured profile is not permission to claim its whole ecosystem.

The recorded client schema warning is corrected and the current Claude Code
check requires no startup/schema warnings. Published schemas compile under strict
standard validation; URL/path boundary cases and actual Codex guidance retrieval
are verified in `CLIENTS.md`. The original frozen ESLint runtime and harness were
archived before that correction and replayed against the original observations
on both platforms; see `EXTERNAL-EVALUATION.md`. Later engine revisions must not
be silently substituted into that frozen holdout.

## External gates

The historical MCP SDK routing blocker is resolved in the pinned SDK 2.3.0
profile. Optional standard Tasks polling has bounded synthetic wire/lifecycle
acceptance, including source and offline installed-package controls. Other
client/runtime profiles and full conformance remain unverified. See
`MCP-COMPATIBILITY.md` for the measured scope and historical reproduction.

The public repository, npm preview `0.1.0-alpha.5` and its MCP Registry entry are
published. The [hosted run at 832a044](https://github.com/stsepelin/checktrail/actions/runs/35694375091)
passed all jobs, and fresh public installation was verified. Alpha.5 adds
[per-check Go build-tag profiles](GO-BUILD.md) alongside [legacy compiler compatibility](TYPESCRIPT.md)
and the [setup commands](ONBOARDING.md). The [GitHub prerelease](https://github.com/stsepelin/checktrail/releases/tag/v0.1.0-alpha.5)
is also published with the verified tarball and checksum. npm tag cleanup remains
unresolved. The repository's explicit-action requirements still apply.
`RELEASE.md` defines the concrete
candidate checks and the authorization sequence; a local green run does not
replace external acceptance.

This audit uses the existing execution ledger and recorded native observations.
It is not a fresh security review of every source file, an independent review of
the evaluation labels, or proof that the entire M0–M5 plan is complete.

The selected C#/VB SDK formatting extension is specified in [DOTNET-FORMAT-EXTENSIONS.md](DOTNET-FORMAT-EXTENSIONS.md). [Its measurement](measurements/dotnet-format-extensions-2026-10-10.json) records all nine source and installed callbacks, 28 preserved .NET cases, 20 paired compiling controls and the mandatory host check. These are separate from final artifact/license, platform-matrix and Gate A acceptance. Native process freshness is not evidence of independent AI host sessions.

[The formatting CI repair](measurements/dotnet-format-ci-repair-2026-10-10.json) records the observed file/stage budget failures and complete local acceptance after exact callback isolation. Every native mutant and restored callback still runs; identical unchanged baselines are reused. Wider runtime and Gate A acceptance remain separate.

The selected generator and method extension is specified in [DOTNET-GENERATOR-EXTENSIONS.md](DOTNET-GENERATOR-EXTENSIONS.md). [Its measurement](measurements/dotnet-generator-extensions-2026-10-10.json) records 37 preserved native cases, all nine source and installed callbacks, and 12 paired controls including three compiled native mutations. Identical frozen inputs were used across separate supervised acceptance runs. Final artifact/license closure, the complete runtime matrix, independent AI host sessions and Gate A remain separate.
