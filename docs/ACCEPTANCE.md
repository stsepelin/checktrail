# Milestone acceptance audit

This audit maps the original plan to implemented profiles and their recorded
verification. It does not replace the plan or promote an unverified capability.
Local implementation, local native evidence, hosted CI and publication are
separate states. Follow the linked evidence for tested versions and limits.

| Milestone                         | Implemented scope and evidence                                                                                                                                                                                                                                                                                                                                                                                                          | Open acceptance work                                                                                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0: public contracts              | Original public fixtures, MIT license, security/contribution guidance, schemas, explicit package allowlist, dependency notices and CI definitions. `STATUS.md`, `SECURITY.md`, `RELEASE.md`.                                                                                                                                                                                                                                            | Public source, npm alpha.2 and its MCP Registry entry are published. Hosted CI passed at `4ce8398`; fresh registry installation was verified.                                                                                                  |
| M1: executable foundation         | Shared CLI/library/MCP engine, bounded inventory/runner, startup trust, native Node/Python/Go/PHP profiles, protocol and lifecycle regressions. `ARCHITECTURE.md`, `STATUS.md`, `MCP-COMPATIBILITY.md`. Fresh installed application-client profiles now have evidence in `CLIENTS.md`.                                                                                                                                                  | Application-client coverage beyond the named profiles. PHP remains unavailable when the consumer has no prepared runtime.                                                                                                                      |
| M2: practical language validation | Explicit JS/TS, Python, Go and PHP native tool profiles, structured diagnostics/test evidence, versions, environments, workspace selection, scope accounting, SARIF/JUnit and finding ratchets. `LANGUAGES.md`, adapter documents, `WORKSPACES.md`, `FINDING-POLICY.md`, `NATIVE-CI.md`.                                                                                                                                                | Hosted toolchain profiles passed at `52ba415`. Wider tool versions/framework configurations must be promoted separately; detection is not execution support.                                                                                   |
| M3: framework/contracts           | Native Laravel, Vue Router/Nuxt, Django/FastAPI assembly projections; imported runtime comparison, explicit architecture boundaries, producer/consumer schemas and a built package consumer. `RUNTIME-INVENTORY.md`, framework documents, `CONTRACTS.md`, `ARCHITECTURE-POLICY.md`, `examples/package-contract/README.md`.                                                                                                              | Broader native semantics/import collection and live service integration are not implemented. Synthetic evidence does not establish equivalent results in a private application; private integration feedback must remain private.              |
| M4: ecosystem/distribution        | Bounded Rust, Java, C#, Ruby, Swift, Clang and actionlint profiles; trusted external adapters, pinned data-only pack distribution, fresh offline package checks, production notice audit, measured performance and published MCP Registry metadata. `LANGUAGES.md`, `EXTERNAL-ADAPTERS.md`, `PACK-DISTRIBUTION.md`, `PERFORMANCE.md`, `RELEASE.md`.                                                                                     | npm tag cleanup remains unresolved. Windows execution and the unimplemented subsequent integrations in `LANGUAGES.md` remain unsupported. Runtime/container/development dependency provenance is broader than the production npm notice audit. |
| M5: measured assistance           | Advisory guidance, bounded Node mutation experiments, explicit-graph impact measurements, optional local/model review exchange, durable library task storage/worker, development evaluation and externally authored ESLint and Ruff integration cohorts. `GUIDANCE.md`, `MUTATIONS.md`, `IMPACT-MEASUREMENT.md`, `REVIEW-EXCHANGE.md`, `VALIDATION-TASKS.md`, `EVALUATION.md`, `EXTERNAL-EVALUATION.md`, `EXTERNAL-RUFF-EVALUATION.md`. | Standard MCP Tasks wire integration; wider held-out rule-family/review evidence, prior-workflow comparison and representative cost/latency measurement. No general equal-or-better review-quality claim is supported.                          |

## Remaining work that can proceed locally

1. Extend independently authored evaluation cohorts to additional implemented
   language/rule families, preserving the verifier freeze and recording exact
   selection, exclusions, native baselines and interpretation limits. New fixtures
   authored after inspecting the implementation remain development tests.
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

The pinned MCP server SDK routing probe still rejects `tasks/get` and `tasks/cancel` before their extension handlers
run. The local worker/store are available independently; standard Tasks must stay
unadvertised until routing and the integrated wire/lifecycle suite pass. See
`MCP-COMPATIBILITY.md` for the reproduction and upstream issue.

The public repository, npm preview `0.1.0-alpha.2` and its MCP Registry entry are
published. The [hosted run at 4ce8398](https://github.com/stsepelin/checktrail/actions/runs/35590670960)
passed all jobs, and fresh public installation was verified. Alpha.2 adds
[setup commands](ONBOARDING.md). npm tag cleanup and GitHub releases remain
separate work. The repository's explicit-action requirements still apply.
`RELEASE.md` defines the concrete
candidate checks and the authorization sequence; a local green run does not
replace external acceptance.

This audit uses the existing execution ledger and recorded native observations.
It is not a fresh security review of every source file, an independent review of
the evaluation labels, or proof that the entire M0–M5 plan is complete.
