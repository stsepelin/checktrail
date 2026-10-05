# Locally operated reviewer roadmap

Status: implementation in progress; feature and quality gates remain open. This records the expanded product target and
the required completion sequence. It makes no achieved review-quality claim.
The deterministic foundation and its limits remain in [PLAN.md](PLAN.md),
[ARCHITECTURE.md](ARCHITECTURE.md) and [ACCEPTANCE.md](ACCEPTANCE.md).

## Target and meaning of local

Build a locally operated reviewer that produces independently supported,
actionable findings across a declared, expanding language/framework matrix.
The acceptance target is same-or-better material-defect detection against a
frozen external reference, with strong precision, low valid-change false alarms,
calibrated confidence and complete accounting of unreviewed work. There is no
universal ranking claim or promise that every project is supported.

Local means that Checktrail, repository access, evidence, execution and retained
artifacts are controlled by the operator. The required interface is a local MCP
server used by the operator's chosen AI host. The host selects the AI and handles
its subscription or API authentication; Checktrail needs neither subscription
credentials nor a native AI client launcher. Optional Checktrail-owned direct
provider inference is a separate interface. It does not require offline inference or a
hosted review service. Provider-backed inference can transmit selected context
to that provider; the operator must authorize that disclosure. Use documented
authentication interfaces opaquely; never read, copy or retain credentials.

The provider-neutral MCP reviewer workflow is the primary target. Model
orchestration inside Checktrail is optional; it is not a Gate A requirement.
The core remains useful without an account or model provider. A bounded stateless API
transport now has offline synthetic evidence and operator admission budgets.
A bounded source-bound Node probe, fresh refutation and a separate raw-evidence
adjudication assignment are implemented;
provider-neutral staged review, broader probes and independent claim validation
remain unfinished. Optional native AI client orchestration is not implemented. Deterministic native outcomes, advisory hypotheses
and independently validated findings remain distinct. A model cannot change a
failed/incomplete native result into a pass or grant execution/source permissions
through an MCP argument, repository file or source instruction.

## Three gates preserve the finish-first sequence

| Gate                          | Required evidence                                                                                                                                                                                                                                                         | Current state                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| A: feature complete           | A frozen required task inventory covering the existing M0–M5 plan and this reviewer expansion; every implementation task has its declared synthetic/native/protocol acceptance evidence and no unresolved required capability. Evaluation tooling and protocol are ready. | Pending: inventory reconciliation and implementation remain open. |
| B: evaluation ready/permitted | Gate A complete; existing operator authorization covers the concrete evaluation and selected source/model/execution/budget permissions; frozen revisions, hidden case selection/labels, metrics, thresholds and functioning blinded adjudication.                         | Pending readiness; this roadmap starts no field evaluation.       |
| C: quality demonstrated       | A complete eligible evaluation satisfies the predeclared quality gates with independent adjudication, uncertainty, exclusions, incomplete results, cost and latency reported.                                                                                             | Pending: no same-or-better quality result exists.                 |

No new real-project MCP field trial starts before Gate A. Passing code checks
does not automatically authorize a field trial or complete Gates B/C. Original
synthetic acceptance tests, native adapter tests and harness-readiness tests are
development work and can proceed before A. Actual model integration checks on
original synthetic fixtures additionally require operator-authorized inference.
Existing authorization is sufficient when it covers the concrete action; this
gate does not require a fresh confirmation by default. Readiness and the existing
trust/privacy boundaries still need to be satisfied.

M5 evaluation implementation/readiness belongs to A; actual comparative outcomes
belong to C and remain required quality evidence. This separates building the
measurement system from using it and avoids requiring a completed comparison
before permitting that comparison. Ordinary field use for reliance follows C;
a controlled evaluation after B is the experiment, not proof of quality.

Existing [public adoption](PUBLIC-ADOPTION.md) and agent-evaluation records remain
historical evidence. They are not rewritten, discarded or substituted for the
new prospective holdout. Research into public review history can inform the
protocol without running Checktrail MCP against those repositories or opening
the reserved acceptance cases.

## Reconcile every existing planned task first

The immediate required task is a finite inventory mapping each obligation to its
source document, bounded deliverable, dependencies, named acceptance cases,
platform/tool profile and evidence location. The [required inventory](REQUIRED-INVENTORY.md) reconciles the capability families
and explicit deferrals. Exact new acceptance-profile pins remain open. Broad phrases such as broader semantics or wider versions need
explicit finite profiles before Gate A can be assessed. Unsupported, blocked or
unmeasured work stays open; it cannot become optional merely to enable a trial.
Changing an existing requirement needs an explicit scope decision.

| Inventory group                                | Required reconciliation and completion evidence                                                                                                                                                                                                                                                                                                                                              | State                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| M0/M1 contracts and clients                    | Preserve public/synthetic provenance, schema and package boundaries; reconcile advertised client/version profiles beyond the existing named evidence. Historical publication/CI does not certify new revisions.                                                                                                                                                                              | Pending reconciliation; existing evidence retained.                         |
| Evidence error classification and verification | Close the pre-existing Staticcheck cache/loading-error versus source-diagnostic classification defect; audit sibling analyzer parsers for the same error family. Use environment-compatible runner/cache settings and account for every required result without treating sandbox-denied or unavailable checks as passes. Broken infrastructure cannot be scored as a detected source defect. | F1 locally verified; exact profiles and limits remain in REVIEWER-TASKS.md. |
| M2 language validation                         | Go repeated-check/profile/target identities and aggregation, matched native listing/execution, race/cgo constraints and target versus cross-compilation distinctions; wider tool/configuration profiles, scope/evidence parsers and required native CI cases.                                                                                                                                | Pending.                                                                    |
| M3 frameworks and contracts                    | Finite Laravel, Vue Router/Nuxt, Django/FastAPI semantic and assembly categories; non-evaluating native import collectors with explicit completeness; affected consumer graphs and synthetic live producer/consumer integrations exercising both sides.                                                                                                                                      | Pending beyond current bounded profiles.                                    |
| M4 platforms and distribution                  | Windows executable resolution, environment behavior and process-tree cancellation; pinned Linux/macOS matrices; development/native/container provenance beyond npm production notices; external adapter/pack and installed-package compatibility; representative resource measurements and remaining release/tag gates.                                                                      | Pending beyond recorded profiles/releases.                                  |
| M5 assistance and Tasks                        | Broader mutation/runner and impact support; standard negotiated MCP Tasks, ordinary-call fallback, worker/store wiring, cancellation/restart/expiry/concurrency/privacy; independent rule-family cohorts, prior-workflow baseline and reliable metering/adjudicator delivery.                                                                                                                | Pending beyond existing guidance/exchange/library worker.                   |
| Cross-cutting unimplemented items              | Reconcile complete dependency/tool/environment fingerprints, inferred graphs, native import collection, execution isolation and executable private-plugin distribution against the original plan. Distinguish explicit outside-first-version items, such as remote serving and automatic fixes, from unfinished requirements; listing a gap does not silently remove or add a requirement.   | Pending inventory decision.                                                 |

Every subsequent native integration in [LANGUAGES.md](LANGUAGES.md) must receive
an inventory entry and its own broken/fixed/near-miss, execution-accounting and
platform evidence. The complete named set is:

| Family                | Named integration obligations to reconcile                                                                                                                                                      | State    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| JavaScript/TypeScript | Framework scope profiles, including parser/processor and loader/build prerequisites.                                                                                                            | Pending. |
| Python                | Pyright, namespace/virtual-environment/plugin constraints.                                                                                                                                      | Pending. |
| Go                    | Broader golangci-lint settings and module/workspace/build-tag/platform constraints.                                                                                                             | Pending. |
| PHP                   | Larastan integration and PHP-CS-Fixer, extensions/generated proxies/framework initialization.                                                                                                   | Pending. |
| Rust                  | cargo fmt, clippy and test; feature/target/workspace coverage and offline dependencies.                                                                                                         | Pending. |
| JVM                   | Maven/Gradle test, Checkstyle, SpotBugs and detekt; wrapper/module/JVM/generated-source prerequisites. Record intended execution coverage for currently discovery-only Kotlin/Scala explicitly. | Pending. |
| .NET                  | dotnet format, build and test, restore/analyzer/framework/generated-code/TRX coverage. Record intended execution coverage for currently discovery-only F#/Visual Basic explicitly.              | Pending. |
| Ruby                  | RuboCop, RSpec and Minitest, Bundler/runtime configuration constraints.                                                                                                                         | Pending. |
| Swift                 | swift build/test and SwiftLint, manifest/platform/SDK constraints.                                                                                                                              | Pending. |
| C/C++                 | clang-format, clang-tidy, compiler checks and CTest, compilation databases/linking/toolchain/build-target prerequisites.                                                                        | Pending. |
| Infrastructure        | terraform validate, helm lint/template and kubeconform, local/offline inputs and evidence boundaries; reconcile the ledger's unsupported Kustomize scope.                                       | Pending. |

Beginning with deeper JS/TS, Python, Go and PHP reviewer support and the current
framework profiles is an implementation order, not a reduction of this inventory.
New ideas after the freeze enter a later queue; neither an indefinitely moving
finish line nor a quiet reduction of the required scope satisfies Gate A.

## Required reviewer task groups

The [task ledger](REVIEWER-TASKS.md) records implementation dependencies and
development evidence. R1's bounded snapshot/diff foundation is locally verified;
its semantic/caller collection and the remaining groups are pending. These groups
implement a reviewer, rather than
relabeling the current [review exchange](REVIEW-EXCHANGE.md), whose receipts
check freshness/quotations but explicitly do not verify claims or run inference.

| Group                                     | Deliverable and measurable completion evidence                                                                                                                                                                                                                                                                                                                                                                                                                                | State                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1: source and behavior context           | Immutable base/head plus staged/working identities, diff hunks, changed/deleted/moved behavior, full touched functions, declarations/defaults, bounded callers and downstream consumers. Non-evaluating collectors expose completeness/omissions and conservative fallback. Synthetic stale/escape/rename/delete/cycle/limit cases must fail for the intended reason.                                                                                                         | Foundation locally verified; semantic/caller and wider acceptance pending.                                                                                                                                                                                                                                            |
| R2: specialized hypotheses                | Versioned families for authorization/tenancy, input/identifier/allowlist boundaries, types/numeric semantics, lifecycle/order, framework assembly, concurrency/resources, multi-artifact atomicity, dependencies/builds and test adequacy. Each has trigger, invariant, evidence requirements, applicability limits and broken/fixed/near-miss acceptance.                                                                                                                    | Catalogue and source-bound plans verified; detection/probe acceptance partial.                                                                                                                                                                                                                                        |
| R3: provider-neutral review exchange      | Local MCP assignment/assessment contracts usable by the chosen host AI without Checktrail-owned credentials or inference. Host-declared model/session provenance remains distinct from engine-observed evidence. Strict source/citation/output contracts, startup disclosure/execution grants and provider-neutral stage controls require synthetic acceptance. Existing direct API transports stay optional.                                                                 | Bounded neutral staged exchange has synthetic profiles; host isolation, actual client acceptance and wider workflow evidence remain pending.                                                                                                                                                                          |
| R4: falsifiable probes and controls       | Candidates state current address, trigger, consequence, relevant callers/defaults and base/head attribution. Native checks, approved probe templates or separately reviewed pinned probes test baseline, broken behavior, repaired/control and near misses; scale fixtures arm runtime guards. No general model-selected shell or automatic service startup.                                                                                                                  | Pinned native Boolean profile verified; broader probes and caller evidence pending.                                                                                                                                                                                                                                   |
| R5: independent validation and findings   | A separate verifier attempts refutation, checks defaults and the whole sibling family, reachability, test doubles, infrastructure errors and fix feasibility. Supported/refuted/unresolved outcomes link evidence; agreement alone is not proof. Deduplicate underlying defects, preserve affected paths, distinguish regression/pre-existing/follow-up scope and assign severity by consequence. Blind seeded-claim tests include incorrect mechanisms, locations and fixes. | Fresh refutation, live Node corroboration and raw-evidence adjudication have synthetic controls; general claim resolution, deduplication and severity remain pending.                                                                                                                                                 |
| R6: confidence and abstention             | Separate severity, evidence tier and calibrated probability. Explicit unsupported, incomplete, exhausted-budget and unreviewed states; no empty review implies a clean result. Held-out reliability/probability scores, risk-versus-coverage, high-confidence errors and abstention rates accompany findings. Acceptance tests preserve these states through all surfaces.                                                                                                    | Descriptive proper scoring and abstention implemented; calibration and held-out uncertainty pending.                                                                                                                                                                                                                  |
| R7: budgets, privacy and cleanup          | Startup-selected source/tool-output/native-time/call/wall limits and bounded engine retries; cancellation and retained-artifact cleanup. Engine-owned API paths additionally bound attempts and reported usage/cost. Host AI calls, tokens and billing are outside MCP-server control and remain unknown unless externally measured. No credential retention or model-granted trust.                                                                                          | API, bounded Node and protected workflow ledgers implemented; version 2 private journals retain returned structured native receipts; broader native/tool lifecycle and complete model/raw-output archives remain pending.                                                                                             |
| R8: shared surfaces and benchmark harness | One provider-neutral library/CLI/MCP reviewer contract with native results separate; versioned external corpus manifests, sealed packets, answer-hiding, blinded adjudication, paired scoring, accounting and reproducible artifacts. Original synthetic end-to-end tests cover pass/fail/incomplete native results and supported/refuted/unresolved claims; dry runs verify harness integrity without opening holdouts.                                                      | Shared neutral exchange has synthetic end-to-end profiles; version 2 native receipt journals implemented; sealed synthetic review/judgment intake is implemented with structural acceptance; observed host isolation, independently verified judgments, complete external attempts and paired scoring remain pending. |

The first implementation slice is inventory completion plus R1's stronger
diff/base/behavior/caller context. Required synthetic acceptance covers a new
regression, preserved behavior moved into a helper, an unchanged nearby decision
defect, a renamed/deleted caller, a cross-project consumer and a valid near miss.
Record omitted context explicitly and name the test that fails if each behavior
is removed. No real-project trial is started by this plan. The operator's clarified
MCP-first scope removes mandatory native AI client launching; it does not remove
independence, evidence, accounting or quality obligations.
The early closure slice also corrects the observed infrastructure-error
classification and audits its sibling paths. Previous type/lint successes do not
make the current full test suite green; unresolved environment-dependent paths
need truthful verification accounting rather than an assumed pass.

## Independent corpus and quality gates

Use public review snapshots, independently reproduced bug/fix pairs and valid
controls through external pinned manifests/source caches. Public comments,
author agreement and later patches nominate candidates; they are not truth labels.
Keep comparator identity, case links, copied source/comments, answers and provider
receipts outside Git. Repository fixtures remain original and synthetic. Audit
upstream source/data rights; a benchmark harness license does not relicense its
harvested material.

An independent curator reserves repository-grouped and time-separated acceptance
cases before implementation inspection. Group forks and all related defect/fix/
near-miss variants into the same split; detect duplicate commits across corpora.
Hold out entire repositories where generalization is claimed. Hide labels, future
commits, fixing patches, review threads and answer-bearing metadata from reviewer
inputs and retrieval. Public-data memorization cannot be ruled out by fresh
sessions; disclose contamination risk and add independently authored fresh cases.
Inspected public sets are development/calibration evidence, not the new holdout.
No frozen independent acceptance holdout has yet been acquired. Corpus acquisition,
license eligibility, exact-source sealing and per-case reproduction remain open
tasks, not completed research outcomes.

Fresh-session independence is required for each review assignment. A snapshot
reviewer sees only its assigned snapshot and task, with no previous or sibling
revision, paired status, earlier findings, labels, fixing commits, conversation
history, shared project memory, cross-arm outputs or answer-bearing metadata.
Isolate source, artifacts, caches and session state; neutral names cannot reveal
buggy/fixed/control status. Supply no Git history in the snapshot track. A separate
predeclared diff-review track provides exactly its assigned base/head as legitimate
inputs, never future commits or other trial context. These tracks answer different
questions and must not be merged into one score.

Use independent reviewer sessions and separate blinded adjudicators. Randomize or
rotate balanced case/arm ordering without giving sessions access to other cases.
Keep repository/related-defect groups together within splits and declare held-out
defect-family experiments separately. Do not retry selectively or cherry-pick
outputs; predeclare repeated-trial policy and include all attempts. Freeze rules,
prompts, models and harness before exposing hidden labels. Test rule variants
directly on repaired/valid-near-miss and scale/order controls; guard-removal
mutations must fail the exact expected assertion rather than an unrelated setup
failure. Record isolation evidence and residual limits, not a claim that public
examples are unseen by provider training.

Blind adjudicators inspect shuffled anonymous atomic claims under the same source
and contemporaneous requirements, using reproduction or an explicit causal
argument. Resolve disagreements independently; preserve unresolved cases.
Additional genuine defects absent from a golden set require symmetric adjudication
and versioned labels for every compared system. A fixed revision is a control for
the repaired defect, not proof of global cleanliness.

The following are target gates, not existing measurements or external-reference
scores. Freeze threshold selection, minimum useful review coverage, severity
strata/weights and budget matching before Gate B.

| Measure                           | Proposed acceptance requirement                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High-confidence finding precision | At least 95% independently supported, in-scope, actionable unique findings; the predeclared one-sided 95% lower confidence bound must also reach 95%. Include wrong mechanisms/addresses/unreachable prescriptions in error accounting.                                                                                                                                                  |
| Valid-change false alarms         | At most 5% of eligible independently adjudicated valid controls receive a material-defect allegation; the one-sided 95% upper bound must also stay at or below 5%. Report false findings per change separately.                                                                                                                                                                          |
| Material-defect recall            | At least the frozen external reference at matched inputs/context and declared budgets; the paired lower confidence bound must support non-negative difference. Report severity/language/framework/defect-family slices. Superiority requires the paired improvement interval to exclude zero while precision/false-alarm gates hold.                                                     |
| Confidence and abstention         | Calibrate on separate development data; report held-out reliability bins and a predeclared proper probability score, plus risk-versus-coverage and incomplete/abstention rates. Verbal certainty or model agreement is not a probability. Do not satisfy precision by silently withholding useful coverage.                                                                              |
| Adequate sample and power         | As a proposed design choice, predeclare case/repository counts and an analysis targeting at least 80% power for the stated recall effect or comparison criterion; use repository-grouped paired uncertainty and effective independent sample sizes. Too few findings, clean controls, repositories or severity-stratum cases makes the claim inconclusive regardless of point estimates. |
| Completeness and cost             | Reconcile selected/eligible/excluded/incomplete snapshots and supported/refuted/unresolved claims; retain timeouts, unavailable tools and budget exhaustion. Record exact versions, revisions, context omissions, actual/unknown provider usage, latency, cost and cleanup. No missing/empty/stale evidence counts as pass.                                                              |

Use defect recall and precision directly rather than maximizing finding volume.
Equal point estimates do not establish parity when the uncertainty still permits
a meaningful deficit; such a comparison remains inconclusive.
If a composite score is used, freeze weights and denominators before evaluating
and keep its component metrics visible. The [agent evaluation protocol](AGENT-EVALUATION.md)
and [prior-workflow comparison](PRIOR-WORKFLOW-EVALUATION.md) supply existing
contracts to extend, not proof that these targets have been met.

Historical reference outputs support only a bounded historical comparison.
They cannot establish present-day parity against an evolving system, or worldwide
superiority. Report exactly the evaluated support slice and uncertainty. Failures
return to implementation and a fresh reserved cohort; repeated tuning on the
same holdout turns it into development data.
