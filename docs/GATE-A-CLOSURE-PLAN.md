# Gate A closure plan

Status: **open**. Execution baseline: `ca600a2447ca263128b7ab8ad7bfc185774a554b`,
audited on 2026-11-19. This is the execution order for the existing requirements,
not a replacement acceptance standard, except for the explicit producer budget
revision in [section 2a](#2a-producer-budget-revision-2026-11-24). The primary
implementing agent owns this plan, its status updates and the final closure
decision.

## 1. Fixed scope and current position

The completion contract is [Gate A in the roadmap](REVIEWER-ROADMAP.md#three-gates-preserve-the-finish-first-sequence):
freeze the required inventory, finish its implementation and declared acceptance,
and prepare the evaluation tooling/protocol. Every selected upstream producer,
compiler, SDK and bootstrap input still needs a closed provenance row and complete
original notices; [section 2a](#2a-producer-budget-revision-2026-11-24) defines
which evidence closes a producer whose original build cannot run within the
free hosted budget. New
real-project MCP, held-out and model review trials remain closed until Gate A is
complete and Gate B separately permits the concrete experiment.

Use these existing files as the scope, rather than broad historical summary rows:

- [Selected profiles](gate-a-profiles.v1.json): the exact extension deliverables,
  versions, runtime selections and named acceptance cases.
- [Preserved native baseline](gate-a-native-baseline.v1.json) and
  [required test manifest](../scripts/required-native-tests.json): existing
  compatibility and callback obligations that must survive the work.
- [Required inventory](REQUIRED-INVENTORY.md): M0–M5, F1, R1–R8 and E1–E17,
  including explicit exclusions and deferred work.
- [Hosted producer plan](HOSTED-PRODUCER-PLAN.md) and
  [provenance contract](NATIVE-PROVENANCE.md): upstream execution and evidence.

The existing read-only audit at this baseline reports the following. Recompute
these values when the selection changes; they are a dated snapshot, not an
overall completion percentage.

| Inventory dimension         | Audited value | Meaning                                                                                                 |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| Required obligation IDs     | 32            | The M/F/R/E obligations in the selected inventory.                                                      |
| Extension profiles          | 51            | 50 declared implemented; `native-license-provenance` pending. Declarations do not establish acceptance. |
| Preserved native profiles   | 89            | 716 profile/file/name entries, containing 689 unique callbacks.                                         |
| Planned extension cases     | 459           | 453 present in the shared manifest; six outside it require controller-specific reconciliation.          |
| Unresolved freeze decisions | 2             | `expanded-native-artifact-closures` and `matrix-and-acceptance-bindings`.                               |
| Selected runtime slots      | 8             | Exact versions/platforms are in the inventory, not inferred from runner labels.                         |

The six cases outside the shared manifest belong to `cpp-extensions`,
`terraform-extensions` and `helm-extensions`, two each. Locate their actual
controller bindings and outcomes before adding or changing anything. The audit
does not assess those controllers, so this count alone proves neither missing
implementation nor acceptance.

Current application checks and controller tests qualify their recorded inputs.
They do not close an upstream producer. The prepared GCC and .NET SDK
multi-job continuations are withdrawn from the closure path by section 2a.
Existing successful source-build and reconstructed payload facets must be
reused within their actual scope instead of repeated.

## 2. Completion rules

Each work item has these separate states:

`open -> ready -> running -> evidence retained -> verified -> closed`

`blocked` records an exact prerequisite, authorization or infrastructure limit.
It never counts as closed. A repaired controller, a prepared workflow, a static
archive match and a successful native build are different evidence.

Separate execution prerequisites from final provenance joins. A consumer can
execute with its original admitted, pinned input artifact while that input's
producer closure proceeds independently. Rebuilding a compiler first is an
execution dependency only if the selected consumer recipe actually requires its
new output. All required producer proofs must still be joined before Gate A
closes; this scheduling distinction removes none of them.

An upstream group closes only after its selected source/recipe, actual required
producer inputs, complete original notices, original command outcomes, required
outputs and retained/replayed evidence are reconciled. Preserve genuine failed,
empty or skipped upstream test outcomes. Do not introduce an all-upstream-tests-
pass requirement where the original contract requires faithful outcomes; also
do not promote a failed build to a successful source-build facet.

A native acceptance profile closes only with the declared broken, fixed,
near-miss, prerequisite, stale, empty, privacy, lifecycle and installed evidence
on its selected platforms. Every required callback needs a terminal outcome.
Missing, stale, skipped, unavailable and unknown results remain incomplete.

Receipt reuse requires proof that the relevant source, dependencies, tools,
configuration and acceptance inputs are unchanged. A new engine or package
revision needs its own applicable bindings; a version label or a green job is
insufficient. Keep source-build completion, historical publisher byte equality
and current adapter acceptance separate.

## 2a. Producer budget revision (2026-11-24)

This is an explicit requirement change approved by the operator on 2026-11-24.
Gate A producer work runs only on free standard GitHub-hosted runners for public
repositories. Multi-hour original builds chained across jobs with checkpoints,
continuations or large private evidence exports are not available on that
infrastructure and are removed from the Gate A closure path.

**Budget.** A producer source-build facet is admissible only as one job on a
standard hosted runner that completes, including preparation, upload and
cleanup, within **five hours** of the job's six-hour limit. No checkpoint chain,
continuation round, paid or larger runner, self-hosted machine or evidence
export above the standard artifact path is part of a Gate A closure.

**Retained builds.** A source-build facet already completed and retained under
the earlier rules, including a local build such as the retained Temurin 25
output, keeps counting as source-built evidence within its recorded inputs,
environment and scope. The budget applies to new build attempts. Any open
obligation recorded with such a facet, such as capture recovery or work-volume
cleanup, stays open for that row.

**Classification per producer.** Each selected producer is classified on its
own, using eligible retained evidence first, then one measured attempt; one
package can contain both classifications. A work package closes only when all
of its producer rows are resolved. An attempt stopped early by a controller or
infrastructure defect, before the budget is exhausted, is neither a source build
nor a measurement: it does not consume the measured attempt, and the failure
policy in section 5.5 governs its repair and single bounded retry within the
existing authorization.

- **Source-built.** The original selected command completes within the budget.
  Close it with the existing source-build evidence rules.
- **Eligible for publisher attestation.** A measured attempt on a standard
  hosted runner exhausted the budget while running the original build, with
  the runner, elapsed time and stopping cause recorded in aggregate; or the
  operator recorded an explicit exception. Before the attempt the controller
  declares its finalization reserve, justified by that carrier's own bounded
  upload and cleanup limits; the original command's window is the five-hour
  budget minus preparation and that reserve. The reserve, the preparation time
  and the observed cutoff are retained so a verifier can tell genuine
  exhaustion from an unnecessarily short window. A command still running at
  the end of its window is stopped, and that stop is the measured exhaustion. A command that finishes inside its window is a source build if
  its required evidence is then retained; a finalization that overruns its
  declared reserve is a controller defect under section 5.5, not exhaustion.
  An existing carrier whose own job or step limit is shorter than this window
  can still produce a source build by finishing inside it, but a cutoff at that
  shorter limit is not a measurement: it needs a budget-aligned carrier or an
  explicit operator exception before it can establish eligibility. A setup failure, denied export or
  early stop does not by itself show budget exhaustion. GCC 12 and .NET SDK
  10.0.401 are **explicit operator exceptions** recorded on 2026-11-24, not
  measured results: their retained attempts show interruption or no run, not a
  measured duration.
- **Publisher-attested.** An eligible producer closes only when all of this is
  verified; until then it stays open:
  1. the exact selected upstream release artifact, pinned by size and SHA-256;
  2. verification against the publisher's own signature, signed checksum
     manifest or signed package index, with the verifying key's identity pinned;
  3. the publisher's corresponding source release identity and build recipe
     reference for that artifact;
  4. complete original notices extracted from the selected artifact and its
     corresponding source;
  5. any reproducible-build attestation or SBOM the publisher provides,
     recorded as such and not required.

A publisher-attested row **does not claim a source build, reproduction or
historical byte equality**. The closure record and support matrix label it
`publisher-attested`, separately from `source-built`, and never merge the two.
An artifact whose publisher offers no verifiable signature or signed checksum
stays open; a hash recorded only by this project is not a publisher attestation.
Source reproduction of publisher-attested producers moves to the post-Gate-A
queue and is not a Gate A obligation.

Consumers still run with their original admitted input identities. Only two
execution paths are withdrawn: the multi-job GCC 12 continuation (its staged
and main05 carriers) and the .NET SDK 10.0.401 original-build producer.
Integrating them into the repository as diagnostic tooling, with their
synthetic controls in ordinary validation, is an A03 deliverable that is still
open; no Gate A item waits on a run of them. Every other single-job carrier, such as the
Go C-root bootstrap, stays on its existing acceptance path.

## 3. Ordered work ledger

These IDs are the fixed execution queue. They are work packages, not equal-sized
units for computing a percentage. Every closure update records the exact input
revision, evidence location, outcome and remaining child obligations. Public
records retain permitted aggregate evidence; private inputs and detailed records
stay outside Git.

| ID  | Work and initial state                                                                                                              | Dependencies                                       | Evidence required to close                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A01 | Publish this plan and record the inventory baseline. **Closed** (#210, merged 2026-11-19).                                          | None                                               | Audited scope, all existing obligation/profile IDs covered, explicit pending permissions, and a reviewable PR targeting `main`.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A02 | Reconcile producer facets already completed and their remaining notice/prerequisite joins. **Open.**                                | A01                                                | For every group in section 4, distinguish retained build/output evidence from open notices and selected input edges. Close only supported facets; do not rebuild completed producers merely to obtain another receipt.                                                                                                                                                                                                                                                                                                                                       |
| A03 | Integrate the already qualified producer implementation into the repository. **Prepared work; integration open.**                   | A01                                                | Exact reviewed source, focused regressions, applicable normal checks, synthetic public fixtures and a non-stacked PR against current `main`. Operator-only helpers and manual producer workflows retain their distinct trust boundary.                                                                                                                                                                                                                                                                                                                       |
| A04 | Close GCC 12 as a publisher-attested producer (section 2a; operator exception). **Open.**                                           | A02 for closure; evidence collection can start now | The selected Debian GCC 12.2.0-14+deb12u1 binary packages and their source package pinned by size and SHA-256; verification through the signed Debian `InRelease`/`Release` and `Packages`/`Sources` indexes with the archive key identity pinned; the source package identity and `debian/rules` recipe reference; complete original notices (`copyright` files and the GCC runtime library exception) from the binary and source packages. Retained interrupted build observations stay historical records and are not reported as a build.                |
| A05 | Close .NET SDK 10.0.401 as a publisher-attested producer (section 2a; operator exception). **Open.**                                | A02 for closure; evidence collection can start now | The selected official SDK 10.0.401 archive pinned by size and SHA-256 and verified against the publisher's signed release metadata or signed package repository with the key identity pinned; the corresponding `dotnet/dotnet` source release tag and build recipe reference; complete original notices from the archive (`LICENSE.txt`, `ThirdPartyNotices.txt`), reconciled with the notices of the corresponding `dotnet/dotnet` source release. The prepared source/key/attempt state is retained unused; no build or encrypted export runs for Gate A. |
| A06 | Complete selected Rust 1.98/bootstrap and required SDK/tool/notice inputs. **Open; remaining input permissions must be respected.** | A02; actual stock-host admission                   | Selected bootstrap/source/tool identities, original native build outcomes and outputs, original notices and required SDK provenance. Earlier Rust 1.90 evidence does not substitute for this producer.                                                                                                                                                                                                                                                                                                                                                       |
| A07 | Complete Binaryen 132's selected original ARM64 phases. **Open.**                                                                   | A02; actual hosted SDK/source admission            | Original configure/build-install/strip/package phases, complete selected sources/Gitlinks, outputs and notices on the explicitly admitted hosted environment. Preserve the distinction from historical runner/SDK/binary equality.                                                                                                                                                                                                                                                                                                                           |
| A08 | Complete WASI SDK 34 and its selected support producers. **Open.**                                                                  | A02; declared compiler/runtime inputs              | Actual original build/capture/runtime adapters, selected Wasmtime producer, and the actual original unlocked Cargo resolution where required. Reuse completed source materialization; do not guess dependency resolution from a packaged lockfile.                                                                                                                                                                                                                                                                                                           |
| A09 | Close Scala/JDK/JLine/ASM and selected component producer edges. **Open.**                                                          | A02; selected native/header/compiler inputs        | Whole selected JAR/component/native packaging and notices, with original JNI/test participation. Reuse completed JDK source-build/capture evidence. Decoded-cache cleanup and class-payload byte matches alone do not close whole producers.                                                                                                                                                                                                                                                                                                                 |
| A10 | Close Fantomas and the selected .NET 11 producer/input graph. **Open.**                                                             | A02; selected compiler/reference/native inputs     | Reconcile original default-pipeline outcomes, generated/core/reference/package inputs and notices. Separate observed compilation/Pack facets from any unfinished required default producer.                                                                                                                                                                                                                                                                                                                                                                  |
| A11 | Integrate and execute the Tree-sitter 0.27.0 producer. **Open.**                                                                    | A03; actual original tool/input admission          | Integrate the focused process-lifecycle repair into its real driver/carrier bindings, then qualify permissions/capacity and execute original stages with complete capture/notices. Join selected Rust/emsdk/WASI producer edges in A12 without artificially waiting for unrelated source builds. Respect its separate export authorization. Do not substitute 0.27.1 web artifacts.                                                                                                                                                                          |
| A12 | Close original notices/provenance and finish acceptance of `native-license-provenance`. **Open.**                                   | A02, A04–A11 and all actual selected child edges   | Complete original texts, copied/generated/component obligations and artifact-to-producer associations; all nine declared acceptance cases, source and offline installed behavior; unknown or changed input refusal. Reuse existing code and wire only genuinely missing behavior. A generic synthetic license fixture cannot stand for actual upstream closure.                                                                                                                                                                                              |
| A13 | Complete the final current-source/native/installed matrix. **Open.**                                                                | A03, A12; final code candidate                     | Every selected profile in its declared slots, every preserved required callback, exact OS/tool/dependency identities and a fresh offline installation from the exact built package. Reconcile all expected and terminal events; no optional skip closes a required slot. Execute the fixed candidate selections before certifying their completed freeze.                                                                                                                                                                                                    |
| A14 | Finish evaluation implementation/readiness and release/resource obligations. **Partially evidenced; current closure open.**         | A02, A03, A13 for current-source acceptance        | Synthetic independent-session/stage/attempt/archive/label-hiding/scoring controls, effective configuration bindings and the selected cohort/protocol readiness; applicable performance/package/release/tag obligations. Plain Codex and Claude baselines remain separate; additional operator-selected private configurations stay private. No actual comparison, held-out source inspection or model review trial runs here.                                                                                                                                |
| A15 | Resolve both inventory freeze decisions. **Open.**                                                                                  | A12, A13, A14                                      | All selected artifact/build/license closures bound; exact acceptance mapping for every preserved/extension profile, including the six externally bound cases. Remove a freeze blocker only with its completed evidence, preserving the original selection and callbacks.                                                                                                                                                                                                                                                                                     |
| A16 | Implement and perform final Gate A acceptance; publish the closure record. **Open.**                                                | A01–A15 verified and required changes merged       | Recompute the structural audit and completed freeze; verify a separate closure record against actual obligation/profile/producer evidence, exact merged source and installed artifacts; reject all missing/stale/unknown required bindings; reconcile the ledger/roadmap/support documents. Preserve the selection auditor's prohibition on claiming acceptance. Declare Gate A complete only from the verified closure record. Gate B/C remain separate.                                                                                                    |

Within A06–A11, each selected producer is classified separately under
section 2a, using eligible retained evidence before any new measured attempt.
For a publisher-attested row, section 2a evidence replaces only the
original-build evidence in the "Evidence required" text above; every
implementation, integration and input obligation listed there, such as A08's
runtime adapters or A11's driver integration, still applies to either
classification. A02 and the authorized
portions of A03/A14 run while producer jobs execute or a specific permission is
pending. A04/A05 need no build, export or capacity admission: their evidence
collection can start now, and their closure waits for A02. Then execute the remaining producer DAG according
to actual input dependencies; A06–A11 are not an artificial serial queue. Each
consumer must use its original admitted input identities. A12–A16 close the evidence,
inventory and final application boundary.

The primary obligation-to-work mapping is below. Cross-cutting dependencies and
each profile's complete `obligations` list in the selected inventory still apply.
Every required obligation ID is present; this mapping does not narrow any profile.

| Source obligations                                    | Closure packages                                          |
| ----------------------------------------------------- | --------------------------------------------------------- |
| M0, M1                                                | A03, A12, A13, A14, A16                                   |
| M2, F1, E1, E8, E9, E10, E11, E12, E13, E14, E15, E16 | A03, applicable A04–A12 producer inputs, A13, A16         |
| M3, R1, E3                                            | A03, A13, A16                                             |
| M4, E4, E5, E6, E17                                   | A02–A13, applicable A14 release/resource obligations, A16 |
| M5, R2, R3, R4, R5, R6, R7, R8, E2, E7                | A03, A13, A14, A16                                        |

## 4. Producer coverage checklist

This grouping prevents a focus on GCC/SDK from hiding the other required roots.
Versions and exact selections remain in the existing source profiles; each
listed family must resolve all of its actual selected child edges. This table
does not add universal historical publisher/operating-system ancestry.

| Family                        | Selected obligations to reconcile                                                                                                                      | Queue owner   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| Go/random                     | Selected random provider source/release packaging; Go SDK archive and compiler/packager SDKs; source generators; selected C-root bootstrap             | A02, A04, A12 |
| Emscripten/tooling            | Selected emsdk 3 LLVM/Ninja, Binaryen, libc++/c++abi, Emscripten, Node SDK and CMake producers; tagged emsdk 4 components; selected Rust 1.90 producer | A02, A12      |
| GNU/C                         | Binutils, GCC, glibc, libtool and GMP source/build facets, original configured outcomes, selected prerequisites and notices                            | A02, A04, A12 |
| OCaml/Coq                     | OCaml compiler/stdlib, Coq, original FIAT standalone targets, findlib, num and zarith                                                                  | A02, A12      |
| JVM                           | Scala 2, scala-asm, scala-diff-utils, JLine native/components, selected JDK 8 and JDK 25 inputs                                                        | A09, A12      |
| .NET                          | Fantomas core/generated/reference/package graph and selected SDK 11 and SDK 10 producers                                                               | A05, A10, A12 |
| Rust/bootstrap                | Selected Rust 1.98 source, bootstrap/native tooling, SDK and original notices                                                                          | A06, A12      |
| WASI                          | Selected WASI SDK compiler graph, Wasmtime and component-linker resolution/build inputs                                                                | A08, A12      |
| Binaryen                      | Selected original Binaryen 132 source, hosted build/packaging and required compiler/SDK inputs                                                         | A07, A12      |
| Tree-sitter/WASM              | Original 0.27.0 native stages, selected Rust/emsdk/WASI inputs, locked registry inputs and outputs                                                     | A11, A12      |
| Shared notices/runtime inputs | Selected native loader/libedit inputs, declared copied/generated dependencies, container inputs and finite SDK notice unions                           | A02, A12      |

For each actual selected producer/input, retain a row with: selection source,
pinned input, build facet, output facet, original-notice facet, required child
edges, evidence identity and exact remaining action. Finish the whole finite set;
do not report a group closed from one successful facet. Newly discovered edges
must cite an original selected recipe or output contribution and receive an
explicit plan update. Unrelated optional features go to the later queue.

## 5. Execution and failure policy

1. **Use stock hosted infrastructure.** Linux uses Ubuntu 26.04; keep the existing
   selected macOS/Windows profiles. Follow the hosted producer plan's actual
   SDK/image admission. A runner label, preinstalled compiler smoke or historical
   metadata result does not qualify a full producer. If a required build cannot
   fit the section 2a budget, retain the measured attempt and record the
   producer as eligible for publisher attestation; it becomes
   `publisher-attested` only after its artifact, signer, source, recipe and
   notices are verified. Do not shrink the selected source, features or tests to
   make a source build fit, and do not report a partial build as one.
2. **Schedule independent work in parallel.** At most two long producer jobs and
   twelve verification workers at once, reduced further for other account jobs.
   Allow at most two producer macOS jobs and three verification macOS jobs.
   Respect the account-wide 20-job/5-macOS limits; matrix `max-parallel` alone is
   not an account-wide scheduler. Measure queue and execution separately.
   Remote job slots do not reserve local recovery disk/RAM. Admit the combined
   local capture budgets before overlapping receivers. Keep large checkouts,
   intake and broad application runs paused while an exclusive SDK recovery
   admission requires them stopped; small independent reconciliation can proceed.
3. **Keep producer builds manual.** GitHub-hosted jobs have a six-hour execution
   limit; a Gate A source-build facet must finish within the five-hour section 2a
   budget, including preparation, upload and cleanup, in one job. No checkpoint
   or continuation chain counts toward Gate A. Ordinary PRs must not start
   compiler/SDK source rebuilds. These limits
   are documented by [GitHub](https://docs.github.com/en/actions/reference/limits);
   `strategy.max-parallel` controls an individual matrix as described in the
   [matrix documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations#defining-the-maximum-number-of-concurrent-jobs).
4. **Use existing evidence first.** Retrieve already permitted retained outcomes
   before another run. Run a new host probe only when a concrete missing
   prerequisite prevents the listed next action. A further controller revision
   must repair an observed defect or satisfy that named prerequisite.
5. **Repair a failure causally.** Retain the original failed attempt and genuine
   charge/outcome; reproduce the defect with the real relevant guard armed; fix
   the responsible code and siblings; run focused broken/fixed/near-miss controls;
   then make one justified bounded retry within authorization. Do not edit an
   expected result to bless a regression, restart the aggregate allowance or
   repeatedly run the same failing long job.
6. **Batch normal validation.** Run the applicable normal check after a behavior
   batch; repeat it after a meaningful fix or changed required input, not merely
   after another metadata/proof revision. Retain exact source/package provenance.
   Keep the ordinary PR 10–20 minute objective separate from long manual producer
   work; measure actual CI wall time before claiming the objective is met.
7. **Use direct `main` PRs.** Each PR targets current `main`; after each merge,
   fetch main and reconcile the next branch. Preserve completed upstream evidence
   under its original identities and requalify changed consumers. Do not create a
   stack of mutually targeted branches, close a PR as though merged, or claim a
   cancelled check passed. Prepare release-only changes on the intended release
   branch under the existing release preference; do not invent another release PR.
8. **Respect actual effect permissions.** Commit/push/PR work is authorized.
   A rejected data export is not approved by a generic continue. Preserve its
   source/key/attempt state and exact rejection; request only the concrete missing
   authorization, then continue independent authorized queue work. Do not reroute
   the payload, regenerate a key, discard original evidence or delete unrelated
   data to make admission pass. Use shared managed foreground leases and verify
   cleanup; a stopped task can restart only under the shared runner's current
   port-ownership rules.
9. **Keep maintenance scoped to closure.** Dependency-bump work, optional feature
   breadth and unrelated CI/performance refactors stay parked. Repair CI or a
   dependency when its actual failure blocks a required package above; record
   that dependency explicitly instead of starting a separate maintenance queue.

### Current effect dependencies

The detailed prepared operations remain private and reviewable. This table
records the type of missing authorization; it does not grant any of it or copy
private reports, paths, keys or payloads into Git.

| Task        | Concrete scope needing an answer                                                                    | Behavior while pending                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A06/A07/A11 | Any still-unapproved original notice bodies, native execution or producer-specific encrypted export | Check the existing exact request and retained authorization before the action; do not infer permission or repeat completed intake. |

The earlier A04 GCC checkpoint export and A05 encrypted SDK recovery requests
are withdrawn by section 2a; they are no longer needed for Gate A and remain
unapproved. Their retained state is preserved, not deleted. Storage cleanup is a
separate lifecycle decision and contributes no producer acceptance.

## 6. Final acceptance and reporting

At each work session, resume the first open item whose dependencies and permissions
are satisfied. Report these facts when an item closes, a long run changes stage,
or a real blocker occurs:

- Task IDs actually closed since the previous report, with their evidence.
- Remaining critical-path task IDs and the next concrete command or repair.
- Active native run URL, exact head/attempt/stage, elapsed time and retained
  terminal state. Distinguish queued, running, failed, cancelled and completed.
- Any permission/capacity blocker and the independent work progressing meanwhile.

Do not report helper versions, test counts, reconstructed archives or preparation
as a percentage of Gate A. Derive counts from the inventory and evidence states;
do not revive the historical “25 of 36” estimate. Update this document's task
states when evidence closes work. A real requirement change needs an explicit
reviewable plan revision; a new idea is not a reason to move the finish line.

Final verification includes:

```sh
node scripts/audit-gate-inventory.mjs .
node scripts/audit-gate-inventory.mjs . --require-frozen
npm run check
```

Use the installed direct runner if the package-manager wrapper cannot start in
the local environment; do not disable its signature verification. The inventory
audit is structural and intentionally never certifies Gate A by itself. The
`--require-frozen` command is expected to fail while freeze work is open. Final
acceptance also needs the actual declared native/installed matrices, complete
producer/notice joins, current package identities and a source-bound closure
record; an ordinary suite containing skips cannot substitute for those records.

In particular, `gate-a-profiles.v1.json` is selection metadata. Its
`gateAComplete`, `inferenceInvoked`, `fieldEvaluationExecuted` and
`qualityAssessed` fields must remain false under the existing auditor contract.
Do not weaken that assertion or flip these fields to announce completion.
A16 needs a separate final acceptance record and verifier which consume actual
evidence for all required obligations, profiles, slots and producer/notice joins.
Include broken controls for omitted producer children, missing/changed notices,
stale source/package identities, missing terminal cases and unavailable/skipped
required slots. The successful structural audit is one input to that verifier,
not its verdict.

Close A16 only when there are **zero unresolved required implementation,
producer, notice, lifecycle, profile-binding or inventory gaps**, and required
changes and checks are present on merged `main`. Publish the verified closure
record and reconcile the ledger, roadmap and acceptance audit together; link it
from the inventory documentation without turning selection metadata into an
acceptance claim. Keep demonstrated
review quality unassessed until the separately permitted Gate B/C experiment.
