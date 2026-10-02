# Native corroboration and independent adjudication

`runReviewVerification`, CLI `review-verify` and MCP `review_verify` share one
experimental advisory engine. It binds one captured context, one exactly cited
unverified candidate and one operator-pinned `node-export-boolean-v1` recipe.
Only original synthetic development controls have been used. Gate A remains
open; this integration enables no real-project field or held-out evaluation.

The engine first runs a fresh [refutation assignment](REVIEW-REFUTATION.md).
The refuter receives no native outcomes, prior reviewer identity, original
candidate label, severity, confidence or prior verdict. An incomplete refutation
stops the run before native execution. A completed attempt can return no
counterclaims; this supplies no support for the original claim.

Next, the [native probe](REVIEW-PROBES.md) executes baseline, trigger and near-miss
cases against fresh copies of the assigned source. Project code is operator
trusted and **not sandboxed**. Missing scale/coverage, failed controls, non-Boolean
returns, unsupported scope, cancellation, source changes and incomplete cleanup
cannot advance to adjudication. Discovery and context creation do not execute
these probes.

A separate stateless provider assignment then receives the captured source,
unverified target and counterclaims, plus raw native inputs, operator expectations,
actual Boolean results and measured coverage. It receives no prior provider
identity, candidate labels, severity, confidence or verdict. The native recipe's
case labels and aggregate `violated`/`satisfied` decision are also withheld. Each
provider assignment has distinct run and attempt identities and no conversation
history, tools or local memory. Its returned candidates remain advisory proposals;
an empty response is abstention. Provider training contamination remains unknown.

The report records a bounded evidence tier:

| Tier                          | What it establishes                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native-expectation-mismatch` | Current source executed the declared trigger at the required input scale; baseline and near-miss controls agreed, while a trigger Boolean differed from the operator expectation. |
| `native-controls-observed`    | All declared cases agreed with their operator expectations. This does not refute a broader claim.                                                                                 |
| `no-current-native-evidence`  | Complete current controls are absent, failed, unsupported, stale or otherwise unresolved.                                                                                         |

A free-text hypothesis is not semantically equivalent to its Boolean recipe.
None of these tiers establishes intended production policy, full mechanism,
production caller reachability, consequence, feasible remedy, calibrated
confidence or historical attribution. `claimsVerified` stays false,
`resolution` stays unresolved and consequence-based severity stays unassigned.
Deduplicating underlying defects and independently supported/refuted findings
remain required R5 work. Completing all three stages means the bounded experiment
completed, not that a defect or quality gate passed. Deterministic validation
outcomes are never rewritten by this layer.

## Operator configuration and accounting

The library requires execution trust plus inference and provider-source grants.
CLI use requires `--trust-project`, `--context`, `--input` candidate, exactly one
`--probe PATH#sha256=DIGEST`, `--provider-config`, `--allow-inference` and
`--allow-provider-source`. The same exact provider/model configuration is used
for both fresh assignments, without fallback. MCP receives only context and
candidate paths plus a registered probe ID; grants, recipe, configuration,
model and budgets come from server startup. Verification reserves both the native
and provider execution slots until cancellation or completion releases them.

`--timeout-ms` bounds the combined run through a shared cancellation signal;
MCP uses the operator's `probeLimits.wallMs`. Native cases also share the
[run-wide call/output ledger](REVIEW-PROBES.md#run-wide-native-budgets).
The operator can select `nativeBudget` through the library, startup
`probeLimits.nativeBudget`, or CLI `--native-max-calls` and
`--native-max-output-bytes`. Incomplete admission retains unrun cases and stops
before adjudicator disclosure. Version 2 verification receipts bind these frozen
operator limits to the live version 2 probe accounting; version 1 receipts remain
readable. A verification's native budget applies to its one probe stage.
[Provider admission budgets](REVIEW-PROVIDERS.md) apply per assignment across its
retries. Optional operator `limits.aggregateBudget` also shares call, token,
estimated-cost and body-byte admission across both assignments and all retries;
`budgetScope` records `verification-run` for this profile. With no aggregate
configuration it retains `per-provider-assignment` for compatibility. The shared
ledger stays engine-local and is withheld from both model packets. Each new
verification invocation starts a new ledger, including after cancellation.
Input allowances and billing remain unverified, and transport byte accounting
excludes protocol overhead and can observe an overlarge delivered chunk.
The bounded Node probe ledger does not close wider native/tool budget profiles,
neutral-stage lifecycle or optional streaming-provider cleanup requirements.

Reports retain each reached stage, its numeric usage/attempt accounting and its
source/recipe/packet bindings. Later source changes invalidate the current native
evidence tier while preserving earlier observations. Retained reports reconcile
exact recipe cases, expectations, source/function ranges, assignment packets,
provider receipts and distinct session identities. Digests detect inconsistent
editing; they do not authenticate a completely manufactured external receipt.
The engine runs its own live probe and never takes a native report from an MCP
argument as evidence.

Summary output omits captured source, hypotheses, counterclaims, raw native cases
and adjudicator proposals. Detailed output requires both `--detailed` and the
operator's separate `--allow-review-source` grant. Inference disclosure and
output disclosure remain separate permissions.

## Development acceptance

`review-verification` in `scripts/required-native-tests.json` names the original
synthetic controls. They cover both API transports, wrong production-impact
claims despite actual mismatches, fixed and failed controls, withheld labels,
invalid pins/addresses/grants, unavailable budget/refusal/capacity paths, source
races, cancellation, retained-report mutations, immutable inputs and shared
CLI/MCP execution-slot behavior. Production package smoke exercises the installed
worker and all three public surfaces without development dependencies or real
provider calls. Exact measured profiles belong in dated measurements; this
bounded Node profile does not advertise Windows or wider-language support.

The [dated native measurement](measurements/review-verification-2026-10-02.json)
binds the measured source and exact macOS/Linux, installed-package and client
profiles. Client discovery/direct-tool checks start no model turn and do not
verify host AI session isolation or reviewer quality. The MCP-first workflow
with host-owned AI/authentication is described in REVIEW-MCP-WORKFLOW.md; this
engine-owned API pipeline remains optional.
