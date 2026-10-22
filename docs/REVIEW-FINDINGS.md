# Source-bound declared findings

`review-findings --root ROOT --input RELATIVE_JSON` and the read-only MCP tool
`review_findings` use `inspectReviewFindings(root, serializedJSON, options)`.
They inspect retained evidence without invoking models, project code or remote
services. Input is strict serialized JSON capped at 1 MiB. Reports are capped at
4 MiB. Library cancellation and a 1–120,000 ms wall budget are checked at
boundaries; synchronous parsing and file reads are not preempted. CLI
`--timeout-ms` and the MCP startup timeout supply the budget.

The input profile is `source-bound-declared-findings-v1`. Its `provenance` uses
[review provenance](REVIEW-PROVENANCE.md), with scoring fixed to null: answer
labels cannot enter this intake. Every candidate remains in the denominator.
Missing decisions, stale or unmatched sources, incomplete stages and unknown
consequences remain unresolved. Empty candidate selections are incomplete.
Foreign or repeated candidate decisions and repeated common-defect membership
are rejected. Incomplete and cancelled stage declarations may be retained but
cannot support a final declared finding.

Each decision binds the full context, candidate, native run and ordered native
case-ID cohort. Completed refutation and adjudication stages require a declared
session ID and rationale. One reviewer session is declared for the whole input;
refuter/adjudicator IDs must be distinct across all candidates and roles. Reuse
is assessed before deriving any row and degrades every affected candidate.
These checks compare declarations; they cannot establish fresh host sessions,
blinding, independent reasoning or that every actual attempt was disclosed.

A final `declared-supported` or `declared-refuted` row needs current matched
citations, a reconciled completed imported native receipt, one unambiguous
captured native function, and complete declared mechanism, callers and default
checks. Equal source bytes and function ranges in different captured files are
ambiguous; inspection does not choose a convenient filename. Support additionally
requires a violated pinned native predicate, complete consequence descriptors
and a proposed repair with a declared scope. A satisfied predicate alone does
not refute a claim. No result establishes the intended production policy,
reachability, native execution attestation or claim truth.

## Repair parameter availability

A proposed repair identifies a current candidate citation, captured function ID
and required parameter names. The inspector lazily loads the pinned TypeScript
parser and reparses captured JavaScript/TypeScript text using an in-memory host.
It reads no project compiler configuration or imports, emits nothing and
executes no project modules. The AST function must match the captured offsets
exactly. Unsupported, malformed, unmatched or exhausted parsing remains
unavailable. The observer bounds AST visits, depth and parameter bindings.

Only that function's parameter bindings count: destructuring aliases, nested
bindings, rest and Unicode identifiers are included. Nested function/default
initializer parameters, local variables, global names and destructuring property
keys are excluded. This verifies availability of declared parameter names only.
An empty required-name list makes no claim about missing values. The inspector
cannot determine whether the repair omitted a required value, whether its
parameters hold the right values, or whether the repair is correct. Other
languages remain unavailable for this check.

All asynchronous parameter work finishes before the final current-source
verification. Subsequent derivation is synchronous. Source observations are
boundary checks, not an atomic or continuous filesystem attestation.
`projectReviewFindings` independently rederives retained results and refuses
modified states, counts, groups, severities or parameter observations. Projection
replays captured evidence; it does not recheck the current filesystem.

## Declared severity and common causes

`declared-consequence-matrix-v1` assigns a descriptive priority from declared
category, extent, access and recovery fields. Any unknown field yields
`unassigned`; support then remains unresolved. With complete descriptors:

| Condition, in precedence order                         | Declared priority |
| ------------------------------------------------------ | ----------------- |
| Maintainability                                        | low               |
| Security boundary accessible without privileged access | high              |
| Irreversible data loss or wrong result                 | high              |
| Systemwide effect other than a wrong result            | high              |
| Remaining combinations                                 | moderate          |

This is this profile's finite policy, not a standard severity score, verified
impact or a calibrated claim-confidence estimate. Descriptor truth stays
host-declared and `severityVerified` stays false.

Common-defect groups are explicit host mappings. Members must be selected exactly
once and all must retain supported declarations at the same current root
function. An invalid group remains unresolved and never removes its individual
findings. Supported candidates absent from reconciled groups remain counted as
unmapped and keep the report incomplete. Original claims, citations, attribution,
repair text and fix scopes remain in the retained input. Sharing a function does
not prove a common cause; `commonCauseVerified` stays false. The profile does not
perform semantic duplicate detection or automatically rewrite workflow outputs.

## Disclosure and acceptance limits

The default projection is a strict allowlist of aggregate states, counts and
digests. It omits candidate/group/session IDs, paths, source, raw native output,
parameter names and judgment prose. CLI full output requires both `--detailed`
and `--allow-review-source`; MCP disclosure is fixed at server startup. Tool
arguments cannot grant disclosure or execution. Invalid-input errors are generic.

Public schemas are `review-findings-input`, `review-findings-report` and
`review-findings-summary`. The required `finding-resolution` component cohort
runs through an existing CI job and repeats its controls in a fresh offline
production installation. These original synthetic controls do not close the
whole multi-candidate workflow profile, wider runtime acceptance, independent
judgments or Gate A. All truth, independence, common-cause, repair-correctness and
native-execution flags remain false; quality remains unassessed. No actual AI
review or real-project field evaluation is invoked by this feature.
